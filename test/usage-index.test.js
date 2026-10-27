const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createUsageIndex, SCHEMA_VERSION } = require('../lib/usage-index');
const { computeDailyUsage, scanFileForUsage } = require('../lib/usage');

const TEST_NOW = new Date(2026, 9, 27, 12).getTime();
const compute = (opts) => computeDailyUsage({ ...opts, now: TEST_NOW });

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(file, lines) {
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

function fakePlatforms(ids) {
  const registry = {};
  for (const id of ids) registry[id] = { id, defaultDir: () => '/tmp/fake', collectFiles: async () => [] };
  return registry;
}

test('usage index stores only daily rollups and reuses unchanged files', async () => {
  const dir = tmpDir('axr-usage-index-');
  const file = path.join(dir, 'session.jsonl');
  const indexPath = path.join(dir, 'usage-index.sqlite');
  writeJsonl(file, [
    {
      type: 'message',
      timestamp: '2026-10-20T10:00:00Z',
      message: { usage: { input: 100, output: 20, cacheRead: 5 } },
    },
  ]);

  const index = createUsageIndex(indexPath);
  let scanCount = 0;
  const scanFile = async (filePath) => {
    scanCount += 1;
    return scanFileForUsage(filePath);
  };

  const opts = {
    days: 90,
    platform: 'codex',
    platforms: fakePlatforms(['codex']),
    filesByPlatform: { codex: [{ path: file, file: 'session.jsonl' }] },
    scanFile,
    usageIndex: index,
  };

  const first = await compute(opts);
  assert.equal(scanCount, 1);
  assert.equal(first.series.find((day) => day.total.input > 0).total.input, 100);

  const second = await compute(opts);
  assert.equal(scanCount, 1, 'unchanged mtime and size should reuse the index');
  assert.equal(second.series.find((day) => day.total.input > 0).total.input, 100);

  const db = new Database(indexPath, { readonly: true });
  const columns = db
    .prepare('PRAGMA table_info(daily_usage)')
    .all()
    .map((row) => row.name);
  db.close();
  assert.ok(!columns.includes('content'), 'prompt/content must not be stored in the index');
  assert.deepEqual(columns, [
    'platform',
    'path',
    'date',
    'input',
    'output',
    'cache_read',
    'cache_write',
    'reasoning',
    'cost',
    'sessions',
  ]);
  index.close();
});

test('usage index invalidates changed files by mtime and size', async () => {
  const dir = tmpDir('axr-usage-index-change-');
  const file = path.join(dir, 'session.jsonl');
  const index = createUsageIndex(path.join(dir, 'usage-index.sqlite'));
  writeJsonl(file, [
    { type: 'message', timestamp: '2026-10-20T10:00:00Z', message: { usage: { input: 10, output: 1 } } },
  ]);

  let scanCount = 0;
  const opts = {
    days: 90,
    platform: 'codex',
    platforms: fakePlatforms(['codex']),
    filesByPlatform: { codex: [{ path: file, file: 'session.jsonl' }] },
    scanFile: async (filePath) => {
      scanCount += 1;
      return scanFileForUsage(filePath);
    },
    usageIndex: index,
  };

  await compute(opts);
  assert.equal(scanCount, 1);

  // Same content and mtime can be preserved on some filesystems, so force a new mtime too.
  const later = Date.now() + 10;
  writeJsonl(file, [
    { type: 'message', timestamp: '2026-10-20T10:00:00Z', message: { usage: { input: 30, output: 2 } } },
  ]);
  fs.utimesSync(file, new Date(later), new Date(later));

  const updated = await compute(opts);
  assert.equal(scanCount, 2, 'changed file must be rescanned');
  assert.equal(updated.series.find((day) => day.total.input > 0).total.input, 30);
  index.close();
});

test('usage index removes orphan records for the scanned platform', async () => {
  const dir = tmpDir('axr-usage-index-cleanup-');
  const fileA = path.join(dir, 'a.jsonl');
  const fileB = path.join(dir, 'b.jsonl');
  const index = createUsageIndex(path.join(dir, 'usage-index.sqlite'));
  writeJsonl(fileA, [
    { type: 'message', timestamp: '2026-10-20T10:00:00Z', message: { usage: { input: 10, output: 1 } } },
  ]);
  writeJsonl(fileB, [
    { type: 'message', timestamp: '2026-10-20T10:00:00Z', message: { usage: { input: 20, output: 2 } } },
  ]);

  const opts = {
    days: 90,
    platform: 'codex',
    platforms: fakePlatforms(['codex']),
    scanFile: scanFileForUsage,
    usageIndex: index,
  };
  await compute({
    ...opts,
    filesByPlatform: {
      codex: [
        { path: fileA, file: 'a.jsonl' },
        { path: fileB, file: 'b.jsonl' },
      ],
    },
  });
  await compute({
    ...opts,
    filesByPlatform: { codex: [{ path: fileA, file: 'a.jsonl' }] },
  });

  const result = await compute({
    ...opts,
    filesByPlatform: { codex: [{ path: fileA, file: 'a.jsonl' }] },
  });
  assert.equal(result.series.find((day) => day.total.input > 0).total.input, 10);
  assert.equal(index.fileCount('codex'), 1);
  index.close();
});

test('usage index schema migration clears incompatible versions', () => {
  const dir = tmpDir('axr-usage-index-migrate-');
  const indexPath = path.join(dir, 'usage-index.sqlite');
  const db = new Database(indexPath);
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION - 1));
  db.close();

  const index = createUsageIndex(indexPath);
  assert.equal(index.schemaVersion(), SCHEMA_VERSION);
  assert.equal(index.fileCount('codex'), 0);
  index.close();
});
