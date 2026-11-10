const { iterateJsonlLines } = require('../fs-utils');
const { createSessionStatsCollector } = require('./shared');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { CODEX_DIR, CODEX_ARCHIVED_DIR, isPathWithin, assertSafePath, HOME } = require('../config');
const { createCache } = require('../cache');
const {
  withMetadataCache,
  withInFlightDedup,
  makeMessage,
  sortSessionsByTimestampDesc,
  topToolsOf,
} = require('./shared');

function normalizeCodexTokenUsage(rawUsage, contextWindow = null) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const input = number(rawUsage.input_tokens);
  const output = number(rawUsage.output_tokens);
  const cacheRead = number(rawUsage.cached_input_tokens);
  const cacheWrite = number(rawUsage.cache_write_input_tokens);
  const reasoning = number(rawUsage.reasoning_output_tokens);
  const rawTotal = number(rawUsage.total_tokens);
  // cached_input_tokens is a subset of input_tokens, and reasoning_output_tokens
  // is included in output_tokens. Never add either bucket to the total again.
  const totalTokens = rawTotal > 0 ? rawTotal : input + output;
  const usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens,
  };
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow)) usage.contextWindow = contextWindow;
  return usage;
}

function normalizeCodexContextUsage(rawUsage, contextWindow = null) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const input = number(rawUsage.input_tokens);
  const cacheRead = number(rawUsage.cached_input_tokens);
  const cacheWrite = number(rawUsage.cache_write_input_tokens);
  const output = number(rawUsage.output_tokens);
  const limit =
    typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  const used = input > 0 ? input : null;
  return {
    used,
    limit,
    percent: used !== null && limit ? (used / limit) * 100 : null,
    source: 'native',
    input,
    cacheRead,
    cacheWrite,
    output,
    breakdownStatus: 'unavailable',
    note: 'Codex 使用最近一次请求的 last_token_usage 计算上下文占用；缓存输入已包含在 Input 中。',
  };
}

function codexSessionIdFromFile(fileName) {
  // rollout-2026-03-31T13-18-02-019d4253-d114-7da1-89b7-826bb51867b6.jsonl
  return fileName.replace(/\.jsonl$/, '');
}

async function listJsonlFiles(rootDir) {
  const files = [];
  const entries = await fsp.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      // Resolve symlink target and only recurse if it stays within rootDir.
      try {
        await assertSafePath(entryPath, rootDir);
        const real = await fsp.realpath(entryPath);
        const stat = await fsp.stat(real);
        if (stat.isDirectory()) {
          files.push(...(await listJsonlFiles(real)));
        } else if (stat.isFile() && entry.name.endsWith('.jsonl')) {
          files.push(entryPath);
        }
      } catch {
        // broken symlink, escapes scope, or other error — skip
      }
    } else if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

