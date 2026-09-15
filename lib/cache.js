'use strict';

/**
 * Unified LRU + TTL cache factory.
 *
 * Replaces the six module-level `new Map()` caches that had no size bound
 * and no eviction — a memory leak that grows linearly with uptime when
 * AgentXRay runs as a long-lived server.
 *
 * Usage:
 *   const cache = createCache({ max: 500, ttl: 5 * 60 * 1000 });
 *   cache.set('key', value);
 *   cache.get('key'); // → value or undefined
 *
 * Options:
 *   max  — maximum entries; when exceeded, least-recently-used is evicted.
 *          Default 1000. Set to 0 or Infinity for unbounded (not recommended).
 *   ttl  — time-to-live in ms; entries older than this are treated as missing.
 *          Default 0 = no TTL.
 *
 * The returned object is Map-compatible (get/set/has/delete/clear/size/keys)
 * so it can be a drop-in replacement for `new Map()` in most call sites.
 */

function createCache({ max = 1000, ttl = 0 } = {}) {
  // Internal Map preserves insertion order; we re-insert on get() to make
  // insertion order = recency order (the classic JS LRU trick).
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (entry === undefined) return undefined;
    // TTL check
    if (ttl > 0 && Date.now() - entry.setAt > ttl) {
      store.delete(key);
      return undefined;
    }
    // LRU: re-insert to mark as most-recently-used
    store.delete(key);
    store.set(key, entry);
    return entry.value;
  }

  function set(key, value) {
    // If key exists, delete first so re-insertion updates recency.
    if (store.has(key)) store.delete(key);
    store.set(key, { value, setAt: Date.now() });
    // Evict LRU entries (oldest = first in insertion order)
    if (max > 0 && max !== Infinity) {
      while (store.size > max) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
      }
    }
    return value;
  }

  function has(key) {
    return get(key) !== undefined;
  }

  function del(key) {
    return store.delete(key);
  }

  function clear() {
    store.clear();
  }

  function keys() {
    // Return only non-expired keys
    const now = Date.now();
    const result = [];
    for (const [key, entry] of store) {
      if (ttl > 0 && now - entry.setAt > ttl) continue;
      result.push(key);
    }
    return result[Symbol.iterator]();
  }

  Object.defineProperty(
    {
      get,
      set,
      has,
      delete: del,
      clear,
      keys,
    },
    'size',
    {
      get() {
        // Count non-expired entries
        if (ttl <= 0) return store.size;
        const now = Date.now();
        let count = 0;
        for (const entry of store.values()) {
          if (now - entry.setAt <= ttl) count++;
        }
        return count;
      },
      enumerable: true,
    }
  );

  // Return the object with size getter
  const cache = {
    get,
    set,
    has,
    delete: del,
    clear,
    keys,
  };
  Object.defineProperty(cache, 'size', {
    get() {
      if (ttl <= 0) return store.size;
      const now = Date.now();
      let count = 0;
      for (const entry of store.values()) {
        if (now - entry.setAt <= ttl) count++;
      }
      return count;
    },
    enumerable: true,
  });
  return cache;
}

module.exports = { createCache };
