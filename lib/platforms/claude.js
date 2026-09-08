const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { CLAUDE_CODE_DIR } = require('../config');
const { withMetadataCache, withInFlightDedup, makeMessage, sortSessionsByTimestampDesc, topToolsOf } = require('./shared');

function normalizeClaudeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const usage = {
    input: number(rawUsage.input_tokens ?? rawUsage.input),
    output: number(rawUsage.output_tokens ?? rawUsage.output),
    cacheRead: number(rawUsage.cache_read_input_tokens ?? rawUsage.cache_read ?? rawUsage.cacheRead),
    cacheWrite: number(rawUsage.cache_creation_input_tokens ?? rawUsage.cache_write ?? rawUsage.cacheWrite),
  };
  const contextWindow = number(
    rawUsage.model_context_window ?? rawUsage.context_window ?? rawUsage.contextWindow ?? rawUsage.context_window_size
  );
  if (contextWindow > 0) usage.contextWindow = contextWindow;
  const componentSum = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const rawTotal = number(rawUsage.total_tokens);
  // Prefer raw total_tokens when present and positive; fall back to component
  // sum. Take the larger value to guard against incomplete raw data.
  usage.totalTokens = rawTotal > 0 ? Math.max(rawTotal, componentSum) : componentSum;
  return usage;
}

function summarizeClaudeRequestUsage(requestUsage, latestUsage) {
  if (!requestUsage.size || !latestUsage) return { tokenUsage: null, contextUsage: null };
  // Claude API input_tokens and cache_*_input_tokens are cumulative per request
  // (each request includes the full conversation history up to that point), so
  // session-level input/cache values must come from the latest request rather
  // than being summed. Output is per-response and is summed across requests.
  let outputSum = 0;
  for (const usage of requestUsage.values()) {
    outputSum += usage.output;
  }
  const tokenUsage = {
    input: latestUsage.input,
    output: outputSum,
    cacheRead: latestUsage.cacheRead,
    cacheWrite: latestUsage.cacheWrite,
    totalTokens: latestUsage.input + latestUsage.cacheRead + latestUsage.cacheWrite + outputSum,
  };
  const used = latestUsage.input + latestUsage.cacheRead + latestUsage.cacheWrite;
  const limit = latestUsage.contextWindow > 0 ? latestUsage.contextWindow : null;
  return {
    tokenUsage,
    contextUsage: {
      used,
      limit,
      percent: limit ? (used / limit) * 100 : null,
      source: 'native',
      input: latestUsage.input,
      cacheRead: latestUsage.cacheRead,
      cacheWrite: latestUsage.cacheWrite,
      output: latestUsage.output,
      breakdownStatus: 'unavailable',
      note: 'Claude Code 日志记录了本次输入与缓存 Token，但未记录上下文窗口上限及分类 Token。',
    },
  };
}

async function listClaudeCodeProjects(baseDir) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function findClaudeCodeSessionFile(baseDir, sessionId) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  const projects = await listClaudeCodeProjects(dir);
  for (const project of projects) {
    const dirPath = path.join(dir, project);
    const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base === sessionId || base.endsWith(sessionId)) {
        return path.join(dirPath, f.name);
      }
    }
    // Check subagents subdirectory
    const subDir = path.join(dirPath, 'subagents');
    const subFiles = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
    for (const f of subFiles) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base === sessionId || base.endsWith(sessionId)) {
        return path.join(subDir, f.name);
      }
    }
  }
  return null;
}

function parseClaudeCodeSessionIdFromFilename(fileName) {
  return fileName.replace(/\.jsonl$/, '');
}

// Returns the real human prompt text from a Claude Code user record, or null if
// the record is noise (tool results, slash commands, injected reminders, etc.)
function extractClaudeCodeUserPromptText(rec) {
  if (rec.isMeta === true) return null;
  const content = rec.message?.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const textBlocks = content.filter((b) => b.type === 'text' && (b.text || '').trim());
    const hasToolResult = content.some((b) => b.type === 'tool_result');
    if (hasToolResult && textBlocks.length === 0) return null;
    text = textBlocks.map((b) => b.text).join('\n');
  }
  if (!text) return null;
  if (text.includes('<command-name>') || text.includes('<command-message>') || text.includes('<local-command-stdout>'))
    return null;
  if (text.includes('<task-notification>')) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('Caveat:')) return null;
  if (trimmed === '[Request interrupted by user]' || trimmed === '[Request interrupted by user for tool use]')
    return null;
  // System reminders are appended to real prompts — strip them rather than drop the message
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return text || null;
}

const parseClaudeCodeSessionMetadata = withMetadataCache(_parseClaudeCodeSessionMetadataRaw);

