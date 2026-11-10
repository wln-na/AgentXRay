const { aggregatePetState } = require('../pet-aggregator');
const { sseInit, numOr } = require('../sse');

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
//
// Connections are grouped into shared hubs: one timer + one aggregation per
// distinct subscription config (interval/window/thresholds), fanned out to every
// subscriber. Previously each client owned its own setInterval and each poll
// re-aggregated independently, so N tabs cost N× the work; the hub is created by
// the first subscriber and torn down by the last, so no timer outlives its
// clients.

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

// ========= Shared SSE hubs =========
// One aggregator timer per distinct subscription config, broadcast to every
// connected response. Clients that ask for the same window/interval observe the
// exact same stream, so sharing the poll turns N subscribers into 1 aggregation
// per tick instead of N.

const PING_INTERVAL_MS = 15000;

// Key every query parameter that can change the emitted payload. Thresholds are
// fixed today but included so a future override can't silently share a hub.
function hubKey(intervalMs, windowMs, thresholds) {
  return `${intervalMs}|${windowMs}|${JSON.stringify(thresholds || {})}`;
}

// Digest of everything the client can observe. The whole sessions list is
// included: dismissing a lower-priority session can change the list without
// touching top-1 / activeCount, and the renderer must still learn about it.
// updatedAt is deliberately excluded — it changes on every tick and would defeat
// "emit only on change".
function stateKey(st) {
  const sessKey = (st.sessions || []).map((s) => `${s.platform}:${s.sessionId}:${s.state}`).join('|');
  return `${st.state}|${st.platform}|${st.sessionId}|${st.agent}|${st.title || ''}|${st.platformLabel || ''}|${st.bubble}|${st.activeCount || 0}|${sessKey}`;
}

// Immediate idle frame so the widget shows "connected" right away while the
// (potentially slow, first-time) enumeration runs. Fresh object per connection
// because updatedAt is per-connect; a fresh idle won't re-emit once the real
// state lands.
function idleSnapshot() {
  return {
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
  };
}

// Seed for "what this connection has already been sent". Kept as the historical
// literal (which intentionally does not match stateKey(idleSnapshot())) so a new
// connection still observes idle frame → real snapshot even when the pet is idle,
// exactly as it did when every client seeded its own lastKey.
const IDLE_SEED_KEY = 'idle|null|null|null|null|null|空闲|0|';

// Config key -> hub. Bounded by live subscriptions: a hub only exists while it
// has at least one subscriber.
const hubs = new Map();

function writeFrame(sub, eventName, data) {
  if (sub.closed) return;
  try {
    sub.send(eventName, data);
  } catch {
    // The socket can die between req 'close' and the next tick; tear this
    // subscriber down so a dead client can never break the fan-out.
    sub.close();
  }
}

function createHub({ intervalMs, windowMs, thresholds }) {
  const hub = {
    key: hubKey(intervalMs, windowMs, thresholds),
    intervalMs,
    windowMs,
    thresholds,
    subscribers: new Set(),
    timer: null,
    inflight: null,
    lastState: null,
  };

  // Fan one freshly aggregated snapshot out to every subscriber, skipping
  // clients whose last delivered key already equals it (emit only on change).
  hub.broadcast = (st) => {
    hub.lastState = st;
    const key = stateKey(st);
    for (const sub of hub.subscribers) {
      if (sub.closed || sub.lastKey === key) continue;
      sub.lastKey = key;
      writeFrame(sub, 'state', st);
    }
  };

  // One aggregation per tick. A timer tick that lands while the previous
  // aggregation is still running (metadata caches cold can take seconds) joins
  // the in-flight promise instead of piling up more work.
  hub.tick = () => {
    if (hub.inflight) return hub.inflight;
    if (hub.subscribers.size === 0) return Promise.resolve();
    const run = aggregatePetState({ now: Date.now(), windowMs: hub.windowMs, thresholds: hub.thresholds })
      .then((st) => {
        if (hub.subscribers.size > 0) hub.broadcast(st);
      })
      .catch((e) => {
        for (const sub of hub.subscribers) writeFrame(sub, 'error', { error: e.message });
      })
      .finally(() => {
        hub.inflight = null;
      });
    hub.inflight = run;
    return run;
  };

  hub.start = () => {
    if (hub.timer) return;
    hub.timer = setInterval(() => {
      void hub.tick();
    }, hub.intervalMs);
  };

  hub.stop = () => {
    if (!hub.timer) return;
    clearInterval(hub.timer);
    hub.timer = null;
  };

  return hub;
}

function hubFor(config) {
  const key = hubKey(config.intervalMs, config.windowMs, config.thresholds);
  let hub = hubs.get(key);
  if (!hub) {
    hub = createHub(config);
    hubs.set(key, hub);
  }
  hub.start();
  return hub;
}

// Attach one SSE response to the hub for its config, preserving the per-client
// wire behaviour: idle frame immediately, then the current state without waiting
// for the next tick (last broadcast when the hub is already running, otherwise a
// fresh aggregation).
function subscribeSse(req, res, config) {
  const send = sseInit(res);
  const hub = hubFor(config);
  const sub = { send, lastKey: IDLE_SEED_KEY, closed: false, pingTimer: null, close: null };

  sub.close = () => {
    if (sub.closed) return;
    sub.closed = true;
    clearInterval(sub.pingTimer);
    hub.subscribers.delete(sub);
    if (hub.subscribers.size === 0) {
      hub.stop();
      if (hubs.get(hub.key) === hub) hubs.delete(hub.key);
    }
  };

  writeFrame(sub, 'state', idleSnapshot());

  hub.subscribers.add(sub);
  if (hub.lastState) {
    hub.broadcast(hub.lastState); // existing subscribers are skipped by stateKey
  } else {
    void hub.tick(); // first subscriber: don't make it wait a full interval
  }

  sub.pingTimer = setInterval(() => {
    if (sub.closed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      sub.close();
    }
  }, PING_INTERVAL_MS);

  req.on('close', () => sub.close());
  return sub;
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

    subscribeSse(req, res, { intervalMs, windowMs, thresholds });
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
