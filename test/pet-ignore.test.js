// pet-ignore store unit tests: persistence, expiry, clamps, key format.
// Uses real fs via a temp file (like the production default), plus an injected
// clock so expiry is deterministic.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  clampDurationMs,
  sessionKey,
  createPetIgnoreStore,
  DEFAULT_IGNORE_MS,
  MIN_IGNORE_MS,
  MAX_IGNORE_MS,
} = require('../lib/pet-ignore');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axr-pet-ignore-')), 'pet-ignore.json');
}

test('clampDurationMs: default/floor/ceiling and non-numbers', () => {
  assert.equal(clampDurationMs(undefined), DEFAULT_IGNORE_MS);
  assert.equal(clampDurationMs(null), DEFAULT_IGNORE_MS);
  assert.equal(clampDurationMs('abc'), DEFAULT_IGNORE_MS);
  assert.equal(clampDurationMs(0), DEFAULT_IGNORE_MS);
  assert.equal(clampDurationMs(-5), DEFAULT_IGNORE_MS);
  assert.equal(clampDurationMs(5000), MIN_IGNORE_MS); // below floor → 1 min
  assert.equal(clampDurationMs(60_000), MIN_IGNORE_MS);
  assert.equal(clampDurationMs(2 * 60_000), 120_000);
  assert.equal(clampDurationMs(25 * 60 * 60_000), MAX_IGNORE_MS); // above ceiling → 24 h
  // explicit fallback
  assert.equal(clampDurationMs(undefined, 1234), 1234);
  assert.equal(clampDurationMs('x', 99), 99);
});

test('sessionKey: platform:agent:sessionId with empty agent segment', () => {
  assert.equal(sessionKey('codex', 'abc', null), 'codex::abc');
  assert.equal(sessionKey('codex', 'abc', ''), 'codex::abc');
  assert.equal(sessionKey('openclaw', 'abc', 'a1'), 'openclaw:a1:abc');
  // empty-agent and non-empty-agent keys never collide
  assert.notEqual(sessionKey('codex', 'a', 'b'), sessionKey('codex', 'a', null));
});

test('set/get/remove roundtrip persists to disk', async () => {
  const file = tmpFile();
  const store = createPetIgnoreStore({ file, now: () => 1_000_000 });
  const key = sessionKey('codex', 'abc', null);

  assert.equal(await store.get(key), null, 'nothing before set');
  const entry = await store.set(key, { durationMs: 5 * 60_000 });
  assert.equal(entry.ignoredAt, 1_000_000);
  assert.equal(entry.until, 1_000_000 + 300_000);
  assert.deepEqual(await store.get(key), entry);

  assert.equal(await store.remove(key), true, 'remove returns true when present');
  assert.equal(await store.remove(key), false, 'remove returns false when absent');
  assert.equal(await store.get(key), null);
});

test('a fresh store on the same file sees the persisted entries', async () => {
  const file = tmpFile();
  const a = createPetIgnoreStore({ file, now: () => 1_000_000 });
  await a.set(sessionKey('codex', 'abc', null), { durationMs: 60_000 });
  await a.set(sessionKey('trae', 'def', 'sub'), { durationMs: 120_000 });

  const b = createPetIgnoreStore({ file, now: () => 1_000_000 });
  const snap = await b.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['codex::abc', 'trae:sub:def']);
});

test('expired entries report null and are not re-surfaced', async () => {
  let clock = 1_000_000;
  const file = tmpFile();
  const store = createPetIgnoreStore({ file, now: () => clock });
  const key = sessionKey('codex', 'abc', null);
  await store.set(key, { durationMs: 60_000 });

  clock = 1_000_000 + 60_000 + 1; // 1ms past expiry
  assert.equal(await store.get(key), null);
  assert.deepEqual(await store.snapshot(), {});
});

test('unrelated keys survive a remove', async () => {
  const file = tmpFile();
  const store = createPetIgnoreStore({ file, now: () => 1_000_000 });
  await store.set(sessionKey('codex', 'a', null), { durationMs: 60_000 });
  await store.set(sessionKey('codex', 'b', null), { durationMs: 60_000 });
  await store.remove(sessionKey('codex', 'a', null));
  assert.equal(await store.get(sessionKey('codex', 'a', null)), null);
  assert.ok((await store.get(sessionKey('codex', 'b', null))) !== null);
});

test('a malformed file is treated as empty (start fresh)', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  const store = createPetIgnoreStore({ file, now: () => 1_000_000 });
  assert.deepEqual(await store.snapshot(), {});
  // and a subsequent write still works
  const entry = await store.set(sessionKey('codex', 'abc', null), {});
  assert.ok(entry.until > entry.ignoredAt);
});
