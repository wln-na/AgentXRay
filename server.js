const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('./package.json');
const {
  DATA_DIR,
  CODEX_DIR,
  CLAUDE_CODE_DIR,
  CLAUDE_DESKTOP_DIR,
  HERMES_DIR,
  OMP_DIR,
  DSH_DIR,
  GEMINI_DIR,
  DOUBAO_DIR,
  WORKBUDDY_DIR,
  TRAE_DIR,
} = require('./lib/config');
const { PLATFORMS } = require('./lib/platforms');
const {
  buildHealth,
  cachePolicy,
  compressionMiddleware,
  installGracefulShutdown,
  requestLogger,
} = require('./lib/ops');
const mountInsightsRoutes = require('./lib/routes/insights');
const mountPromptRoutes = require('./lib/routes/prompts');
const mountSearchRoutes = require('./lib/routes/search');
const mountSessionRoutes = require('./lib/routes/sessions');
const mountExportRoutes = require('./lib/routes/export');
const mountLibraryRoutes = require('./lib/routes/library');
const mountBackupRoutes = require('./lib/routes/backup');
const mountWatchRoutes = require('./lib/routes/watch');
const mountPetRoutes = require('./lib/routes/pet');
const mountUsageRoutes = require('./lib/routes/usage');
const mountLlmRoutes = require('./lib/routes/llm');
const mountContextRoutes = require('./lib/routes/context');
const mountEvalRoutes = require('./lib/routes/evals');

const app = express();
const PORT = process.env.PORT || 3800;
// Bind to localhost by default: the dashboard exposes full AI session
// history (and ?dir= reads) with zero auth — opt into LAN via HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(__dirname, 'frontend', 'dist');
// Vite emits content-hashed filenames under assets/; everything else in dist
// (index.html, favicons) has a stable name and must be revalidated.
const DIST_ASSETS_PREFIX = `${path.join(DIST_DIR, 'assets')}${path.sep}`;
// Single frontend (the legacy vanilla UI was retired): serve the built React
// app from frontend/dist. `public/` is no longer served over HTTP.
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));
const PLATFORM_COUNT = Object.keys(PLATFORMS).length;

// Keep the SPA shell from becoming an unbounded filesystem-read endpoint.
// This small in-process limiter is sufficient for the localhost-first server;
// deployments behind a proxy should still enforce a network-level limit.
const SPA_RATE_WINDOW_MS = 60_000;
const SPA_RATE_MAX = 120;
const spaRateBuckets = new Map();
function spaRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = spaRateBuckets.get(key);
  if (!current || now - current.startedAt >= SPA_RATE_WINDOW_MS) {
    spaRateBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > SPA_RATE_MAX) {
    res.setHeader('Retry-After', '60');
    return res.status(429).end('Too many requests');
  }
  return next();
}

// --- Transport & ops middleware (lib/ops.js) -------------------------------
// Order matters: the logger wraps everything so it measures the full request,
// and the compressor sits in front of static + routes so every body (JSON,
// hashed JS/CSS, index.html, SVG) is eligible.
const SLOW_REQ_MS = Number(process.env.SLOW_REQ_MS);
app.use(
  requestLogger({
    slowMs: Number.isFinite(SLOW_REQ_MS) ? SLOW_REQ_MS : 500,
    logAll: process.env.AXR_LOG_REQUESTS === '1',
  })
);
app.use(compressionMiddleware());
// API responses may be stored but must revalidate: Express' default weak ETag
// then answers repeat requests with 304 instead of a full body.
app.use(cachePolicy());

// Frontend staleness detection: the SPA polls this and prompts a reload
// when the serving process (and thus possibly the code) has changed.
// Written without res.json on purpose: this response must never have an ETag
// (a 304 would hide a server restart) and must never be cached.
const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
app.get('/api/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ bootId: SERVER_BOOT_ID }));
});

// Cheap liveness/readiness probe: process counters only, no disk access.
app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(buildHealth({ version: pkg.version, platforms: PLATFORM_COUNT })));
});

if (HAS_DIST) {
  // Hashed assets get an immutable year; index.html and any other non-hashed
  // dist file are no-cache (stored, revalidated) so a new build is picked up.
  app.use(
    express.static(DIST_DIR, {
      maxAge: '365d',
      immutable: true,
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (!filePath.startsWith(DIST_ASSETS_PREFIX)) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );
}
app.use(express.json({ limit: '256kb' }));

// Route modules (lib/routes/*): business logic lives in lib/, routes keep
// only parameter validation and response shaping. Order matters only where
// paths overlap: the export route (/api/:platform/sessions/:id/export) is
// more specific than the generic session detail route, so it mounts first.
mountInsightsRoutes(app);
mountPromptRoutes(app);
mountSearchRoutes(app);
mountExportRoutes(app);
mountSessionRoutes(app);
mountLibraryRoutes(app);
mountBackupRoutes(app);
mountWatchRoutes(app);
mountPetRoutes(app);
mountUsageRoutes(app);
mountLlmRoutes(app);
mountContextRoutes(app);
mountEvalRoutes(app);

// API 404s must stay JSON. Without this branch the SPA fallback would return
// index.html with status 200, and callers would fail while parsing HTML as JSON.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// SPA fallback: every non-API path renders the one remaining UI (the React app
// in frontend/dist). The shell must revalidate (no-cache + ETag) so a rebuilt
// UI is not served stale forever. Without a build the API still works and this
// route explains how to build the UI — the retired `/legacy` path has no shell.
app.get('*', spaRateLimit, (_req, res) => {
  if (!HAS_DIST) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(503).end('AgentXRay UI is not built. Run `npm run build:ui`, then restart the server.');
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`AgentXRay listening on http://${HOST}:${PORT}`);
  console.log(`  OpenClaw:    ${DATA_DIR}`);
  console.log(`  Codex:       ${CODEX_DIR}`);
  console.log(`  Claude Code: ${CLAUDE_CODE_DIR}`);
  console.log(`  Claude Desktop: ${CLAUDE_DESKTOP_DIR}`);
  console.log(`  Hermes:      ${path.join(HERMES_DIR, 'state.db')}`);
  console.log(`  OMP:         ${OMP_DIR}`);
  console.log(`  DeepSeek Harness: ${DSH_DIR}`);
  console.log(`  Gemini CLI:  ${GEMINI_DIR}`);
  console.log(`  Doubao:      ${DOUBAO_DIR}`);
  console.log(`  WorkBuddy:   ${WORKBUDDY_DIR}`);
  console.log(`  Trae CN:     ${TRAE_DIR}`);
});

// SIGTERM/SIGINT stop accepting connections, let in-flight responses finish for
// up to 3 s, then exit. Never process.exit while a response is still writing.
const shutdown = installGracefulShutdown(server);
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
