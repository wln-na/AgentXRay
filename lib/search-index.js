const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = '1';
const syncLocks = new Map();

function defaultIndexPath(sourceDir, baseDir = process.env.AGENTXRAY_SEARCH_INDEX_DIR) {
  const root = baseDir || path.join(process.env.HOME || os.homedir(), '.agentxray', 'search');
  const digest = crypto.createHash('sha256').update(path.resolve(sourceDir)).digest('hex').slice(0, 16);
  return path.join(root, `codex-${digest}.sqlite`);
}

function quoteFtsTerm(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

function initializeSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  if (version !== SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS documents_fts;
      DROP TABLE IF EXISTS indexed_files;
      CREATE TABLE indexed_files (
        file_path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        file_path UNINDEXED,
        content,
        tokenize='trigram'
      );
    `);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }
}

async function indexJsonlFile(db, file, extractDocuments) {
  const deleteDocuments = db.prepare('DELETE FROM documents_fts WHERE file_path = ?');
  const insertDocument = db.prepare('INSERT INTO documents_fts(file_path, content) VALUES (?, ?)');
  const updateFile = db.prepare(`
    INSERT INTO indexed_files(file_path, size, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      size=excluded.size,
      mtime_ms=excluded.mtime_ms,
      indexed_at=excluded.indexed_at
  `);
  const stat = await fsp.stat(file.path);
  db.exec('BEGIN IMMEDIATE');
  try {
    deleteDocuments.run(file.path);
    const stream = fs.createReadStream(file.path, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        for (const document of extractDocuments(record)) {
          if (document.text) insertDocument.run(file.path, document.text);
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    updateFile.run(file.path, stat.size, stat.mtimeMs, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function syncIndex(db, files, extractDocuments) {
  const currentPaths = new Set(files.map((file) => file.path));
  const indexed = new Map(
    db
      .prepare('SELECT file_path, size, mtime_ms FROM indexed_files')
      .all()
      .map((row) => [row.file_path, row])
  );

  const removeFile = db.transaction((filePath) => {
    db.prepare('DELETE FROM documents_fts WHERE file_path = ?').run(filePath);
    db.prepare('DELETE FROM indexed_files WHERE file_path = ?').run(filePath);
  });
  for (const filePath of indexed.keys()) {
    if (!currentPaths.has(filePath)) removeFile(filePath);
  }

  for (const file of files) {
    let stat;
    try {
      stat = await fsp.stat(file.path);
    } catch {
      continue;
    }
    const previous = indexed.get(file.path);
    if (previous && previous.size === stat.size && previous.mtime_ms === stat.mtimeMs) continue;
    await indexJsonlFile(db, file, extractDocuments);
  }
}

function withSyncLock(key, operation) {
  const previous = syncLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  syncLocks.set(key, current);
  return current.finally(() => {
    if (syncLocks.get(key) === current) syncLocks.delete(key);
  });
}

async function indexedCodexCandidates(files, keywords, extractDocuments, options = {}) {
  if (!files.length) return [];
  const primaryTerm = keywords[0] || '';
  if (primaryTerm.length < 3) return null;
  const sourceDir = options.sourceDir || path.dirname(files[0].path);
  const indexPath = options.indexPath || defaultIndexPath(sourceDir, options.baseDir);

  try {
    return await withSyncLock(indexPath, async () => {
      await fsp.mkdir(path.dirname(indexPath), { recursive: true });
      const db = new Database(indexPath);
      try {
        initializeSchema(db);
        await syncIndex(db, files, extractDocuments);
        const rows = db
          .prepare('SELECT DISTINCT file_path FROM documents_fts WHERE documents_fts MATCH ?')
          .all(quoteFtsTerm(primaryTerm));
        const candidates = new Set(rows.map((row) => path.resolve(row.file_path)));
        return files.filter((file) => candidates.has(path.resolve(file.path)));
      } finally {
        db.close();
      }
    });
  } catch {
    return null;
  }
}

module.exports = {
  defaultIndexPath,
  indexedCodexCandidates,
  initializeSchema,
  quoteFtsTerm,
};
