const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  DATA_DIR,
  OMP_DIR,
  CLAUDE_CODE_DIR,
  assertSafePath,
  resolveDir,
  sanitizeAgentName,
  sanitizeSessionId,
  readAgents,
} = require('../config');
const { PLATFORMS } = require('../platforms');
const { computeSessionStats } = require('../session-stats');
const { locateSession, openSession, detectActiveWriter } = require('../open-session');
const { listCodexChildren, getCodexChildSession } = require('../platforms/codex');
const { listDshChildren, getDshChildSession } = require('../platforms/dsh');
const { classifySessionTasks } = require('../session-tasks');
const { DEFAULT_PAGE_SIZE, paginateList, paginateMessages } = require('../session-pagination');
const { validateQuery, validateResponse } = require('../contracts');
const { parseOmpSessionMetadata, parseOmpSessionFile, findOmpSpawnDir } = require('../platforms/omp');
const {
  parseClaudeCodeSessionMetadata,
  parseClaudeCodeSessionFile,
  findClaudeSpawnDir,
} = require('../platforms/claude');
const {
  listSessionsForAgent,
  resolveSessionFile,
  parseSessionFile,
  buildSpawnMap,
  buildSpawnTree,
} = require('../platforms/openclaw');

// Session browsing: agents, per-agent (openclaw) sessions, spawn tracking,
// the generic registry-driven platform routes, and subagent children.

/**
 * Attach precomputed session stats to a { session, messages } payload so the
 * frontend can skip the O(n) client-side scan for large sessions.
 * The stats field is additive — existing payload shape is unchanged.
 */
function withStats(payload, messages = payload?.messages) {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  return { ...payload, stats: computeSessionStats(messages) };
}

function sessionPage(payload, query, defaultLimit = null) {
  const full = withStats(payload, payload.messages);
  const { messages, page } = paginateMessages(full.messages, query, { defaultLimit });
  return { ...full, messages, messagePage: page };
}

function messagesPage(payload, query) {
  const { messages, page } = paginateMessages(payload?.messages, query, { defaultLimit: DEFAULT_PAGE_SIZE });
  return { messages, messagePage: page };
}

// --- Session resolution shared by every session-scoped route -----------------
//
// OpenClaw stores sessions per agent, so its adapters need an agent name and have
// no `platform.getSession`. That used to be handled by a whole parallel route
// family (`/api/agents/:name/sessions/...`) whose handlers were near-duplicates of
// the generic ones. `?agent=` is now the one way to say "openclaw, this agent" —
// mirroring `/api/:platform/sessions/:id/export`, which already worked this way —
// so there is a single code path per operation and no second URL surface.

/** Resolve the agent name from the query for platforms that need one. Returns
 *  `{agent}` or `{error}` (already shaped for a 400 response). */
function agentFromQuery(platform, req) {
  if (!platform.needsAgent) return { agent: null };
  const agent = sanitizeAgentName(req.query.agent || '');
  if (!agent) return { error: `agent query parameter is required for ${platform.id}` };
  return { agent };
}

async function listSessionsForPlatform(platform, dir, agent, includeArchived) {
  if (platform.needsAgent) return listSessionsForAgent(dir, agent, includeArchived);
  return platform.list(dir);
}

async function loadSessionPayloadForPlatform(platform, dir, sessionId, agent) {
  if (!platform.needsAgent) {
    return loadSessionPayloadCached(`${platform.id}:${dir}:${sessionId}`, () => platform.getSession(dir, sessionId));
  }
  const filePath = await resolveSessionFile(dir, agent, sessionId);
  if (!filePath) return null;
  return loadSessionPayloadCached(`openclaw:${dir}:${agent}:${sessionId}`, () => parseSessionFile(filePath));
}

