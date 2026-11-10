// Small worker pool for per-file session-log parsing.
//
// Why: JSON.parse over hundreds of MB of session logs is CPU-bound, and Node's
// single main thread means a cold /api/insights or /api/tools/audit blocks every
// other request for ~1–3 s. The fix is deliberately narrow: the main thread
// still enumerates files, owns the shared per-file cache (session-file-index.js)
// and the whole-response TTL caches, and merges the aggregates; only the
// per-file parse runs here. Putting the whole scan layer in a worker would give
// the worker its own module instances and caches — duplicating the shared index,
// doubling memory, and making the TTL caches useless.
//
// Fallbacks (all intentional, all transparent to callers):
//   * AXR_SCAN_WORKERS=0 disables the pool → inline scans on the main thread.
//   * Worker startup failure / crash / per-job timeout → warn ONCE, terminate the
//     pool, and finish every queued job inline. The process never retries.
//   * Queue over MAX_QUEUE → that job runs inline instead of growing memory.
//
// Process exit: idle workers are unref()'d; a worker is ref()'d only while it
// holds a job, so a finished scan leaves no handles behind and `node --test`
// (or the server) exits normally.

const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_WORKER_COUNT = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));
const MAX_QUEUE = 2048; // queued jobs; beyond this a job is scanned inline
const JOB_TIMEOUT_MS = 30_000;
const INLINE_CONCURRENCY = 8;
const WORKER_ENTRY = process.env.AXR_SCAN_WORKER_ENTRY || path.join(__dirname, 'scan-worker.js');

let requestedCount = null; // parsed once from AXR_SCAN_WORKERS
let disabled = false; // set after the first worker failure; never reset
let warned = false;
let workers = []; // [{ worker, job }]
let queue = []; // [{ message, resolve, reject }]
let nextJobId = 1;

function workerCount() {
  if (requestedCount !== null) return requestedCount;
  const raw = process.env.AXR_SCAN_WORKERS;
  if (raw === undefined || raw === '') {
    requestedCount = DEFAULT_WORKER_COUNT;
  } else {
    const parsed = Number(raw);
    requestedCount = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_WORKER_COUNT;
  }
  return requestedCount;
}

function inlineRun(message) {
  // Lazy require: scan-worker pulls in the four scanners, which require this
  // module's callers (session-file-index) — loading it eagerly would create a
  // require cycle. At call time everything is initialised.
  return require('./scan-worker').runScanJob(message);
}

function warnOnce(error) {
  if (warned) return;
  warned = true;
  console.warn(`[scan-pool] worker scanning disabled, falling back to inline scans: ${error?.message || error}`);
}

function deserializeError(error) {
  const result = new Error(error?.message || 'scan worker failed');
  if (error?.code) result.code = error.code;
  return result;
}

function settleJobInline(job) {
  clearTimeout(job.timer);
  inlineRun(job.message).then(job.resolve, job.reject);
}

function resolveQueuedInline(item) {
  inlineRun(item.message).then(item.resolve, item.reject);
}

// Terminate the whole pool and transparently finish every outstanding job on the
// main thread. Called on worker crash/startup failure/timeout and on shutdown.
function disableAndDrain(reason) {
  if (!disabled) {
    disabled = true;
    warnOnce(reason);
  }
  const slots = workers;
  workers = [];
  for (const slot of slots) {
    slot.terminated = true;
    const job = slot.job;
    slot.job = null;
    if (job) settleJobInline(job);
    slot.worker.removeAllListeners();
    slot.worker.terminate().catch(() => {});
  }
  const pending = queue;
  queue = [];
  for (const item of pending) resolveQueuedInline(item);
}

function onWorkerMessage(slot, message) {
  const job = slot.job;
  if (!job || !message || message.id !== job.id) return; // stale reply
  slot.job = null;
  clearTimeout(job.timer);
  slot.worker.unref(); // idle again: no handle should keep the process alive
  if (message.ok) job.resolve(message.value);
  else job.reject(deserializeError(message.error));
  pump();
}

function createWorker() {
  const worker = new Worker(WORKER_ENTRY);
  const slot = { worker, job: null, terminated: false };
  worker.on('message', (message) => onWorkerMessage(slot, message));
  worker.on('error', (error) => {
    if (!slot.terminated) disableAndDrain(error);
  });
  worker.on('exit', (code) => {
    if (!slot.terminated && code !== 0) disableAndDrain(new Error(`scan worker exited with code ${code}`));
  });
  // unref() must come AFTER the listeners: registering them re-refs the worker's
  // message port, and an idle worker must not keep the process alive (that is the
  // difference between `node --test` exiting and hanging forever).
  worker.unref();
  return slot;
}

