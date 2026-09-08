const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- Unified filesystem utilities ---
// Safe directory traversal, streaming JSONL parsing, and atomic writes.
// Extracted from repeated patterns across platforms/codex.js, claude-desktop.js,
// backup.js, prompts.js, and insights.js.

/**
 * Safely and recursively walk a directory, invoking visitor for every file.
 *
 * - Symlinked directories are skipped (never followed) to prevent escapes and loops.
 * - Unreadable directories are silently skipped (no throw), matching the
 *   best-effort bulk-scan semantics used by backup/insights.
 * - visitor receives (filePath, dirent) for every regular file.
 *
 * @param {string} root - absolute directory to walk
 * @param {(filePath: string, dirent: import('fs').Dirent) => void|Promise<void>} visitor
 */
async function safeWalk(root, visitor) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks
    if (entry.isDirectory()) {
      await safeWalk(fullPath, visitor);
    } else if (entry.isFile()) {
      await visitor(fullPath, entry);
    }
  }
}

/**
 * Stream a JSONL file line by line, invoking onLine for each successfully
 * parsed record. Malformed lines are passed to onError (or skipped by default).
 *
 * Returns a Promise that resolves when the stream ends.
 *
 * @param {string} filePath
 * @param {(record: unknown, line: string) => void|Promise<void>} onLine
 * @param {(line: string, error: Error) => void} [onError]
 */
function readJsonlLines(filePath, onLine, onError) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (err) {
        if (onError) onError(line, err);
        return;
      }
      onLine(rec, line);
    });
    rl.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.on('error', (err) => {
      rl.close();
      reject(err);
    });
  });
}

/**
 * Atomically write content to a file via tmp-file + rename so a crash
 * mid-write never truncates the destination. Parent directories are created
 * automatically.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {BufferEncoding} [encoding='utf8']
 */
async function atomicWrite(filePath, content, encoding = 'utf8') {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fsp.writeFile(tmpPath, content, encoding);
  await fsp.rename(tmpPath, filePath);
}

module.exports = {
  safeWalk,
  readJsonlLines,
  atomicWrite,
};