async function _parseClaudeCodeSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = null;
  let sessionTimestamp = null;
  let sessionCwd = null;
  let sessionSlug = null;
  let sessionModel = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
  const toolNames = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const t = rec.type;

      if (t === 'user') {
        messageCount++;
        userCount++;
        const content = rec.message?.content;
        // Extract first real user prompt text (filters tool results / injected noise)
        if (!firstUserMessage) {
          const t = extractClaudeCodeUserPromptText(rec);
          if (t) firstUserMessage = t.slice(0, 120);
        }
        // Check if this user message contains tool_result blocks
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') toolResultCount++;
          }
        }
        if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
        if (!sessionCwd && rec.cwd) sessionCwd = rec.cwd;
        if (!sessionSlug && rec.slug) sessionSlug = rec.slug;
      } else if (t === 'assistant') {
        messageCount++;
        assistantCount++;
        const model = rec.message?.model;
        if (model && model !== '<synthetic>') sessionModel = model;
        const content = rec.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              toolCallCount++;
              const name = block.name || 'unknown';
              toolNames[name] = (toolNames[name] || 0) + 1;
            }
          }
        }
      } else if (t === 'system' && rec.subtype === 'turn_duration') {
        // Skip system turn_duration records for message counting
      }

      if (rec.timestamp) lastTimestamp = rec.timestamp;
      if (!sessionTimestamp && rec.timestamp && (t === 'user' || t === 'assistant')) {
        sessionTimestamp = rec.timestamp;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = topToolsOf(toolNames);

  return {
    id: sessionId || parseClaudeCodeSessionIdFromFilename(fileName),
    timestamp: sessionTimestamp,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    cwd: sessionCwd,
    slug: sessionSlug,
    model: sessionModel,
    file: fileName,
  };
}

async function listClaudeCodeSessions(baseDir) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  const sessions = [];
  const projects = await listClaudeCodeProjects(dir);

  for (const project of projects) {
    const dirPath = path.join(dir, project);
    const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      sessions.push(parseClaudeCodeSessionMetadata(path.join(dirPath, f.name), f.name));
    }
  }

  const resolved = await Promise.all(sessions);
  return sortSessionsByTimestampDesc(resolved);
}

function normalizeClaudeAttachmentContext(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const fieldsByType = {
    task_reminder: ['content', 'itemCount'],
    skill_listing: ['skillCount', 'names', 'content', 'isInitial'],
    agent_listing_delta: ['addedTypes', 'removedTypes', 'addedLines', 'showConcurrencyNote', 'isInitial'],
    mcp_instructions_delta: ['addedNames', 'removedNames', 'addedBlocks'],
    command_permissions: ['allowedTools'],
    date_change: ['newDate'],
    deferred_tools_delta: ['addedNames', 'removedNames', 'readdedNames', 'addedLines', 'pendingMcpServers'],
  };
  const tagByType = {
    task_reminder: 'task-context',
    skill_listing: 'skill-context',
    agent_listing_delta: 'agent-context',
    mcp_instructions_delta: 'mcp-context',
    command_permissions: 'permissions-context',
    date_change: 'date-context',
    deferred_tools_delta: 'mcp-context',
  };
  const fields = fieldsByType[attachment.type];
  const tag = tagByType[attachment.type];
  if (!fields || !tag) return null;
  const safe = { type: attachment.type };
  for (const field of fields) {
    const value = attachment[field];
    if (value !== undefined && value !== null) safe[field] = value;
  }
  return `<${tag}>\n${JSON.stringify(safe, null, 2)}\n</${tag}>`;
}

