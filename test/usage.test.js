// Daily token usage aggregation: per-file scanner (record shapes) + cross-platform
// daily bucketing. Uses temp JSONL files + injected filesByPlatform so tests never
// touch real agent dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { toLocalDate, scanFileForUsage, computeDailyUsage, USAGE_PLATFORMS } = require('../lib/usage');

// Freeze the aggregation clock: scanner tests below use fixed 2026-10-20/22
// records, so computeDailyUsage must never depend on the real wall clock.
const TEST_NOW = new Date(2026, 9, 27, 12).getTime();
const compute = (opts) => computeDailyUsage({ ...opts, now: TEST_NOW });

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-usage-'));
  return { dir, file: path.join(dir, name) };
}

function writeJsonl(file, lines) {
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
}

// Fake platform registry for computeDailyUsage (files injected via filesByPlatform).
function fakePlatforms(ids) {
  const reg = {};
  for (const id of ids) {
    reg[id] = { id, defaultDir: () => '/tmp/fake', collectFiles: async () => [] };
  }
  return reg;
}

// ---------- scanner ----------

test('scanFileForUsage: standard message usage (openclaw/omp)', async () => {
  const { file } = tmpFile('std.jsonl');
  writeJsonl(file, [
    { type: 'session', timestamp: '2026-10-20T10:00:00Z' },
    {
      type: 'message',
      timestamp: '2026-10-20T10:01:00Z',
      message: { usage: { input: 100, output: 50, cacheRead: 10 } },
    },
    {
      type: 'message',
      timestamp: '2026-10-20T10:02:00Z',
      message: { usage: { input: 200, output: 30, cache_read: 5 } },
    },
  ]);
  const buckets = await scanFileForUsage(file);
  assert.equal(buckets.size, 1);
  const t = buckets.get('2026-10-20');
  assert.deepEqual(
    { input: t.input, output: t.output, cacheRead: t.cacheRead },
    { input: 300, output: 80, cacheRead: 15 }
  );
});

test('scanFileForUsage: claude streamed snapshots — latest per request wins', async () => {
  const { file } = tmpFile('claude.jsonl');
  writeJsonl(file, [
    {
      type: 'assistant',
      timestamp: '2026-10-20T10:00:00Z',
      message: { id: 'r1', usage: { input_tokens: 100, output_tokens: 10 } },
    },
    {
      type: 'assistant',
      timestamp: '2026-10-20T10:01:00Z',
      message: { id: 'r1', usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 30 } },
    },
  ]);
  const buckets = await scanFileForUsage(file);
  const t = buckets.get('2026-10-20');
  assert.deepEqual(
    { input: t.input, output: t.output, cacheRead: t.cacheRead },
    { input: 500, output: 40, cacheRead: 30 }
  );
});

test('scanFileForUsage: codex cumulative snapshots — same-day deltas equal the latest total', async () => {
  const { file } = tmpFile('codex.jsonl');
  writeJsonl(file, [
    {
      type: 'event_msg',
      timestamp: '2026-10-20T10:00:00Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 500 } } },
    },
    {
      type: 'event_msg',
      timestamp: '2026-10-20T10:02:00Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 2000,
            output_tokens: 900,
            cached_input_tokens: 40,
            reasoning_output_tokens: 60,
          },
        },
      },
    },
  ]);
  const buckets = await scanFileForUsage(file);
  const t = buckets.get('2026-10-20');
  assert.deepEqual(
    { input: t.input, output: t.output, cacheRead: t.cacheRead, reasoning: t.reasoning },
    { input: 2000, output: 900, cacheRead: 40, reasoning: 60 }
  );
});

