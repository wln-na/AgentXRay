const fs = require('fs');
const readline = require('readline');
const { extractErrorSnippet, normalizeErrorPattern } = require('./text-utils');
const { readDshSessionLines } = require('./platforms/dsh');
const { stringifyToolResult: stringifyGeminiToolResult } = require('./platforms/gemini');

// --- Per-file insights scanner (extracted from insights.js) ---
// Pure file-scanning + stat aggregation. No caching, no LLM, no routes.
// insights.js imports these and re-exports them for backward compatibility.

// Stream a session log line by line. dsh zstd logs can't be streamed as UTF-8:
// they're decompressed via the dsh adapter and yielded from memory.
async function* iterateSessionLines(filePath) {
  if (filePath.endsWith('.zstd')) {
    for (const line of await readDshSessionLines(filePath)) yield line;
    return;
  }
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
}

// Scan a single JSONL file for insights data
// Supports both standard format (type:'message' with toolCall/toolResult roles)
// and Claude Code format (type:'assistant'/'user' with tool_use/tool_result content blocks)
async function scanFileForInsights(filePath, sessionId) {
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalReasoning = 0;
  let codexTokenUsage = null;
  const claudeRequestUsage = new Map();
  let totalCost = 0;
  let sessionDate = null;
  const toolStats = {}; // name → { calls, errors, totalDurationMs }
  const errorExamples = []; // { toolName, snippet, pattern }
  const dshToolNames = new Map(); // callId → name (dsh tool/call → tool/result pairing)

  for await (const line of iterateSessionLines(filePath)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    // Session timestamp
    if (rec.type === 'session' && rec.timestamp) {
      sessionDate = rec.timestamp.slice(0, 10);
    }
    // Claude Code: timestamp at top level on type:'user'/'assistant'
    if ((rec.type === 'user' || rec.type === 'assistant') && !sessionDate && rec.timestamp) {
      sessionDate = rec.timestamp.slice(0, 10);
    }

    // --- Standard format: type === 'message' ---
    if (rec.type === 'message') {
      messageCount++;
      const msg = rec.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];

      if (msg.usage) {
        totalInputTokens += msg.usage.input || 0;
        totalOutputTokens += msg.usage.output || 0;
        totalCacheRead += msg.usage.cacheRead || msg.usage.cache_read || 0;
        if (msg.usage.cost && typeof msg.usage.cost.total === 'number') totalCost += msg.usage.cost.total;
      }

      for (const c of content) {
        if (c.type === 'toolCall') {
          toolCallCount++;
          const name = c.name || 'unknown';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
        }
      }

      if (msg.role === 'toolResult') {
        toolResultCount++;
        const name = msg.toolName || '?';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };

        if (msg.isError) {
          errorCount++;
          toolStats[name].errors++;
          const snippet = extractErrorSnippet(msg.content);
          const pattern = normalizeErrorPattern(snippet);
          errorExamples.push({
            toolName: name,
            snippet,
            pattern,
            sessionId,
            messageId: rec.id || rec.uuid || null,
            timestamp: rec.timestamp || null,
          });
        }

        if (msg.details && typeof msg.details.durationMs === 'number') {
          toolStats[name].totalDurationMs += msg.details.durationMs;
        } else if (msg.details && typeof msg.details.wallTimeMs === 'number') {
          toolStats[name].totalDurationMs += Math.round(msg.details.wallTimeMs);
        }
      }
    }

    // --- Claude Code format: type === 'assistant' with tool_use blocks ---
    if (rec.type === 'assistant') {
      messageCount++;
      const msg = rec.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];

      // Claude Code can emit several streamed rows for one request. Keep the
      // latest usage snapshot per message/request id and aggregate after scan.
      if (msg.usage) {
        const requestKey = String(msg.id || rec.requestId || rec.uuid || messageCount);
        claudeRequestUsage.set(requestKey, {
          input: msg.usage.input_tokens || msg.usage.input || 0,
          output: msg.usage.output_tokens || msg.usage.output || 0,
          cacheRead: msg.usage.cache_read_input_tokens || msg.usage.cache_read || 0,
          cacheWrite: msg.usage.cache_creation_input_tokens || msg.usage.cache_write || 0,
        });
      }

      for (const c of content) {
        if (c.type === 'tool_use') {
          toolCallCount++;
          const name = c.name || 'unknown';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
        }
      }
    }

    // --- Claude Code format: type === 'user' with tool_result blocks ---
    if (rec.type === 'user') {
      messageCount++;
      const msg = rec.message || {};
      const content = Array.isArray(msg.content) ? msg.content : [];

      for (const c of content) {
        if (c.type === 'tool_result') {
          toolResultCount++;
          // tool_result blocks don't carry the tool name directly;
          // we use a generic label since we can't easily correlate tool_use id
          const name = 'tool';

          if (c.is_error) {
            errorCount++;
            if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
            toolStats[name].errors++;
            // Extract error text from tool_result content
            let errorText = '';
            if (typeof c.content === 'string') {
              errorText = c.content;
            } else if (Array.isArray(c.content)) {
              errorText = c.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text || '')
                .join(' ');
            }
            const snippet = extractErrorSnippet(errorText);
            const pattern = normalizeErrorPattern(snippet);
            errorExamples.push({
              toolName: name,
              snippet,
              pattern,
              sessionId,
              messageId: rec.uuid || rec.id || null,
              timestamp: rec.timestamp || null,
            });
          }
        }
      }
    }

    // --- Codex usage snapshots: total_token_usage is cumulative for this file.
    // Keep only the latest snapshot; summing snapshots would double count.
    if (rec.type === 'event_msg' && rec.payload?.type === 'token_count') {
      const usage = rec.payload.info?.total_token_usage;
      if (usage && typeof usage === 'object') codexTokenUsage = usage;
    }

    // --- Codex format: type === 'response_item' with payload.type === 'function_call'/'function_call_output' ---
    if (rec.type === 'response_item') {
      const payload = rec.payload || {};
      if (payload.type === 'message') {
        messageCount++;
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        toolCallCount++;
        const name = payload.name || 'unknown';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].calls++;
      }
      if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        toolResultCount++;
        const name = 'tool';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        const output = payload.output;
        let outputText = '';
        let isErr = false;
        if (typeof output === 'string') {
          outputText = output;
          isErr = outputText.includes('Process exited with code') && !outputText.includes('exited with code 0');
        } else if (output && typeof output === 'object') {
          outputText = output.output || JSON.stringify(output);
          if (output.metadata && output.metadata.exit_code !== undefined) {
            isErr = output.metadata.exit_code !== 0;
          }
        }
        if (isErr) {
          errorCount++;
          toolStats[name].errors++;
          const snippet = extractErrorSnippet(outputText);
          const pattern = normalizeErrorPattern(snippet);
          errorExamples.push({
            toolName: name,
            snippet,
            pattern,
            sessionId,
            messageId: rec.id || (rec.payload && rec.payload.id) || null,
            timestamp: rec.timestamp || null,
          });
        }
        if (output && typeof output === 'object' && output.metadata && output.metadata.duration_seconds) {
          toolStats[name].totalDurationMs += Math.round(output.metadata.duration_seconds * 1000);
        }
      }
    }

    // --- Gemini CLI format: type === 'gemini' assistant records with inline toolCalls ---
    // (user records already count as messages via the type === 'user' branch above;
    // their content is a top-level string/Part[], so the claude tool_result loop is a no-op)
    if (rec.type === 'gemini') {
      messageCount++;
      if (!sessionDate && rec.timestamp) sessionDate = rec.timestamp.slice(0, 10);
      if (rec.tokens) {
        totalInputTokens += rec.tokens.input || 0;
        totalOutputTokens += rec.tokens.output || 0;
        totalCacheRead += rec.tokens.cached || 0;
      }
      for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
        toolCallCount++;
        const name = call.name || 'unknown';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].calls++;
        const hasResult = call.result !== undefined && call.result !== null;
        if (hasResult || call.status === 'error' || call.status === 'cancelled') toolResultCount++;
        if (call.status === 'error' || call.status === 'cancelled') {
          errorCount++;
          toolStats[name].errors++;
          const snippet = extractErrorSnippet(
            hasResult ? stringifyGeminiToolResult(call.result) : `Tool call ${call.status}`
          );
          const pattern = normalizeErrorPattern(snippet);
          errorExamples.push({
            toolName: name,
            snippet,
            pattern,
            sessionId,
            messageId: call.id || rec.id || null,
            timestamp: call.timestamp || rec.timestamp || null,
          });
        }
      }
    }

    // --- dsh format: slash-typed session events (user/message, assistant/message, tool/call, tool/result) ---
    if (rec.type === 'user/message' || rec.type === 'assistant/message') {
      messageCount++;
      if (!sessionDate && typeof rec.time === 'number') {
        sessionDate = new Date(rec.time).toISOString().slice(0, 10);
      }
      const usage = (rec.data || {}).usage;
      if (usage) {
        totalInputTokens += usage.inputTokens || 0;
        totalOutputTokens += usage.outputTokens || 0;
        totalCacheRead += usage.cacheReadTokens || 0;
      }
    }
    if (rec.type === 'tool/call') {
      toolCallCount++;
      const data = rec.data || {};
      const name = data.name || 'unknown';
      if (data.callId) dshToolNames.set(data.callId, name);
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls++;
    }
    if (rec.type === 'tool/result') {
      toolResultCount++;
      const data = rec.data || {};
      const message = data.message || {};
      const callId = (message.source && message.source.callId) || null;
      const name = (callId && dshToolNames.get(callId)) || 'tool';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      const blocks = Array.isArray(message.content) ? message.content : [];
      const isErr = Boolean(data.error) || blocks.some((b) => b.type === 'tool-result' && b.isError);
      if (isErr) {
        errorCount++;
        toolStats[name].errors++;
        let errorText = data.error ? `${data.error.name || 'error'}` : '';
        for (const b of blocks) {
          if (b.type === 'tool-result') {
            for (const inner of Array.isArray(b.content) ? b.content : []) {
              if (inner.type === 'text' && inner.text) errorText = errorText || inner.text;
            }
          }
        }
        const snippet = extractErrorSnippet(errorText);
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({
          toolName: name,
          snippet,
          pattern,
          sessionId,
          messageId: message.id || null,
          timestamp: typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null,
        });
      }
    }

    // --- Doubao (豆包) format: role-based OpenAI-style chat records ---
    // { role: "user"|"assistant"|"tool", content: string, tool_calls?: [...] }
    if (rec.role === 'user' || rec.role === 'assistant') {
      messageCount++;
      const text = typeof rec.content === 'string' ? rec.content : '';
      const estTokens = Math.ceil(text.length / 3);
      if (rec.role === 'assistant') {
        totalOutputTokens += estTokens;
      } else {
        totalInputTokens += estTokens;
      }
      if (rec.role === 'assistant' && Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          toolCallCount++;
          const name = (tc.function && tc.function.name) || tc.name || 'unknown';
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
        }
      }
    }
    if (rec.role === 'tool') {
      toolResultCount++;
      const text = typeof rec.content === 'string' ? rec.content : '';
      totalInputTokens += Math.ceil(text.length / 3);
      const isErr = text.includes('Error') || text.includes('error') || text.includes('failed');
      if (isErr) {
        errorCount++;
        const name = 'tool';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].errors++;
        const snippet = extractErrorSnippet(text);
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({
          toolName: name,
          snippet,
          pattern,
          sessionId,
          messageId: rec.id || null,
          timestamp: null,
        });
      }
    }
  }

  if (claudeRequestUsage.size) {
    for (const usage of claudeRequestUsage.values()) {
      totalInputTokens += usage.input;
      totalOutputTokens += usage.output;
      totalCacheRead += usage.cacheRead;
      totalCacheWrite += usage.cacheWrite;
    }
  }

  if (codexTokenUsage) {
    totalInputTokens = codexTokenUsage.input_tokens || 0;
    totalOutputTokens = codexTokenUsage.output_tokens || 0;
    totalCacheRead = codexTokenUsage.cached_input_tokens || 0;
    totalCacheWrite = codexTokenUsage.cache_write_input_tokens || 0;
    totalReasoning = codexTokenUsage.reasoning_output_tokens || 0;
  }

  return {
    messageCount,
    toolCallCount,
    toolResultCount,
    errorCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    totalCacheWrite,
    totalReasoning,
    totalCost,
    sessionDate,
    toolStats,
    errorExamples,
  };
}

module.exports = {
  iterateSessionLines,
  scanFileForInsights,
};
