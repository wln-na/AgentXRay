// 桌面宠物壳点击跳回客户端单测：buildOpenRequest 平台分派 + N1（body 只有 action）+
// createOpenClient（假 httpRequest 覆盖成功/错误/响应畸形）。绝不真连 3800。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildOpenRequest, buildIgnoreRequest, createOpenClient } = require(
  path.join(__dirname, '..', 'desktop', 'lib', 'open-client')
);

function makeFakeHttpRequest() {
  const reqs = [];
  function httpRequest(opts, cb) {
    const reqEvents = {};
    const req = {
      written: '',
      on(ev, fn) {
        (reqEvents[ev] || (reqEvents[ev] = [])).push(fn);
        return req;
      },
      emit(ev, ...a) {
        (reqEvents[ev] || []).forEach((f) => f(...a));
      },
      write(s) {
        req.written += s;
      },
      end() {
        req.ended = true;
      },
    };
    const resEvents = {};
    const res = {
      on(ev, fn) {
        (resEvents[ev] || (resEvents[ev] = [])).push(fn);
        return res;
      },
    };
    const conn = {
      opts,
      req,
      respond: () => cb(res),
      data: (c) => (resEvents.data || []).forEach((f) => f(c)),
      end: () => (resEvents.end || []).forEach((f) => f()),
      failReq: (e) => req.emit('error', e),
    };
    reqs.push(conn);
    return req;
  }
  return { httpRequest, reqs };
}

// --- buildOpenRequest ---

test('buildOpenRequest：普通平台走 /api/:platform/sessions/:id/open', () => {
  const r = buildOpenRequest({ platform: 'codex', sessionId: 'abc', action: 'open' });
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/codex/sessions/abc/open');
  assert.deepEqual(r.body, { action: 'open' });
});

test('buildOpenRequest：openclaw 走 /api/agents/:agent/sessions/:id/open', () => {
  const r = buildOpenRequest({ platform: 'openclaw', agent: 'a1', sessionId: 's1' });
  assert.equal(r.path, '/api/agents/a1/sessions/s1/open');
  assert.deepEqual(r.body, { action: 'open' }); // 默认 open
});

test('buildOpenRequest：action=locate 透传', () => {
  const r = buildOpenRequest({ platform: 'codex', sessionId: 'abc', action: 'locate' });
  assert.deepEqual(r.body, { action: 'locate' });
});

test('N1：body 只含 action，绝不携带任何内容回复', () => {
  const r = buildOpenRequest({ platform: 'codex', sessionId: 'abc', action: 'open', reply: 'hi', text: 'x' });
  assert.deepEqual(Object.keys(r.body), ['action']);
});

// --- createOpenClient ---

test('createOpenClient.open：POST 到正确路径并把结果交给 onResult', async () => {
  const fake = makeFakeHttpRequest();
  const results = [];
  const client = createOpenClient({
    host: 'h',
    port: 1,
    httpRequest: fake.httpRequest,
    onResult: (r) => results.push(r),
  });

  const p = client.open({ platform: 'codex', sessionId: 's1', action: 'open' });
  const conn = fake.reqs[0];
  assert.equal(conn.opts.path, '/api/codex/sessions/s1/open');
  assert.equal(conn.opts.method, 'POST');
  assert.equal(conn.opts.host, 'h');
  assert.equal(conn.opts.port, 1);
  assert.equal(conn.req.written, JSON.stringify({ action: 'open' }));

  conn.respond();
  conn.data('{"ok":true,"action":"open","detail":"已在 ChatGPT 中打开会话"}');
  conn.end();

  const result = await p;
  assert.equal(result.ok, true);
  assert.equal(result.action, 'open');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], result);
});

test('createOpenClient.locate：action 为 locate', async () => {
  const fake = makeFakeHttpRequest();
  const client = createOpenClient({ host: 'h', port: 1, httpRequest: fake.httpRequest });
  const p = client.locate({ platform: 'claude-code', sessionId: 's1' });
  assert.equal(fake.reqs[0].req.written, JSON.stringify({ action: 'locate' }));
  fake.reqs[0].respond();
  fake.reqs[0].data('{"ok":true,"action":"locate"}');
  fake.reqs[0].end();
  const r = await p;
  assert.equal(r.action, 'locate');
});

