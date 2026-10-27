// Cursor (the AI IDE / Agent) session adapter. Cursor keeps readable agent
// transcripts as JSONL under ~/.cursor/projects:
//
//   <CURSOR_DIR>/<project-slug>/agent-transcripts/<session-uuid>/<session-uuid>.jsonl
//
// Records are one JSON object per line:
//   {"role":"user"|"assistant","message":{"content":[block,…]}}
//   {"type":"turn_ended","status":…}
// with blocks {"type":"text","text":…} and {"type":"tool_use","name":…,"input":{…}}.
// The human query is wrapped in <user_query>…</user_query> (surrounding text is
// harness-injected context); transcripts contain tool *calls* but never tool
// *results*; records carry no timestamps, so mtime stands in for activity.
// Subagent transcripts live in <session-uuid>/subagents/*.jsonl and are
// deliberately excluded (they can outnumber main transcripts ~5:1 and may
// reuse the parent id — the transcript path is the identity, not the id).
// Format observed July 2026 (CursorDump / Agent Sessions, see README).
//
// Tolerant parse: torn trailing lines, malformed JSON and unknown record
// types are skipped, never fatal (transcripts are actively appended).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { CURSOR_DIR } = require('../config');
const {
  withMetadataCache,
  withInFlightDedup,
  makeMessage,
  sortSessionsByTimestampDesc,
  topToolsOf,
} = require('./shared');

function cursorSessionIdFromFile(fileName) {
  return fileName.replace(/\.jsonl$/, '');
}

/**
 * Extract the human query from a Cursor user record. The query text is wrapped
 * in <user_query>…</user_query>; anything outside it is harness-injected
 * context (attached files, rules, timestamps, subagent notifications).
 */
function extractCursorUserQuery(text) {
  if (!text) return null;
  const match = String(text).match(/<user_query>([\s\S]*?)<\/user_query>/);
  const query = match ? match[1].trim() : null;
  return query || null;
}

/** Best-effort display name for a project directory slug (Cursor stores no workspace metadata). */
function decodeProjectSlug(slug) {
  // Slugs look like `-Users-me-repo` or `my-repo`; only decode the path-like
  // leading-dash form, keep everything else as-is.
  if (slug && /^-.+-/.test(slug) && !slug.includes(' ')) {
    return slug.replace(/-+/g, '/').replace(/^\/+|\/+$/g, '');
  }
  return slug;
}

/**
 * Normalize one Cursor transcript record into normalized messages.
 * Returns an ARRAY: a user/assistant record may expand to several messages
 * (assistant text + each tool_use call). Never throws; returns [] for
 * non-conversation records (turn_ended, malformed).
 */
function normalizeCursorRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const role = rec.role;
  const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
  if (role === 'user') {
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!text) return [];
    const query = extractCursorUserQuery(text);
    return [makeMessage({ role: 'user', content: [{ type: 'text', text: query || text }] })];
  }
  if (role === 'assistant') {
    const textParts = [];
    const toolCalls = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        textParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        toolCalls.push(block);
      }
    }
    const messages = [];
    if (textParts.length) messages.push(makeMessage({ role: 'assistant', content: textParts }));
    for (const tool of toolCalls) {
      messages.push(
        makeMessage({
          role: 'toolCall',
          toolCallId: tool.id || tool.tool_use_id || null,
          toolName: tool.name || null,
          details: tool.input ?? null,
        })
      );
    }
    return messages;
  }
  return [];
}

/**
 * Metadata pass: role/message counts, first human query (title), top tools.
 * Timestamps come from the file mtime (Cursor records carry no timestamps).
 */