function codexArchivedDir(baseDir) {
  if (!baseDir || path.resolve(baseDir) === path.resolve(CODEX_DIR)) return CODEX_ARCHIVED_DIR;
  // For a custom baseDir, place archived_sessions as a child of that directory
  // rather than assuming the same parent-sibling layout as the default.
  return path.join(path.resolve(baseDir), 'archived_sessions');
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
  for await (const rec of iterateJsonlLines(filePath)) {
    // Malformed lines are skipped by iterateJsonlLines, so anything yielded
    // here parses cleanly; keep scanning until a session_meta record shows up.
    if (rec.type !== 'session_meta') continue;
    const payload = rec.payload || {};
    return {
      ...codexThreadMeta(payload),
      id: payload.id || codexSessionIdFromFile(fileName),
      timestamp: payload.timestamp || rec.timestamp || null,
      cwd: payload.cwd || null,
    };
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

// LRU-bounded cache for Codex thread metadata, keyed by file path with
// mtime+size invalidation. Prevents unbounded growth in long-running servers.
const threadMetaCache = createCache({ max: 1000, ttl: 10 * 60 * 1000 });

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
  // Defense-in-depth: reject any user-supplied directory that escapes HOME.
  const resolvedActive = path.resolve(activeDir);
  if (!isPathWithin(HOME, resolvedActive)) {
    throw new Error('Directory path escapes allowed scope');
  }
  const archivedDir = codexArchivedDir(resolvedActive);
  // Validate archivedDir stays within HOME; if it escapes, skip archive scan
  // rather than crashing.
  let archivedFiles = [];
  try {
    await assertSafePath(path.resolve(archivedDir), HOME);
    archivedFiles = await listJsonlFiles(archivedDir);
  } catch {
    // archivedDir outside allowed scope — skip silently
  }
  const activeFiles = await listJsonlFiles(resolvedActive);
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

// Fast path: locate a Codex session file by scanning only the top-level
// entries of activeDir and archivedDir (Codex sessions are flat), matching by
// filename. Falls back to null so callers can do a full collectCodexSessionEntries
// scan when the sessionId is an internal meta.id rather than a filename.
async function findCodexSessionFileFast(baseDir, sessionId) {
  if (!sessionId) return null;
  const activeDir = path.resolve(baseDir || CODEX_DIR);
  if (!isPathWithin(HOME, activeDir)) return null;
  const archivedDir = codexArchivedDir(activeDir);

  // 1. Try direct filename construction (sessionId may be a full filename).
  const directNames = [`${sessionId}.jsonl`];
  if (sessionId.endsWith('.jsonl')) directNames.push(sessionId);
  for (const dir of [activeDir, archivedDir]) {
    for (const name of directNames) {
      try {
        const candidate = path.join(dir, name);
        if ((await fsp.stat(candidate)).isFile()) return candidate;
      } catch {
        // not found
      }
    }
  }

  // 2. Scan top-level files in both dirs for exact or suffix match.
  for (const dir of [activeDir, archivedDir]) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const base = entry.name.slice(0, -'.jsonl'.length);
      if (base === sessionId || base.endsWith(sessionId)) {
        return path.join(dir, entry.name);
      }
    }
  }

  return null;
}

async function getCodexSession(baseDir, sessionId) {
  const resolvedActive = path.resolve(baseDir || CODEX_DIR);
  const archivedDir = codexArchivedDir(resolvedActive);

  // Fast path: find file by name without reading every session's first line.
  const fastFile = await findCodexSessionFileFast(baseDir, sessionId);
  if (fastFile) {
    const isArchived = isPathWithin(path.resolve(archivedDir), path.resolve(fastFile));
    const payload = await parseCodexSessionFile(fastFile, { archivedDir });
    if (payload.session) {
      payload.session.archived = isArchived;
      payload.session.filePath = fastFile;
    }
    return payload;
  }

  // Fallback: full scan (needed when sessionId is an internal meta.id).
  const entries = await collectCodexSessionEntries(baseDir, { includeChildren: true });
  const entry = entries.find(
    (item) => item.meta.id === sessionId || codexSessionIdFromFile(item.fileName) === sessionId
  );
  if (!entry) return null;
  const payload = await parseCodexSessionFile(entry.filePath, { archivedDir });
  if (payload.session) {
    payload.session.archived = entry.archived;
    payload.session.filePath = entry.filePath;
  }
  return payload;
}

async function findCodexSessionFile(baseDir, sessionId) {
  const fast = await findCodexSessionFileFast(baseDir, sessionId);
  if (fast) return fast;
  const entries = await collectCodexSessionEntries(baseDir);
  const hit = entries.find(
    (entry) => entry.meta.id === sessionId || codexSessionIdFromFile(entry.fileName) === sessionId
  );
  return hit?.filePath || null;
}

// Provenance kinds newer Codex rollouts attach to every message via
// payload.internal_chat_message_metadata_passthrough.content_item_metadata:
//   "user"     — the human's typed input
//   "agents_md" / "harness" — synthetic context blocks (AGENTS.md, env context, …)
// Older rollouts carry no metadata and fall back to text-prefix heuristics.
function codexMessageProvenance(payload) {
  const md = payload.internal_chat_message_metadata_passthrough;
  const items = Array.isArray(md?.content_item_metadata) ? md.content_item_metadata : [];
  return items.map((item) => item?.provenance?.type).filter((kind) => typeof kind === 'string');
}

function codexUserMessageText(payload) {
  const content = Array.isArray(payload.content)
    ? payload.content
    : typeof payload.content === 'string'
      ? [{ type: 'input_text', text: payload.content }]
      : [];
  return content
    .filter((c) => c.type === 'input_text' || c.type === 'text')
    .map((c) => c.text || '')
    .join('\n')
    .trim();
}

