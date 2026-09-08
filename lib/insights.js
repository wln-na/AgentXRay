const { extractErrorSnippet, normalizeErrorPattern } = require('./text-utils');
const { HERMES_DIR, resolveDir } = require('./config');
const { openHermesDb } = require('./platforms/hermes');
const { PLATFORMS, collectSessionFiles } = require('./platforms');
const { iterateSessionLines, scanFileForInsights } = require('./insights-scanner');

// ========= Insights: aggregate analytics across sessions =========
const insightsCache = new Map(); // key → { expires: number, data: object }
const INSIGHTS_TTL_MS = 60_000;
const INSIGHTS_CACHE_MAX = 50; // LRU cap to prevent unbounded memory growth
// In-flight promise dedup: concurrent computeInsights calls with the same
// key share one computation instead of each scanning all session files.
const inFlight = new Map(); // key → Promise<object|null>

function getInsightsCacheKey(platform, agent, dir) {
  return `${platform}|${agent || ''}|${dir || ''}`;
}

// Insert into the insights cache with LRU eviction: when the cap is exceeded
// the oldest insertion-order key is dropped. Re-setting an existing key moves
// it to the most-recent end (delete-then-set), matching true LRU semantics.
// Map preserves insertion order, so map.keys().next().value is the oldest.
function setInsightsCache(key, data) {
  if (insightsCache.has(key)) insightsCache.delete(key);
  insightsCache.set(key, { data, expires: Date.now() + INSIGHTS_TTL_MS });
  while (insightsCache.size > INSIGHTS_CACHE_MAX) {
    const oldest = insightsCache.keys().next().value;
    if (oldest === undefined) break;
    insightsCache.delete(oldest);
  }
}

// Scan a single Hermes session for insights (from SQLite)
function scanHermesSessionForInsights(db, sessionId) {
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  const totalOutputTokens = 0;
  let sessionDate = null;
  const toolStats = {};
  const errorExamples = [];

  const rows = db
    .prepare(`
    SELECT role, content, tool_calls, tool_name, token_count, timestamp
    FROM messages WHERE session_id = ?
    ORDER BY rowid
  `)
    .all(sessionId);

  for (const row of rows) {
    messageCount++;
    totalInputTokens += row.token_count || 0;

    if (!sessionDate && row.timestamp) {
      sessionDate = new Date(row.timestamp * 1000).toISOString().slice(0, 10);
    }

    // Parse tool calls from assistant messages
    if (row.role === 'assistant' && row.tool_calls) {
      let calls;
      try {
        calls = JSON.parse(row.tool_calls);
      } catch {
        continue;
      }
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          const name = tc?.function?.name || tc?.name || 'unknown';
          toolCallCount++;
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
        }
      }
    }

    // Tool results
    if (row.role === 'tool') {
      toolResultCount++;
      const name = row.tool_name || 'tool';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      // Detect errors from content (no is_error column in Hermes)
      const content = row.content || '';
      const isErr =
        content.includes('"isError":true') ||
        content.includes('"isError": true') ||
        (content.toLowerCase().includes('error') && content.includes('exit code') && !content.includes('exit code 0'));
      if (isErr) {
        errorCount++;
        toolStats[name].errors++;
        const snippet = content.trim().split('\n')[0].trim().slice(0, 200);
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({
          toolName: name,
          snippet,
          pattern,
          sessionId,
          timestamp: row.timestamp ? new Date(row.timestamp * 1000).toISOString() : null,
        });
      }
    }
  }

  return {
    messageCount,
    toolCallCount,
    toolResultCount,
    errorCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead: 0,
    sessionDate,
    toolStats,
    errorExamples,
  };
}

