// Tests for the startup stale-scratch-dir sweeper (test/support/stale-home.js).
//
// Every fixture lives under os.tmpdir() in a uniquely named root that is
// removed in t.after(). The roots passed to sweepStaleDirs are those temp roots,
// so the real $HOME / $TMPDIR are never touched here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STALE_PREFIXES,
  DEFAULT_MAX_AGE_DAYS,
  HELPERS_TMP_HOME_PREFIX,
  sweepStaleDirs,
  sweepOnce,
  resolveMaxAgeDays,
  __resetSweeperForTests,
} = require('./support/stale-home');

const DAY_MS = 86_400_000;

/** Fresh throwaway root; auto-removed after the test. */
function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-sweep-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Backdate a path's mtime by `ms` (call AFTER writing its contents). */
function agePath(target, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(target, when, when);
}

test('exports the documented API surface', () => {
  assert.ok(Object.isFrozen(STALE_PREFIXES));
  for (const prefix of ['.agentxray-test-', '.agentxray-codextest-', 'axr-home-', 'agentxray-test-']) {
    assert.ok(STALE_PREFIXES.includes(prefix), `missing prefix ${prefix}`);
  }
  // D3: the helpers' no-leading-dot prefix is covered and shared, not copied.
  assert.equal(HELPERS_TMP_HOME_PREFIX, 'agentxray-test-');
  assert.ok(STALE_PREFIXES.includes(HELPERS_TMP_HOME_PREFIX));
  assert.equal(DEFAULT_MAX_AGE_DAYS, 7);
  assert.equal(typeof sweepStaleDirs, 'function');
  assert.equal(typeof sweepOnce, 'function');
  assert.equal(typeof resolveMaxAgeDays, 'function');
  assert.equal(typeof __resetSweeperForTests, 'function');
});

test('removes a matching dir older than maxAgeDays, keeps a recent one', (t) => {
  const root = makeRoot(t);
  const oldDir = makeDir(root, '.agentxray-test-old');
  fs.mkdirSync(path.join(oldDir, 'nested'));
  fs.writeFileSync(path.join(oldDir, 'nested', 'payload.txt'), 'x');
  agePath(oldDir, 8 * DAY_MS);
  const freshDir = makeDir(root, '.agentxray-test-fresh');

  const res = sweepStaleDirs({ roots: [root], maxAgeDays: 7 });

  assert.deepEqual(res.removed, [oldDir]);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(freshDir), true);
  assert.equal(res.errors.length, 0);
  assert.ok(res.skipped.some((s) => s.path === freshDir && s.reason === 'recent'));
  assert.equal(res.scanned, 2);
});

test('keeps non-matching names, prefixed files, and symlinks (target intact)', (t) => {
  const root = makeRoot(t);
  const keepDir = makeDir(root, 'not-a-scratch-dir');
  agePath(keepDir, 30 * DAY_MS);
  const prefixedFile = path.join(root, '.agentxray-test-file');
  fs.writeFileSync(prefixedFile, 'keep me');
  agePath(prefixedFile, 30 * DAY_MS);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-sweep-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const linkTarget = path.join(outside, 'target-dir');
  fs.mkdirSync(linkTarget);
  fs.writeFileSync(path.join(linkTarget, 'keep.txt'), 'keep');
  agePath(linkTarget, 30 * DAY_MS);
  const link = path.join(root, 'axr-home-outside-link'); // prefix matches: axr-home-
  fs.symlinkSync(linkTarget, link);

  const res = sweepStaleDirs({ roots: [root], maxAgeDays: 7 });

  assert.equal(res.removed.length, 0);
  assert.equal(fs.existsSync(keepDir), true);
  assert.equal(fs.existsSync(prefixedFile), true);
  assert.equal(fs.existsSync(link), true); // symlink itself untouched
  assert.equal(fs.existsSync(linkTarget), true); // never followed/removed
  assert.equal(fs.readFileSync(path.join(linkTarget, 'keep.txt'), 'utf8'), 'keep');

  const reasons = new Map(res.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons.get(keepDir), 'prefix');
  assert.equal(reasons.get(prefixedFile), 'not-directory');
  assert.equal(reasons.get(link), 'symlink');
});

test('dryRun reports candidates but deletes nothing', (t) => {
  const root = makeRoot(t);
  const oldDir = makeDir(root, '.agentxray-test-dry');
  agePath(oldDir, 8 * DAY_MS);

  const res = sweepStaleDirs({ roots: [root], maxAgeDays: 7, dryRun: true });

  assert.equal(fs.existsSync(oldDir), true);
  assert.equal(res.removed.length, 0);
  assert.deepEqual(res.wouldRemove, [oldDir]);

  // and the same input really is removable when dryRun is off
  const real = sweepStaleDirs({ roots: [root], maxAgeDays: 7 });
  assert.deepEqual(real.removed, [oldDir]);
  assert.equal(fs.existsSync(oldDir), false);
});

