// Context reconstruction API: reconstruct the full system prompt + history
// a model likely saw before a given user turn.
//
// GET /api/:platform/sessions/:sessionId/context?messageIndex=N
// GET /api/:platform/sessions/:sessionId/context?messageId=xxx
//
// Returns a ContextSnapshot (see lib/context.js).

const { reconstructContext } = require('../context');
const { resolveDir, sanitizeSessionId } = require('../config');
const { PLATFORMS } = require('../platforms');

const CONTEXT_PLATFORMS = new Set(['codex', 'claude-code', 'claude-desktop']);

module.exports = function mountContextRoutes(app) {
  app.get('/api/:platform/sessions/:sessionId/context', async (req, res) => {
    const platform = req.params.platform;
    const sessionId = sanitizeSessionId(req.params.sessionId);

    if (!CONTEXT_PLATFORMS.has(platform)) {
      return res.status(400).json({
        error: `Context reconstruction not yet supported for platform: ${platform}. Supported: ${[...CONTEXT_PLATFORMS].join(', ')}`,
      });
    }
    if (!sessionId) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const messageIndex = req.query.messageIndex !== undefined ? Number(req.query.messageIndex) : undefined;
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : undefined;

    if (messageIndex === undefined && !messageId) {
      return res.status(400).json({ error: 'Either messageIndex or messageId is required' });
    }
    if (messageIndex !== undefined && (!Number.isFinite(messageIndex) || !Number.isInteger(messageIndex) || messageIndex < 0)) {
      return res.status(400).json({ error: 'messageIndex must be a non-negative integer' });
    }

    try {
      const platformDef = PLATFORMS[platform];
      const dir = resolveDir(req.query.dir, platformDef ? platformDef.defaultDir() : null);
      const snapshot = await reconstructContext(platform, dir, sessionId, { messageIndex, messageId });
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