test('scanFileForUsage: codex cumulative snapshots split across local days by delta', async () => {
  const { file } = tmpFile('codex-cross-day.jsonl');
  const first = '2026-10-20T10:00:00Z';
  const second = '2026-10-22T10:00:00Z';
  writeJsonl(file, [
    {
      type: 'event_msg',
      timestamp: first,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 10,
            cached_input_tokens: 5,
            reasoning_output_tokens: 1,
          },
        },
      },
    },
    {
      type: 'event_msg',
      timestamp: second,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 150,
            output_tokens: 15,
            cached_input_tokens: 7,
            reasoning_output_tokens: 2,
          },
        },
      },
    },
  ]);
  const buckets = await scanFileForUsage(file);
  const d1 = buckets.get(toLocalDate(Date.parse(first)));
  const d2 = buckets.get(toLocalDate(Date.parse(second)));
  assert.deepEqual(
    { input: d1.input, output: d1.output, cacheRead: d1.cacheRead, reasoning: d1.reasoning },
    { input: 100, output: 10, cacheRead: 5, reasoning: 1 }
  );
  assert.deepEqual(
    { input: d2.input, output: d2.output, cacheRead: d2.cacheRead, reasoning: d2.reasoning },
    { input: 50, output: 5, cacheRead: 2, reasoning: 1 }
  );
});

test('scanFileForUsage: gemini + dsh + doubao shapes', async () => {
  const { file } = tmpFile('mixed.jsonl');
  writeJsonl(file, [
    { type: 'gemini', timestamp: '2026-10-20T10:00:00Z', tokens: { input: 10, output: 20, cached: 3, thoughts: 5 } },
    {
      type: 'user/message',
      time: Date.parse('2026-10-20T10:05:00Z'),
      data: { usage: { inputTokens: 7, outputTokens: 8, reasoningTokens: 7 } },
    },
    {
      role: 'assistant',
      timestamp: '2026-10-20T10:06:00Z',
      content: 'hello world this is a long assistant reply that should estimate tokens',
    },
    { role: 'user', timestamp: '2026-10-20T10:07:00Z', content: 'short prompt' },
  ]);
  const buckets = await scanFileForUsage(file);
  const t = buckets.get('2026-10-20');
  assert.ok(t.input > 10, `input ${t.input} should include gemini+dsh+doubao`);
  assert.ok(t.output > 28, `output ${t.output} should include gemini+dsh+doubao`);
  assert.equal(t.reasoning, 12, 'gemini thoughts + dsh reasoning tokens');
});

test('scanFileForUsage: timestamp-less Doubao estimates fall back to file mtime', async () => {
  const { file } = tmpFile('doubao-no-timestamp.jsonl');
  writeJsonl(file, [
    { role: 'user', content: 'short prompt' },
    { role: 'assistant', content: 'a longer assistant reply that should still be estimated' },
  ]);
  const buckets = await scanFileForUsage(file);
  const expectedDate = toLocalDate(fs.statSync(file).mtimeMs);
  assert.equal(buckets.size, 1);
  const t = buckets.get(expectedDate);
  assert.ok(t, `usage should be bucketed on file mtime date ${expectedDate}`);
  assert.ok(t.input > 0);
  assert.ok(t.output > 0);
});

test('scanFileForUsage: multi-day session splits into local-day buckets', async () => {
  const { file } = tmpFile('multiday.jsonl');
  // Two records 2 calendar days apart in UTC — guaranteed distinct local days
  // for any real-world timezone offset, so the test is timezone-robust.
  const ts1 = '2026-10-20T10:00:00Z';
  const ts2 = '2026-10-22T10:00:00Z';
  writeJsonl(file, [
    { type: 'message', timestamp: ts1, message: { usage: { input: 100, output: 10 } } },
    { type: 'message', timestamp: ts2, message: { usage: { input: 200, output: 20 } } },
  ]);
  const buckets = await scanFileForUsage(file);
  const d1 = toLocalDate(Date.parse(ts1));
  const d2 = toLocalDate(Date.parse(ts2));
  assert.equal(buckets.size, 2);
  assert.deepEqual({ input: buckets.get(d1).input, output: buckets.get(d1).output }, { input: 100, output: 10 });
  assert.deepEqual({ input: buckets.get(d2).input, output: buckets.get(d2).output }, { input: 200, output: 20 });

  const r = await compute({
    days: 90,
    platform: 'codex',
    platforms: fakePlatforms(['codex']),
    filesByPlatform: { codex: [{ path: file, file: 'multiday.jsonl' }] },
  });
  const activeDays = r.series.filter((d) => d.total.sessions > 0);
  assert.equal(activeDays.length, 2);
  assert.equal(r.totalSessions, 1, 'a transcript crossing days counts once in the range total');
});

