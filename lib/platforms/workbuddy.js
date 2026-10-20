// WorkBuddy (腾讯 WorkBuddy) 平台适配器。
//
// 会话记录是 JSONL，布局与 Claude Code 同构：
//   <dir>/<project-slug>/<sessionId>.jsonl            主会话
//   <dir>/<project-slug>/<sessionId>/subagents/*.jsonl 子代理
//   <dir>/<project-slug>/<sessionId>.file-rollback.ndjson（非会话，跳过）
//
// 记录类型（epoch 毫秒时间戳，归一化时统一转 ISO 字符串——deriveState 只认
// Date.parse 可解析的字符串）：
//   session-meta        {sessionId, timestamp}          会话头（tail 时可当 session 帧）
//   message             {role: user|assistant, content:[{type:input_text|output_text,text}], status}
//   reasoning           {content/rawContent:[{type:reasoning_text,text}]}
//   function_call       {callId, name, arguments(JSON 字符串)}
//   function_call_result{callId, name, status, output:{type:text,text}}
//   ai-title            {aiTitle}                       会话标题（列表展示优先用它）
//   file-history-snapshot / credit-usage / resend-fork-notice  → 忽略

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { WORKBUDDY_DIR, resolveDir } = require('../config');
const {
  withMetadataCache,
  withInFlightDedup,
  makeMessage,
  sortSessionsByTimestampDesc,
  topToolsOf,
} = require('./shared');

function parseWorkbuddySessionIdFromFileName(fileName) {
  return fileName.replace(/\.jsonl$/, '');
}

// WorkBuddy 记录时间戳是 epoch 毫秒数字；deriveState / 列表排序都吃 ISO 字符串。
function msToIso(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  if (typeof ts === 'string' && Number.isFinite(Date.parse(ts))) return ts;
  return null;
}

// content 既可能是块数组（input_text / output_text / text），也可能是纯字符串。
function textFromWorkbuddyContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim();
}

function safeParseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { raw };
  } catch {
    return { raw };
  }
}

/** 记录 → 归一化消息（makeMessage 形状）；非消息类记录返回 null。 */
function normalizeWorkbuddyRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const base = { id: rec.id || null, timestamp: msToIso(rec.timestamp) };

  if (rec.type === 'message') {
    const text = textFromWorkbuddyContent(rec.content);
    if (rec.role === 'user') {
      return makeMessage({ ...base, role: 'user', content: [{ type: 'text', text }] });
    }
    if (rec.role === 'assistant') {
      return makeMessage({
        ...base,
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: rec.providerData?.model || null,
      });
    }
    return null;
  }

  if (rec.type === 'function_call') {
    return makeMessage({
      ...base,
      role: 'toolCall',
      toolCallId: rec.callId || null,
      toolName: rec.name || 'tool',
      content: [
        {
          type: 'toolCall',
          id: rec.callId || null,
          name: rec.name || 'tool',
          arguments: safeParseArguments(rec.arguments),
        },
      ],
    });
  }

  if (rec.type === 'function_call_result') {
    return makeMessage({
      ...base,
      role: 'toolResult',
      toolCallId: rec.callId || null,
      toolName: rec.name || null,
      isError: typeof rec.status === 'string' && rec.status !== 'completed',
      content: [{ type: 'text', text: rec.output?.text || '' }],
    });
  }

  if (rec.type === 'reasoning') {
    const blocks = Array.isArray(rec.content) ? rec.content : Array.isArray(rec.rawContent) ? rec.rawContent : [];
    const text = blocks
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .join('')
      .trim();
    return makeMessage({ ...base, role: 'reasoning', content: text ? [{ type: 'text', text }] : [] });
  }

  return null;
}

// ---- 元数据（列表用）：mtime 缓存兜底 ----
const parseWorkbuddySessionMetadata = withMetadataCache(_parseWorkbuddySessionMetadataRaw);

async function _parseWorkbuddySessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = null;
  let sessionCwd = null;
  let sessionModel = null;
  let aiTitle = null;
  let firstUserMessage = null;
  let firstTimestampMs = null;
  let lastTimestampMs = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
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
      if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
      if (!sessionCwd && rec.cwd) sessionCwd = rec.cwd;
      if (!sessionModel && rec.providerData?.model) sessionModel = rec.providerData.model;
      if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;

      const msg = normalizeWorkbuddyRecord(rec);
      if (!msg) continue;
      messageCount++;
      if (msg.role === 'user') {
        userCount++;
        if (!firstUserMessage) {
          const text = (msg.content || [])
            .map((b) => b.text || '')
            .join('')
            .trim();
          if (text) firstUserMessage = text.slice(0, 120);
        }
      } else if (msg.role === 'assistant') {
        assistantCount++;
      } else if (msg.role === 'toolCall') {
        toolCallCount++;
        const name = msg.toolName || 'unknown';
        toolNames[name] = (toolNames[name] || 0) + 1;
      }
      const ms = typeof rec.timestamp === 'number' ? rec.timestamp : Date.parse(rec.timestamp || '') || null;
      if (Number.isFinite(ms)) {
        if (firstTimestampMs === null || ms < firstTimestampMs) firstTimestampMs = ms;
        if (lastTimestampMs === null || ms > lastTimestampMs) lastTimestampMs = ms;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    id: sessionId || parseWorkbuddySessionIdFromFileName(fileName),
    timestamp: msToIso(firstTimestampMs),
    lastActivity: msToIso(lastTimestampMs),
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    topTools: topToolsOf(toolNames),
    firstUserMessage: firstUserMessage || null,
    title: aiTitle || firstUserMessage || null,
    cwd: sessionCwd,
    model: sessionModel,
    file: fileName,
  };
}

