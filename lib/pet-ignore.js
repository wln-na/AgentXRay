// Persistent "don't remind me about this session in the pet" store.
//
// The pet bubbles sessions touched in the last 3 minutes (see
// lib/pet-aggregator.js). A user may not care about a particular conversation —
// a sub-agent still grinding in the background, or a session sitting in
// waiting_input they'll never answer. Dismissing a session writes an entry
// here; the aggregator hides it from the sessions list (and top-1) until the
// entry expires OR the user writes back into the session (a new `user` message
// after the ignore time) — the latter means they're engaging again, so the
// session should re-surface immediately.
//
// Storage: one JSON file under ~/.agentxray (PET_IGNORE_FILE, env-overridable).
// Writes are serialized through a promise queue and flushed atomically
// (write temp + rename) so concurrent dismisses can't corrupt the file.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { PET_IGNORE_FILE } = require('./config');

// Default silence window before a dismissed session is allowed back into the
// pet list. Bounded so an ignored entry can never be written to be effectively
// forever, and never so short that a dismiss is useless.
const DEFAULT_IGNORE_MS = 30 * 60 * 1000; // 30 min
const MIN_IGNORE_MS = 60 * 1000; // 1 min
const MAX_IGNORE_MS = 24 * 60 * 60 * 1000; // 24 h

function clampDurationMs(raw, fallback = DEFAULT_IGNORE_MS) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_IGNORE_MS, Math.max(MIN_IGNORE_MS, Math.round(n)));
}

// Stable per-session key shared with the aggregator's session identity:
// `platform:agent:sessionId`. An empty agent (non-agent platforms) is encoded
// as an empty segment so codex:user:1 and codex::1 never collide.
function sessionKey(platform, sessionId, agent) {
  return `${platform}:${agent || ''}:${sessionId}`;
}

async function readJson(file) {
  try {
    const [raw, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
    return { raw, stat };
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function parseEntries(raw) {
  const map = new Map();
  if (!raw) return map;
  try {
    const data = JSON.parse(raw);
    const obj = data && typeof data === 'object' ? data.entries || data : {};
    for (const [key, e] of Object.entries(obj)) {
      if (!e || typeof e !== 'object') continue;
      const ignoredAt = Number(e.ignoredAt);
      const until = Number(e.until);
      if (!Number.isFinite(ignoredAt) || !Number.isFinite(until)) continue;
      map.set(key, { ignoredAt, until });
    }
  } catch {
    // Malformed file → treat as empty and let the next mutation overwrite it.
  }
  return map;
}

/**
 * Create an ignore store backed by a JSON file (default ~/.agentxray).
 *
 * All reads are served from an in-memory map loaded once from disk; writes
 * flush atomically. Inject `file` (path) and `now` (clock) for tests.
 */
function createPetIgnoreStore(opts = {}) {
  const file = opts.file || PET_IGNORE_FILE;
  const nowFn = opts.now || (() => Date.now());

  let entries = null; // null = not loaded yet
  let pendingWrite = Promise.resolve();

  async function load() {
    if (entries) return entries;
    const loaded = await readJson(file);
    entries = loaded ? parseEntries(loaded.raw) : new Map();
    return entries;
  }

  function atomicWrite() {
    const data = { version: 1, updatedAt: nowFn(), entries: Object.fromEntries(entries || []) };
    const tmp = `${file}.tmp`;
    return fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8'))
      .then(() => fsp.rename(tmp, file));
  }

  function persist() {
    // Serialize writes; swallow IO errors — ignoring a session is best-effort
    // (the entry just won't survive a restart), it must never break the pet.
    pendingWrite = pendingWrite.then(atomicWrite).catch(() => {});
    return pendingWrite;
  }

  /**
   * Look up an entry; expired entries are dropped (memory-only) and report null.
   * @returns {Promise<{ignoredAt:number, until:number}|null>}
   */
  async function get(key) {
    const map = await load();
    const e = map.get(key);
    if (!e) return null;
    if (e.until <= nowFn()) {
      map.delete(key);
      return null;
    }
    return { ignoredAt: e.ignoredAt, until: e.until };
  }

  /**
   * Ignore a session for `durationMs` (clamped) from now.
   * @returns {Promise<{ignoredAt:number, until:number}>}
   */
  async function set(key, { durationMs } = {}) {
    const map = await load();
    const now = nowFn();
    const entry = { ignoredAt: now, until: now + clampDurationMs(durationMs) };
    map.set(key, entry);
    await persist();
    return entry;
  }

  /** Remove an ignore entry. Returns true when one existed. */
  async function remove(key) {
    const map = await load();
    const had = map.delete(key);
    if (had) await persist();
    return had;
  }

  /** Snapshot of the non-expired entries as a plain object (for debugging/tests). */
  async function snapshot() {
    const map = await load();
    const out = {};
    const now = nowFn();
    for (const [k, e] of map) {
      if (e.until > now) out[k] = { ...e };
    }
    return out;
  }

  return {
    get,
    set,
    remove,
    snapshot,
    sessionKey: (platform, sessionId, agent) => sessionKey(platform, sessionId, agent),
  };
}

// Process-wide default store (the server owns the file).
const defaultStore = createPetIgnoreStore();

module.exports = {
  DEFAULT_IGNORE_MS,
  MIN_IGNORE_MS,
  MAX_IGNORE_MS,
  clampDurationMs,
  sessionKey,
  createPetIgnoreStore,
  defaultStore,
};
