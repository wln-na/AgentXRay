// Shared per-file session-log index.
//
// Four bulk aggregation endpoints (/api/insights, /api/prompts,
// /api/tools/audit, /api/usage/daily) all walk the same session files of a
// platform and derive a per-file aggregate from each. Before this module every
// caller had its own walk and its own mtime cache (or no cache at all), with
// different invalidation rules. This is the single per-file layer:
//
//   1. enumerate the files once, with identity = { path, mtimeMs, size };
//   2. cache each caller's aggregate under `path|mtimeMs|size|kind`, where the
//      kind separates the differently-shaped aggregates (insights counters,
//      prompt lists, tool-audit rollups, daily usage buckets).
//
// Content aggregates get NO TTL: mtime+size is the invalidation, and an
// unchanged session log must never be re-read. Memory is bounded twice — by
// entry count and by an estimated total byte budget, because aggregates differ
// wildly in size (prompts carry prompt text; insights carry small counters).

const fsp = require('node:fs/promises');
const { createCache } = require('./cache');
const { collectSessionFiles } = require('./platforms');

// Bounds are deliberately generous: a large multi-platform install has a few
// thousand session logs, and a warm aggregate is tiny compared to the log it
// was derived from. The byte budget is the real safety valve.
const AGGREGATE_CACHE_MAX_ENTRIES = 5000;
const AGGREGATE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const AGGREGATE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const STAT_CONCURRENCY = 16;

// createCache provides the LRU + delete/get bookkeeping; we keep our own byte
// ledger next to it so the byte budget can be enforced exactly.
const aggregateCache = createCache({ max: AGGREGATE_CACHE_MAX_ENTRIES, ttl: 0 });
const entryBytes = new Map(); // cache key → estimated bytes
const counters = { hits: 0, misses: 0, evictions: 0, oversized: 0 };
let cachedBytes = 0;

// Rough owned-size estimate, used only for the memory budget. Conservative
// (UTF-16 string length) and depth/count-capped so a pathological aggregate
// cannot make estimation more expensive than the scan that produced it.
function estimateBytes(root) {
  let bytes = 0;
  const stack = [root];
  const seen = new Set();
  let visited = 0;
  while (stack.length > 0 && visited < 100_000) {
    const value = stack.pop();
    visited++;
    if (value === null || value === undefined) continue;
    const type = typeof value;
    if (type === 'string') {
      bytes += value.length * 2;
      continue;
    }
    if (type === 'number' || type === 'boolean' || type === 'bigint') {
      bytes += 8;
      continue;
    }
    if (type !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      bytes += 16 + value.length * 8;
      for (const item of value) stack.push(item);
      continue;
    }
    if (value instanceof Map) {
      bytes += 32 + value.size * 16;
      for (const [key, item] of value) {
        stack.push(key);
        stack.push(item);
      }
      continue;
    }
    if (value instanceof Set) {
      bytes += 32 + value.size * 8;
      for (const item of value) stack.push(item);
      continue;
    }
    bytes += 32;
    for (const key of Object.keys(value)) {
      bytes += key.length * 2;
      stack.push(value[key]);
    }
  }
  return bytes;
}

// Drop the least-recently-used entry that is not `skipKey` (never evict the
// entry we are about to write). createCache.keys() returns a snapshot in
// recency order, so deleting from it while iterating is safe.
function evictOldest(skipKey) {
  for (const key of aggregateCache.keys()) {
    if (key === skipKey) continue;
    aggregateCache.delete(key);
    const bytes = entryBytes.get(key) || 0;
    entryBytes.delete(key);
    cachedBytes -= bytes;
    counters.evictions++;
    return true;
  }
  return false;
}

function remember(key, value) {
  const bytes = estimateBytes(value);
  if (bytes > AGGREGATE_MAX_ENTRY_BYTES) {
    counters.oversized++;
    return;
  }
  const isNewEntry = !entryBytes.has(key);
  // Evict BEFORE inserting so createCache's own entry cap never drops an entry
  // behind our byte ledger's back.
  while (isNewEntry && aggregateCache.size >= AGGREGATE_CACHE_MAX_ENTRIES) {
    if (!evictOldest(key)) break;
  }
  let incoming = bytes;
  const previous = entryBytes.get(key);
  if (previous !== undefined) incoming -= previous;
  while (cachedBytes + incoming > AGGREGATE_CACHE_MAX_BYTES && aggregateCache.size > 0) {
    if (!evictOldest(key)) break;
  }
  if (previous !== undefined) {
    cachedBytes -= previous;
    entryBytes.delete(key);
  }
  aggregateCache.set(key, value);
  entryBytes.set(key, bytes);
  cachedBytes += bytes;
  while (cachedBytes > AGGREGATE_CACHE_MAX_BYTES && aggregateCache.size > 1) {
    if (!evictOldest(key)) break;
  }
}

