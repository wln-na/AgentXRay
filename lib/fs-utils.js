const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// --- Unified filesystem utilities ---
// Safe directory traversal, streaming JSONL parsing, and atomic writes.

function safeAbsolutePath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0')) {
    throw new TypeError('Expected an absolute file path');
  }
  if (filePath.split(path.sep).includes('..')) throw new TypeError('Path traversal is not allowed');
  return path.normalize(filePath);
}
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
  const safePath = safeAbsolutePath(filePath);
  return new Promise((resolve, reject) => {
    // lgtm[js/path-injection]
    const stream = fs.createReadStream(safePath, { encoding: 'utf8' });
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
 * Async-generator over a JSONL file: yields each successfully parsed record.
 * Blank lines are skipped; malformed lines are skipped silently. Closing the
 * stream is handled in the generator's finally block, so both normal
 * completion and early return (breaking out of the for-await loop) clean up.
 *
 * This is the same boilerplate every adapter hand-rolled as
 *   const stream = fs.createReadStream(...); const rl = readline.createInterface(...);
 *   for await (const line of rl) { if (!line.trim()) continue; try { rec = JSON.parse(line) } catch { continue } ... }
 * but with the stream lifecycle centralized.
 *
 * @param {string} filePath
 * @param {{ lineFilter?: (line: string) => boolean }} [options]
 * @returns {AsyncGenerator<object>}
 */
async function* iterateJsonlLines(filePath, { lineFilter } = {}) {
  const safePath = safeAbsolutePath(filePath);
  // lgtm[js/path-injection]
  const stream = fs.createReadStream(safePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      // Optional cheap pre-parse skip (e.g. substring pre-filters in the
      // search and spawn scanners) so hot scans avoid JSON.parse on noise.
      if (lineFilter && !lineFilter(line)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      yield rec;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Async-generator over a text file's lines (unparsed). Same stream lifecycle
 * as iterateJsonlLines; used by line-level scanners (e.g. the insights
 * scanner, which must JSON-parse each line itself across many log shapes).
 *
 * @param {string} filePath
 * @returns {AsyncGenerator<string>}
 */
async function* iterateTextLines(filePath) {
  const safePath = safeAbsolutePath(filePath);
  // lgtm[js/path-injection]
  const stream = fs.createReadStream(safePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
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
  iterateJsonlLines,
  iterateTextLines,
  atomicWrite,
};