test('scanFileForUsage: empty / no-usage file → empty buckets', async () => {
  const { file } = tmpFile('empty.jsonl');
  writeJsonl(file, [
    { type: 'session', timestamp: '2026-10-20T10:00:00Z' },
    { type: 'message', timestamp: '2026-10-20T10:01:00Z', message: { content: [] } },
  ]);
  const buckets = await scanFileForUsage(file);
  assert.equal(buckets.size, 0);
});

// ---------- aggregation ----------

test('computeDailyUsage: buckets by day × platform, totals = sum, zero-filled series', async () => {
  const codexFile = path.join(tmpFile('c.jsonl').dir, 'c.jsonl');
  const claudeFile = path.join(tmpFile('cl.jsonl').dir, 'cl.jsonl');
  writeJsonl(codexFile, [
    {
      type: 'event_msg',
      timestamp: '2026-10-20T10:00:00Z',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 500 } } },
    },
  ]);
  writeJsonl(claudeFile, [
    {
      type: 'assistant',
      timestamp: '2026-10-20T11:00:00Z',
      message: { id: 'a', usage: { input_tokens: 300, output_tokens: 200 } },
    },
  ]);

  const filesByPlatform = {
    codex: [{ path: codexFile, file: 'c.jsonl' }],
    'claude-code': [{ path: claudeFile, file: 'cl.jsonl' }],
  };
  const platforms = fakePlatforms(['codex', 'claude-code']);

  // Pin "today" to 2026-10-20 local: computeDailyUsage builds the series from
  // the real clock, so freeze it via a tiny stub by scanning only 1 day after
  // monkeypatching is not possible — instead assert on the 1-day window contents.
  const r = await compute({ days: 1, platform: 'all', platforms, filesByPlatform });
  assert.equal(r.series.length, 1);
  // Whatever local date "today" is, the file buckets may or may not fall in the
  // 1-day window — so assert the aggregation structure via a 90-day window and
  // filter by the dates that actually have data.
  const wide = await compute({ days: 90, platform: 'all', platforms, filesByPlatform });
  assert.ok(wide.platforms.includes('codex') && wide.platforms.includes('claude-code'));
  const withData = wide.series.filter((d) => d.total.input > 0 || d.total.output > 0);
  assert.equal(withData.length, 1);
  const d = withData[0];
  assert.equal(d.total.input, 1300);
  assert.equal(d.total.output, 700);
  assert.equal(d.byPlatform.codex.input, 1000);
  assert.equal(d.byPlatform['claude-code'].input, 300);
  assert.equal(d.total.sessions, 2);
});

test('computeDailyUsage: sessions counted per platform-day, total = distinct files', async () => {
  const a = path.join(tmpFile('a.jsonl').dir, 'a.jsonl');
  const b = path.join(tmpFile('b.jsonl').dir, 'b.jsonl');
  writeJsonl(a, [{ type: 'message', timestamp: '2026-10-20T10:00:00Z', message: { usage: { input: 10, output: 1 } } }]);
  writeJsonl(b, [{ type: 'message', timestamp: '2026-10-20T11:00:00Z', message: { usage: { input: 20, output: 2 } } }]);
  const filesByPlatform = {
    codex: [
      { path: a, file: 'a.jsonl' },
      { path: b, file: 'b.jsonl' },
    ],
  };
  const wide = await compute({
    days: 90,
    platform: 'all',
    platforms: fakePlatforms(['codex']),
    filesByPlatform,
  });
  const d = wide.series.find((x) => x.total.input > 0);
  assert.equal(d.total.input, 30);
  assert.equal(d.total.sessions, 2);
  assert.equal(d.byPlatform.codex.sessions, 2);
});