const parseCursorSessionMetadata = withMetadataCache(async function parseCursorSessionMetadataRaw(
  filePath,
  fileName = path.basename(filePath)
) {
  const stat = await fsp.stat(filePath);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  const toolNames = {};
  const userQueries = [];
  let firstUserMessage = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== 'object' || !rec.role) continue;
      const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
      if (rec.role === 'user') {
        userCount++;
        messageCount++;
        const text = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n');
        const query = extractCursorUserQuery(text);
        if (query) {
          userQueries.push(query);
          if (!firstUserMessage) firstUserMessage = query.slice(0, 120);
        }
      } else if (rec.role === 'assistant') {
        assistantCount++;
        messageCount++;
        for (const block of content) {
          if (block && block.type === 'tool_use' && block.name) {
            toolCallCount++;
            toolNames[block.name] = (toolNames[block.name] || 0) + 1;
          }
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  const mtime = stat.mtime.toISOString();
  return {
    id: cursorSessionIdFromFile(fileName),
    timestamp: mtime,
    lastActivity: mtime,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount: 0, // Cursor transcripts never contain tool results
    topTools: topToolsOf(toolNames),
    firstUserMessage: firstUserMessage || null,
    bestTitle: userQueries.length ? userQueries[0].slice(0, 120) : null,
    cwd: null,
    model: null,
    file: fileName,
  };
});

/** Scan <root>/<project-slug>/agent-transcripts/<id>/<id>.jsonl (main transcripts only). */
async function collectCursorSessionEntries(baseDir, { includeSubagents = false } = {}) {
  const root = baseDir || CURSOR_DIR;
  const entries = [];
  const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const transcriptsDir = path.join(root, project.name, 'agent-transcripts');
    const sessionDirs = await fsp.readdir(transcriptsDir, { withFileTypes: true }).catch(() => []);
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      // Subagent transcripts live INSIDE the session dir (subagents/*.jsonl);
      // a "subagents" directory is not a session itself.
      const sessionFilePath = path.join(transcriptsDir, sessionDir.name, `${sessionDir.name}.jsonl`);
      try {
        const stat = await fsp.stat(sessionFilePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      entries.push({
        sessionDir: path.join(transcriptsDir, sessionDir.name),
        filePath: sessionFilePath,
        fileName: `${sessionDir.name}.jsonl`,
        sessionId: sessionDir.name,
        projectSlug: project.name,
      });
      if (includeSubagents) {
        // Reserved for future subagent support; not collected today.
      }
    }
  }
  return entries;
}

/** Locate a session file by exact <sessionId>/<sessionId>.jsonl across projects. */
async function findCursorSessionFile(baseDir, sessionId) {
  if (!sessionId) return null;
  const root = baseDir || CURSOR_DIR;
  const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(root, project.name, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not found in this project
    }
  }
  return null;
}

async function listCursorSessions(baseDir) {
  const entries = await collectCursorSessionEntries(baseDir);
  const sessions = await Promise.all(
    entries.map(async (entry) => {
      const metadata = await parseCursorSessionMetadata(entry.filePath, entry.fileName);
      return {
        ...metadata,
        title: metadata.bestTitle || null,
        filePath: entry.filePath,
        project: entry.projectSlug,
        projectName: decodeProjectSlug(entry.projectSlug),
      };
    })
  );
  return sortSessionsByTimestampDesc(sessions);
}

async function _parseCursorSessionFileRaw(filePath, { projectSlug = null } = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
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
      const normalized = normalizeCursorRecord(rec);
      if (normalized.length) messages.push(...normalized);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  const mtime = stat?.mtime?.toISOString() || null;
  const session = {
    id: cursorSessionIdFromFile(path.basename(filePath)),
    timestamp: mtime,
    lastActivity: mtime,
    cwd: null,
    project: projectSlug || null,
    filePath,
  };
  return { session, messages };
}

const parseCursorSessionFile = withInFlightDedup((filePath) => filePath, _parseCursorSessionFileRaw);

module.exports = {
  cursorSessionIdFromFile,
  extractCursorUserQuery,
  decodeProjectSlug,
  normalizeCursorRecord,
  parseCursorSessionMetadata,
  collectCursorSessionEntries,
  findCursorSessionFile,
  listCursorSessions,
  parseCursorSessionFile,
};
