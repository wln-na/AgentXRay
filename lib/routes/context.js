// Context reconstruction API: reconstruct the full system prompt + history
// a model likely saw before a given user turn.
//
// GET /api/:platform/sessions/:sessionId/context?messageIndex=N
// GET /api/:platform/sessions/:sessionId/context?messageId=xxx
// GET /api/:platform/sessions/:sessionId/context?messageIds=a,b,c   (batch)
//
// Returns a ContextSnapshot (see lib/context.js), or for the batch form
// `{ snapshots: ContextSnapshot[], errors: {messageId, error}[] }`.
//
// The batch form exists because reconstructing context is expensive per call:
// the underlying builder reads and normalizes the whole session log. Callers
// that need several anchors (analytics, "expand all turns") used to fire N
// independent requests, so the same file was parsed N times. Batching resolves
// every anchor from one parse and keeps the per-message HTTP contract intact.

const { reconstructContext } = require('../context');
const { resolveDir, sanitizeAgentName, sanitizeSessionId } = require('../config');
const { PLATFORMS, platformSupports } = require('../platforms');
const { validateContextMessageIds, validateQuery, validateResponse } = require('../contracts');

// Upper bound on one batch so a single request cannot ask for thousands of
// reconstructions. Comfortably above any real session's user-turn count.
const MAX_BATCH_IDS = 200;

function contextPlatforms() {
  return Object.values(PLATFORMS)
    .filter((platform) => platformSupports(platform.id, 'context'))
    .map((platform) => platform.id);
}

function parseMessageIds(raw) {
  if (typeof raw !== 'string') return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length ? ids : null;
}

// Per-call `dir` + `agent` resolution, shared by both response modes.
function callOptions(req) {
  return {
    dir: resolveDir(req.query.dir, PLATFORMS[req.params.platform]?.defaultDir() ?? null),
    agent: req.query.agent ? sanitizeAgentName(req.query.agent) || null : null,
  };
}

module.exports = function mountContextRoutes(app) {
  app.get('/api/:platform/sessions/:sessionId/context', async (req, res) => {
    const platform = req.params.platform;
    const sessionId = sanitizeSessionId(req.params.sessionId);

    if (!platformSupports(platform, 'context')) {
      return res.status(400).json({
        error: `Context reconstruction not yet supported for platform: ${platform}. Supported: ${contextPlatforms().join(', ')}`,
      });
    }
    if (!sessionId) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const messageIds = parseMessageIds(req.query.messageIds);
    const messageIndex = req.query.messageIndex !== undefined ? Number(req.query.messageIndex) : undefined;
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : undefined;

    if (!messageIds && messageIndex === undefined && !messageId) {
      return res.status(400).json({ error: 'Either messageIndex, messageId or messageIds is required' });
    }
    if (
      messageIndex !== undefined &&
      (!Number.isFinite(messageIndex) || !Number.isInteger(messageIndex) || messageIndex < 0)
    ) {
      return res.status(400).json({ error: 'messageIndex must be a non-negative integer' });
    }
    if (messageIds && messageIds.length > MAX_BATCH_IDS) {
      return res.status(400).json({ error: `messageIds accepts at most ${MAX_BATCH_IDS} ids per request` });
    }

    // Contract validation (lib/contracts): the checks above keep their existing
    // messages/status codes; this only rejects malformed anchors/agent values
    // that used to be silently dropped, naming the offending parameter.
    try {
      validateQuery('context.query', {
        messageIds: typeof req.query.messageIds === 'string' ? req.query.messageIds : undefined,
        messageId: typeof req.query.messageId === 'string' ? req.query.messageId : undefined,
        agent: typeof req.query.agent === 'string' ? req.query.agent : undefined,
        dir: typeof req.query.dir === 'string' ? req.query.dir : undefined,
      });
      if (messageIds) validateContextMessageIds(messageIds);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const { dir, agent } = callOptions(req);

    // --- batch form -------------------------------------------------------
    if (messageIds) {
      const snapshots = [];
      const errors = [];
      // Anchors are resolved in order against one parse; a single unknown anchor
      // must not fail the whole batch, so failures are reported per id.
      for (const anchorId of messageIds) {
        try {
          snapshots.push(await reconstructContext(platform, dir, sessionId, { messageId: anchorId, agent }));
        } catch (error) {
          if (error.code === 'SESSION_NOT_FOUND') {
            return res.status(404).json({ error: error.message });
          }
          errors.push({ messageId: anchorId, error: error.message });
        }
      }
      const body = { snapshots, errors };
      validateResponse('context.batch', body);
      return res.json(body);
    }

    // --- single form ------------------------------------------------------
    try {
      const snapshot = await reconstructContext(platform, dir, sessionId, { messageIndex, messageId, agent });
      validateResponse('context.single', snapshot);
      res.json(snapshot);
    } catch (error) {
      if (error.code === 'SESSION_NOT_FOUND' || error.code === 'TARGET_NOT_FOUND') {
        return res.status(404).json({ error: error.message });
      }
      if (error.code === 'UNSUPPORTED_PLATFORM') {
        return res.status(400).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });
};
