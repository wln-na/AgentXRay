const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { CODEX_DIR, CODEX_ARCHIVED_DIR } = require('../config');
const { withMetadataCache, makeMessage, sortSessionsByTimestampDesc, topToolsOf } = require('./shared');

function codexSessionIdFromFile(fileName) {
  // rollout-2026-03-31T13-18-02-019d4253-d114-7da1-89b7-826bb51867b6.jsonl
  return fileName.replace(/\.jsonl$/, '');
}

async function listJsonlFiles(rootDir) {
  const files = [];
  const entries = await fsp.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

function codexArchivedDir(baseDir) {
  if (!baseDir || path.resolve(baseDir) === path.resolve(CODEX_DIR)) return CODEX_ARCHIVED_DIR;
  return path.join(path.dirname(path.resolve(baseDir)), 'archived_sessions');
}

function codexThreadMeta(payload = {}) {
  const spawn = payload.source?.subagent?.thread_spawn || null;
  return {
    id: payload.id || null,
    parentThreadId: payload.parent_thread_id || null,
    sessionId: payload.session_id || null,
    agentRole: payload.agent_role || spawn?.agent_role || null,
    agentNickname: payload.agent_nickname || spawn?.agent_nickname || null,
    source: typeof payload.source === 'string' ? payload.source : payload.source?.subagent ? 'subagent' : null,
  };
}

async function readCodexThreadMeta(filePath, fileName = path.basename(filePath)) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type !== 'session_meta') continue;
        const payload = rec.payload || {};
        return {
          ...codexThreadMeta(payload),
          id: payload.id || codexSessionIdFromFile(fileName),
          timestamp: payload.timestamp || rec.timestamp || null,
          cwd: payload.cwd || null,
        };
      } catch {
        // Keep scanning until a valid session_meta record is found.
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return {
    id: codexSessionIdFromFile(fileName),
    parentThreadId: null,
    sessionId: null,
    agentRole: null,
    agentNickname: null,
    source: null,
    timestamp: null,
    cwd: null,
  };
}

const threadMetaCache = new Map();

async function readCodexThreadMetaCached(filePath, fileName = path.basename(filePath)) {
  const stat = await fsp.stat(filePath);
  const cached = threadMetaCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;
  const meta = await readCodexThreadMeta(filePath, fileName);
  threadMetaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

async function collectCodexSessionEntries(baseDir, { includeChildren = true } = {}) {
  const activeDir = baseDir || CODEX_DIR;
  const archivedDir = codexArchivedDir(activeDir);
  const [activeFiles, archivedFiles] = await Promise.all([listJsonlFiles(activeDir), listJsonlFiles(archivedDir)]);
  const rows = await Promise.all(
    [
      ...activeFiles.map((filePath) => ({ filePath, archived: false })),
      ...archivedFiles.map((filePath) => ({ filePath, archived: true })),
    ].map(async (entry) => ({
      ...entry,
      fileName: path.basename(entry.filePath),
      meta: await readCodexThreadMetaCached(entry.filePath),
    }))
  );

  const deduped = new Map();
  for (const row of rows) {
    if (!includeChildren && row.meta.parentThreadId) continue;
    const current = deduped.get(row.meta.id);
    if (!current || (current.archived && !row.archived)) deduped.set(row.meta.id, row);
  }
  return [...deduped.values()];
}

async function getCodexSession(baseDir, sessionId) {
  const entries = await collectCodexSessionEntries(baseDir, { includeChildren: true });
  const entry = entries.find(
    (item) => item.meta.id === sessionId || codexSessionIdFromFile(item.fileName) === sessionId
  );
  if (!entry) return null;
  const payload = await parseCodexSessionFile(entry.filePath);
  if (payload.session) {
    payload.session.archived = entry.archived;
    payload.session.filePath = entry.filePath;
  }
  return payload;
}

async function findCodexSessionFile(baseDir, sessionId) {
  const entries = await collectCodexSessionEntries(baseDir);
  const hit = entries.find(
    (entry) => entry.meta.id === sessionId || codexSessionIdFromFile(entry.fileName) === sessionId
  );
  return hit?.filePath || null;
}

// Returns the real human prompt text from a Codex user message payload, or null
// for synthetic session-start injections (<environment_context>, <user_instructions>)
function extractCodexUserPromptText(payload) {
  const content = Array.isArray(payload.content)
    ? payload.content
    : typeof payload.content === 'string'
      ? [{ type: 'input_text', text: payload.content }]
      : [];
  const text = content
    .filter((c) => c.type === 'input_text' || c.type === 'text')
    .map((c) => c.text || '')
    .join(' ')
    .trim();
  if (!text) return null;
  if (text.startsWith('<environment_context>') || text.startsWith('<user_instructions>')) return null;
  return text;
}

const parseCodexSessionMetadata = withMetadataCache(_parseCodexSessionMetadataRaw);

async function _parseCodexSessionMetadataRaw(filePath, fileName) {
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
  let activeModel = null;
  const models = [];
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
      const payload = rec.payload || {};
      const nextModel = modelFromCodexRecord(rec);
      if (nextModel) {
        activeModel = nextModel;
        if (!models.includes(nextModel)) models.push(nextModel);
      }

      if (t === 'session_meta' && !sessionMeta) {
        sessionMeta = {
          id: payload.id || codexSessionIdFromFile(fileName),
          timestamp: payload.timestamp || null,
          cwd: payload.cwd || null,
          ...codexThreadMeta(payload),
        };
      }

      if (t === 'response_item') {
        const pt = payload.type;
        if (pt === 'message') {
          messageCount++;
          if (payload.role === 'user') {
            userCount++;
            if (!firstUserMessage) {
              const content = Array.isArray(payload.content)
                ? payload.content
                : typeof payload.content === 'string'
                  ? [{ type: 'input_text', text: payload.content }]
                  : [];
              const texts = content
                .filter((c) => c.type === 'input_text' || c.type === 'text')
                .map((c) => c.text || '')
                .join(' ')
                .trim();
              if (texts) firstUserMessage = texts.slice(0, 120);
            }
          }
          if (payload.role === 'assistant') assistantCount++;
        } else if (pt === 'function_call' || pt === 'custom_tool_call') {
          toolCallCount++;
          const name = payload.name || 'unknown';
          toolNames[name] = (toolNames[name] || 0) + 1;
        } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
          toolResultCount++;
        }
        // reasoning counts as assistant activity but not a separate message
        if (rec.timestamp) lastTimestamp = rec.timestamp;
      }

      if (t === 'event_msg' && rec.timestamp) {
        lastTimestamp = rec.timestamp;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = topToolsOf(toolNames);

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
    cwd: sessionMeta?.cwd || null,
    model: activeModel,
    models,
    file: fileName,
    parentThreadId: sessionMeta?.parentThreadId || null,
    agentRole: sessionMeta?.agentRole || null,
    agentNickname: sessionMeta?.agentNickname || null,
    source: sessionMeta?.source || null,
  };
}