test('computeDailyUsage: platform filter narrows to one platform', async () => {
  const a = path.join(tmpFile('a.jsonl').dir, 'a.jsonl');
  const b = path.join(tmpFile('b.jsonl').dir, 'b.jsonl');
  writeJsonl(a, [{ type: 'message', timestamp: '2026-10-20T10:00:00Z', message: { usage: { input: 10 } } }]);
  writeJsonl(b, [{ type: 'message', timestamp: '2026-10-20T11:00:00Z', message: { usage: { input: 99 } } }]);
  const filesByPlatform = { codex: [{ path: a, file: 'a.jsonl' }], 'claude-code': [{ path: b, file: 'b.jsonl' }] };
  const r = await compute({
    days: 90,
    platform: 'codex',
    platforms: fakePlatforms(['codex', 'claude-code']),
    filesByPlatform,
  });
  const d = r.series.find((x) => x.total.input > 0);
  assert.equal(d.total.input, 10);
  assert.equal(d.byPlatform.codex.input, 10);
  assert.equal(d.byPlatform['claude-code'], undefined);
});

test('computeDailyUsage: platforms only include platforms with data in the requested window', async () => {
  const currentFile = path.join(tmpFile('current.jsonl').dir, 'current.jsonl');
  const oldFile = path.join(tmpFile('old.jsonl').dir, 'old.jsonl');
  writeJsonl(currentFile, [
    {
      type: 'assistant',
      timestamp: new Date(TEST_NOW).toISOString(),
      message: { id: 'current', usage: { input_tokens: 11, output_tokens: 2 } },
    },
  ]);
  writeJsonl(oldFile, [
    {
      type: 'message',
      timestamp: '2026-10-20T10:00:00Z',
      message: { usage: { input: 999, output: 999 } },
    },
  ]);
  const r = await compute({
    days: 1,
    platform: 'all',
    platforms: fakePlatforms(['codex', 'claude-code']),
    filesByPlatform: {
      codex: [{ path: oldFile, file: 'old.jsonl' }],
      'claude-code': [{ path: currentFile, file: 'current.jsonl' }],
    },
  });
  assert.deepEqual(r.platforms, ['claude-code']);
});

test('computeDailyUsage: platform directory overrides are honored and affect the cache key', async () => {
  const { file } = tmpFile('custom-dir.jsonl');
  writeJsonl(file, [
    { type: 'message', timestamp: new Date(TEST_NOW).toISOString(), message: { usage: { input: 17, output: 4 } } },
  ]);
  let seenDir = null;
  const customDir = path.join(os.homedir(), 'axr-usage-custom-dir');
  const platforms = {
    codex: {
      id: 'codex',
      defaultDir: () => '/default/codex',
      collectFiles: async (dir) => {
        seenDir = dir;
        return [{ path: file, file: 'custom-dir.jsonl' }];
      },
    },
  };

  const r = await compute({
    days: 1,
    platform: 'codex',
    platforms,
    dirs: { codex: customDir },
  });
  assert.equal(seenDir, customDir);
  assert.equal(r.series.find((d) => d.total.input > 0)?.byPlatform.codex.input, 17);
});

test('computeDailyUsage: dsh sessions are counted by session id, not shared file name', async () => {
  const a = tmpFile('session.v4.jsonl');
  const b = tmpFile('session.v4.jsonl');
  const record = (input) => [
    { type: 'session', version: 4, id: path.basename(path.dirname(a.file)), createdAt: TEST_NOW },
    {
      type: 'assistant/message',
      time: TEST_NOW,
      data: { usage: { inputTokens: input, outputTokens: 1, cacheReadTokens: 0 } },
    },
  ];
  writeJsonl(a.file, record(10));
  writeJsonl(b.file, record(20));
  const r = await compute({
    days: 1,
    platform: 'dsh',
    platforms: fakePlatforms(['dsh']),
    filesByPlatform: {
      dsh: [
        { path: a.file, file: 'session.v4.jsonl', sessionId: 'session-a' },
        { path: b.file, file: 'session.v4.jsonl', sessionId: 'session-b' },
      ],
    },
  });
  assert.equal(r.totalSessions, 2);
  assert.equal(r.series.find((d) => d.total.input > 0)?.byPlatform.dsh.sessions, 2);
});

