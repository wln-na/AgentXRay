// Tests for the mtime/size short-circuit in watchSnapshotSession (Batch D).
// Verifies that getSession is not re-invoked when the source file's mtime and
// size are unchanged, and that a change triggers a reparse.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { watchSnapshotSession, resolveSnapshotSourceFiles } = require('../lib/routes/watch');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Build a minimal mock req/res pair. res.write collects SSE frames.
function mockReqRes() {
  let closeHandler = null;
  const events = [];
  const req = {
    query: {},
    on: (event, cb) => {
      if (event === 'close') closeHandler = cb;
    },
  };
  const res = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (chunk) => {
      // Collect non-ping events for assertion
      if (typeof chunk === 'string' && chunk.startsWith('event:')) {
        const match = chunk.match(/event: (\w+)/);
        if (match) events.push(match[1]);
      }
    },
    end: () => {},
  };
  return { req, res, events, close: () => closeHandler?.() };
}

function makeMockPlatform(sourceFile, getSessionImpl) {
  let calls = 0;
  return {
    id: 'mock-snapshot',
    defaultDir: () => path.dirname(sourceFile),
    find: async () => sourceFile,
    getSession: async () => {
      calls++;
      return getSessionImpl ? getSessionImpl(calls) : { session: { id: 's1' }, messages: [] };
    },
    get calls() {
      return calls;
    },
  };
}

describe('resolveSnapshotSourceFiles', () => {
  it('returns the file from platform.find', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentxray-src-'));
    const sourceFile = path.join(tmpDir, 'session.jsonl');
    await fsp.writeFile(sourceFile, '{}\n');
    try {
      const platform = { id: 'mock', find: async () => sourceFile };
      const files = await resolveSnapshotSourceFiles(platform, tmpDir, 's1');
      assert.deepEqual(files, [sourceFile]);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns [] when platform.find is not a function', async () => {
    const platform = { id: 'mock' };
    const files = await resolveSnapshotSourceFiles(platform, '/tmp', 's1');
    assert.deepEqual(files, []);
  });

  it('returns [] when platform.find returns null', async () => {
    const platform = { id: 'mock', find: async () => null };
    const files = await resolveSnapshotSourceFiles(platform, '/tmp', 's1');
    assert.deepEqual(files, []);
  });
});

describe('watchSnapshotSession mtime short-circuit', () => {
  let tmpDir;
  let sourceFile;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentxray-watch-'));
    sourceFile = path.join(tmpDir, 'session.jsonl');
    await fsp.writeFile(sourceFile, '{"role":"user","content":"hi"}\n');
  });

  after(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('does not call getSession on polls when source file is unchanged', async () => {
    const platform = makeMockPlatform(sourceFile);
    const { req, res, close } = mockReqRes();

    watchSnapshotSession(req, res, platform, 's1', 150);
    // Wait for initial connect + several poll intervals.
    await sleep(700);
    close();

    // Only the initial getSession should have run; all polls short-circuited.
    assert.equal(platform.calls, 1, `expected 1 getSession call, got ${platform.calls}`);
  });

  it('calls getSession again after source file mtime changes', async () => {
    const platform = makeMockPlatform(sourceFile);
    const { req, res, close } = mockReqRes();

    watchSnapshotSession(req, res, platform, 's1', 150);
    await sleep(400); // initial + a couple of skipped polls
    assert.equal(platform.calls, 1, 'expected 1 call before mtime change');

    // Touch the file: set mtime clearly into the future so it differs.
    const future = new Date(Date.now() + 10000);
    await fsp.utimes(sourceFile, future, future);

    await sleep(500); // enough for several poll cycles
    close();

    assert.ok(platform.calls >= 2, `expected >=2 getSession calls after mtime change, got ${platform.calls}`);
  });

  it('calls getSession again after source file size changes', async () => {
    const platform = makeMockPlatform(sourceFile);
    const { req, res, close } = mockReqRes();

    watchSnapshotSession(req, res, platform, 's1', 150);
    await sleep(400);
    assert.equal(platform.calls, 1);

    // Append data to change size (mtime also changes, but size is the key signal here).
    await fsp.appendFile(sourceFile, '{"role":"assistant","content":"hello"}\n');

    await sleep(500);
    close();

    assert.ok(platform.calls >= 2, `expected >=2 getSession calls after size change, got ${platform.calls}`);
  });

  it('falls back to always-reparse when source files cannot be resolved', async () => {
    // Platform with find returning null → sourceFiles = [] → no short-circuit.
    let calls = 0;
    const platform = {
      id: 'mock-nofile',
      defaultDir: () => tmpDir,
      find: async () => null,
      getSession: async () => {
        calls++;
        return { session: { id: 's1' }, messages: [] };
      },
    };
    const { req, res, close } = mockReqRes();

    watchSnapshotSession(req, res, platform, 's1', 150);
    await sleep(600); // initial + ~3 polls, all should call getSession
    close();

    assert.ok(calls >= 3, `expected >=3 getSession calls (no short-circuit), got ${calls}`);
  });
});
