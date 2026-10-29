const { aggregatePetState } = require('../pet-aggregator');

// ========= Global pet-state SSE =========
// GET /api/pet/state                 → Server-Sent Events, top-1 pet state (PRD §5.2)
// GET /api/pet/state?once=1          → single JSON snapshot (handy for curl/tests)
// POST /api/pet/ignore               → dismiss a session from the pet
// POST /api/pet/ignore/clear         → lift a dismissal
//
// Query params:
//   window    seconds of recent activity to consider (default 180)
//   interval   SSE poll interval in ms (default 2000, clamped 500–10000)
//
// Emits:
//   event: state  data: { state, platform, platformLabel, sessionId, title, agent, bubble, activeCount, sessions[], updatedAt }
//   event: error  data: { error }
//
// Keep-alive pings every 15s; emits only on change so the client isn't spammed
// with identical frames. SSE plumbing only — aggregation lives in
// lib/pet-aggregator.js.

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  return function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 10000;
const DEFAULT_INTERVAL_MS = 2000;

// Bind the SSE poll interval to a fixed range.
//
// Written as explicit comparisons rather than Math.min/Math.max on purpose: the
// bounds must be readable as range guards on the value that reaches the timer,
// because static analysis (CodeQL js/resource-exhaustion) does not model
// Math.min/Math.max as a sanitizer and otherwise reports the poll timer duration
// as attacker-controlled.
function clampIntervalMs(raw) {
  const n = numOr(raw, DEFAULT_INTERVAL_MS);
  if (n < MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
  if (n > MAX_INTERVAL_MS) return MAX_INTERVAL_MS;
  return n;
}

const { PLATFORMS } = require('../platforms');
const { SESSION_ID_RE, AGENT_NAME_RE } = require('../config');
const { defaultStore: petIgnoreStore, sessionKey } = require('../pet-ignore');

// Validate a pet-ignore target. Returns an error string, or null when valid.
// Kept as a pure exported function so the range/format rules are unit-testable
// (mirrors clampIntervalMs). sessionId/agent must be printable-safe so the key
// can never smuggle path or shell characters anywhere.
function validatePetIgnore(platform, sessionId, agent) {
  if (!platform || !PLATFORMS[platform]) return `unknown platform: ${platform || '(empty)'}`;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return `invalid sessionId: ${sessionId || '(empty)'}`;
  if (agent && !AGENT_NAME_RE.test(agent)) return `invalid agent: ${agent}`;
  return null;
}

function petIgnoreBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return {
    platform: String(body.platform || ''),
    sessionId: String(body.sessionId || ''),
    agent: body.agent ? String(body.agent) : '',
    durationMs: body.durationMs,
  };
}

function mountPetRoutes(app) {
  app.get('/api/pet/state', async (req, res) => {
    const once = req.query.once === '1' || req.query.once === 'true';
    const windowMs = numOr(req.query.window, 180) * 1000;
    const intervalMs = clampIntervalMs(req.query.interval);
    const thresholds = {};

    const snapshot = () => aggregatePetState({ now: Date.now(), windowMs, thresholds });

    if (once) {
      try {
        return res.json(await snapshot());
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    const send = sseInit(res);
    let closed = false;
    let lastKey = '';

    // Immediate idle frame so the widget shows "connected" right away while the
    // (potentially slow, first-time) enumeration runs. The real top-1 state
    // replaces it as soon as it's computed; a fresh idle won't re-emit.
    send('state', {
      state: 'idle',
      platform: null,
      platformLabel: null,
      sessionId: null,
      title: null,
      agent: null,
      bubble: '空闲',
      activeCount: 0,
      sessions: [],
      updatedAt: Date.now(),
    });
    lastKey = 'idle|null|null|null|null|null|空闲|0|';

    const emit = async () => {
      if (closed) return;
      try {
        const st = await snapshot();
        // Digest the whole sessions list into the change key: dismissing a
        // lower-priority session can change the list without touching top-1 /
        // activeCount, and the renderer must still learn about it.
        const sessKey = (st.sessions || []).map((s) => `${s.platform}:${s.sessionId}:${s.state}`).join('|');
        const key = `${st.state}|${st.platform}|${st.sessionId}|${st.agent}|${st.title || ''}|${st.platformLabel || ''}|${st.bubble}|${st.activeCount || 0}|${sessKey}`;
        if (key !== lastKey) {
          lastKey = key;
          send('state', st);
        }
      } catch (e) {
        send('error', { error: e.message });
      }
    };

    await emit();
    const pollTimer = setInterval(emit, intervalMs);
    const pingTimer = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15000);
    req.on('close', () => {
      closed = true;
      clearInterval(pollTimer);
      clearInterval(pingTimer);
    });
  });

  // ========= Pet-ignore (dismiss a session from the pet) =========
  // POST   /api/pet/ignore       {platform, sessionId, agent?, durationMs?} → ignore
  // POST   /api/pet/ignore/clear {platform, sessionId, agent?}              → lift
  // Dismissed sessions stay out of the pet sessions list / top-1 until the
  // ignore expires or the user writes back into the session (see
  // lib/pet-ignore.js). Best-effort: errors here never affect the SSE stream.
  app.post('/api/pet/ignore', async (req, res) => {
    const { platform, sessionId, agent, durationMs } = petIgnoreBody(req);
    const invalid = validatePetIgnore(platform, sessionId, agent);
    if (invalid) return res.status(400).json({ ok: false, error: invalid });
    const entry = await petIgnoreStore.set(sessionKey(platform, sessionId, agent), { durationMs });
    return res.json({ ok: true, ignoredAt: entry.ignoredAt, until: entry.until });
  });

  app.post('/api/pet/ignore/clear', async (req, res) => {
    const { platform, sessionId, agent } = petIgnoreBody(req);
    const invalid = validatePetIgnore(platform, sessionId, agent);
    if (invalid) return res.status(400).json({ ok: false, error: invalid });
    const removed = await petIgnoreStore.remove(sessionKey(platform, sessionId, agent));
    return res.json({ ok: true, removed });
  });
}

module.exports = mountPetRoutes;
module.exports.clampIntervalMs = clampIntervalMs;
module.exports.validatePetIgnore = validatePetIgnore;