test('computeDailyUsage: a broken scan file is skipped, not fatal', async () => {
  const good = path.join(tmpFile('good.jsonl').dir, 'good.jsonl');
  const bad = path.join(tmpFile('bad.jsonl').dir, 'bad.jsonl');
  writeJsonl(good, [{ type: 'message', timestamp: '2026-10-20T10:00:00Z', message: { usage: { input: 5 } } }]);
  fs.writeFileSync(bad, '{ not json\n', 'utf8'); // unparseable lines → no usage
  const filesByPlatform = {
    codex: [
      { path: good, file: 'good.jsonl' },
      { path: bad, file: 'bad.jsonl' },
    ],
  };
  const r = await compute({
    days: 90,
    platform: 'all',
    platforms: fakePlatforms(['codex']),
    filesByPlatform,
  });
  const d = r.series.find((x) => x.total.input > 0);
  assert.equal(d.total.input, 5);
});

test('USAGE_PLATFORMS covers file-based platforms plus the Hermes SQLite source', () => {
  assert.ok(USAGE_PLATFORMS.includes('codex'));
  assert.ok(USAGE_PLATFORMS.includes('claude-code'));
  assert.ok(USAGE_PLATFORMS.includes('hermes'));
});

test('computeDailyUsage: Hermes SQLite sessions contribute token and cost totals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-hermes-usage-'));
  const db = new Database(path.join(dir, 'state.db'));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      estimated_cost_usd REAL,
      actual_cost_usd REAL
    );
  `);
  const nowSeconds = Math.floor(TEST_NOW / 1000);
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, started_at, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('a', nowSeconds, 100, 20, 5, 2, 3, 0.01, null);
  insert.run('b', nowSeconds, 200, 40, 6, 1, 4, null, 0.03);
  db.close();

  const r = await compute({
    days: 1,
    platform: 'hermes',
    platforms: { hermes: { id: 'hermes', defaultDir: () => dir } },
  });
  const day = r.series.find((x) => x.total.input > 0);
  assert.ok(day, 'Hermes usage should appear in the one-day window');
  assert.deepEqual(day.byPlatform.hermes, {
    input: 300,
    output: 60,
    cacheRead: 11,
    cacheWrite: 3,
    reasoning: 7,
    cost: 0.04,
    sessions: 2,
  });
  assert.equal(day.total.sessions, 2);
});

test('toLocalDate formats YYYY-MM-DD in local time', () => {
  assert.match(toLocalDate(Date.parse('2026-10-20T10:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(toLocalDate(new Date(2026, 9, 20).getTime()), '2026-10-20');
});

// ---------- route helpers ----------

const { clampDays, dirsFromQuery } = require('../lib/routes/usage');

test('clampDays: default 14, floor 1, ceiling 90', () => {
  assert.equal(clampDays(undefined), 14);
  // ''/null coerce to 0 → floor 1 (same convention as pet-routes clampIntervalMs)
  assert.equal(clampDays(''), 1);
  assert.equal(clampDays(null), 1);
  assert.equal(clampDays('abc'), 14);
  assert.equal(clampDays('0'), 1);
  assert.equal(clampDays(-5), 1);
  assert.equal(clampDays('7'), 7);
  assert.equal(clampDays('200'), 90);
  assert.equal(clampDays('7.6'), 8); // rounded
});

test('dirsFromQuery maps frontend directory settings to platform IDs', () => {
  const dirs = dirsFromQuery({
    codexDir: '/custom/codex',
    claudeCodeDir: '/custom/claude',
    workbuddyDir: '/custom/workbuddy',
    traeDir: '/custom/trae',
    invalidDir: '/ignored',
  });
  assert.deepEqual(dirs, {
    codex: '/custom/codex',
    'claude-code': '/custom/claude',
    workbuddy: '/custom/workbuddy',
    trae: '/custom/trae',
  });
});

test('mountUsageRoutes registers GET /api/usage/daily', () => {
  const mount = require('../lib/routes/usage');
  const routes = [];
  mount({
    get(path, handler) {
      routes.push({ path, handler });
    },
  });
  assert.deepEqual(
    routes.map((r) => r.path),
    ['/api/usage/daily']
  );
  assert.equal(typeof routes[0].handler, 'function');
});