// Fixed 4-tag classification for role=user response_item messages:
//   'user'     — the human's typed input            → renders as 用户实际输入
//   'injected' — AGENTS.md / env-context injection  → system context channel
//   'event'    — turn-level wrapper (<turn_aborted>) → not a conversation message
function classifyCodexUserMessage(payload) {
  const text = codexUserMessageText(payload);
  if (text.startsWith('<turn_aborted>')) return 'event';
  const provenance = codexMessageProvenance(payload);
  if (provenance.includes('user')) return 'user';
  if (provenance.length > 0) return 'injected';
  // Fallback for old rollouts without provenance metadata
  const INJECTED_PREFIXES = [
    '<environment_context>',
    '<user_instructions>',
    '<system>',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    '# AGENTS.md',
    '# CLAUDE.md',
  ];
  return INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix)) ? 'injected' : 'user';
}

// Returns the real human prompt text from a Codex user message payload, or null
// for synthetic session-start injections (<environment_context>, <user_instructions>,
// AGENTS.md / CLAUDE.md auto-loads, etc.)
function extractCodexUserPromptText(payload) {
  if (classifyCodexUserMessage(payload) !== 'user') return null;
  const text = codexUserMessageText(payload).replace(/\n/g, ' ').trim();
  if (!text) return null;
  // Filter out messages that are just file contents (very long, or contain markdown headers only)
  // A real user prompt is usually < 500 chars and contains a question/command
  if (text.length > 2000 && (text.includes('# AGENTS.md') || text.includes('# CLAUDE.md'))) return null;
  return text;
}

const parseCodexSessionMetadata = withMetadataCache(_parseCodexSessionMetadataRaw);