test('maxAgeDays: 0 deletes a one-minute-old matching dir', (t) => {
  const root = makeRoot(t);
  const dir = makeDir(root, '.agentxray-codextest-recent');
  agePath(dir, 60_000);

  // default 7-day threshold leaves a 1-minute-old dir alone
  const conservative = sweepStaleDirs({ roots: [root] });
  assert.equal(conservative.removed.length, 0);
  assert.ok(conservative.skipped.some((s) => s.path === dir && s.reason === 'recent'));

  // the test hook: any non-zero age qualifies
  const aggressive = sweepStaleDirs({ roots: [root], maxAgeDays: 0 });
  assert.deepEqual(aggressive.removed, [dir]);
  assert.equal(fs.existsSync(dir), false);
});

test('root safety: never removes the root itself or a .agentxray-shaped dir', (t) => {
  const root = makeRoot(t);
  const agentxray = makeDir(root, '.agentxray');
  fs.writeFileSync(path.join(agentxray, 'keep.txt'), 'user data');
  agePath(agentxray, 30 * DAY_MS);
  agePath(root, 30 * DAY_MS);

  // '.agentx' is a prefix broad enough to match '.agentxray' — the protection
  // must hold even then (that is the actual attack shape).
  const res = sweepStaleDirs({ roots: [root], prefixes: ['.agentx'], maxAgeDays: 0 });

  assert.equal(fs.existsSync(root), true); // root itself is never a target
  assert.equal(fs.existsSync(agentxray), true); // and ~/.agentxray-shaped dirs are protected
  assert.equal(fs.readFileSync(path.join(agentxray, 'keep.txt'), 'utf8'), 'user data');
  assert.equal(res.removed.length, 0);
  assert.ok(res.skipped.some((s) => s.path === agentxray && s.reason === 'protected'));
});

