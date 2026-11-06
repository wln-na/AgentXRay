const fsp = require('node:fs/promises');
const { sessionMetaCache } = require('../config');
const { createCache } = require('../cache');
const { withInFlightDedup } = require('../shared');

// --- Shared platform-adapter skeleton helpers ---
// Every adapter used to hand-roll these three pieces; they live here once.

// Wrap a raw metadata parser with the mtime cache: a file whose mtime hasn't
// changed since the last parse is served from sessionMetaCache.
function withMetadataCache(parseRaw) {
  return async function cachedMetadataParse(filePath, ...rest) {
    try {
      const stat = await fsp.stat(filePath);
      const cached = sessionMetaCache.get(filePath);
      if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    } catch {
      // If stat fails, fall through to parse
    }

    const data = await parseRaw(filePath, ...rest);

    try {
      const stat = await fsp.stat(filePath);
      sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
    } catch {
      // Non-critical — just skip caching
    }

    return data;
  };
}

// Fresh per-parse session statistics. Every adapter's metadata parser used to
// declare the same counter block by hand; this is the single definition site.
// Fields are mutated in place by the parser and read back when assembling the
// session summary (topTools via topToolsOf(stats.toolNames)).
function createSessionStatsCollector() {
  return {
    messageCount: 0,
    userCount: 0,
    assistantCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    lastTimestamp: null,
    firstUserMessage: null,
    toolNames: {},
  };
}

// The normalized message shape served by every session endpoint. This is the
// single definition site of the 11-field literal; adapters override only the
// fields their record actually carries.
function makeMessage(overrides) {
  return {
    id: null,
    timestamp: null,
    role: null,
    content: [],
    usage: null,
    model: null,
    provider: null,
    toolCallId: null,
    toolName: null,
    details: null,
    isError: false,
    ...overrides,
  };
}

// In-place newest-first sort by session start timestamp (list* tail sort).
function sortSessionsByTimestampDesc(sessions) {
  sessions.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
  return sessions;
}

// Top-5 most used tools from a name → count histogram.
function topToolsOf(toolNames) {
  return Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}

// Module-level memo cache for deterministic tool-duration estimates.
// LRU-bounded (key space is tool names, but bounded is safer than unbounded).
const toolDurationCache = createCache({ max: 500 });

// Estimate tool execution duration in ms based on tool name.
// Generic across platforms: maps well-known tool name substrings to
// representative latencies. Lives here (not in a platform adapter) so
// both doubao.js and doubao-store.js can import it without a cycle.
function estimateToolDurationMs(toolName) {
  const name = (toolName || '').toLowerCase();
  const cached = toolDurationCache.get(name);
  if (cached !== undefined) return cached;
  let result;
  if (name.includes('bash')) result = 3000;
  else if (name.includes('taskoutput')) result = 2000;
  else if (name.includes('edit') || name.includes('write')) result = 1000;
  else if (name.includes('read')) result = 500;
  else if (name.includes('grep') || name.includes('glob')) result = 800;
  else if (name.includes('todowrite')) result = 100;
  else if (name.includes('wait')) result = 5000;
  else if (name.includes('search')) result = 1500;
  else if (name.includes('computer') || name.includes('browser')) result = 4000;
  else result = 1000;
  toolDurationCache.set(name, result);
  return result;
}

module.exports = {
  withMetadataCache,
  createSessionStatsCollector,
  withInFlightDedup,
  makeMessage,
  sortSessionsByTimestampDesc,
  topToolsOf,
  estimateToolDurationMs,
  toolDurationCache,
};
