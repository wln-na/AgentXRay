const assert = require('node:assert/strict');
const test = require('node:test');

const { startServer } = require('./helpers');

test('SPA fallback rate limit rejects requests above the per-minute budget', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  for (let index = 0; index < 120; index += 1) {
    const response = await fetch(`${srv.base}/rate-limit-${index}`);
    assert.notEqual(response.status, 429);
  }

  const blocked = await fetch(`${srv.base}/rate-limit-final`);
  assert.equal(blocked.status, 429);
  assert.equal(await blocked.text(), 'Too many requests');
  assert.ok(blocked.headers.get('ratelimit-policy'));
});