async function _parseCodexSessionMetadataRaw(filePath, fileName) {
  let sessionMeta = null;
  const stats = createSessionStatsCollector();
  const userPromptTexts = []; // all real user prompts, for better title extraction
  let activeModel = null;
  const models = [];
  let tokenUsage = null;
  let contextUsage = null;

  for await (const rec of iterateJsonlLines(filePath)) {
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
        stats.messageCount++;
        if (payload.role === 'user') {
          // Only the human's typed input counts as a user message; AGENTS.md /
          // environment_context injections are classified via provenance.
          if (classifyCodexUserMessage(payload) === 'user') stats.userCount++;
          // Collect ALL real user prompts, not just the first one.
          // The first user message is often a system injection (AGENTS.md,
          // environment_context, etc.), so we skip those and pick the first
          // real human prompt for the session title.
          const text = extractCodexUserPromptText(payload);
          if (text) {
            userPromptTexts.push(text);
            if (!stats.firstUserMessage) stats.firstUserMessage = text.slice(0, 120);
          }
        }
        if (payload.role === 'assistant') stats.assistantCount++;
      } else if (pt === 'function_call' || pt === 'custom_tool_call') {
        stats.toolCallCount++;
        const name = payload.name || 'unknown';
        stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
      } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
        stats.toolResultCount++;
      }
      // reasoning counts as assistant activity but not a separate message
      if (rec.timestamp) stats.lastTimestamp = rec.timestamp;
    }

    if (t === 'event_msg' && rec.timestamp) {
      stats.lastTimestamp = rec.timestamp;
      if (payload.type === 'token_count' && payload.info) {
        tokenUsage = normalizeCodexTokenUsage(payload.info.total_token_usage, payload.info.model_context_window);
        const nextContextUsage = normalizeCodexContextUsage(
          payload.info.last_token_usage,
          payload.info.model_context_window
        );
        if (nextContextUsage) contextUsage = nextContextUsage;
      }
    }
  }

  const topTools = topToolsOf(stats.toolNames);

  // Best title: prefer the first real user prompt (not system injection).
  // userPromptTexts collects all real user prompts in order; the first one
  // is usually the best title. Fall back to agent nickname / role.
  const bestTitle =
    userPromptTexts.length > 0
      ? userPromptTexts[0].slice(0, 120)
      : sessionMeta?.agentNickname || sessionMeta?.agentRole || null;

  return {
    id: sessionMeta?.id || codexSessionIdFromFile(fileName),
    timestamp: sessionMeta?.timestamp || null,
    lastActivity: stats.lastTimestamp,
    messageCount: stats.messageCount,
    userCount: stats.userCount,
    assistantCount: stats.assistantCount,
    toolCallCount: stats.toolCallCount,
    toolResultCount: stats.toolResultCount,
    topTools,
    firstUserMessage: stats.firstUserMessage || null,
    bestTitle,
    cwd: sessionMeta?.cwd || null,
    model: activeModel,
    models,
    file: fileName,
    parentThreadId: sessionMeta?.parentThreadId || null,
    agentRole: sessionMeta?.agentRole || null,
    agentNickname: sessionMeta?.agentNickname || null,
    source: sessionMeta?.source || null,
    tokenUsage,
    contextUsage,
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
        // Title for session list display: bestTitle (first real user prompt,
        // skipping AGENTS.md / environment_context system injections) > agent
        // nickname > agent role. Without this, the frontend falls back to
        // session.id (a UUID), which is not human-readable.
        title: metadata.bestTitle || null,
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
        title: meta.bestTitle || meta.firstUserMessage || meta.agentNickname || meta.agentRole || null,
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
  const archivedDir = codexArchivedDir(path.resolve(baseDir || CODEX_DIR));
  const payload = await parseCodexSessionFile(entry.filePath, { archivedDir });
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

// Codex stores the active turn on response-item metadata rather than on the
// normalized message itself. Keep it so the viewer can group a multi-turn
// session without treating each tool call as a separate task.
function codexTurnId(rec) {
  const payload = rec?.payload || {};
  return (
    payload.turn_id ||
    payload.internal_chat_message_metadata_passthrough?.turn_id ||
    payload.turn_attribution?.turn_id ||
    rec?.turn_id ||
    null
  );
}

function normalizeCodexRecord(rec, context = {}) {
  const payload = rec.payload || {};
  const t = payload.type;
  const timestamp = rec.timestamp || null;
  const turnId = codexTurnId(rec);

  if (t === 'message') {
    const content = Array.isArray(payload.content) ? payload.content : [];
    const parts = content.map((c) => ({
      type: c.type === 'input_text' || c.type === 'output_text' ? 'text' : c.type || 'text',
      text: c.text || '',
    }));
    // Injected context blocks open with an XML tag naming the block
    // (<app-context>, <skills_instructions>, <current_date>…), so the tag is a
    // free sourceKind — same shape the 系统上下文 panel already groups/folds for
    // dsh. Real conversation messages have no leading tag and stay untagged.
    const text = parts
      .map((part) => part.text)
      .join('\n')
      .trim();
    const tag = /^<([a-zA-Z0-9_.:-]+)>/.exec(text);
    const sourceKind = tag ? tag[1] : payload.role === 'developer' ? 'developer' : null;
    const provenance = codexMessageProvenance(payload);
    const details = {};
    if (sourceKind) details.sourceKind = sourceKind;
    if (provenance.length) details.provenance = provenance;
    return makeMessage({
      id: payload.id || null,
      timestamp,
      role: payload.role || null,
      model: payload.role === 'assistant' ? context.model || null : null,
      provider: payload.role === 'assistant' ? context.provider || null : null,
      content: parts,
      ...(Object.keys(details).length ? { details } : {}),
      ...(turnId ? { turnId } : {}),
    });
  }

  if (t === 'function_call' || t === 'custom_tool_call') {
    return makeMessage({
      id: payload.call_id || null,
      timestamp,
      role: 'toolCall',
      toolCallId: payload.call_id || null,
      toolName: payload.name || null,
      details: payload.arguments ?? payload.input ?? null,
      ...(turnId ? { turnId } : {}),
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
      ...(turnId ? { turnId } : {}),
    });
  }

  if (t === 'reasoning') {
    const summary = Array.isArray(payload.summary)
      ? payload.summary
          .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
          .join('\n\n')
          .trim()
      : '';
    const text = (typeof payload.text === 'string' ? payload.text : '').trim() || summary;
    if (!text) return null;
    return makeMessage({
      timestamp,
      role: 'reasoning',
      content: [{ type: 'text', text }],
      ...(turnId ? { turnId } : {}),
    });
  }

  return null;
}

// Stable projection of a turn_context payload: the fields that describe the
// runtime the model is operating in. Volatile ids (turn_id/root_turn_id/
// comp_hash/summary) are dropped so an unchanged runtime does not look like a
// new version. One "key: value" per line keeps the panel's line diff readable.
const TURN_CONTEXT_FIELDS = [
  'cwd',
  'model',
  'approval_policy',
  'sandbox_policy',
  'permission_profile',
  'collaboration_mode',
  'effort',
  'realtime_active',
  'disabled_plugin_ids',
];

// collaboration_mode carries the full mode instructions blob; keep only the
// mode identity and its sampling settings — the instructions themselves are
// re-sent as their own <collaboration_mode> context block.
function compactCollaborationMode(mode) {
  if (!mode || typeof mode !== 'object') return mode;
  const settings = mode.settings && typeof mode.settings === 'object' ? mode.settings : {};
  const compact = { mode: mode.mode ?? null };
  if (settings.model) compact.model = settings.model;
  if (settings.reasoning_effort) compact.reasoning_effort = settings.reasoning_effort;
  return compact;
}

function codexTurnContextText(payload) {
  const lines = [];
  for (const field of TURN_CONTEXT_FIELDS) {
    let value = payload?.[field];
    if (value === undefined || value === null || value === '') continue;
    if (field === 'collaboration_mode') value = compactCollaborationMode(value);
    lines.push(`${field}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

async function _parseCodexSessionFileRaw(filePath, { archivedDir = CODEX_ARCHIVED_DIR } = {}) {
  let session = null;
  let activeModel = null;
  let provider = null;
  let tokenUsage = null;
  let contextUsage = null;
  let baseInstructions = null;
  let envContextText = '';
  let userInstructionsText = '';
  let agentsMdText = '';
  let compaction = null;
  let messagesAfterCompaction = [];
  const models = [];
  const messages = [];
  const contextMessages = [];
  let lastTurnContextText = '';

  for await (const rec of iterateJsonlLines(filePath)) {
    const nextModel = modelFromCodexRecord(rec);
    if (nextModel) {
      activeModel = nextModel;
      if (!models.includes(nextModel)) models.push(nextModel);
    }

    if (rec.type === 'session_meta') {
      const p = rec.payload || {};
      provider = p.model_provider || provider;
      baseInstructions = p.base_instructions ?? baseInstructions;
      session = {
        id: p.id || null,
        cwd: p.cwd || null,
        timestamp: p.timestamp || null,
        version: p.cli_version || null,
        model: activeModel,
        provider,
        ...codexThreadMeta(p),
        filePath,
        archived: path.resolve(filePath).startsWith(path.resolve(archivedDir) + path.sep),
      };
    } else if (rec.type === 'event_msg' && rec.payload?.type === 'token_count') {
      const info = rec.payload.info;
      tokenUsage = normalizeCodexTokenUsage(info?.total_token_usage, info?.model_context_window);
      const nextContextUsage = normalizeCodexContextUsage(info?.last_token_usage, info?.model_context_window);
      if (nextContextUsage) contextUsage = nextContextUsage;
    } else if (rec.type === 'compacted' && Array.isArray(rec.payload?.replacement_history)) {
      const replacementHistory = rec.payload.replacement_history
        .map((payload) => normalizeCodexRecord({ timestamp: rec.timestamp, payload }, { model: activeModel, provider }))
        .filter(Boolean);
      compaction = { timestamp: rec.timestamp || null, replacementHistory };
      messagesAfterCompaction = [];
    } else if (rec.type === 'turn_context') {
      // Per-turn runtime snapshot (cwd/model/approval/sandbox/…). turn_id and
      // friends change on every request, so the text is built from the stable
      // field set and only emitted when that snapshot actually changes — a
      // session with a constant runtime yields one record, not one per turn.
      const snapshot = codexTurnContextText(rec.payload || {});
      if (snapshot && snapshot !== lastTurnContextText) {
        lastTurnContextText = snapshot;
        contextMessages.push(
          makeMessage({
            id: null,
            timestamp: rec.timestamp || null,
            role: 'context',
            content: [{ type: 'text', text: snapshot }],
            details: { sourceKind: 'runtime-context' },
          })
        );
      }
    } else if (rec.type === 'response_item') {
      const msg = normalizeCodexRecord(rec, { model: activeModel, provider });
      if (msg) {
        const userClass = msg.role === 'user' ? classifyCodexUserMessage(rec.payload) : null;
        if (userClass === 'event') {
          // Turn-level wrappers (<turn_aborted>…) are events, not messages:
          // drop them from both channels.
        } else if (userClass === 'injected') {
          // AGENTS.md / environment_context / user_instructions injections
          // fold into the context channel — visible exactly once in the
          // 系统上下文 panel, never rendered as a "用户实际输入" bubble.
          const provenance = codexMessageProvenance(rec.payload);
          const sourceKind =
            msg.details?.sourceKind || (provenance.includes('agents_md') ? 'agents-md' : 'injected-context');
          contextMessages.push(
            makeMessage({
              id: msg.id || null,
              timestamp: msg.timestamp || null,
              role: 'context',
              content: msg.content,
              details: { sourceKind },
            })
          );
        } else if (typeof msg.details?.sourceKind === 'string' && msg.role === 'developer') {
          // Injected developer context never renders in the conversation
          // stream; route it to the context channel instead of `messages` so
          // it is visible exactly once (in the 系统上下文 panel).
          contextMessages.push(
            makeMessage({
              id: msg.id || null,
              timestamp: msg.timestamp || null,
              role: 'context',
              content: msg.content,
              details: msg.details,
            })
          );
        } else {
          messages.push(msg);
          if (compaction) messagesAfterCompaction.push(msg);
        }
      }

      // Extract synthetic system-context blocks. One injection message can
      // carry several blocks (e.g. AGENTS.md + <environment_context>), so
      // match per content part, not on the whole message text.
      if (rec.payload?.type === 'message' && rec.payload?.role === 'user') {
        if (classifyCodexUserMessage(rec.payload) === 'injected') {
          const content = Array.isArray(rec.payload.content) ? rec.payload.content : [];
          for (const part of content) {
            if (part?.type !== 'input_text' && part?.type !== 'text') continue;
            const text = (part.text || '').trim();
            if (!text) continue;
            if (text.startsWith('<environment_context>')) envContextText = text;
            else if (text.startsWith('<user_instructions>')) userInstructionsText = text;
            else if (/^#?\s*AGENTS\.md/.test(text)) agentsMdText = text;
          }
        }
      }
    }
  }

  if (session) {
    session.model = activeModel || session.model || null;
    session.models = models;
    session.provider = provider;
    session.tokenUsage = tokenUsage;
    session.contextUsage = contextUsage;
  }

  // Build system prompt components extracted during this single pass
  const systemComponents = [];
  if (envContextText) {
    systemComponents.push({
      type: 'environment',
      label: '环境上下文 (<environment_context>)',
      present: true,
      content: envContextText,
      source: 'session 起始合成消息 (response_item/user)',
      note: null,
    });
  }
  if (userInstructionsText) {
    systemComponents.push({
      type: 'user-instructions',
      label: '用户指令 (<user_instructions>)',
      present: true,
      content: userInstructionsText,
      source: 'session 起始合成消息 (response_item/user)',
      note: null,
    });
  }
  if (agentsMdText) {
    systemComponents.push({
      type: 'agents-md',
      label: '项目指令 (AGENTS.md)',
      present: true,
      content: agentsMdText,
      source: 'rollout 合成消息 (provenance=agents_md)',
      note: null,
    });
  }
  if (baseInstructions) {
    systemComponents.push({
      type: 'base-instructions',
      label: '基础指令 (base_instructions)',
      present: true,
      content: typeof baseInstructions === 'string' ? baseInstructions : JSON.stringify(baseInstructions, null, 2),
      source: 'session_meta.payload.base_instructions',
      note: null,
    });
  }

  const systemContext = { systemComponents, compaction, messagesAfterCompaction };
  return { session, messages, contextMessages, tokenUsage, contextUsage, systemContext };
}

// In-flight dedup: concurrent parses of the same file share one read.
const parseCodexSessionFile = withInFlightDedup((filePath) => filePath, _parseCodexSessionFileRaw);

module.exports = {
  codexTurnContextText,
  codexTurnId,
  normalizeCodexTokenUsage,
  codexSessionIdFromFile,
  codexArchivedDir,
  findCodexSessionFileFast,
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
  normalizeCodexContextUsage,
  parseCodexSessionFile,
};
