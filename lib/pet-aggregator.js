// Global pet-state aggregator for AgentXRay.
//
// Enumerates recently-active sessions across every registered platform, derives
// a single agent state for each (via lib/pet-state.js), then picks the
// highest-priority one to drive the desktop pet. Pure derivation logic is split
// out (rankState / pickTopState) so it can be unit-tested without touching disk.
//
// See docs/pet-state-prd.md §5.2 (P1: global aggregation SSE).

const { PLATFORMS } = require('./platforms');
const { listSessionsForAgent } = require('./platforms/openclaw');
const { readAgents } = require('./config');
const { deriveState } = require('./pet-state');
const { createCache } = require('./cache');

// Priority per PRD §4.1: waiting_input > error > working > thinking > done > idle
const STATE_RANK = Object.freeze({
  idle: 0,
  done: 1,
  thinking: 2,
  working: 3,
  error: 4,
  waiting_input: 5,
});

// Only consider sessions touched within this window — the pet is about "what is
// happening right now", and deriveState already cools anything older than 120s to
// idle anyway. 3 min gives margin for the waiting_input (15s) / idle (120s) bands.
const DEFAULT_WINDOW_MS = 180_000;

// Enumerating every platform's sessions is the dominant cost (FS reads over 9
// platform dirs — on a cold disk cache this is several seconds). The set of
// *recently active* sessions changes slowly, so we cache the enumeration per
// platform-set with a 30s TTL. The per-session *state* is still recomputed fresh
// on every poll (cheap once we know which sessions to look at), so the pet's
// accuracy comes from the fast path — only the appearance of brand-new sessions
// is delayed by up to ENUM_CACHE_TTL_MS. A recompute every 30s beats re-scanning
// all dirs on every 2s poll.
const ENUM_CACHE_BUCKET_MS = 30_000;
const ENUM_CACHE_TTL_MS = 30_000;
// Cap how many recently-active sessions we fully parse per poll. The
// highest-priority states (waiting_input ~15s / error) live in the most-recent
// activity, so parsing the 64 most-recent is sufficient and bounds pathological
// scans on a very busy machine.
const MAX_CANDIDATES = 64;

// platform-set ref -> LRU(time-bucketed) of enumeration results. Keyed by the
// platforms *object reference* so injected test registries never collide.
const enumerationCache = new WeakMap();

function rankState(state) {
  return STATE_RANK[state] ?? 0;
}

/**
 * Pick the single highest-priority candidate. Ties (same rank) break toward the
 * most recently active session (largest lastActivity). Returns null when empty.
 * @param {Array<{state:string,lastActivity:number,platform:string,sessionId:string,agent?:string|null,bubble:string,platformLabel?:string}>} candidates
 */
function pickTopState(candidates) {
  let best = null;
  for (const c of candidates) {
    const rank = rankState(c.state);
    const bestRank = best ? rankState(best.state) : -1;
    if (!best || rank > bestRank || (rank === bestRank && (c.lastActivity || 0) > (best.lastActivity || 0))) {
      best = c;
    }
  }
  return best;
}

// Enumerate a single platform's recently-active sessions. Defensive about the
// platform `list`/`getSession` contract: some are async (return a promise), some
// are sync (return an array), and any of them may throw or reject — wrap with
// Promise.resolve + .catch so a broken platform can never take down the pet.
async function enumeratePlatform(platform, now, windowMs) {
  if (!platform || typeof platform.defaultDir !== 'function') return [];
  const dir = platform.defaultDir();
  let summaries = [];
  try {
    if (platform.needsAgent) {
      const agents = await Promise.resolve(readAgents(dir)).catch(() => []);
      for (const agent of agents) {
        const list = await Promise.resolve(listSessionsForAgent(dir, agent)).catch(() => []);
        summaries.push(...list.map((s) => ({ ...s, agent })));
      }
    } else if (typeof platform.list === 'function') {
      summaries = await Promise.resolve(platform.list(dir)).catch(() => []);
    }
  } catch {
    summaries = [];
  }
  const out = [];
  for (const s of summaries) {
    const la = s.lastActivity ? Date.parse(s.lastActivity) : NaN;
    if (!Number.isFinite(la)) continue;
    if (now - la > windowMs) continue;
    if (!s.id) continue;
    out.push({
      platform: platform.id,
      platformLabel: platform.label,
      sessionId: s.id,
      title: s.title || null,
      agent: s.agent || null,
      lastActivity: la,
      dir,
    });
  }
  return out;
}

