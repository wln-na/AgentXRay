// --- Context reconstruction (path 2: log-based) ---
// Reconstructs the full context a model likely saw before generating a reply,
// by combining the message history with platform-specific system-level context.
//
// Design principles:
//   - Transparent about gaps: built-in system prompts that cannot be recovered
//     from logs are explicitly marked as missing, never silently omitted.
//   - System prompt is decomposed into labeled components, each with its source.
//   - Message history is not re-displayed (it's already visible in the main
//     stream); only a summary count is included.
//
// Platform support is added via build*Context functions in lib/platforms/*.
// This module provides the shared entry point + common helpers.

const { getCodexSession, modelFromCodexRecord, normalizeCodexRecord } = require('./platforms/codex');

// Supported platform → builder mapping. New platforms register here.
const BUILDERS = {
  codex: buildCodexContext,
};

/**
 * Reconstruct context for a given platform + session + target message.
 *
 * @param {string} platform - platform key (e.g. 'codex')
 * @param {string} dir - resolved log directory for this platform
 * @param {string} sessionId
 * @param {{messageIndex?: number, messageId?: string}} target
 * @returns {Promise<ContextSnapshot>}
 */
async function reconstructContext(platform, dir, sessionId, target = {}) {
  const builder = BUILDERS[platform];
  if (!builder) {
    const err = new Error(`Context reconstruction not supported for platform: ${platform}`);
    err.code = 'UNSUPPORTED_PLATFORM';
    throw err;
  }
  return builder(dir, sessionId, target);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Locate the target user message in a normalized message array and slice
 * the messages that came before it.
 *
 * @param {Array} messages - normalized SessionMessage[]
 * @param {{messageIndex?: number, messageId?: string}} target
 * @returns {{targetIndex: number, targetMessage: object, priorMessages: Array}}
 */
function sliceMessagesBeforeTarget(messages, target = {}) {
  let targetIndex = target.messageIndex;

  if (target.messageId) {
    const idx = messages.findIndex((m) => m.id === target.messageId && m.role === 'user');
    if (idx >= 0) targetIndex = idx;
  }

  if (typeof targetIndex !== 'number' || !Number.isFinite(targetIndex) || targetIndex < 0) {
    const err = new Error('Target message not found: provide a valid messageIndex or messageId');
    err.code = 'TARGET_NOT_FOUND';
    throw err;
  }

  // If the index points to a non-user message, walk backwards to find the
  // nearest preceding user message (context is anchored to user turns).
  let anchor = targetIndex;
  while (anchor > 0 && messages[anchor]?.role !== 'user') anchor--;
  if (messages[anchor]?.role !== 'user') {
    const err = new Error('No user message found at or before the target index');
    err.code = 'TARGET_NOT_FOUND';
    throw err;
  }

  return {
    targetIndex: anchor,
    targetMessage: messages[anchor],
    priorMessages: messages.slice(0, anchor),
  };
}

/**
 * Build the metadata block that every ContextSnapshot carries.
 */
function buildMetadata(platform, confidence, sources, missingItems) {
  return {
    confidence,
    reconstructedAt: new Date().toISOString(),
    sources,
    missingItems,
    note: '基于日志重建，可能与模型实际收到的请求有差异',
    platform,
  };
}

/**
 * Summarize a message array into counts (for the lightweight history block).
 */
function summarizeMessages(messages) {
  const counts = { user: 0, assistant: 0, toolCall: 0, toolResult: 0, reasoning: 0, other: 0 };
  for (const m of messages) {
    const role = m.role || 'other';
    if (role in counts) counts[role]++;
    else counts.other++;
  }
  // A "turn" ≈ one user message; tool calls/results belong to a turn.
  const turns = counts.user;
  return { total: messages.length, turns, ...counts };
}

// ---------------------------------------------------------------------------
// Codex builder
// ---------------------------------------------------------------------------

/**
 * Codex context reconstruction.
 *
 * System prompt components (in order):
 *   1. Built-in provider system prompt — NOT recoverable from logs (marked missing)
 *   2. <environment_context> synthetic user message — from session start
 *   3. <user_instructions> synthetic user message — from session start
 *   4. base_instructions from session_meta — if present
 *
 * Message history: all normalized messages before the target user turn.
 * Confidence: medium (missing built-in system prompt + tool definitions).
 */
async function buildCodexContext(dir, sessionId, target) {
  const { session, messages } = await getCodexSession(dir, sessionId);
  if (!session) {
    const err = new Error(`Codex session not found: ${sessionId}`);
    err.code = 'SESSION_NOT_FOUND';
    throw err;
  }

  const { targetIndex, targetMessage, priorMessages } = sliceMessagesBeforeTarget(messages, target);

  // Second pass over the raw JSONL to extract system-level context and apply
  // Codex compaction boundaries. A compacted record replaces all earlier
  // history with replacement_history; later response items are appended.
  const rawContext = await extractCodexRequestContext(session.filePath, targetMessage.timestamp);
  const effectiveHistory = rawContext.compaction
    ? [...rawContext.compaction.replacementHistory, ...rawContext.messagesAfterCompaction]
    : priorMessages;
  const systemComponents = rawContext.systemComponents;

  // Built-in system prompt is always missing for Codex (provider-injected).
  const components = [
    {
      type: 'builtin',
      label: '平台内置系统提示词',
      present: false,
      content: null,
      source: null,
      note: '由 LLM provider 在请求时注入，无法从本地日志获取',
    },
    ...systemComponents,
  ];

  // Assemble the full system prompt text (missing parts get a placeholder line).
  const contentParts = components.map((c) => {
    if (c.present && c.content) return `# ${c.label}\n${c.content}`;
    return `# ${c.label}\n[无法从日志获取]`;
  });
  const fullSystemPrompt = contentParts.join('\n\n---\n\n');

  const historySummary = summarizeMessages(effectiveHistory);

  return {
    platform: 'codex',
    sessionId,
    messageIndex: targetIndex,
    targetMessageId: targetMessage.id || null,
    systemPrompt: {
      source: 'reconstructed',
      content: fullSystemPrompt,
      components,
    },
    messages: {
      summary: historySummary,
      included: true,
      items: effectiveHistory,
      target: targetMessage,
      compaction: rawContext.compaction
        ? {
            applied: true,
            timestamp: rawContext.compaction.timestamp,
            source: 'compacted.payload.replacement_history',
          }
        : null,
    },
    tools: {
      available: false,
      count: 0,
      source: null,
      definitions: null,
    },
    metadata: buildMetadata(
      'codex',
      'medium',
      rawContext.compaction
        ? ['主日志消息链 (response_item)', 'Codex 压缩替代历史 (replacement_history)', 'session_meta']
        : [
            '主日志消息链 (response_item)',
            'session_meta',
            '<environment_context> 合成消息',
            '<user_instructions> 合成消息',
          ],
      ['平台内置 system prompt (provider 注入)', '工具定义 (tool definitions)']
    ),
  };
}

/**
 * Second-pass raw JSONL scanner for Codex system-level context.
 * Extracts:
 *   - <environment_context> synthetic messages (full text)
 *   - <user_instructions> synthetic messages (full text)
 *   - session_meta.payload.base_instructions (if present)
 */
async function extractCodexRequestContext(filePath, targetTimestamp) {
  const fs = require('node:fs');
  const readline = require('node:readline');

  const components = [];
  let envContextText = '';
  let userInstructionsText = '';
  let baseInstructions = null;
  let activeModel = null;
  let provider = null;
  let compaction = null;
  let messagesAfterCompaction = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (targetTimestamp && rec.timestamp && Date.parse(rec.timestamp) >= Date.parse(targetTimestamp)) break;

      const nextModel = modelFromCodexRecord(rec);
      if (nextModel) activeModel = nextModel;
      if (rec.type === 'session_meta') {
        provider = rec.payload?.model_provider || provider;
        baseInstructions = rec.payload?.base_instructions ?? baseInstructions;
      }

      if (rec.type === 'compacted' && Array.isArray(rec.payload?.replacement_history)) {
        const replacementHistory = rec.payload.replacement_history
          .map((payload) =>
            normalizeCodexRecord({ timestamp: rec.timestamp, payload }, { model: activeModel, provider })
          )
          .filter(Boolean);
        compaction = { timestamp: rec.timestamp || null, replacementHistory };
        messagesAfterCompaction = [];
        continue;
      }

      if (rec.type === 'response_item' && compaction) {
        const message = normalizeCodexRecord(rec, { model: activeModel, provider });
        if (message) messagesAfterCompaction.push(message);
      }

      if (rec.type === 'response_item' && rec.payload?.type === 'message' && rec.payload?.role === 'user') {
        const content = Array.isArray(rec.payload.content) ? rec.payload.content : [];
        const text = content
          .filter((c) => c.type === 'input_text' || c.type === 'text')
          .map((c) => c.text || '')
          .join('\n')
          .trim();

        if (text.startsWith('<environment_context>')) envContextText = text;
        else if (text.startsWith('<user_instructions>')) userInstructionsText = text;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (envContextText) {
    components.push({
      type: 'environment',
      label: '环境上下文 (<environment_context>)',
      present: true,
      content: envContextText,
      source: 'session 起始合成消息 (response_item/user)',
      note: null,
    });
  }

  if (userInstructionsText) {
    components.push({
      type: 'user-instructions',
      label: '用户指令 (<user_instructions>)',
      present: true,
      content: userInstructionsText,
      source: 'session 起始合成消息 (response_item/user)',
      note: null,
    });
  }

  if (baseInstructions) {
    components.push({
      type: 'base-instructions',
      label: '基础指令 (base_instructions)',
      present: true,
      content: typeof baseInstructions === 'string' ? baseInstructions : JSON.stringify(baseInstructions, null, 2),
      source: 'session_meta.payload.base_instructions',
      note: null,
    });
  }

  return { systemComponents: components, compaction, messagesAfterCompaction };
}

/**
 * Backward-compatible system component extractor used by tests and callers.
 */
async function extractCodexSystemComponents(filePath) {
  return (await extractCodexRequestContext(filePath)).systemComponents;
}

module.exports = {
  reconstructContext,
  sliceMessagesBeforeTarget,
  buildMetadata,
  summarizeMessages,
  // Exported for testing
  extractCodexSystemComponents,
  extractCodexRequestContext,
};