function descendantEntries(entries, rootId) {
  const childrenByParent = new Map();
  for (const entry of entries) {
    const parentId = entry.meta.parentThreadId;
    if (!parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(entry);
  }
  const descendants = [];
  const queue = [...(childrenByParent.get(rootId) || [])];
  const seen = new Set();
  while (queue.length) {
    const entry = queue.shift();
    if (!entry || seen.has(entry.meta.id)) continue;
    seen.add(entry.meta.id);
    descendants.push(entry);
    queue.push(...(childrenByParent.get(entry.meta.id) || []));
  }
  return descendants;
}

async function listCodexSessions(baseDir) {
  const entries = await collectCodexSessionEntries(baseDir, { includeChildren: true });
  const mainEntries = entries.filter((entry) => !entry.meta.parentThreadId);
  const sessions = await Promise.all(
    mainEntries.map(async (entry) => {
      const metadata = await parseCodexSessionMetadata(entry.filePath, entry.fileName);
      const children = descendantEntries(entries, metadata.id);
      const childMetadata = await Promise.all(
        children.map((child) => parseCodexSessionMetadata(child.filePath, child.fileName).catch(() => null))
      );
      const activity = [metadata.lastActivity, metadata.timestamp];
      for (const child of childMetadata) {
        if (child?.lastActivity) activity.push(child.lastActivity);
        else if (child?.timestamp) activity.push(child.timestamp);
      }
      const lastActivity = activity.filter(Boolean).sort().at(-1) || null;
      return {
        ...metadata,
        archived: entry.archived,
        filePath: entry.filePath,
        lastActivity,
        childCount: children.length,
      };
    })
  );
  return sortSessionsByTimestampDesc(sessions);
}

async function listCodexChildren(baseDir, sessionId) {
  const entries = await collectCodexSessionEntries(baseDir, { includeChildren: true });
  const direct = descendantEntries(entries, sessionId);
  const children = await Promise.all(
    direct.map(async (entry) => {
      const meta = await parseCodexSessionMetadata(entry.filePath, entry.fileName);
      return {
        name: meta.id,
        file: entry.fileName,
        filePath: entry.filePath,
        title: meta.firstUserMessage || meta.agentNickname || meta.agentRole || null,
        timestamp: meta.timestamp || null,
        lastActivity: meta.lastActivity || null,
        messageCount: meta.messageCount || 0,
        toolCallCount: meta.toolCallCount || 0,
        agentType: meta.agentRole || null,
        description: meta.agentNickname || null,
        archived: entry.archived,
        parentThreadId: entry.meta.parentThreadId || null,
      };
    })
  );
  return sortSessionsByTimestampDesc(children);
}

async function getCodexChildSession(baseDir, sessionId, childId) {
  const entries = await collectCodexSessionEntries(baseDir, { includeChildren: true });
  const descendants = descendantEntries(entries, sessionId);
  const entry = descendants.find((item) => item.meta.id === childId);
  if (!entry) return null;
  const payload = await parseCodexSessionFile(entry.filePath);
  if (payload.session) {
    payload.session.parentThreadId = entry.meta.parentThreadId || sessionId;
    payload.session.rootThreadId = sessionId;
    payload.session.archived = entry.archived;
    payload.session.filePath = entry.filePath;
  }
  return payload;
}

function modelFromCodexRecord(rec) {
  const payload = rec?.payload || {};
  if (rec?.type === 'turn_context') {
    return payload.model || payload.collaboration_mode?.settings?.model || null;
  }
  if (rec?.type === 'world_state') return payload.state?.model || null;
  if (rec?.type === 'event_msg' && payload.type === 'thread_settings') return payload.model || null;
  if (rec?.type === 'session_meta') return payload.base_instructions?.provenance?.model || null;
  return null;
}

function normalizeCodexRecord(rec, context = {}) {
  const payload = rec.payload || {};
  const t = payload.type;
  const timestamp = rec.timestamp || null;

  if (t === 'message') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    return makeMessage({
      id: payload.id || null,
      timestamp,
      role: payload.role || null,
      model: payload.role === 'assistant' ? context.model || null : null,
      provider: payload.role === 'assistant' ? context.provider || null : null,
      content: content.map((c) => ({
        type: c.type === 'input_text' || c.type === 'output_text' ? 'text' : c.type || 'text',
        text: c.text || '',
      })),
    });
  }

  if (t === 'function_call' || t === 'custom_tool_call') {
    return makeMessage({
      id: payload.call_id || null,
      timestamp,
      role: 'toolCall',
      toolCallId: payload.call_id || null,
      toolName: payload.name || null,
      details: payload.arguments || null,
    });
  }

  if (t === 'function_call_output' || t === 'custom_tool_call_output') {
    let outputText = '';
    const output = payload.output;
    if (typeof output === 'string') {
      outputText = output;
    } else if (output && typeof output === 'object') {
      outputText = output.output || JSON.stringify(output);
    }
    const metadata = output && typeof output === 'object' ? output.metadata : null;
    return makeMessage({
      id: payload.call_id || null,
      timestamp,
      role: 'toolResult',
      content: [{ type: 'text', text: outputText }],
      toolCallId: payload.call_id || null,
      details: metadata
        ? {
            status: metadata.exit_code === 0 ? 'ok' : 'error',
            exitCode: metadata.exit_code,
            durationMs: metadata.duration_seconds ? Math.round(metadata.duration_seconds * 1000) : null,
          }
        : null,
      isError: metadata ? metadata.exit_code !== 0 : false,
    });
  }

  if (t === 'reasoning') {
    return makeMessage({
      timestamp,
      role: 'reasoning',
      content: [{ type: 'text', text: payload.text || '' }],
    });
  }

  return null;
}