/**
 * Enumerate sessions with activity within `windowMs` of `now`.
 * @returns {Promise<Array<{platform:string,platformLabel:string,sessionId:string,title:string|null,agent:string|null,lastActivity:number,dir:string}>>}
 */
async function collectActiveSessions({ now, windowMs = DEFAULT_WINDOW_MS, platforms = PLATFORMS } = {}) {
  const bucket = Math.floor(now / ENUM_CACHE_BUCKET_MS);
  const key = `${windowMs}:${bucket}`;
  let inner = enumerationCache.get(platforms);
  if (!inner) {
    inner = createCache({ max: 8, ttl: ENUM_CACHE_TTL_MS });
    enumerationCache.set(platforms, inner);
  }
  const cached = inner.get(key);
  if (cached) return cached; // a promise (dedupes concurrent callers) or its result
  const promise = (async () => {
    const all = await Promise.all(Object.values(platforms).map((p) => enumeratePlatform(p, now, windowMs)));
    return all.flat().sort((a, b) => b.lastActivity - a.lastActivity);
  })();
  inner.set(key, promise);
  return promise;
}

// Per-call cache of parsed message arrays so a fast-poll SSE connection (interval
// < TTL) doesn't reparse the same session file on every tick. Created fresh per
// aggregatePetState call — never module-global — so concurrent sessions / tests
// can't leak cached messages across invocations.
async function getMessages(platform, dir, sessionId, agent, cache) {
  const key = `${platform.id}:${agent || ''}:${sessionId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let messages = [];
  try {
    const detail = await Promise.resolve(platform.getSession(dir, sessionId, { agent }));
    messages = Array.isArray(detail?.messages) ? detail.messages : [];
  } catch {
    messages = [];
  }
  cache.set(key, messages);
  return messages;
}

/**
 * Aggregate every recently-active session into a single pet state (top-1 by
 * priority). Returns an idle state when nothing is active.
 * @returns {Promise<{state:string,platform:string|null,platformLabel:string|null,sessionId:string|null,title:string|null,agent:string|null,bubble:string,updatedAt:number}>}
 */
async function aggregatePetState({
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  thresholds = {},
  platforms = PLATFORMS,
} = {}) {
  const active = await collectActiveSessions({ now, windowMs, platforms });
  const sessionCache = createCache({ max: 256, ttl: 1500 });
  const candidates = (await Promise.all(
    active.slice(0, MAX_CANDIDATES).map(async (a) => {
      const platform = platforms[a.platform];
      if (!platform) return null;
      const messages = await getMessages(platform, a.dir, a.sessionId, a.agent, sessionCache);
      const st = deriveState(messages, { now, thresholds });
      return {
        state: st.state,
        bubble: st.bubble,
        platform: a.platform,
        platformLabel: a.platformLabel,
        sessionId: a.sessionId,
        title: a.title,
        agent: a.agent,
        lastActivity: a.lastActivity,
      };
    })
  )).filter(Boolean);

  // 与 pickTopState 同序：优先级高在前，同分取最近活跃。
  const sorted = candidates.sort(
    (a, b) => rankState(b.state) - rankState(a.state) || (b.lastActivity || 0) - (a.lastActivity || 0)
  );
  const sessions = sorted.map((c) => ({
    state: c.state,
    platform: c.platform,
    platformLabel: c.platformLabel || null,
    sessionId: c.sessionId,
    title: c.title || null,
    agent: c.agent || null,
    bubble: c.bubble,
  }));
  const activeCount = sessions.filter((s) => s.state !== 'idle').length;

  const top = sorted[0] || null;
  if (!top) {
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
      updatedAt: now,
    };
  }
  return {
    state: top.state,
    platform: top.platform,
    platformLabel: top.platformLabel || null,
    sessionId: top.sessionId,
    title: top.title || null,
    agent: top.agent || null,
    bubble: top.bubble,
    activeCount,
    sessions,
    updatedAt: now,
  };
}

module.exports = {
  STATE_RANK,
  rankState,
  pickTopState,
  collectActiveSessions,
  aggregatePetState,
  DEFAULT_WINDOW_MS,
};
