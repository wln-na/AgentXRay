// Pet-state reducer: turns a normalized message stream into a single agent
// state enum the desktop pet (and, later, the sidebar / web widget) can render.
//
// This is a pure function: feed it the full message list of one session plus a
// `now` timestamp, get back { state, bubble, … }. No I/O, no timers, no
// hidden module state — that makes the time-cooling branches unit-testable.
//
// See docs/pet-state-prd.md for the state machine definition and acceptance
// criteria.

const DEFAULT_THRESHOLDS = Object.freeze({
  // No event at all within this window → idle regardless of instant state.
  idleAfter: 120_000,
  // Assistant text older than this and still nothing new → waiting_input.
  waitingAfter: 15_000,
  // Assistant text fresher than this still shows "done" with the text bubble.
  doneBubbleWindow: 8_000,
});

function isoToMs(ts) {
  if (!ts || typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function textOf(msg) {
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
    .trim();
}

function truncate(s, n = 60) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Derive the pet state for one session from its normalized messages.
 *
 * @param {Array} messages  normalized messages (see makeMessage in
 *                          lib/platforms/shared.js), time-ascending
 * @param {object} [opts]
 * @param {number} [opts.now]           epoch ms, defaults to Date.now()
 * @param {object} [opts.thresholds]     override idleAfter/waitingAfter/…
 * @returns {{state: string, bubble: string, lastEventAt: number|null,
 *            pendingToolCalls: Array, errorSticky: boolean}}
 */
function deriveState(messages, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };

  const out = {
    state: 'idle',
    bubble: '空闲',
    lastEventAt: null,
    pendingToolCalls: [],
    errorSticky: false,
  };

  if (!Array.isArray(messages) || messages.length === 0) return out;

  // Ordered pending set: toolCallId -> { toolName, at }. Preserve insertion
  // order so "latest pending tool" is deterministic.
  const pending = new Map();
  let lastEventAt = null;
  let lastAssistantTextAt = null;
  let lastAssistantText = '';
  let lastErrorText = '';
  // Instant state from walking the message stream; time cooling happens after.
  let instant = 'idle';

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const at = isoToMs(msg.timestamp);
    if (at !== null && (lastEventAt === null || at > lastEventAt)) {
      lastEventAt = at;
    }

    switch (msg.role) {
      case 'user': {
        // A new user instruction closes any previous error/pending loop.
        pending.clear();
        out.errorSticky = false;
        instant = 'thinking';
        break;
      }
      case 'assistant': {
        const text = textOf(msg);
        if (text) {
          if (at !== null) lastAssistantTextAt = at;
          lastAssistantText = text;
          // Assistant prose answers the previous error — clear sticky.
          out.errorSticky = false;
        }
        // If tools are still outstanding the turn is not over yet.
        instant = pending.size === 0 ? 'done' : 'working';
        break;
      }
      case 'toolCall': {
        const id = msg.toolCallId || `unnamed-${pending.size}`;
        pending.set(id, { toolName: msg.toolName || 'tool', at });
        instant = 'working';
        break;
      }
      case 'toolResult': {
        const id = msg.toolCallId;
        if (id && pending.has(id)) pending.delete(id);
        if (msg.isError) {
          out.errorSticky = true;
          lastErrorText = textOf(msg);
        }
        instant = pending.size === 0 ? 'thinking' : 'working';
        break;
      }
      case 'reasoning':
        // Reasoning blocks are model activity, not a state transition.
        break;
      default:
        break;
    }
  }

  out.pendingToolCalls = [...pending.entries()].map(([toolCallId, v]) => ({
    toolCallId,
    toolName: v.toolName,
  }));
  out.lastEventAt = lastEventAt;

  // ---- Time cooling: turn the instant state into a semantic state ----
  let state = instant;
  if (lastEventAt !== null && now - lastEventAt > thresholds.idleAfter) {
    state = 'idle';
  } else if (out.errorSticky && (state === 'thinking' || state === 'done' || state === 'idle')) {
    state = 'error';
  } else if (state === 'done') {
    const sinceAssistant = lastAssistantTextAt === null ? Number.POSITIVE_INFINITY : now - lastAssistantTextAt;
    if (sinceAssistant > thresholds.waitingAfter) {
      state = 'waiting_input';
    } else {
      // within [0, waitingAfter] → done (the <= doneBubbleWindow branch is
      // also "done"; we just keep the bubble text below)
      state = 'done';
    }
  }

  out.state = state;

  // ---- Bubble text ----
  switch (state) {
    case 'working': {
      const pendingList = [...pending.values()];
      const latest = pendingList[pendingList.length - 1];
      out.bubble = latest ? `正在调用 ${latest.toolName}` : '正在工作…';
      break;
    }
    case 'thinking':
      out.bubble = '思考中…';
      break;
    case 'done':
      out.bubble = truncate(lastAssistantText, 60) || '完成';
      break;
    case 'waiting_input':
      out.bubble = '需要你的输入';
      break;
    case 'error':
      out.bubble = truncate(lastErrorText, 60) || '出错了';
      break;
    default:
      out.bubble = '空闲';
      break;
  }

  return out;
}

module.exports = { deriveState, DEFAULT_THRESHOLDS };
