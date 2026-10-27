// Persistent daily-usage index.
//
// The index deliberately stores only:
//   1. file identity (platform + path + mtime + size)
//   2. per-day token/cost rollups
// It never stores prompts, tool output, message bodies, or other session content.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { USAGE_INDEX_FILE } = require('./config');

const SCHEMA_VERSION = 1;

function createTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      platform TEXT NOT NULL,
      path TEXT NOT NULL,
      file TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (platform, path)
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      platform TEXT NOT NULL,
      path TEXT NOT NULL,
      date TEXT NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      reasoning INTEGER NOT NULL,
      cost REAL NOT NULL,
      sessions INTEGER NOT NULL,
      PRIMARY KEY (platform, path, date),
      FOREIGN KEY (platform, path) REFERENCES files(platform, path) ON DELETE CASCADE
    );
  `);
}

function migrateIfNeeded(db) {
  const existingVersion = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value;
  const current = Number(existingVersion);

  if (existingVersion !== undefined && Number.isFinite(current) && current === SCHEMA_VERSION) return;

  // Incompatible or missing metadata means the derived index can be rebuilt
  // safely from source logs. Source data always outranks the index.
  const rebuild = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS daily_usage');
    db.exec('DROP TABLE IF EXISTS files');
    db.exec('DROP TABLE IF EXISTS meta');
    createTables(db);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  });
  rebuild();
}

function createUsageIndex(file = USAGE_INDEX_FILE) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  const initialize = db.transaction(() => {
    createTables(db);
    migrateIfNeeded(db);
  });
  initialize();

  const replaceFileTx = db.transaction(({ platform, filePath, file, mtimeMs, size, buckets }) => {
    db.prepare('DELETE FROM files WHERE platform = ? AND path = ?').run(platform, filePath);
    db.prepare(
      `INSERT INTO files (
        platform, path, file, mtime_ms, size, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(platform, filePath, file, mtimeMs, size, Date.now());

    const insertDaily = db.prepare(
      `INSERT INTO daily_usage (
        platform, path, date, input, output, cache_read,
        cache_write, reasoning, cost, sessions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [date, totals] of buckets) {
      insertDaily.run(
        platform,
        filePath,
        date,
        totals.input || 0,
        totals.output || 0,
        totals.cacheRead || 0,
        totals.cacheWrite || 0,
        totals.reasoning || 0,
        totals.cost || 0,
        totals.sessions || 0
      );
    }
  });

  function getRecord(platform, filePath) {
    return db
      .prepare(
        `SELECT platform, path, file, mtime_ms AS mtimeMs, size
         FROM files WHERE platform = ? AND path = ?`
      )
      .get(platform, filePath);
  }

  function getFileBuckets(platform, filePath) {
    const rows = db
      .prepare(
        `SELECT date, input, output, cache_read AS cacheRead,
                cache_write AS cacheWrite, reasoning, cost, sessions
         FROM daily_usage WHERE platform = ? AND path = ? ORDER BY date`
      )
      .all(platform, filePath);
    const buckets = new Map();
    for (const row of rows) buckets.set(row.date, row);
    return buckets;
  }

  function replaceFile(record) {
    replaceFileTx(record);
  }

  function fileCount(platform) {
    return db.prepare('SELECT COUNT(*) AS count FROM files WHERE platform = ?').get(platform).count;
  }

  function deleteMissing(platform, knownPaths) {
    const cleanup = db.transaction((paths) => {
      db.exec(
        `CREATE TEMP TABLE IF NOT EXISTS known_paths (
          platform TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY (platform, path)
        )`
      );
      db.exec('DELETE FROM known_paths');
      const insert = db.prepare('INSERT OR IGNORE INTO known_paths (platform, path) VALUES (?, ?)');
      for (const filePath of paths) insert.run(platform, filePath);

      db.prepare(
        `DELETE FROM files
         WHERE platform = ?
           AND NOT EXISTS (
             SELECT 1 FROM known_paths k
             WHERE k.platform = files.platform AND k.path = files.path
           )`
      ).run(platform);
      db.exec('DELETE FROM known_paths');
    });
    cleanup(knownPaths);
  }

  function schemaVersion() {
    return Number(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value);
  }

  function close() {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }

  return {
    getRecord,
    getFileBuckets,
    replaceFile,
    fileCount,
    deleteMissing,
    schemaVersion,
    close,
  };
}

module.exports = {
  SCHEMA_VERSION,
  createUsageIndex,
};
