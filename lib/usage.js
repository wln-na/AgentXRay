// Daily token-usage aggregation across platforms.
//
// Mirrors how similar tools (tokscale / Gauge-style dashboards) surface usage:
// a per-day series with the total and a per-application (platform) breakdown,
// split by input/output/cache tokens. Built on the same record-shape knowledge
// as insights-scanner, but lean: only usage + timestamps are read, no tool
// stats / errors, so a full multi-platform scan stays cheap enough to cache.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { PLATFORMS } = require('./platforms');
const { listHermesUsageRecords } = require('./platforms/hermes');
const { createUsageIndex } = require('./usage-index');
const { resolveDir } = require('./config');
const { iterateSessionLines } = require('./insights-scanner');

// File-based platforms are scanned line by line; Hermes contributes usage from
// its SQLite session table through a dedicated adapter function.
const USAGE_PLATFORMS = Object.values(PLATFORMS)
  .filter((p) => p.collectFiles || p.id === 'hermes')
  .map((p) => p.id);

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_CACHE_MAX = 16; // LRU cap
const usageCache = new Map(); // key → { expires, data }
const inFlight = new Map(); // key → Promise

function usageCacheKey(platform, days, dirs = {}) {
  const dirPart = Object.keys(dirs)
    .filter((id) => dirs[id])
    .sort()
    .map((id) => `${id}=${dirs[id]}`)
    .join('&');
  return `${platform}|${days}|${dirPart}`;
}

let defaultUsageIndex = null;

function getDefaultUsageIndex() {
  if (!defaultUsageIndex) defaultUsageIndex = createUsageIndex();
  return defaultUsageIndex;
}

function setUsageCache(key, data) {
  if (usageCache.has(key)) usageCache.delete(key);
  usageCache.set(key, { data, expires: Date.now() + USAGE_CACHE_TTL_MS });
  while (usageCache.size > USAGE_CACHE_MAX) {
    const oldest = usageCache.keys().next().value;
    if (oldest === undefined) break;
    usageCache.delete(oldest);
  }
}

/** YYYY-MM-DD in the *local* timezone (the day the user actually consumed). */
function toLocalDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateOf(ts, fallbackMs) {
  if (!ts) return fallbackMs === null || fallbackMs === undefined ? null : toLocalDate(fallbackMs);
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(ms)
    ? toLocalDate(ms)
    : fallbackMs === null || fallbackMs === undefined
      ? null
      : toLocalDate(fallbackMs);
}

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, sessions: 0 };
}

function addTotals(target, src) {
  target.input += src.input || 0;
  target.output += src.output || 0;
  target.cacheRead += src.cacheRead || 0;
  target.cacheWrite += src.cacheWrite || 0;
  target.reasoning += src.reasoning || 0;
  target.cost += src.cost || 0;
}

/**
 * Scan a single session JSONL file for usage, bucketed by local calendar day.
 * Returns a Map<date, totals> (a session spanning midnight splits correctly)
 * or an empty map when the file carries no usage records.
 */
