const fsp = require('fs/promises');
const path = require('path');
const {
  DATA_DIR,
  OMP_DIR,
  CLAUDE_CODE_DIR,
  resolveDir,
  sanitizeAgentName,
  sanitizeSessionId,
  readAgents,
} = require('../config');
const { PLATFORMS } = require('../platforms');
const { computeSessionStats } = require('../session-stats');
const { locateSession, openSession, detectActiveWriter } = require('../open-session');
const { listCodexChildren, getCodexChildSession } = require('../platforms/codex');
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
function withStats(payload) {
  if (!payload || !Array.isArray(payload.messages)) return payload;
  return { ...payload, stats: computeSessionStats(payload.messages) };
}

module.exports = function mountSessionRoutes(app) {
  app.get('/api/agents', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const agents = await readAgents(dir);
      res.json(agents);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/agents/:name/sessions', async (req, res) => {
    const agentName = sanitizeAgentName(req.params.name);
    if (!agentName) {
      return res.status(400).json({ error: 'Invalid agent name' });
    }

    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const sessions = await listSessionsForAgent(dir, agentName, req.query.include_archived === 'true');
      res.json(sessions);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/agents/:name/sessions/:sessionId', async (req, res) => {
    const agentName = sanitizeAgentName(req.params.name);
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!agentName || !sessionId) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const filePath = await resolveSessionFile(dir, agentName, sessionId);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const payload = await parseSessionFile(filePath);
      res.json(withStats(payload));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session not found' });
      }
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
  // GET /api/:platform/sessions            → session list (newest first)
  // GET /api/:platform/sessions/:sessionId → normalized { session, messages }
  // openclaw is served by /api/agents/:name/sessions (per-agent listing) and
  // falls through here; platform-specific children routes are registered below.

  app.get('/api/:platform/sessions', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || !platform.list) return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      res.json(await platform.list(dir));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/sessions/:sessionId', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || platform.needsAgent) return next();
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await platform.getSession(dir, sessionId);
      if (!payload) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json(withStats(payload));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.status(500).json({ error: error.message });
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
  // openclaw is served by the per-agent route below (needsAgent).

  /**
   * Attach an advisory "active elsewhere" hint to a successful open result:
   * when another process is currently holding the log open (e.g. the ChatGPT
   * app writing a codex rollout), the frontend warns that the session is in
   * active use elsewhere and may not refresh here. Probing is best-effort and
   * never fails the request.
   */
  async function withActiveHint(result, filePath) {
    if (!result || result.ok !== true || result.action !== 'open') return result;
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

  app.post('/api/agents/:name/sessions/:sessionId/open', async (req, res) => {
    const agentName = sanitizeAgentName(req.params.name);
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const action = openActionFromBody(req.body);
    if (!agentName) return res.status(400).json({ error: 'Invalid agent name' });
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    if (!action) return res.status(400).json({ error: 'Invalid action (expected "locate" or "open")' });
    try {
      const platform = PLATFORMS.openclaw;
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const { filePath, cwd } = await resolveOpenTarget(platform, dir, sessionId);
      if (!filePath) return res.status(404).json({ error: 'Session not found' });
      if (action === 'open' && !platform.capabilities.open) {
        return res.json({ ok: false, error: '该平台不支持打开会话', fallback: { type: 'copy-path', path: filePath } });
      }
      const result =
        action === 'locate'
          ? await locateSession(filePath, {})
          : await withActiveHint(await openSession(platform.id, sessionId, filePath, cwd, {}), filePath);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/:platform/sessions/:sessionId/open', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || platform.needsAgent) return next();
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const action = openActionFromBody(req.body);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
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
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
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
      res.json(withStats(payload));
    } catch (error) {
      res.status(500).json({ error: error.message });
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
      const payload = await parseOmpSessionFile(path.join(spawnDir, name + '.jsonl'));
      res.json(withStats(payload));
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
        const stem = e.name.replace(/\.jsonl$/, '');
        const meta = await parseClaudeCodeSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
        let agentMeta = null;
        try {
          agentMeta = JSON.parse(await fsp.readFile(path.join(spawnDir, stem + '.meta.json'), 'utf8'));
        } catch {
          /* absent or corrupt meta.json */
        }
        children.push({
          name: stem,
          file: e.name,
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
      const payload = await parseClaudeCodeSessionFile(path.join(spawnDir, name + '.jsonl'));
      res.json(withStats(payload));
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
      res.status(500).json({ error: error.message });
    }
  });
};
