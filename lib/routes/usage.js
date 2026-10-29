// Daily token usage API — total + per-application breakdown.
//
// GET /api/usage/daily?days=14&platform=all|codex|…
//   days      trailing calendar days to include (default 14, clamped 1–90)
//   platform  'all' (default) or one of lib/usage.js USAGE_PLATFORMS
//
// Response:
//   { generatedAt, days, platforms: string[], series: [{ date, total, byPlatform }] }
//   total/byPlatform = { input, output, cacheRead, cacheWrite, reasoning, cost, sessions }
//
// Aggregation lives in lib/usage.js (scan + bucket + cache); this route only
// validates and shapes the response.

const { USAGE_PLATFORMS, getDailyUsage } = require('../usage');

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const DIR_QUERY_PARAMS = {
  openclawDir: 'openclaw',
  codexDir: 'codex',
  claudeCodeDir: 'claude-code',
  claudeDesktopDir: 'claude-desktop',
  hermesDir: 'hermes',
  ompDir: 'omp',
  dshDir: 'dsh',
  geminiDir: 'gemini',
  cursorDir: 'cursor',
  doubaoDir: 'doubao',
  workbuddyDir: 'workbuddy',
  traeDir: 'trae',
};

function dirsFromQuery(query) {
  const dirs = {};
  for (const [param, platform] of Object.entries(DIR_QUERY_PARAMS)) {
    const value = query[param];
    if (typeof value === 'string' && value) dirs[platform] = value;
  }
  return dirs;
}

function clampDays(raw) {
  const n = numOr(raw, 14);
  if (n < 1) return 1;
  if (n > 90) return 90;
  return Math.round(n);
}

module.exports = function mountUsageRoutes(app) {
  app.get('/api/usage/daily', async (req, res) => {
    try {
      const days = clampDays(req.query.days);
      const platform = String(req.query.platform || 'all');
      if (platform !== 'all' && !USAGE_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: `unknown platform: ${platform}` });
      }
      const data = await getDailyUsage({ days, platform, dirs: dirsFromQuery(req.query) });
      return res.json(data);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
};

module.exports.clampDays = clampDays;
module.exports.dirsFromQuery = dirsFromQuery;