test('collects errors for a bad root and never throws', (t) => {
  const missing = path.join(
    os.tmpdir(),
    `axr-sweep-missing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  let res;
  assert.doesNotThrow(() => {
    res = sweepStaleDirs({ roots: [missing] });
  });
  assert.ok(Array.isArray(res.errors));
  assert.ok(res.errors.length >= 1);
  assert.equal(res.errors[0].path, path.resolve(missing));
  assert.equal(res.scanned, 0);
  assert.equal(res.removed.length, 0);
});

// --- D1: empty / too-short / traversal prefixes must never match everything ---

test('D1: empty or "." prefixes remove nothing and report an option error', (t) => {
  const root = makeRoot(t);
  const doomed = makeDir(root, '.agentxray-test-d1');
  const dotDir = makeDir(root, '.hidden-d1');
  agePath(doomed, 30 * DAY_MS);
  agePath(dotDir, 30 * DAY_MS);
  agePath(root, 30 * DAY_MS);

  for (const prefixes of [[''], ['.'], ['..'], ['', '.'], [12], ['a/b'], [' axr-home-']]) {
    const res = sweepStaleDirs({ roots: [root], prefixes, maxAgeDays: 0 });
    assert.equal(res.removed.length, 0, `removed something with prefixes=${JSON.stringify(prefixes)}`);
    assert.equal(fs.existsSync(doomed), true);
    assert.equal(fs.existsSync(dotDir), true);
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].path, '(options)');
    assert.match(res.errors[0].message, /no valid prefixes/);
  }

  // a mixed list keeps the valid prefix and ignores the poisoned ones
  const mixed = sweepStaleDirs({ roots: [root], prefixes: ['', '.agentxray-test-'], maxAgeDays: 0 });
  assert.deepEqual(mixed.removed, [doomed]);
  assert.equal(fs.existsSync(dotDir), true);
});

// --- D2: env parsing must not be able to enable the 0-day behaviour ---

test('D2: AXR_STALE_HOME_DAYS only accepts positive strict integers', (t) => {
  const saved = process.env.AXR_STALE_HOME_DAYS;
  t.after(() => {
    if (saved === undefined) delete process.env.AXR_STALE_HOME_DAYS;
    else process.env.AXR_STALE_HOME_DAYS = saved;
  });

  for (const value of ['-0', '0x10', '1e9', 'abc', '', '  ', '7d', '-5', '0']) {
    process.env.AXR_STALE_HOME_DAYS = value;
    assert.equal(
      resolveMaxAgeDays(undefined),
      DEFAULT_MAX_AGE_DAYS,
      `env value ${JSON.stringify(value)} must fall back to the default`
    );
  }

  process.env.AXR_STALE_HOME_DAYS = '3';
  assert.equal(resolveMaxAgeDays(undefined), 3);
  process.env.AXR_STALE_HOME_DAYS = ' 14 ';
  assert.equal(resolveMaxAgeDays(undefined), 14);
  process.env.AXR_STALE_HOME_DAYS = '3651';
  assert.equal(resolveMaxAgeDays(undefined), 3650); // capped

  // explicit option: 0 is the documented test hook, junk falls back to default
  process.env.AXR_STALE_HOME_DAYS = '3';
  assert.equal(resolveMaxAgeDays(0), 0);
  assert.equal(resolveMaxAgeDays(2), 2);
  assert.equal(resolveMaxAgeDays(3651), 3650);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, '4', null]) {
    assert.equal(resolveMaxAgeDays(bad), DEFAULT_MAX_AGE_DAYS, `option ${String(bad)} must fall back`);
  }
});

test('D2: env cannot make a fresh matching dir eligible, explicit 0 can', (t) => {
  const saved = process.env.AXR_STALE_HOME_DAYS;
  t.after(() => {
    if (saved === undefined) delete process.env.AXR_STALE_HOME_DAYS;
    else process.env.AXR_STALE_HOME_DAYS = saved;
  });
  const root = makeRoot(t);
  const fresh = makeDir(root, '.agentxray-test-just-now');
  agePath(fresh, 2_000); // created 2 seconds ago by "a parallel test"

  for (const value of ['0', '-0', '0x10', '1e9']) {
    process.env.AXR_STALE_HOME_DAYS = value;
    const res = sweepStaleDirs({ roots: [root] });
    assert.equal(res.removed.length, 0, `env ${JSON.stringify(value)} deleted a fresh dir`);
    assert.equal(fs.existsSync(fresh), true);
  }

  // ... while the explicit option still enables the hook
  assert.deepEqual(sweepStaleDirs({ roots: [root], maxAgeDays: 0 }).removed, [fresh]);
});

// --- D5: bad `roots` must be reported, never silently redirected ---

test('D5: non-array and cwd-disguise roots remove nothing and report errors', (t) => {
  const root = makeRoot(t);
  const sentinel = makeDir(root, '.agentxray-test-sentinel');
  agePath(sentinel, 30 * DAY_MS);

  let res;
  assert.doesNotThrow(() => {
    res = sweepStaleDirs({ roots: 'oops', maxAgeDays: 0 });
  });
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].path, '(options)');
  assert.match(res.errors[0].message, /roots must be an array/);
  assert.equal(res.scanned, 0);
  assert.equal(fs.existsSync(sentinel), true);

  for (const roots of [[''], ['.'], ['..'], ['   '], [null]]) {
    const r = sweepStaleDirs({ roots, maxAgeDays: 0 });
    assert.equal(r.removed.length, 0, `roots=${JSON.stringify(roots)} removed something`);
    assert.ok(r.errors.length >= 1, `roots=${JSON.stringify(roots)} had no error`);
    assert.equal(r.scanned, 0);
    assert.equal(fs.existsSync(sentinel), true);
  }
});

// --- D4: sweepOnce is per-key, not one global boolean ---

test('D4: sweepOnce is idempotent per key and sweeps different keys', (t) => {
  __resetSweeperForTests();
  t.after(() => __resetSweeperForTests());

  const rootA = makeRoot(t);
  const rootB = makeRoot(t);
  const oldA = makeDir(rootA, '.agentxray-test-a');
  const oldB = makeDir(rootB, '.agentxray-test-b');
  agePath(oldA, 30 * DAY_MS);
  agePath(oldB, 30 * DAY_MS);

  const r1 = sweepOnce({ key: 'site-a', roots: [rootA], maxAgeDays: 7 });
  assert.deepEqual(r1.removed, [oldA]);

  // same key: cached, no rescan (make a new old dir that must survive)
  const lateA = makeDir(rootA, '.agentxray-test-a-late');
  agePath(lateA, 30 * DAY_MS);
  const r1again = sweepOnce({ key: 'site-a', roots: [rootA], maxAgeDays: 7 });
  assert.equal(r1again, r1);
  assert.equal(fs.existsSync(lateA), true);

  // different key: must actually sweep its own root (audit D4)
  const r2 = sweepOnce({ key: 'site-b', roots: [rootB], maxAgeDays: 7 });
  assert.deepEqual(r2.removed, [oldB]);
  assert.equal(fs.existsSync(oldB), false);
  assert.notEqual(r2, r1);
});

test('no output by default; AXR_SWEEP_VERBOSE=1 writes one stderr line', (t) => {
  const saved = process.env.AXR_SWEEP_VERBOSE;
  t.after(() => {
    if (saved === undefined) delete process.env.AXR_SWEEP_VERBOSE;
    else process.env.AXR_SWEEP_VERBOSE = saved;
  });
  const root = makeRoot(t);
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite.call(process.stderr, chunk, ...rest);
  };
  t.after(() => {
    process.stderr.write = originalWrite;
  });

  delete process.env.AXR_SWEEP_VERBOSE;
  sweepStaleDirs({ roots: [root] });
  assert.equal(writes.filter((w) => w.includes('[stale-home]')).length, 0);

  process.env.AXR_SWEEP_VERBOSE = '1';
  sweepStaleDirs({ roots: [root] });
  assert.equal(writes.filter((w) => w.includes('[stale-home]')).length, 1);
});