async function scanFileForUsage(filePath) {
  const buckets = new Map(); // date → totals
  let sessionDateMs = null; // fallback date (session start)
  const claudeRequests = new Map(); // requestKey → { usage, date }
  const codexSnapshots = []; // ordered cumulative snapshots: { date, usage }
  const doubaoEstimates = []; // Doubao has no per-message timestamps in trajectory files

  const add = (date, src) => {
    if (!date) return;
    let t = buckets.get(date);
    if (!t) {
      t = emptyTotals();
      buckets.set(date, t);
    }
    addTotals(t, src);
  };

  for await (const line of iterateSessionLines(filePath)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;

    if (rec.type === 'session' && rec.timestamp) {
      const ms = Date.parse(rec.timestamp);
      if (Number.isFinite(ms) && sessionDateMs === null) sessionDateMs = ms;
    }

    // --- Standard format (openclaw/omp): type === 'message' with msg.usage ---
    if (rec.type === 'message' && rec.message && rec.message.usage) {
      const u = rec.message.usage;
      add(dateOf(rec.timestamp, sessionDateMs), {
        input: u.input || 0,
        output: u.output || 0,
        cacheRead: u.cacheRead || u.cache_read || 0,
        cost: u.cost && typeof u.cost.total === 'number' ? u.cost.total : 0,
      });
    }

    // --- Claude Code: streamed usage snapshots per request; latest wins ---
    if (rec.type === 'assistant' && rec.message && rec.message.usage) {
      const u = rec.message.usage;
      const requestKey = String(rec.message.id || rec.requestId || rec.uuid || rec.timestamp || '');
      const date = dateOf(rec.timestamp, sessionDateMs);
      claudeRequests.set(requestKey, {
        usage: {
          input: u.input_tokens || u.input || 0,
          output: u.output_tokens || u.output || 0,
          cacheRead: u.cache_read_input_tokens || u.cache_read || 0,
          cacheWrite: u.cache_creation_input_tokens || u.cache_write || 0,
          cost: u.cost && typeof u.cost.total === 'number' ? u.cost.total : 0,
        },
        date,
      });
    }

    // --- Codex/Trae: total_token_usage is cumulative per file. Keep every
    // snapshot so a session crossing midnight can be split into daily deltas.
    if (rec.type === 'event_msg' && rec.payload && rec.payload.type === 'token_count') {
      const usage = rec.payload.info?.total_token_usage;
      if (usage && typeof usage === 'object') {
        codexSnapshots.push({
          date: dateOf(rec.timestamp, sessionDateMs),
          usage: {
            input: usage.input_tokens || 0,
            output: usage.output_tokens || 0,
            cacheRead: usage.cached_input_tokens || 0,
            cacheWrite: usage.cache_write_input_tokens || 0,
            reasoning: usage.reasoning_output_tokens || 0,
          },
        });
      }
    }

    // --- Gemini CLI: per-record tokens ---
    if (rec.type === 'gemini' && rec.tokens) {
      if (sessionDateMs === null && rec.timestamp) {
        const ms = Date.parse(rec.timestamp);
        if (Number.isFinite(ms)) sessionDateMs = ms;
      }
      add(dateOf(rec.timestamp, sessionDateMs), {
        input: rec.tokens.input || 0,
        output: rec.tokens.output || 0,
        cacheRead: rec.tokens.cached || 0,
        reasoning: rec.tokens.thoughts || 0,
      });
    }

    // --- dsh: usage on slash-typed message events (time is epoch ms) ---
    if ((rec.type === 'user/message' || rec.type === 'assistant/message') && rec.data && rec.data.usage) {
      if (sessionDateMs === null && typeof rec.time === 'number') sessionDateMs = rec.time;
      const u = rec.data.usage;
      add(dateOf(rec.time, sessionDateMs), {
        input: u.inputTokens || 0,
        output: u.outputTokens || 0,
        cacheRead: u.cacheReadTokens || 0,
        reasoning: u.reasoningTokens || 0,
      });
    }

    // --- Doubao: role-based OpenAI-style records — estimate like insights ---
    if (rec.role === 'user' || rec.role === 'assistant' || rec.role === 'tool') {
      const text = typeof rec.content === 'string' ? rec.content : '';
      const est = Math.ceil(text.length / 3);
      doubaoEstimates.push({
        date: dateOf(rec.timestamp, sessionDateMs),
        totals: {
          input: rec.role === 'user' || rec.role === 'tool' ? est : 0,
          output: rec.role === 'assistant' ? est : 0,
        },
      });
    }
  }

  // Flush deduped Claude request usage (latest snapshot per request).
  for (const { usage, date } of claudeRequests.values()) add(date, usage);

  // Flush cumulative Codex snapshots as daily deltas. The first observed
  // snapshot is the session's baseline; later snapshots contribute only the
  // positive difference, so a session crossing midnight splits correctly.
  for (const [index, snapshot] of codexSnapshots.entries()) {
    if (!snapshot.date) continue;
    if (index === 0) {
      add(snapshot.date, snapshot.usage);
      continue;
    }
    const previous = codexSnapshots[index - 1].usage;
    add(snapshot.date, {
      input: Math.max(0, snapshot.usage.input - previous.input),
      output: Math.max(0, snapshot.usage.output - previous.output),
      cacheRead: Math.max(0, snapshot.usage.cacheRead - previous.cacheRead),
      cacheWrite: Math.max(0, snapshot.usage.cacheWrite - previous.cacheWrite),
      reasoning: Math.max(0, snapshot.usage.reasoning - previous.reasoning),
    });
  }

  // Doubao trajectory records have no message timestamps. If any estimate is
  // undated, use the file's mtime as a local-calendar-day fallback.
  if (doubaoEstimates.some((item) => !item.date)) {
    try {
      const stat = await fsp.stat(filePath);
      const fallbackDate = toLocalDate(stat.mtimeMs);
      for (const item of doubaoEstimates) {
        if (!item.date) item.date = fallbackDate;
      }
    } catch {
      // Leave undated estimates out; usage must not guess a day.
    }
  }
  for (const { date, totals } of doubaoEstimates) add(date, totals);

  return buckets;
}