async function listWorkbuddyProjects(baseDir) {
  const dir = resolveDir(baseDir, WORKBUDDY_DIR);
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function listWorkbuddySessions(baseDir) {
  const dir = resolveDir(baseDir, WORKBUDDY_DIR);
  const sessions = [];
  for (const project of await listWorkbuddyProjects(dir)) {
    const dirPath = path.join(dir, project);
    const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        sessions.push(parseWorkbuddySessionMetadata(path.join(dirPath, f.name), f.name));
      }
    }
  }
  return sortSessionsByTimestampDesc(await Promise.all(sessions));
}

async function findWorkbuddySessionFile(baseDir, sessionId) {
  const dir = resolveDir(baseDir, WORKBUDDY_DIR);
  for (const project of await listWorkbuddyProjects(dir)) {
    const dirPath = path.join(dir, project);
    const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base === sessionId || base.endsWith(sessionId)) return path.join(dirPath, f.name);
    }
    // 子代理：<sessionId>/subagents/agent-*.jsonl
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(dirPath, e.name, 'subagents');
      const subFiles = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
      for (const f of subFiles) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const base = f.name.replace(/\.jsonl$/, '');
        if (base === sessionId || base.endsWith(sessionId)) return path.join(subDir, f.name);
      }
    }
  }
  return null;
}

async function _parseWorkbuddySessionFileRaw(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
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
      if (!session && rec.sessionId) {
        session = { id: rec.sessionId, cwd: rec.cwd || null, timestamp: null, version: null };
      }
      if (session && !session.cwd && rec.cwd) session.cwd = rec.cwd;
      if (session && !session.timestamp && rec.type === 'message') {
        session.timestamp = msToIso(rec.timestamp);
      }
      if (session && !session.model && rec.providerData?.model) session.model = rec.providerData.model;
      if (rec.type === 'ai-title' && rec.aiTitle) {
        session = session || { id: null, cwd: null, timestamp: null, version: null };
        session.title = rec.aiTitle;
      }
      const msg = normalizeWorkbuddyRecord(rec);
      if (msg) messages.push(msg);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (session) session.sourcePath = filePath;
  return { session, messages };
}

const parseWorkbuddySessionFile = withInFlightDedup((filePath) => filePath, _parseWorkbuddySessionFileRaw);

async function getWorkbuddySession(dir, sessionId) {
  const filePath = await findWorkbuddySessionFile(dir, sessionId);
  return filePath ? parseWorkbuddySessionFile(filePath) : null;
}

async function collectWorkbuddyFiles(dir) {
  const files = [];
  for (const project of await listWorkbuddyProjects(dir)) {
    const dirPath = path.join(dir, project);
    const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of entries) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        files.push({
          path: path.join(dirPath, f.name),
          file: f.name,
          sessionId: parseWorkbuddySessionIdFromFileName(f.name),
          project,
        });
      } else if (f.isDirectory()) {
        const subDir = path.join(dirPath, f.name, 'subagents');
        const subFiles = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
        for (const s of subFiles) {
          if (s.isFile() && s.name.endsWith('.jsonl')) {
            files.push({
              path: path.join(subDir, s.name),
              file: s.name,
              sessionId: parseWorkbuddySessionIdFromFileName(s.name),
              project,
            });
          }
        }
      }
    }
  }
  return files;
}

// watch SSE 的 tail 行处理：会话头当 session 帧，其余走统一归一化。
function watchParseWorkbuddyRecord(rec) {
  if (rec && rec.type === 'session-meta') {
    return { session: { id: rec.sessionId || null, cwd: rec.cwd || null, timestamp: msToIso(rec.timestamp) } };
  }
  const normalized = normalizeWorkbuddyRecord(rec);
  return normalized ? { messages: [normalized] } : null;
}

module.exports = {
  msToIso,
  normalizeWorkbuddyRecord,
  parseWorkbuddySessionIdFromFileName,
  parseWorkbuddySessionMetadata,
  listWorkbuddyProjects,
  listWorkbuddySessions,
  findWorkbuddySessionFile,
  parseWorkbuddySessionFile,
  getWorkbuddySession,
  collectWorkbuddyFiles,
  watchParseWorkbuddyRecord,
};