function normalizeClaudeCodeRecord(rec) {
  const t = rec.type;
  const base = { id: rec.uuid || null, timestamp: rec.timestamp || null };

  if (t === 'user') {
    const msg = rec.message || {};
    const content = msg.content;

    if (typeof content === 'string') {
      // Plain user text message
      return makeMessage({ ...base, role: 'user', content: [{ type: 'text', text: content }] });
    }

    if (Array.isArray(content)) {
      // Check if this is purely tool_result blocks
      const hasToolResult = content.some((b) => b.type === 'tool_result');
      const hasText = content.some((b) => b.type === 'text');

      if (hasToolResult && !hasText) {
        // This is a tool result message — return as toolResult
        const textParts = content
          .filter((b) => b.type === 'tool_result')
          .map((b) => {
            const inner = b.content;
            if (typeof inner === 'string') return inner;
            if (Array.isArray(inner))
              return inner
                .filter((ib) => ib.type === 'text')
                .map((ib) => ib.text || '')
                .join('\n');
            return JSON.stringify(inner);
          });
        const toolResultBlock = content.find((b) => b.type === 'tool_result');
        const isError = toolResultBlock?.is_error || false;
        return makeMessage({
          ...base,
          role: 'toolResult',
          content: [{ type: 'text', text: textParts.join('\n\n') }],
          toolCallId: toolResultBlock?.tool_use_id || null,
          details:
            rec.toolUseResult && typeof rec.toolUseResult === 'object'
              ? {
                  stdout: rec.toolUseResult.stdout ? String(rec.toolUseResult.stdout).slice(0, 200) : null,
                  stderr: rec.toolUseResult.stderr ? String(rec.toolUseResult.stderr).slice(0, 200) : null,
                }
              : typeof rec.toolUseResult === 'string'
                ? { error: rec.toolUseResult }
                : null,
          isError,
        });
      }

      // Mixed content or text-only array — extract text
      const textParts = content.filter((b) => b.type === 'text').map((b) => b.text || '');
      return makeMessage({ ...base, role: 'user', content: [{ type: 'text', text: textParts.join('\n\n') }] });
    }

    // Fallback: no content
    return makeMessage({ ...base, role: 'user' });
  }

  if (t === 'assistant') {
    const msg = rec.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];

    const textParts = content.filter((b) => b.type === 'text').map((b) => b.text || '');
    const toolUseBlocks = content.filter((b) => b.type === 'tool_use');

    // Build content array matching our unified format
    const unifiedContent = textParts.map((text) => ({ type: 'text', text }));
    // Add toolUse blocks as 'toolCall' type (matching OpenClaw format)
    for (const block of toolUseBlocks) {
      unifiedContent.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      });
    }

    return makeMessage({
      ...base,
      role: 'assistant',
      content: unifiedContent,
      usage: normalizeClaudeUsage(msg.usage),
      model: msg.model || null,
    });
  }

  return null;
}

async function _parseClaudeCodeSessionFileRaw(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  const messages = [];
  const userMessagesByUuid = new Map();
  const requestUsage = new Map();
  let latestRequestUsage = null;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const t = rec.type;

      if (!session && rec.sessionId) {
        session = {
          id: rec.sessionId,
          cwd: rec.cwd || null,
          timestamp: null,
          version: rec.version || null,
        };
      }

      // Update session cwd if we find it on a later record
      if (session && !session.cwd && rec.cwd) {
        session.cwd = rec.cwd;
      }

      if (!session?.timestamp && rec.timestamp && (t === 'user' || t === 'assistant')) {
        session.timestamp = rec.timestamp;
      }

      if (t === 'user' || t === 'assistant') {
        const msg = normalizeClaudeCodeRecord(rec);
        if (msg) {
          messages.push(msg);
          if (t === 'user' && rec.uuid && msg.role === 'user') userMessagesByUuid.set(rec.uuid, msg);
        }
        if (t === 'assistant') {
          const normalizedUsage = normalizeClaudeUsage(rec.message?.usage);
          if (normalizedUsage) {
            const requestKey = String(rec.message?.id || rec.requestId || rec.uuid || messages.length);
            requestUsage.set(requestKey, normalizedUsage);
            latestRequestUsage = normalizedUsage;
          }
        }
      } else if (t === 'attachment' && rec.parentUuid) {
        const context = normalizeClaudeAttachmentContext(rec.attachment);
        const parent = userMessagesByUuid.get(rec.parentUuid);
        if (context && parent) {
          parent.content = [...(parent.content || []), { type: 'text', text: context }];
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const usageSummary = summarizeClaudeRequestUsage(requestUsage, latestRequestUsage);
  if (session) {
    session.tokenUsage = usageSummary.tokenUsage;
    session.contextUsage = usageSummary.contextUsage;
    session.sourcePath = filePath;
  }
  return { session, messages, tokenUsage: usageSummary.tokenUsage, contextUsage: usageSummary.contextUsage };
}

// In-flight dedup: concurrent parses of the same file share one read.
const parseClaudeCodeSessionFile = withInFlightDedup((filePath) => filePath, _parseClaudeCodeSessionFileRaw);

// Claude Code subagents: a session that spawns children keeps them as
// <slug>/<sessionId>/subagents/agent-<id>.jsonl next to its own file, with
// an optional sibling agent-<id>.meta.json ({agentType, description, ...}).
async function findClaudeSpawnDir(baseDir, sessionId) {
  const filePath = await findClaudeCodeSessionFile(baseDir, sessionId);
  if (!filePath) return null;
  const spawnDir = path.join(path.dirname(filePath), sessionId, 'subagents');
  try {
    const st = await fsp.stat(spawnDir);
    return st.isDirectory() ? spawnDir : null;
  } catch {
    return null;
  }
}

module.exports = {
  normalizeClaudeUsage,
  summarizeClaudeRequestUsage,
  listClaudeCodeProjects,
  findClaudeCodeSessionFile,
  parseClaudeCodeSessionIdFromFilename,
  extractClaudeCodeUserPromptText,
  parseClaudeCodeSessionMetadata,
  listClaudeCodeSessions,
  normalizeClaudeCodeRecord,
  normalizeClaudeAttachmentContext,
  parseClaudeCodeSessionFile,
  findClaudeSpawnDir,
};
