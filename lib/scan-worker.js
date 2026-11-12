// Worker-side entry for the scan pool: one per-file CPU parse per message.
//
// The worker deliberately does NOT contain a second copy of any scanner, and it
// does not touch the shared per-file cache or the whole-response TTL caches —
// those live on the main thread (lib/session-file-index.js). A worker's only job
// is `parse one file → return a plain aggregate`; the main thread decides
// whether the aggregate is fresh, caches it, merges it into the response, and
// owns the caches. Keeping the split at this boundary is what makes sharing a
// worker pool with the shared index safe (separate module instances get their
// own caches, so moving the layer here would duplicate all of them).
//
// The same `runScanJob` dispatch is used by the pool's inline fallback on the
// main thread, so there is exactly one place that maps a kind to a scanner.

const { isMainThread, parentPort } = require('node:worker_threads');
const { scanFileForInsights } = require('./insights-scanner');
const { extractPromptsForFile } = require('./prompts');
const { scanFileForToolAudit } = require('./tool-audit');
const { scanFileForUsage } = require('./usage');

// kind → pure per-file scanner. `params` carries only structured-clone-safe
// values (currently: sessionId for insights, platform for prompts).
async function runScanJob({ kind, filePath, params = {} }) {
  switch (kind) {
    case 'insights':
      return scanFileForInsights(filePath, params.sessionId || null);
    case 'prompts':
      return extractPromptsForFile(filePath, params.platform);
    case 'toolAudit':
      return scanFileForToolAudit(filePath);
    case 'usage':
      return scanFileForUsage(filePath);
    default:
      throw new Error(`unknown scan kind: ${kind}`);
  }
}

// Worker thread: answer one job per message. Errors are returned as data (the
// Error object itself is not structured-cloneable in a useful way), and the
// main thread re-creates an Error with the same message/code.
if (!isMainThread) {
  parentPort.on('message', async (message) => {
    try {
      const value = await runScanJob(message);
      parentPort.postMessage({ id: message.id, ok: true, value });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        ok: false,
        error: { message: error?.message || String(error), code: error?.code || null },
      });
    }
  });
}

module.exports = { runScanJob };