async function parseCodexSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  let activeModel = null;
  let provider = null;
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

      const nextModel = modelFromCodexRecord(rec);
      if (nextModel) {
        activeModel = nextModel;
        if (!models.includes(nextModel)) models.push(nextModel);
      }

      if (rec.type === 'session_meta') {
        const p = rec.payload || {};
        provider = p.model_provider || provider;
        session = {
          id: p.id || null,
          cwd: p.cwd || null,
          timestamp: p.timestamp || null,
          version: p.cli_version || null,
          model: activeModel,
          provider,
          ...codexThreadMeta(p),
          filePath,
          archived: path.resolve(filePath).startsWith(path.resolve(CODEX_ARCHIVED_DIR) + path.sep),
        };
      } else if (rec.type === 'response_item') {
        const msg = normalizeCodexRecord(rec, { model: activeModel, provider });
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
    session.provider = provider;
  }
  return { session, messages };
}

module.exports = {
  codexSessionIdFromFile,
  collectCodexSessionEntries,
  listCodexChildren,
  getCodexChildSession,
  getCodexSession,
  findCodexSessionFile,
  extractCodexUserPromptText,
  parseCodexSessionMetadata,
  listCodexSessions,
  modelFromCodexRecord,
  normalizeCodexRecord,
  parseCodexSessionFile,
};
