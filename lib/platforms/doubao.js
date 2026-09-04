const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { DOUBAO_DIR, isArchivedFile, ensureDirectory } = require('../config');
const { withMetadataCache, sortSessionsByTimestampDesc, topToolsOf, makeMessage } = require('./shared');

// --- Doubao (豆包) agent session adapter ---
// Session layout:
//   <DOUBAO_DIR>/<sessionId>/agents/<agentId>/system/trajectory.jsonl
// Each line is an OpenAI-style chat record:
//   { role: "user"|"assistant"|"tool", content: string, tool_calls?: [...] }

function stripDoubaoNoise(text) {
  if (!text) return '';
  // Remove <system-reminder>...</system-reminder> blocks (injected context, not user input)
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  // Remove leading/trailing whitespace
  return cleaned.trim();
}

function extractFirstUserMessage(content) {
  if (typeof content !== 'string') return null;
  const cleaned = stripDoubaoNoise(content);
  if (!cleaned) return null;
  // Take first line, truncated
  const firstLine = cleaned.split('\n').find((l) => l.trim());
  return firstLine ? firstLine.trim().slice(0, 120) : cleaned.slice(0, 120);
}

// Find the main agent's trajectory.jsonl inside a session directory.
// A session may have multiple agents (main + subagents); we pick the first
// agent directory that contains a trajectory.jsonl.
async function findTrajectoryInSession(sessionDir) {
  const agentsDir = path.join(sessionDir, 'agents');
  let entries;
  try {
    entries = await fsp.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const agentDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  for (const agentId of agentDirs) {
    const traj = path.join(agentsDir, agentId, 'system', 'trajectory.jsonl');
    try {
      await fsp.access(traj);
      return traj;
    } catch {
      // try next agent
    }
  }
  return null;
}

const parseSessionMetadata = withMetadataCache(_parseSessionMetadataRaw);

async function _parseSessionMetadataRaw(filePath, sessionId) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let firstUserMessage = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  const toolNames = {};

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const role = record.role;
      if (!role) continue;

      messageCount++;

      // Timestamps: Doubao trajectory doesn't carry per-message timestamps in
      // the record itself. We infer from file mtime for start/end.
      if (record.timestamp) {
        if (!firstTimestamp) firstTimestamp = record.timestamp;
        lastTimestamp = record.timestamp;
      }

      if (role === 'user') {
        userCount++;
        if (!firstUserMessage) {
          const msg = extractFirstUserMessage(record.content);
          if (msg) firstUserMessage = msg;
        }
      } else if (role === 'assistant') {
        assistantCount++;
        const toolCalls = record.tool_calls || [];
        for (const tc of toolCalls) {
          toolCallCount++;
          const name = tc.function?.name || tc.name || 'unknown';
          toolNames[name] = (toolNames[name] || 0) + 1;
        }
      } else if (role === 'tool') {
        toolResultCount++;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Fallback timestamps from file mtime
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    stat = null;
  }
  const fileMtime = stat ? stat.mtime.toISOString() : null;
  if (!firstTimestamp) firstTimestamp = fileMtime;
  if (!lastTimestamp) lastTimestamp = fileMtime;

  return {
    id: sessionId,
    timestamp: firstTimestamp,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    spawnCount: 0,
    topTools: topToolsOf(toolNames),
    model: null,
    firstUserMessage: firstUserMessage || null,
    status: 'active',
    file: path.basename(filePath),
  };
}