function aggregateKey(entry, kind) {
  return `${entry.path}|${entry.mtimeMs}|${entry.size}|${kind}`;
}

// Run `fn` over `items` with at most `limit` in flight and return results in
// input order (Promise.all's contract without opening one stream/fd per item
// at once — a platform can have hundreds of session logs).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    let index = next++;
    while (index < items.length) {
      results[index] = await fn(items[index], index);
      index = next++;
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Attach `{ mtimeMs, size }` to each collected file entry. Files that cannot be
// statted keep nulls: callers must still attempt the work (so their existing
// error/warning behaviour is preserved) but the result cannot be cached.
async function statSessionFiles(files, { concurrency = STAT_CONCURRENCY } = {}) {
  return mapWithConcurrency(files, concurrency, async (file) => {
    try {
      const stat = await fsp.stat(file.path);
      return { ...file, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return { ...file, mtimeMs: null, size: null };
    }
  });
}

// Collect + identify the session files of one platform. Order is exactly
// collectSessionFiles' order, so downstream aggregate ordering (and therefore
// response JSON) is unchanged.
async function enumerateSessionFiles(platform, agentName, dirOverride, opts = {}) {
  const files = await collectSessionFiles(platform, agentName, dirOverride, opts);
  return statSessionFiles(files);
}

// Return the per-file aggregate of `kind`, computing it through `compute(file)`
// only when this exact file version has not been seen. When the file has no
// identity (stat failed) the value is computed but never cached.
async function getFileAggregate(entry, kind, compute) {
  const { path: filePath, mtimeMs, size } = entry || {};
  if (typeof filePath !== 'string' || typeof mtimeMs !== 'number' || typeof size !== 'number') {
    return compute(entry);
  }
  const key = aggregateKey(entry, kind);
  const cached = aggregateCache.get(key);
  if (cached !== undefined) {
    counters.hits++;
    return cached;
  }
  counters.misses++;
  const value = await compute(entry);
  remember(key, value);
  return value;
}

// Batch-populate the cache for a set of files before the caller's merge loop.
// Only misses are handed to the scanners (worker pool, or inline when workers are
// disabled), so the merge loop itself then runs on cache hits. Individual scan
// failures are left uncached on purpose: the caller's per-file path re-runs and
// reports them through its existing warnings/skippedFiles behaviour.
async function prefetchFileAggregates(entries, kind, paramsFor = () => ({})) {
  if (!entries || entries.length === 0) return;
  const misses = [];
  for (const entry of entries) {
    if (typeof entry?.path !== 'string' || typeof entry?.mtimeMs !== 'number' || typeof entry?.size !== 'number')
      continue;
    if (aggregateCache.get(aggregateKey(entry, kind)) !== undefined) {
      counters.hits++;
      continue;
    }
    misses.push(entry);
  }
  if (misses.length === 0) return;
  // Lazy require: scan-pool's inline fallback loads scan-worker, which loads the
  // four scanner modules — and those require this module.
  const { runFileScansSettled } = require('./scan-pool');
  const results = await runFileScansSettled(
    misses.map((entry) => ({ kind, filePath: entry.path, params: paramsFor(entry) || {} }))
  );
  for (let i = 0; i < misses.length; i++) {
    const result = results[i];
    if (!result || !('value' in result)) continue;
    counters.misses++;
    remember(aggregateKey(misses[i], kind), result.value);
  }
}

// Observability for the audit report / tests; not used on any hot path.
function aggregateCacheStats() {
  return {
    ...counters,
    size: aggregateCache.size,
    bytes: cachedBytes,
    maxEntries: AGGREGATE_CACHE_MAX_ENTRIES,
    maxBytes: AGGREGATE_CACHE_MAX_BYTES,
  };
}

// Test hook: drop every cached aggregate (the module-level singleton is shared
// by all four callers, so tests that reuse paths must be able to reset it).
function clearAggregateCache() {
  aggregateCache.clear();
  entryBytes.clear();
  cachedBytes = 0;
}

module.exports = {
  AGGREGATE_CACHE_MAX_ENTRIES,
  AGGREGATE_CACHE_MAX_BYTES,
  AGGREGATE_MAX_ENTRY_BYTES,
  STAT_CONCURRENCY,
  mapWithConcurrency,
  statSessionFiles,
  enumerateSessionFiles,
  getFileAggregate,
  prefetchFileAggregates,
  aggregateCacheStats,
  clearAggregateCache,
};
