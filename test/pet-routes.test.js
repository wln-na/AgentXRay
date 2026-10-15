// Bounds for the SSE poll interval exposed by GET /api/pet/state.
//
// The clamp is a real defense, not cosmetic: without it a client could ask the
// server to re-aggregate every millisecond. It is written as explicit range
// guards (rather than Math.min/Math.max) so the bound is visible on the value
// that reaches setInterval — CodeQL js/resource-exhaustion otherwise flags the
// timer duration as attacker-controlled.

const test = require('node:test');
const assert = require('node:assert/strict');

const { clampIntervalMs } = require('../lib/routes/pet');

test('clampIntervalMs falls back to the default when the value is absent', () => {
  assert.equal(clampIntervalMs(undefined), 2000);
});

test('clampIntervalMs floors empty/null input, which coerce to 0', () => {
  // Number('') and Number(null) are both 0 (a finite number), so they take the
  // floor path rather than the default. Asserted as-is to keep behaviour
  // identical to the pre-refactor Math.min/Math.max expression.
  assert.equal(clampIntervalMs(''), 500);
  assert.equal(clampIntervalMs(null), 500);
});

test('clampIntervalMs falls back to the default when the value is not a number', () => {
  assert.equal(clampIntervalMs('abc'), 2000);
  assert.equal(clampIntervalMs('NaN'), 2000);
  assert.equal(clampIntervalMs(Number.POSITIVE_INFINITY), 2000);
  assert.equal(clampIntervalMs(Number.NaN), 2000);
});

test('clampIntervalMs raises values below the floor', () => {
  assert.equal(clampIntervalMs('1'), 500);
  assert.equal(clampIntervalMs(0), 500);
  assert.equal(clampIntervalMs(-5000), 500);
  assert.equal(clampIntervalMs('499'), 500);
});

test('clampIntervalMs caps values above the ceiling', () => {
  assert.equal(clampIntervalMs('10001'), 10000);
  assert.equal(clampIntervalMs(60000), 10000);
  assert.equal(clampIntervalMs('1e9'), 10000);
});

test('clampIntervalMs passes in-range values through', () => {
  assert.equal(clampIntervalMs('500'), 500);
  assert.equal(clampIntervalMs(2000), 2000);
  assert.equal(clampIntervalMs('10000'), 10000);
  assert.equal(clampIntervalMs('7500'), 7500);
});

test('clampIntervalMs passes fractional in-range values through unchanged', () => {
  // No rounding is applied: the guard only clips to [500, 10000], so this
  // refactor is behaviour-identical to the previous Math.min/Math.max form.
  assert.equal(clampIntervalMs('1500.9'), 1500.9);
});

test('clampIntervalMs always returns a number inside the allowed range', () => {
  const probes = [undefined, null, '', 'abc', '-1', '0', '499', '500', '2000', '10000', '10001', '1e9', 1e9, -1e9];
  for (const probe of probes) {
    const out = clampIntervalMs(probe);
    assert.equal(typeof out, 'number', `probe ${String(probe)} should yield a number`);
    assert.ok(out >= 500 && out <= 10000, `probe ${String(probe)} yielded ${out} outside 500–10000`);
  }
});

test('clampIntervalMs tolerates repeated query params arriving as an array', () => {
  // Express turns ?interval=1&interval=2 into ['1','2']; Number() of that is NaN,
  // so the documented default must win instead of producing NaN or a 1ms timer.
  assert.equal(clampIntervalMs(['1', '2']), 2000);
});

test('clampIntervalMs is exposed without breaking the mount function export', () => {
  const mount = require('../lib/routes/pet');
  assert.equal(typeof mount, 'function', 'module export must stay the route mounter');
  assert.equal(typeof mount.clampIntervalMs, 'function');
});

test('mountPetRoutes registers GET /api/pet/state', () => {
  const mount = require('../lib/routes/pet');
  const routes = [];
  const fakeApp = {
    get(path, handler) {
      routes.push({ path, handler });
    },
  };
  mount(fakeApp);
  assert.deepEqual(
    routes.map((r) => r.path),
    ['/api/pet/state']
  );
  assert.equal(typeof routes[0].handler, 'function');
});
