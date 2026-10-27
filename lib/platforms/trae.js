// Trae (CN) CLI 平台适配器：trae-cli 是 Codex fork，会话 rollout 文件格式与
// ~/.codex/sessions 完全同构（session_meta / response_item / event_msg /
// turn_context，<TRAE_DIR>/<YYYY>/<MM>/<DD>/rollout-*.jsonl）。
//
// 与 Codex 适配器的关键差异：本机观察到的 trae-cli 版本（0.202.x-tob）把对话
// 活动写在 event_msg 流里（user_message / agent_message /
// agent_reasoning_raw_content / item_completed / token_count），小会话可能完全没有
// response_item。因此本适配器在 codex 的 response_item 解析之外，把 event_msg
// 也归一化为消息（normalizeTraeRecord），否则 deriveState 拿不到任何消息、宠物永远 idle。
//
// 注意：Trae CN **IDE** 的 AI 会话库是加密 DB（ModularData/ai-agent/database.db，
// 非 SQLite 明文），不在本平台监控范围；这里只覆盖 trae CLI（`trae` 命令 /
// IDE 内嵌 CLI 共用的 ~/.trae/cli/sessions）。
//
// 复用面：entry 枚举/查找直接复用 codex.js 的 collectCodexSessionEntries /
// findCodexSessionFile（都接受 baseDir）；归一化与解析独立实现以覆盖 event_msg。

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { TRAE_DIR } = require('../config');
const {
  collectCodexSessionEntries,
  findCodexSessionFile,
  normalizeCodexRecord,
  normalizeCodexTokenUsage,
  codexSessionIdFromFile,
} = require('./codex');
const {
  withMetadataCache,
  withInFlightDedup,
  makeMessage,
  sortSessionsByTimestampDesc,
  topToolsOf,
} = require('./shared');

// event_msg 归一化：把 trae-cli 的实时事件流映射为标准消息。
function normalizeTraeEventRecord(rec) {
  if (rec?.type !== 'event_msg') return null;
  const payload = rec.payload || {};
  const timestamp = rec.timestamp || null;

  if (payload.type === 'user_message') {
    const text = typeof payload.message === 'string' ? payload.message : '';
    if (!text.trim()) return null;
    return makeMessage({
      id: null,
      timestamp,
      role: 'user',
      content: [{ type: 'text', text }],
    });
  }

  if (payload.type === 'agent_message') {
    const text = typeof payload.message === 'string' ? payload.message : '';
    if (!text.trim()) return null;
    return makeMessage({
      id: null,
      timestamp,
      role: 'assistant',
      content: [{ type: 'text', text }],
    });
  }

  if (payload.type === 'agent_reasoning_raw_content' || payload.type === 'agent_reasoning_section_break') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) return null;
    return makeMessage({
      timestamp,
      role: 'reasoning',
      content: [{ type: 'text', text }],
    });
  }

  // item_completed 的 item 可能带工具调用/结果（UserMessage/AgentMessage 已被
  // 上面的 user_message/agent_message 事件覆盖，跳过避免重复计数）。
  if (payload.type === 'item_completed' || payload.type === 'item_started') {
    const item = payload.item || {};
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      return makeMessage({
        id: item.call_id || item.id || null,
        timestamp,
        role: 'toolCall',
        toolCallId: item.call_id || item.id || null,
        toolName: item.name || 'unknown',
        details: item.arguments ?? item.input ?? null,
      });
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const output = item.output;
      const outputText = typeof output === 'string' ? output : output ? JSON.stringify(output) : '';
      return makeMessage({
        id: item.call_id || item.id || null,
        timestamp,
        role: 'toolResult',
        content: [{ type: 'text', text: outputText }],
        toolCallId: item.call_id || item.id || null,
        isError: false,
      });
    }
  }

  return null;
}

// watch 尾随 / 单条记录归一化：response_item 走 codex 归一化，event_msg 走 trae 映射。
function normalizeTraeRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.type === 'response_item') return normalizeCodexRecord(rec);
  if (rec.type === 'event_msg') return normalizeTraeEventRecord(rec);
  return null;
}

function modelFromTraeRecord(rec) {
  const payload = rec?.payload || {};
  if (rec?.type === 'turn_context') return payload.model || null;
  if (rec?.type === 'session_meta') return payload.model_catalog_snapshot?.default_model || null;
  return null;
}

const parseTraeSessionMetadata = withMetadataCache(_parseTraeSessionMetadataRaw);