async function listDoubaoSessions(baseDir) {
  const dir = baseDir || DOUBAO_DIR;
  await ensureDirectory(dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  const sessions = [];
  for (const sessionId of sessionDirs) {
    const sessionDir = path.join(dir, sessionId);
    const trajPath = await findTrajectoryInSession(sessionDir);
    if (!trajPath) continue;
    const meta = await parseSessionMetadata(trajPath, sessionId);
    sessions.push(meta);
  }

  return sortSessionsByTimestampDesc(sessions);
}

async function findDoubaoSessionFile(baseDir, sessionId) {
  const dir = baseDir || DOUBAO_DIR;
  const sessionDir = path.join(dir, sessionId);
  try {
    await fsp.access(sessionDir);
  } catch {
    return null;
  }
  return findTrajectoryInSession(sessionDir);
}

function normalizeDoubaoRecord(record) {
  const role = record.role;
  if (!role) return null;

  const content = [];

  // Text content
  if (typeof record.content === 'string' && record.content) {
    content.push({ type: 'text', text: record.content });
  } else if (Array.isArray(record.content)) {
    for (const c of record.content) {
      if (c.type === 'text' && c.text) {
        content.push({ type: 'text', text: c.text });
      }
    }
  }

  // Tool calls (assistant messages)
  if (role === 'assistant' && Array.isArray(record.tool_calls)) {
    for (const tc of record.tool_calls) {
      const fn = tc.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          // keep as string
        }
      }
      content.push({
        type: 'toolCall',
        id: tc.id || null,
        name: fn.name || tc.name || 'unknown',
        arguments: args || {},
      });
    }
  }

  // Tool results map to toolResult role
  const normalizedRole = role === 'tool' ? 'toolResult' : role;

  return makeMessage({
    id: record.id || null,
    timestamp: record.timestamp || null,
    role: normalizedRole,
    content,
    toolCallId: record.tool_call_id || null,
    toolName: role === 'tool' ? (record.name || null) : null,
    isError: Boolean(record.is_error || record.isError),
  });
}

// Estimate token count from text character length.
// Chinese ~1.5 chars/token, English ~4 chars/token; use /3 as a reasonable blend.
function estimateTokens(charCount) {
  if (!charCount || typeof charCount !== 'number') return 0;
  return Math.ceil(charCount / 3);
}

function messageTextLength(msg) {
  if (!msg || !Array.isArray(msg.content)) return 0;
  return msg.content.reduce((sum, c) => sum + (c.type === 'text' && c.text ? c.text.length : 0), 0);
}

async function parseDoubaoSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const rawMessages = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const normalized = normalizeDoubaoRecord(record);
      if (normalized) rawMessages.push(normalized);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Session metadata: derive from file
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    stat = null;
  }

  // Assign synthetic timestamps: Doubao trajectory has no per-message timestamps.
  // Base on file mtime, spread messages evenly across the file's lifetime.
  const baseTime = stat ? stat.mtime.getTime() : Date.now();
  const count = rawMessages.length;
  const messages = rawMessages.map((msg, idx) => {
    // 1ms per message, anchored so the last message is at file mtime
    const ts = new Date(baseTime - (count - 1 - idx)).toISOString();
    const textLen = messageTextLength(msg);
    const tokens = estimateTokens(textLen);
    const usage =
      msg.role === 'assistant'
        ? { output: tokens, input: 0, totalTokens: tokens }
        : { input: tokens, output: 0, totalTokens: tokens };
    return { ...msg, timestamp: ts, usage };
  });

  // Extract sessionId from path: .../.sessions/<sessionId>/agents/<agentId>/system/trajectory.jsonl
  const parts = filePath.split(path.sep);
  const sessionsIdx = parts.lastIndexOf('.sessions');
  const sessionId = sessionsIdx >= 0 && sessionsIdx + 1 < parts.length ? parts[sessionsIdx + 1] : null;

  const firstTimestamp = messages.length > 0 ? messages[0].timestamp : null;

  const session = {
    id: sessionId,
    cwd: null,
    timestamp: firstTimestamp || (stat ? stat.mtime.toISOString() : null),
    version: null,
  };

  return { session, messages };
}

module.exports = {
  stripDoubaoNoise,
  extractFirstUserMessage,
  parseSessionMetadata,
  listDoubaoSessions,
  findDoubaoSessionFile,
  normalizeDoubaoRecord,
  parseDoubaoSessionFile,
};