/**
 * Aggregate daily token usage for one platform or all platforms.
 * @param {object} [opts]
 * @param {number} [opts.days=14]      trailing days to include (1-90)
 * @param {string} [opts.platform='all'] USAGE_PLATFORMS id or 'all'
 * @param {object} [opts.platforms=PLATFORMS] platform registry (test injection)
 * @param {object} [opts.filesByPlatform] test injection: id → [{path, file}]
 * @param {Function} [opts.scanFile=scanFileForUsage] per-file scanner (test injection)
 * @returns {Promise<{generatedAt:number, days:number, platforms:string[], series:Array}>}
 */
async function computeDailyUsage({
  days = 14,
  platform = 'all',
  platforms = PLATFORMS,
  filesByPlatform = null,
  dirs = null,
  scanFile = scanFileForUsage,
  usageIndex = null,
  now = Date.now(),
} = {}) {
  const ids = platform === 'all' ? (filesByPlatform ? Object.keys(filesByPlatform) : USAGE_PLATFORMS) : [platform];
  const byDate = new Map(); // date → { total, byPlatform: Map<id, totals>, sessions: Map<id, Set> }

  const dayBucket = (date) => {
    let d = byDate.get(date);
    if (!d) {
      d = { total: emptyTotals(), byPlatform: new Map(), sessions: new Map() };
      byDate.set(date, d);
    }
    return d;
  };

  for (const id of ids) {
    const p = platforms[id];

    // Hermes stores usage on sessions in SQLite. Its adapter provides a
    // lightweight usage-reader instead of forcing the generic JSONL path.
    if (!filesByPlatform && id === 'hermes') {
      if (!p || typeof p.defaultDir !== 'function') continue;
      const dir = resolveDir(dirs?.[id] || '', p.defaultDir());
      let records = [];
      try {
        records = await listHermesUsageRecords(dir);
      } catch {
        continue; // a broken Hermes database must not take down usage
      }
      for (const record of records) {
        if (!record.timestampMs) continue;
        const date = toLocalDate(record.timestampMs);
        const d = dayBucket(date);
        addTotals(d.total, record.totals);
        const per = d.byPlatform.get(id) || emptyTotals();
        addTotals(per, record.totals);
        per.sessions++;
        d.byPlatform.set(id, per);
        let set = d.sessions.get(id);
        if (!set) {
          set = new Set();
          d.sessions.set(id, set);
        }
        set.add(record.id);
      }
      continue;
    }

    if (!p || typeof p.collectFiles !== 'function') continue;
    let files = [];
    if (filesByPlatform) {
      files = filesByPlatform[id] || [];
    } else {
      const dir = resolveDir(dirs?.[id] || '', p.defaultDir());
      try {
        files = await p.collectFiles(dir, { agent: '' });
      } catch {
        continue; // broken platform must not take down usage
      }
    }
    for (const f of files) {
      let buckets;
      try {
        if (usageIndex) {
          let stat;
          try {
            stat = await fsp.stat(f.path);
          } catch {
            continue;
          }

          let record = null;
          try {
            record = usageIndex.getRecord(id, f.path);
          } catch (error) {
            console.warn('[usage] index read failed for', f.path, ':', error.message);
          }

          if (record && record.mtimeMs === stat.mtimeMs && record.size === stat.size) {
            buckets = usageIndex.getFileBuckets(id, f.path);
          } else {
            buckets = await scanFile(f.path);
            usageIndex.replaceFile({
              platform: id,
              filePath: f.path,
              file: f.file || path.basename(f.path),
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              buckets,
            });
          }
        } else {
          buckets = await scanFile(f.path);
        }
      } catch (error) {
        // A derived cache must never make source-log usage scanning unavailable.
        if (usageIndex && error?.message && !String(error.message).includes('index read failed')) {
          console.warn('[usage] index write failed for', f.path, ':', error.message);
        }
        try {
          buckets = await scanFile(f.path);
        } catch {
          continue;
        }
      }
      if (!buckets.size) continue;
      for (const [date, totals] of buckets) {
        const d = dayBucket(date);
        addTotals(d.total, totals);
        const per = d.byPlatform.get(id) || emptyTotals();
        addTotals(per, totals);
        per.sessions++;
        d.byPlatform.set(id, per);
        let set = d.sessions.get(id);
        if (!set) {
          set = new Set();
          d.sessions.set(id, set);
        }
        // dsh names every log session.vN.jsonl[.zstd]; the file name alone
        // collapses all sessions into one. Prefer the adapter's sessionId.
        set.add(f.sessionId || f.file || path.basename(f.path));
      }
    }

    if (usageIndex) {
      try {
        usageIndex.deleteMissing(
          id,
          files.map((f) => f.path)
        );
      } catch (error) {
        console.warn('[usage] index cleanup failed for', id, ':', error.message);
      }
    }
  }

  // Build the continuous trailing series (local calendar days, zero-filled).
  const nowDate = new Date(now);
  nowDate.setHours(0, 0, 0, 0);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = toLocalDate(nowDate.getTime() - i * 86400000);
    const d = byDate.get(date);
    const total = d ? { ...d.total } : emptyTotals();
    total.sessions = d ? countSessions(d) : 0;
    const byPlatform = {};
    if (d) {
      for (const [id, t] of d.byPlatform) byPlatform[id] = { ...t };
    }
    series.push({ date, total, byPlatform });
  }

  const platformsInWindow = new Set();
  const sessionKeys = new Set();
  for (const day of series) {
    for (const id of Object.keys(day.byPlatform)) platformsInWindow.add(id);
    const dayBuckets = byDate.get(day.date);
    if (!dayBuckets) continue;
    for (const [id, sessions] of dayBuckets.sessions) {
      for (const sessionId of sessions) sessionKeys.add(`${id}:${sessionId}`);
    }
  }

  return {
    generatedAt: Date.now(),
    days: series.length,
    totalSessions: sessionKeys.size,
    platforms: [...platformsInWindow].sort(),
    series,
  };
}

function countSessions(d) {
  let n = 0;
  for (const set of d.sessions.values()) n += set.size;
  return n;
}

/**
 * Cached + deduped wrapper around computeDailyUsage.
 * @returns {Promise<{generatedAt:number, days:number, platforms:string[], series:Array}>}
 */
async function getDailyUsage({ days = 14, platform = 'all', dirs = null } = {}) {
  const normalizedDirs = dirs && typeof dirs === 'object' ? dirs : {};
  const key = usageCacheKey(platform, days, normalizedDirs);
  const cached = usageCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = computeDailyUsage({
    days,
    platform,
    dirs: normalizedDirs,
    usageIndex: getDefaultUsageIndex(),
  });
  inFlight.set(key, promise);
  try {
    const data = await promise;
    setUsageCache(key, data);
    return data;
  } finally {
    inFlight.delete(key);
  }
}

module.exports = {
  USAGE_PLATFORMS,
  USAGE_CACHE_TTL_MS,
  toLocalDate,
  scanFileForUsage,
  computeDailyUsage,
  getDailyUsage,
};