// Platform adapters can attach an HTTP status to a parse failure (for example
// dsh's 422 for an unsupported log generation or 413 for an oversized log).
// Only explicit 4xx/5xx values pass through; everything else stays a 500.
function statusForError(error) {
  const status = error?.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

// Query-parameter contract (lib/contracts): invalid values such as ?limit=abc,
// ?limit=-1 or a repeated ?limit=1&limit=2 are a 400 naming the offending
// parameter instead of being silently coerced by paginateList/paginateMessages.
// Response validation stays dev/test-only (AXR_CONTRACT=1) and never changes a
// payload or a status code — see lib/contracts/index.js.
function readContractQuery(routeName, req, res) {
  try {
    return validateQuery(routeName, req.query);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return null;
  }
}

// The detail view and task panel open together. Share an in-flight parse (and
// keep the result briefly) so they do not read and normalize the same JSONL
// file twice. The short TTL keeps live sessions fresh while absorbing bursts
// from React Query and SSE invalidation.
const SESSION_PAYLOAD_CACHE_TTL_MS = 1500;
const SESSION_PAYLOAD_CACHE_MAX = 32;
const sessionPayloadCache = new Map();

async function loadSessionPayloadCached(key, loader) {
  const now = Date.now();
  const cached = sessionPayloadCache.get(key);
  if (cached && cached.expiresAt > now) {
    cached.lastUsedAt = now;
    return cached.promise;
  }

  const promise = Promise.resolve().then(loader);
  sessionPayloadCache.set(key, { promise, expiresAt: now + SESSION_PAYLOAD_CACHE_TTL_MS, lastUsedAt: now });
  if (sessionPayloadCache.size > SESSION_PAYLOAD_CACHE_MAX) {
    const oldest = [...sessionPayloadCache.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (oldest) sessionPayloadCache.delete(oldest[0]);
  }
  promise.catch(() => {
    const current = sessionPayloadCache.get(key);
    if (current?.promise === promise) sessionPayloadCache.delete(key);
  });
  return promise;
}

module.exports = function mountSessionRoutes(app) {
  async function sendTaskAnalysis(res, platform, sessionId, payload, refresh) {
    try {
      const result = await classifySessionTasks({
        platform,
        sessionId,
        payload,
        refresh: refresh === true,
      });
      validateResponse('sessions.tasks', result);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  app.get('/api/agents', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      await assertSafePath(dir, DATA_DIR);
      const agents = await readAgents(dir);
      res.json(agents);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/spawn-map', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const spawnLinks = await buildSpawnMap(dir);
      res.json(spawnLinks);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/spawn-tree', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const tree = await buildSpawnTree(dir);
      res.json(tree);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/spawn-tree/:sessionId', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const full = await buildSpawnTree(dir);
      const sid = req.params.sessionId;
      // Find tree rooted at this session, or find this session as a child
      function findNode(nodes, targetId) {
        for (const n of nodes) {
          if (n.id === targetId) return n;
          const found = findNode(n.children || [], targetId);
          if (found) return found;
        }
        return null;
      }
      // Find parent of this session
      function findParent(nodes, targetId, parent) {
        for (const n of nodes) {
          if (n.id === targetId) return parent;
          const found = findParent(n.children || [], targetId, n);
          if (found) return found;
        }
        return null;
      }
      const node = findNode(full.trees, sid);
      const parent = findParent(full.trees, sid, null);
      res.json({
        node: node || null,
        parent: parent || null,
        totalSessions: full.totalSessions,
        totalSpawnCalls: full.totalSpawnCalls,
        matchedLinks: full.matchedLinks,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Generic platform session routes (registry-driven) ---
  // GET /api/:platform/sessions?agent&limit&before      → { sessions, page }
  // GET /api/:platform/sessions/:id?agent&limit&before  → normalized { session, messages, messagePage }
  // GET /api/:platform/sessions/:id/full?agent          → the same, complete (no messagePage)
  // OpenClaw is served by these same routes with `?agent=<name>`; see the
  // resolver above. Platform-specific children routes are registered below.

  app.get('/api/:platform/sessions', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform?.list && !platform?.needsAgent) return next();
    const { agent, error } = agentFromQuery(platform, req);
    if (error) return res.status(400).json({ error });
    const query = readContractQuery('sessions.list', req, res);
    if (!query) return;
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      // Only dsh understands the option today (its list hides subagent rows by
      // default); every other adapter ignores the second argument.
      const includeSubagents = query.include_subagents === true;
      // Historical spelling: only the literal "true" enabled archived rows; the
      // frontend sends "1", which this route has always ignored. Kept as-is on
      // purpose (changing it would change the response contents).
      const includeArchived = req.query.include_archived === 'true';
      const sessions = platform.needsAgent
        ? await listSessionsForPlatform(platform, dir, agent, includeArchived)
        : await platform.list(dir, { includeSubagents });
      // Lists page like messages: same limit/before cursor, same page metadata.
      const { items, page } = paginateList(sessions, query);
      const body = { sessions: items, page };
      validateResponse('sessions.list', body);
      res.json(body);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Agent not found' });
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/sessions/:sessionId', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform?.getSession) return next();
    const { agent, error } = agentFromQuery(platform, req);
    if (error) return res.status(400).json({ error });
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }
    const query = readContractQuery('sessions.detail', req, res);
    if (!query) return;

    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await loadSessionPayloadForPlatform(platform, dir, sessionId, agent);
      if (!payload) return res.status(404).json({ error: 'Session not found' });
      // Always paged. The complete transcript has its own route (/full) so one
      // URL can never return two payload shapes differing by 100x in size.
      const body = sessionPage(payload, query, DEFAULT_PAGE_SIZE);
      validateResponse('sessions.detail', body);
      res.json(body);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.status(statusForError(error)).json({ error: error.message });
    }
  });

  // The complete transcript. Deliberately a distinct resource rather than
  // "the same endpoint without ?limit": callers that want every message (session
  // analytics) must say so, and they get a shape without `messagePage`.
  app.get('/api/:platform/sessions/:sessionId/full', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform?.getSession) return next();
    const { agent, error } = agentFromQuery(platform, req);
    if (error) return res.status(400).json({ error });
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    const query = readContractQuery('sessions.full', req, res);
    if (!query) return;
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await loadSessionPayloadForPlatform(platform, dir, sessionId, agent);
      if (!payload) return res.status(404).json({ error: 'Session not found' });
      const full = withStats(payload, payload.messages);
      const body = { ...full, complete: true };
      validateResponse('sessions.full', body);
      res.json(body);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Session not found' });
      res.status(statusForError(error)).json({ error: error.message });
    }
  });

  app.get('/api/:platform/sessions/:sessionId/messages', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform?.getSession) return next();
    const { agent, error } = agentFromQuery(platform, req);
    if (error) return res.status(400).json({ error });
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    const query = readContractQuery('sessions.messages', req, res);
    if (!query) return;
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await loadSessionPayloadForPlatform(platform, dir, sessionId, agent);
      if (!payload) return res.status(404).json({ error: 'Session not found' });
      const body = messagesPage(payload, query);
      validateResponse('sessions.messages', body);
      return res.json(body);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Session not found' });
      return res.status(statusForError(error)).json({ error: error.message });
    }
  });

  app.get('/api/:platform/sessions/:sessionId/tasks', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform?.getSession) return next();
    const { agent, error } = agentFromQuery(platform, req);
    if (error) return res.status(400).json({ error });
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    const query = readContractQuery('sessions.tasks', req, res);
    if (!query) return;
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await loadSessionPayloadForPlatform(platform, dir, sessionId, agent);
      if (!payload) return res.status(404).json({ error: 'Session not found' });
      return sendTaskAnalysis(res, platform.id, sessionId, payload, query.refresh);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Session not found' });
      return res.status(statusForError(error)).json({ error: error.message });
    }
  });

  // --- One-click locate / open a collected session (Flux Island-style jump) ---
  // POST /api/:platform/sessions/:sessionId/open  (body: { action: 'locate' | 'open', agent? })
  //   locate → reveal the session log in Finder (`open -R`)
  //   open   → launch the owning app (codex→ChatGPT, claude-desktop→Claude,
  //            doubao, cursor), resume in a fresh terminal window
  //            (claude-code/omp), or open the log with the default editor.
  //            Non-macOS / missing targets degrade to a copyable path or
  //            command, returned as `fallback`.
  // openclaw is served by this same route with ?agent=<name>.

  /**
   * Attach an advisory "active elsewhere" hint to a successful open result:
   * when another process is currently holding the log open (e.g. the ChatGPT
   * app writing a codex rollout), the frontend warns that the session is in
   * active use elsewhere and may not refresh here. Probing is best-effort and
   * never fails the request.
   */
  async function withActiveHint(result, filePath) {
    if (result?.ok !== true || result.action !== 'open') return result;
    const hint = await detectActiveWriter(filePath);
    return hint ? { ...result, hint } : result;
  }

  async function resolveOpenTarget(platform, dir, sessionId) {
    let summaries = [];
    try {
      summaries = (await platform.list(dir)) || [];
    } catch {
      summaries = [];
    }
    const summary = summaries.find((s) => s.id === sessionId) || null;
    let filePath = null;
    if (platform.find) {
      try {
        filePath = await platform.find(dir, sessionId);
      } catch {
        filePath = null;
      }
    }
    if (!filePath && summary) {
      filePath =
        summary.sourcePath ||
        summary.trajectoryPath ||
        summary.filePath ||
        (summary.file && path.isAbsolute(summary.file) ? summary.file : null);
    }
    if (!filePath && summary?.file && !path.isAbsolute(summary.file)) {
      filePath = path.resolve(dir, summary.file); // e.g. hermes state.db
    }
    return { summary, filePath, cwd: summary?.cwd || null };
  }

  function openActionFromBody(body) {
    const action = body?.action;
    return action === 'locate' || action === 'open' ? action : null;
  }

  // Body of the open/locate route. Parameter validation happens in the route;
  // this resolves the target in the platform dir, honours the platform's `open`
  // capability and dispatches locate vs open (with the active-writer hint).
  async function handleOpenAction(req, res, platform, sessionId) {
    const action = openActionFromBody(req.body);
    if (!action) return res.status(400).json({ error: 'Invalid action (expected "locate" or "open")' });
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const { filePath, cwd } = await resolveOpenTarget(platform, dir, sessionId);
      if (!filePath) return res.status(404).json({ error: 'Session not found' });
      if (action === 'open' && !platform.capabilities.open) {
        return res.json({ ok: false, error: '该平台不支持打开会话', fallback: { type: 'copy-path', path: filePath } });
      }
      const result =
        action === 'locate'
          ? await locateSession(filePath, {})
          : await withActiveHint(await openSession(platform.id, sessionId, filePath, cwd, {}), filePath);
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  app.post('/api/:platform/sessions/:sessionId/open', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform) return next();
    const { error } = agentFromQuery(platform, req);
    if (error) return res.status(400).json({ error });
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    const query = readContractQuery('sessions.open', req, res);
    if (!query) return;
    return handleOpenAction(req, res, platform, sessionId);
  });

  // --- Codex subagents ---

  app.get('/api/codex/sessions/:sessionId/children', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    try {
      const platform = PLATFORMS.codex;
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      res.json(await listCodexChildren(dir, sessionId));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/codex/sessions/:sessionId/children/:name', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const childId = sanitizeSessionId(req.params.name);
    if (!sessionId || !childId) return res.status(400).json({ error: 'Invalid session or child ID' });
    try {
      const platform = PLATFORMS.codex;
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await getCodexChildSession(dir, sessionId, childId);
      if (!payload) return res.status(404).json({ error: 'Subagent not found' });
      res.json(sessionPage(payload, req.query));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- dsh subagents ---
  // dsh v4 declares delegation in the child header (`parentSession`), so the
  // parent's directory holds nothing: children are discovered by scanning
  // session metadata. The generic `/api/:platform/sessions/:sessionId` route
  // matches a single segment only, so `/children` never falls through to it.

  app.get('/api/dsh/sessions/:sessionId/children', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    try {
      const platform = PLATFORMS.dsh;
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      await assertSafePath(dir);
      res.json(await listDshChildren(dir, sessionId));
    } catch (error) {
      res.status(statusForError(error)).json({ error: error.message });
    }
  });

  app.get('/api/dsh/sessions/:sessionId/children/:name', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const childId = sanitizeSessionId(req.params.name);
    if (!sessionId || !childId) return res.status(400).json({ error: 'Invalid session or child ID' });
    try {
      const platform = PLATFORMS.dsh;
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      await assertSafePath(dir);
      const payload = await getDshChildSession(dir, sessionId, childId);
      if (!payload) return res.status(404).json({ error: 'Subagent not found' });
      res.json(sessionPage(payload, req.query));
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
      res.status(statusForError(error)).json({ error: error.message });
    }
  });

  // --- OMP subagents ---

  app.get('/api/omp/sessions/:sessionId/children', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    try {
      const dir = resolveDir(req.query.dir, OMP_DIR);
      const spawnDir = await findOmpSpawnDir(dir, sessionId);
      if (!spawnDir) return res.json([]);
      const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
      const children = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const meta = await parseOmpSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
        children.push({
          name: e.name.replace(/\.jsonl$/, ''),
          file: e.name,
          title: meta?.title || null,
          timestamp: meta?.timestamp || null,
          lastActivity: meta?.lastActivity || null,
          messageCount: meta?.messageCount || 0,
          toolCallCount: meta?.toolCallCount || 0,
        });
      }
      children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
      res.json(children);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/omp/sessions/:sessionId/children/:name', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const name = sanitizeAgentName(req.params.name);
    if (!sessionId || !name) return res.status(400).json({ error: 'Invalid session or agent name' });
    try {
      const dir = resolveDir(req.query.dir, OMP_DIR);
      const spawnDir = await findOmpSpawnDir(dir, sessionId);
      if (!spawnDir) return res.status(404).json({ error: 'No subagents for this session' });
      const payload = await parseOmpSessionFile(path.join(spawnDir, `${name}.jsonl`));
      res.json(sessionPage(payload, req.query));
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
      res.status(500).json({ error: error.message });
    }
  });

  // --- Claude Code subagents ---

  app.get('/api/claude-code/sessions/:sessionId/children', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    try {
      const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
      const spawnDir = await findClaudeSpawnDir(dir, sessionId);
      if (!spawnDir) return res.json([]);
      const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
      const children = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
        // CodeQL js/path-injection: `e.name` derives from a readdir entry — a
        // crafted name like `agent-../../../x.jsonl` could escape spawnDir via
        // path.join. basename() strips any directory components (a no-op for
        // real Claude-written names), keeping every derived path inside spawnDir.
        const safeName = path.basename(e.name);
        const stem = safeName.replace(/\.jsonl$/, '');
        const meta = await parseClaudeCodeSessionMetadata(path.join(spawnDir, safeName), safeName).catch(() => null);
        let agentMeta = null;
        try {
          agentMeta = JSON.parse(await fsp.readFile(path.join(spawnDir, `${stem}.meta.json`), 'utf8'));
        } catch {
          /* absent or corrupt meta.json */
        }
        children.push({
          name: stem,
          file: safeName,
          title: meta?.title || null,
          timestamp: meta?.timestamp || null,
          lastActivity: meta?.lastActivity || null,
          messageCount: meta?.messageCount || 0,
          toolCallCount: meta?.toolCallCount || 0,
          agentType: agentMeta?.agentType || null,
          description: agentMeta?.description || null,
        });
      }
      children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
      res.json(children);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/claude-code/sessions/:sessionId/children/:name', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const name = sanitizeAgentName(req.params.name);
    if (!sessionId || !name) return res.status(400).json({ error: 'Invalid session or agent name' });
    try {
      const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
      const spawnDir = await findClaudeSpawnDir(dir, sessionId);
      if (!spawnDir) return res.status(404).json({ error: 'No subagents for this session' });
      const payload = await parseClaudeCodeSessionFile(path.join(spawnDir, `${name}.jsonl`));
      res.json(sessionPage(payload, req.query));
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
      res.status(500).json({ error: error.message });
    }
  });
};