async function computeInsights(platform, agentName, dirOverride) {
  const key = getInsightsCacheKey(platform, agentName, dirOverride);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = _computeInsightsImpl(platform, agentName, dirOverride);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function _computeInsightsImpl(platform, agentName, dirOverride) {
  // Hermes uses SQLite
  if (platform === 'hermes') {
    const dir = resolveDir(dirOverride, HERMES_DIR);
    const db = openHermesDb(dir);
    if (!db) return null;
    try {
      const sessions = db.prepare('SELECT id FROM sessions').all();
      const totalSessions = sessions.length;
      let totalMessages = 0,
        totalToolCalls = 0,
        totalToolResultCount = 0,
        totalErrors = 0;
      let totalInput = 0,
        totalOutput = 0;
      const toolStats = {};
      const allErrors = [];
      const dailyTrend = {};
      const warnings = [];
      const skippedFiles = [];
      let processedFiles = 0;

      for (const s of sessions) {
        let data;
        try {
          data = scanHermesSessionForInsights(db, s.id);
        } catch (error) {
          if (skippedFiles.length < 50) skippedFiles.push(String(s.id));
          if (warnings.length < 50) warnings.push(`hermes: failed to scan session ${s.id}: ${error.message}`);
          continue;
        }
        processedFiles++;
        totalMessages += data.messageCount;
        totalToolCalls += data.toolCallCount;
        totalToolResultCount += data.toolResultCount;
        totalErrors += data.errorCount;
        totalInput += data.totalInputTokens;
        totalOutput += data.totalOutputTokens;

        for (const [name, st] of Object.entries(data.toolStats)) {
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls += st.calls;
          toolStats[name].errors += st.errors;
          toolStats[name].totalDurationMs += st.totalDurationMs;
        }
        allErrors.push(...data.errorExamples);

        if (data.sessionDate) {
          if (!dailyTrend[data.sessionDate]) dailyTrend[data.sessionDate] = { sessions: 0, errors: 0, toolCalls: 0 };
          dailyTrend[data.sessionDate].sessions++;
          dailyTrend[data.sessionDate].errors += data.errorCount;
          dailyTrend[data.sessionDate].toolCalls += data.toolCallCount;
        }
      }

      return buildInsightsResponse(
        totalSessions,
        totalMessages,
        totalToolCalls,
        totalToolResultCount,
        totalErrors,
        totalInput,
        totalOutput,
        0,
        0,
        toolStats,
        allErrors,
        dailyTrend,
        0,
        0,
        warnings,
        skippedFiles,
        processedFiles
      );
    } finally {
      db.close();
    }
  }

  if (platform === 'doubao') {
    const adapter = PLATFORMS.doubao;
    const dir = resolveDir(dirOverride, adapter.defaultDir());
    const sessions = await adapter.list(dir);
    if (!sessions.length) return null;
    let totalMessages = 0;
    let totalToolCalls = 0;
    let totalToolResultCount = 0;
    let totalErrors = 0;
    let totalInput = 0;
    let totalOutput = 0;
    const toolStats = {};
    const allErrors = [];
    const dailyTrend = {};
    const warnings = [];
    const skippedFiles = [];
    let processedFiles = 0;
    for (const summary of sessions) {
      const detail = await adapter.getSession(dir, summary.id).catch((error) => {
        if (skippedFiles.length < 50) skippedFiles.push(String(summary.id));
        if (warnings.length < 50) warnings.push(`doubao: failed to load session ${summary.id}: ${error.message}`);
        return null;
      });
      if (!detail) continue;
      processedFiles++;
      totalMessages += detail.messages.length;
      const day = (summary.lastActivity || summary.timestamp || '').slice(0, 10);
      if (day && !dailyTrend[day]) dailyTrend[day] = { sessions: 0, errors: 0, toolCalls: 0, cost: 0 };
      if (day) dailyTrend[day].sessions++;
      const callNames = new Map();
      for (const message of detail.messages) {
        const usage = message.usage || {};
        totalInput += usage.input || usage.input_tokens || 0;
        totalOutput += usage.output || usage.output_tokens || 0;
        for (const item of message.content || []) {
          if (item.type !== 'toolCall') continue;
          totalToolCalls++;
          const name = item.name || 'unknown';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
          if (item.id) callNames.set(item.id, name);
          if (day) dailyTrend[day].toolCalls++;
        }
        if (message.role === 'toolResult') {
          totalToolResultCount++;
          const name = message.toolName || callNames.get(message.toolCallId) || 'tool';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          if (message.isError) {
            totalErrors++;
            toolStats[name].errors++;
            if (day) dailyTrend[day].errors++;
            const snippet = extractErrorSnippet(message.content);
            allErrors.push({
              toolName: name,
              snippet,
              pattern: normalizeErrorPattern(snippet),
              sessionId: summary.id,
              messageId: message.id || null,
              timestamp: message.timestamp || null,
            });
          }
        }
      }
    }
    return buildInsightsResponse(
      sessions.length,
      totalMessages,
      totalToolCalls,
      totalToolResultCount,
      totalErrors,
      totalInput,
      totalOutput,
      0,
      0,
      toolStats,
      allErrors,
      dailyTrend,
      0,
      0,
      warnings,
      skippedFiles,
      processedFiles
    );
  }

  // JSONL-based platforms: openclaw, codex, claude-code, omp, dsh, gemini
  const files = await collectSessionFiles(platform, agentName, dirOverride);
  if (files.length === 0) return null;

  const totalSessions = files.length;
  let totalMessages = 0,
    totalToolCalls = 0,
    totalToolResultCount = 0,
    totalErrors = 0;
  let totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCacheWrite = 0,
    totalReasoning = 0,
    totalCost = 0;
  const toolStats = {};
  const allErrors = [];
  const dailyTrend = {};
  const warnings = [];
  const skippedFiles = [];
  let processedFiles = 0;

  for (const f of files) {
    const data = await scanFileForInsights(f.path, f.sessionId).catch((error) => {
      if (skippedFiles.length < 50) skippedFiles.push(f.path);
      if (warnings.length < 50) warnings.push(`failed to scan ${f.path}: ${error.message}`);
      return null;
    });
    if (!data) continue;
    processedFiles++;

    totalMessages += data.messageCount;
    totalToolCalls += data.toolCallCount;
    totalToolResultCount += data.toolResultCount;
    totalErrors += data.errorCount;
    totalInput += data.totalInputTokens;
    totalOutput += data.totalOutputTokens;
    totalCacheRead += data.totalCacheRead;
    totalCacheWrite += data.totalCacheWrite || 0;
    totalReasoning += data.totalReasoning || 0;
    totalCost += data.totalCost || 0;

    for (const [name, st] of Object.entries(data.toolStats)) {
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls += st.calls;
      toolStats[name].errors += st.errors;
      toolStats[name].totalDurationMs += st.totalDurationMs;
    }
    allErrors.push(...data.errorExamples);

    if (data.sessionDate) {
      if (!dailyTrend[data.sessionDate])
        dailyTrend[data.sessionDate] = { sessions: 0, errors: 0, toolCalls: 0, cost: 0 };
      dailyTrend[data.sessionDate].sessions++;
      dailyTrend[data.sessionDate].errors += data.errorCount;
      dailyTrend[data.sessionDate].toolCalls += data.toolCallCount;
      dailyTrend[data.sessionDate].cost += data.totalCost || 0;
    }
  }

  return buildInsightsResponse(
    totalSessions,
    totalMessages,
    totalToolCalls,
    totalToolResultCount,
    totalErrors,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCost,
    toolStats,
    allErrors,
    dailyTrend,
    totalCacheWrite,
    totalReasoning,
    warnings,
    skippedFiles,
    processedFiles
  );
}

function buildInsightsResponse(
  totalSessions,
  totalMessages,
  totalToolCalls,
  totalToolResultCount,
  totalErrors,
  totalInput,
  totalOutput,
  totalCacheRead,
  totalCost,
  toolStats,
  allErrors,
  dailyTrend,
  totalCacheWrite = 0,
  totalReasoning = 0,
  warnings = [],
  skippedFiles = [],
  processedFiles = 0
) {
  const errorRate = totalToolResultCount > 0 ? totalErrors / totalToolResultCount : 0;

  // Tool stats array
  const toolStatsArray = Object.entries(toolStats)
    .map(([name, st]) => ({
      name,
      calls: st.calls,
      errors: st.errors,
      errorRate: st.calls > 0 ? st.errors / st.calls : 0,
      avgDurationMs: st.calls > 0 ? Math.round(st.totalDurationMs / st.calls) : null,
    }))
    .sort((a, b) => b.calls - a.calls);

  // Error clusters: group by normalized pattern
  const clusters = {};
  for (const err of allErrors) {
    const key = err.pattern;
    if (!clusters[key]) clusters[key] = { pattern: err.snippet, count: 0, examples: [] };
    clusters[key].count++;
    if (clusters[key].examples.length < 5) {
      clusters[key].examples.push({
        sessionId: err.sessionId,
        toolName: err.toolName,
        snippet: err.snippet,
        messageId: err.messageId || null,
        timestamp: err.timestamp,
      });
    }
  }
  const errorClusters = Object.values(clusters)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Daily trend sorted by date
  const trend = Object.entries(dailyTrend)
    .map(([date, d]) => ({
      date,
      sessions: d.sessions,
      errors: d.errors,
      toolCalls: d.toolCalls,
      cost: Math.round((d.cost || 0) * 10000) / 10000,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const tokenUsage = { input: totalInput, output: totalOutput, cacheRead: totalCacheRead };
  if (totalCacheWrite > 0) tokenUsage.cacheWrite = totalCacheWrite;
  if (totalReasoning > 0) tokenUsage.reasoning = totalReasoning;

  return {
    totalSessions,
    totalMessages,
    totalToolCalls,
    errorRate: Math.round(errorRate * 10000) / 10000,
    totalCost: Math.round(totalCost * 10000) / 10000,
    tokenUsage,
    toolStats: toolStatsArray,
    errorClusters,
    trend,
    cachedAt: Date.now(),
    warnings,
    skippedFiles,
    processedFiles,
  };
}

module.exports = {
  insightsCache,
  INSIGHTS_TTL_MS,
  INSIGHTS_CACHE_MAX,
  inFlight,
  getInsightsCacheKey,
  setInsightsCache,
  iterateSessionLines,
  scanFileForInsights,
  scanHermesSessionForInsights,
  computeInsights,
  buildInsightsResponse,
};