test('createOpenClient：网络错误 → onError 且 resolve {ok:false,error}', async () => {
  const fake = makeFakeHttpRequest();
  const errors = [];
  const client = createOpenClient({
    host: 'h',
    port: 1,
    httpRequest: fake.httpRequest,
    onError: (e) => errors.push(e),
  });
  const p = client.open({ platform: 'codex', sessionId: 's1' });
  fake.reqs[0].failReq(new Error('ECONNREFUSED'));
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(errors.length, 1);
});

test('createOpenClient：响应畸形 JSON → 报错并 resolve {ok:false}', async () => {
  const fake = makeFakeHttpRequest();
  const errors = [];
  const client = createOpenClient({
    host: 'h',
    port: 1,
    httpRequest: fake.httpRequest,
    onError: (e) => errors.push(e),
  });
  const p = client.open({ platform: 'codex', sessionId: 's1' });
  fake.reqs[0].respond();
  fake.reqs[0].data('not json');
  fake.reqs[0].end();
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /解析失败/);
  assert.equal(errors.length, 1);
});

test('createOpenClient.copyFallback：返回 path / command，无则 null', () => {
  const client = createOpenClient({ httpRequest: makeFakeHttpRequest().httpRequest });
  assert.equal(client.copyFallback({ ok: false, fallback: { type: 'copy-path', path: '/x/y.jsonl' } }), '/x/y.jsonl');
  assert.equal(
    client.copyFallback({ ok: false, fallback: { type: 'copy-command', command: 'codex resume abc' } }),
    'codex resume abc'
  );
  assert.equal(client.copyFallback({ ok: true }), null);
  assert.equal(client.copyFallback({ ok: false, fallback: null }), null);
});

// --- buildIgnoreRequest ---

test('buildIgnoreRequest: set → POST /api/pet/ignore with platform/sessionId/agent', () => {
  const r = buildIgnoreRequest({ platform: 'codex', sessionId: 'abc', agent: 'a1' }, 'set');
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/api/pet/ignore');
  assert.deepEqual(r.body, { platform: 'codex', sessionId: 'abc', agent: 'a1' });
});

test('buildIgnoreRequest: set carries durationMs only when finite', () => {
  const withDur = buildIgnoreRequest({ platform: 'codex', sessionId: 'abc', durationMs: 60000 }, 'set');
  assert.equal(withDur.body.durationMs, 60000);
  const noDur = buildIgnoreRequest({ platform: 'codex', sessionId: 'abc' }, 'set');
  assert.equal(noDur.body.durationMs, undefined);
});

test('buildIgnoreRequest: clear → POST /api/pet/ignore/clear, no durationMs', () => {
  const r = buildIgnoreRequest({ platform: 'codex', sessionId: 'abc', agent: 'a1', durationMs: 5 }, 'clear');
  assert.equal(r.path, '/api/pet/ignore/clear');
  assert.deepEqual(r.body, { platform: 'codex', sessionId: 'abc', agent: 'a1' });
});

test('createOpenClient.ignoreSession: POST to /api/pet/ignore', async () => {
  const fake = makeFakeHttpRequest();
  const client = createOpenClient({ host: 'h', port: 1, httpRequest: fake.httpRequest });
  const p = client.ignoreSession({ platform: 'codex', sessionId: 's1', durationMs: 30000 });
  const conn = fake.reqs[0];
  assert.equal(conn.opts.path, '/api/pet/ignore');
  assert.equal(conn.opts.method, 'POST');
  assert.equal(conn.req.written, JSON.stringify({ platform: 'codex', sessionId: 's1', durationMs: 30000 }));
  conn.respond();
  conn.data('{"ok":true,"ignoredAt":1,"until":2}');
  conn.end();
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.until, 2);
});

test('createOpenClient.clearIgnoreSession: POST to /api/pet/ignore/clear', async () => {
  const fake = makeFakeHttpRequest();
  const client = createOpenClient({ host: 'h', port: 1, httpRequest: fake.httpRequest });
  const p = client.clearIgnoreSession({ platform: 'codex', sessionId: 's1' });
  assert.equal(fake.reqs[0].opts.path, '/api/pet/ignore/clear');
  assert.equal(fake.reqs[0].req.written, JSON.stringify({ platform: 'codex', sessionId: 's1' }));
  fake.reqs[0].respond();
  fake.reqs[0].data('{"ok":true,"removed":true}');
  fake.reqs[0].end();
  const r = await p;
  assert.equal(r.removed, true);
});