function ensureWorkers(count) {
  if (workers.length >= count) return;
  const created = [];
  try {
    for (let i = workers.length; i < count; i++) created.push(createWorker());
  } catch (error) {
    for (const slot of created) {
      slot.terminated = true;
      slot.worker.removeAllListeners();
      slot.worker.terminate().catch(() => {});
    }
    throw error;
  }
  workers.push(...created);
}

function pump() {
  for (const slot of workers) {
    if (queue.length === 0) break;
    if (slot.job) continue;
    const item = queue.shift();
    const id = nextJobId++;
    const message = { ...item.message, id };
    const timer = setTimeout(() => {
      if (slot.job && slot.job.id === id) {
        disableAndDrain(new Error(`scan worker timed out after ${JOB_TIMEOUT_MS} ms`));
      }
    }, JOB_TIMEOUT_MS);
    slot.job = { id, message, resolve: item.resolve, reject: item.reject, timer };
    slot.worker.ref();
    slot.worker.postMessage(message);
  }
}

function dispatch(message) {
  return new Promise((resolve, reject) => {
    if (disabled || workers.length === 0 || queue.length >= MAX_QUEUE) {
      inlineRun(message).then(resolve, reject);
      return;
    }
    queue.push({ message, resolve, reject });
    pump();
  });
}

async function inlineBatch(messages) {
  const results = new Array(messages.length);
  let next = 0;
  const worker = async () => {
    let index = next++;
    while (index < messages.length) {
      try {
        results[index] = { value: await inlineRun(messages[index]) };
      } catch (error) {
        results[index] = { error };
      }
      index = next++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(INLINE_CONCURRENCY, messages.length) }, worker));
  return results;
}

/**
 * Run per-file scan jobs, settling each one independently:
 *   [{ value }] or [{ error }] in input order.
 * Used by the shared index prefetch, which must not let one unreadable file
 * abort the batch (the caller re-runs its own error reporting per file).
 */
async function runFileScansSettled(messages) {
  if (messages.length === 0) return [];
  const count = workerCount();
  if (count <= 0 || disabled) return inlineBatch(messages);
  try {
    ensureWorkers(count);
  } catch (error) {
    disableAndDrain(error);
    return inlineBatch(messages);
  }
  return Promise.all(
    messages.map((message) =>
      dispatch(message).then(
        (value) => ({ value }),
        (error) => ({ error })
      )
    )
  );
}

/** Run one per-file scan job; resolves with the aggregate or throws. */
async function runFileScan(kind, filePath, params = {}) {
  const [result] = await runFileScansSettled([{ kind, filePath, params }]);
  if (result.error) throw result.error;
  return result.value;
}

/** Observable pool state (report/tests only; never on a hot path). */
function scanPoolInfo() {
  return {
    configuredWorkers: workerCount(),
    defaultWorkers: DEFAULT_WORKER_COUNT,
    liveWorkers: workers.length,
    busy: workers.filter((slot) => slot.job).length,
    queued: queue.length,
    disabled,
  };
}

/** Terminate the pool (best effort). Safe to call repeatedly; no-op when idle. */
function shutdownScanPool() {
  if (workers.length === 0 && queue.length === 0) {
    disabled = true;
    return;
  }
  disabled = true;
  const slots = workers;
  workers = [];
  for (const slot of slots) {
    slot.terminated = true;
    // A job still in flight must not be lost: finish it inline.
    const job = slot.job;
    slot.job = null;
    if (job) settleJobInline(job);
    slot.worker.removeAllListeners();
    slot.worker.terminate().catch(() => {});
  }
  const pending = queue;
  queue = [];
  for (const item of pending) resolveQueuedInline(item);
}

// Idle workers are unref'd, so this is only a belt-and-braces cleanup.
process.once('exit', () => {
  for (const slot of workers) {
    try {
      slot.terminated = true;
      slot.worker.terminate();
    } catch {
      /* process is exiting */
    }
  }
});

module.exports = {
  DEFAULT_WORKER_COUNT,
  MAX_QUEUE,
  JOB_TIMEOUT_MS,
  runFileScan,
  runFileScansSettled,
  scanPoolInfo,
  shutdownScanPool,
};