async function _parseTraeSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionMeta = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
  const userPromptTexts = [];
  let activeModel = null;
  const models = [];
  const toolNames = {};
  let tokenUsage = null;

  const countMessage = (msg) => {
    if (!msg) return;
    messageCount++;
    if (msg.role === 'user') {
      userCount++;
      const text = (msg.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '')
        .join(' ')
        .trim();
      if (text && !firstUserMessage) firstUserMessage = text.slice(0, 120);
      if (text) userPromptTexts.push(text);
    } else if (msg.role === 'assistant') {
      assistantCount++;
    } else if (msg.role === 'toolCall') {
      toolCallCount++;
      const name = msg.toolName || 'unknown';
      toolNames[name] = (toolNames[name] || 0) + 1;
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
    }
  };

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const nextModel = modelFromTraeRecord(rec);
      if (nextModel) {
        activeModel = nextModel;
        if (!models.includes(nextModel)) models.push(nextModel);
      }

      if (rec.type === 'session_meta' && !sessionMeta) {
        const p = rec.payload || {};
        sessionMeta = {
          id: p.id || codexSessionIdFromFile(fileName),
          timestamp: p.timestamp || null,
          cwd: p.cwd || null,
          provider: p.model_provider || null,
          originator: p.originator || null,
          parentThreadId: p.parent_thread_id || null,
        };
      }

      if (rec.timestamp) lastTimestamp = rec.timestamp;

      if (rec.type === 'response_item') {
        countMessage(normalizeCodexRecord(rec));
      } else if (rec.type === 'event_msg') {
        const payload = rec.payload || {};
        if (payload.type === 'token_count' && payload.info) {
          tokenUsage = normalizeCodexTokenUsage(payload.info.total_token_usage, payload.info.model_context_window);
        }
        // user_message 事件可能带真实 prompt；agent_message 是最终回答。
        if (payload.type === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
          userPromptTexts.push(payload.message.trim());
          if (!firstUserMessage) firstUserMessage = payload.message.trim().slice(0, 120);
        }
        countMessage(normalizeTraeEventRecord(rec));
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = topToolsOf(toolNames);
  const bestTitle = userPromptTexts.length > 0 ? userPromptTexts[0].slice(0, 120) : null;

  return {
    id: sessionMeta?.id || codexSessionIdFromFile(fileName),
    timestamp: sessionMeta?.timestamp || null,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    bestTitle,
    cwd: sessionMeta?.cwd || null,
    model: activeModel,
    models,
    provider: sessionMeta?.provider || null,
    file: fileName,
    parentThreadId: sessionMeta?.parentThreadId || null,
    tokenUsage,
  };
}

async function _parseTraeSessionFileRaw(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  let activeModel = null;
  let tokenUsage = null;
  const models = [];
  const messages = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const nextModel = modelFromTraeRecord(rec);
      if (nextModel) {
        activeModel = nextModel;
        if (!models.includes(nextModel)) models.push(nextModel);
      }

      if (rec.type === 'session_meta') {
        const p = rec.payload || {};
        session = {
          id: p.id || codexSessionIdFromFile(path.basename(filePath)),
          cwd: p.cwd || null,
          timestamp: p.timestamp || null,
          version: p.cli_version || null,
          provider: p.model_provider || null,
          originator: p.originator || null,
          model: activeModel,
          filePath,
          archived: false,
        };
      } else if (rec.type === 'event_msg' && rec.payload?.type === 'token_count' && rec.payload?.info) {
        tokenUsage = normalizeCodexTokenUsage(
          rec.payload.info.total_token_usage,
          rec.payload.info.model_context_window
        );
      } else {
        const msg = normalizeTraeRecord(rec);
        if (msg) messages.push(msg);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (session) {
    session.model = activeModel || session.model || null;
    session.models = models;
    session.tokenUsage = tokenUsage;
  }
  return { session, messages, tokenUsage };
}

const parseTraeSessionFile = withInFlightDedup((filePath) => filePath, _parseTraeSessionFileRaw);

async function listTraeSessions(dir) {
  const baseDir = dir || TRAE_DIR;
  const entries = await collectCodexSessionEntries(baseDir, { includeChildren: true });
  const sessions = await Promise.all(
    entries.map(async (entry) => {
      const meta = await parseTraeSessionMetadata(entry.filePath, entry.fileName);
      return {
        ...meta,
        title: meta.bestTitle || null,
        archived: entry.archived,
        filePath: entry.filePath,
        lastActivity: meta.lastActivity || meta.timestamp || null,
        childCount: 0,
      };
    })
  );
  return sortSessionsByTimestampDesc(sessions);
}

async function findTraeSessionFile(dir, sessionId) {
  return findCodexSessionFile(dir || TRAE_DIR, sessionId);
}

async function getTraeSession(dir, sessionId) {
  const filePath = await findCodexSessionFile(dir || TRAE_DIR, sessionId);
  if (!filePath) return null;
  const payload = await parseTraeSessionFile(filePath);
  if (payload.session) payload.session.filePath = filePath;
  return payload;
}

module.exports = {
  listTraeSessions,
  findTraeSessionFile,
  getTraeSession,
  parseTraeSessionFile,
  parseTraeSessionMetadata,
  normalizeTraeRecord,
  normalizeTraeEventRecord,
};
