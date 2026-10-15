const { aggregatePetState } = require('../pet-aggregator');

// ========= Global pet-state SSE =========
// GET /api/pet/state                 → Server-Sent Events, top-1 pet state (PRD §5.2)
// GET /api/pet/state?once=1          → single JSON snapshot (handy for curl/tests)
//
// Query params:
//   window    seconds of recent activity to consider (default 180)
//   interval   SSE poll interval in ms (default 2000, clamped 500–10000)
//
// Emits:
//   event: state  data: { state, platform, sessionId, agent, bubble, updatedAt }
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
      sessionId: null,
      agent: null,
      bubble: '空闲',
      updatedAt: Date.now(),
    });
    lastKey = 'idle|null|null|null|空闲';

    const emit = async () => {
      if (closed) return;
      try {
        const st = await snapshot();
        const key = `${st.state}|${st.platform}|${st.sessionId}|${st.agent}|${st.bubble}`;
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
}

module.exports = mountPetRoutes;
module.exports.clampIntervalMs = clampIntervalMs;
