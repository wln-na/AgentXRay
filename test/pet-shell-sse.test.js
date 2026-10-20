// 桌面宠物壳状态客户端单测：SseParser 分帧 + createStateClient（假 http/假定时器覆盖
// 连接、state 事件、畸形帧、error 事件、ping、指数退避、stop）。绝不真连 3800。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createSseParser, buildStateUrl, createStateClient } = require(
  path.join(__dirname, '..', 'desktop', 'lib', 'sse')
);

// --- 假 http：模拟 http.get(opts, cb)，手工驱动 res 事件 ---
function makeFakeHttp() {
  const conns = [];
  function httpGet(opts, cb) {
    const reqEvents = {};
    const req = {
      on(ev, fn) {
        (reqEvents[ev] || (reqEvents[ev] = [])).push(fn);
        return req;
      },
      emit(ev, ...a) {
        (reqEvents[ev] || []).forEach((f) => f(...a));
      },
      destroy() {
        req.destroyed = true;
      },
    };
    const resEvents = {};
    const res = {
      on(ev, fn) {
        (resEvents[ev] || (resEvents[ev] = [])).push(fn);
        return res;
      },
      destroy() {
        res.destroyed = true;
      },
    };
    const conn = {
      opts,
      req,
      res,
      respond: () => cb(res),
      data: (chunk) => (resEvents.data || []).forEach((f) => f(chunk)),
      end: () => (resEvents.end || []).forEach((f) => f()),
      failRes: (err) => (resEvents.error || []).forEach((f) => f(err)),
      failReq: (err) => req.emit('error', err),
    };
    conns.push(conn);
    return req;
  }
  return { httpGet, conns };
}

// --- 假定时器：可停获退避延迟并按需触发 ---
function makeClock() {
  let id = 0;
  const timers = new Map();
  function setTimeoutFn(fn, delay) {
    const t = { id: ++id, fn, delay, cleared: false };
    timers.set(t.id, t);
    return t.id;
  }
  function clearTimeoutFn(tid) {
    const t = timers.get(tid);
    if (t) t.cleared = true;
  }
  function pending() {
    return [...timers.values()].filter((t) => !t.cleared);
  }
  function fireNext() {
    const t = pending()[0];
    timers.delete(t.id);
    t.fn();
    return t;
  }
  return { setTimeoutFn, clearTimeoutFn, pending, fireNext };
}

// --- SseParser ---

test('SseParser 把 chunk 累积并按空行切事件', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\ndata: {"a":1}\n\n'), [{ event: 'state', data: '{"a":1}' }]);
  // 两个事件在同一 chunk。
  const two = p.feed('event: state\ndata: x\n\nevent: state\ndata: y\n\n');
  assert.deepEqual(two, [
    { event: 'state', data: 'x' },
    { event: 'state', data: 'y' },
  ]);
});

test('SseParser 处理跨 chunk 的半个事件', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: sta'), []);
  assert.deepEqual(p.feed('te\ndata: hello'), []);
  assert.deepEqual(p.feed('\n\n'), [{ event: 'state', data: 'hello' }]);
});

test('SseParser 多行 data 用 \\n 连接，默认事件名 message', () => {
  const p = createSseParser();
  const out = p.feed('data: line1\ndata: line2\n\n');
  assert.deepEqual(out, [{ event: 'message', data: 'line1\nline2' }]);
});

test('SseParser 注释块（: ping）产出内部 __ping__ 事件', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed(': ping\n\n'), [{ event: '__ping__', data: '' }]);
});

test('SseParser 忽略空块，reset 清空缓冲', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('\n\n\n\n'), []);
  p.feed('event: state\ndata: partial');
  p.reset();
  assert.deepEqual(p.feed('\n\n'), []);
});

test('SseParser：CRLF 恰好跨 chunk 边界（chunk1 以 \\r 结尾）→ 缓冲尾部 CR 等下一 chunk 确认', () => {
  // 修复前实现按每个 chunk 立即把 \r 归一成 \n，会把跨 chunk 的 CRLF 误判为两条事件，
  // 使 data 落到新块、事件名退化为默认 message。正确语义：残片（含尾部孤立 \r）留在缓冲。
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\r'), []);
  assert.deepEqual(p.feed('\ndata: x\r\n\r\n'), [{ event: 'state', data: 'x' }]);
});

test('SseParser：LF 恰好跨 chunk 边界（chunk1 以 \\n 结尾）→ 单个事件', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\ndata: x\n'), []);
  assert.deepEqual(p.feed('\n'), [{ event: 'state', data: 'x' }]);
});

test('SseParser：整段 CRLF 流按任意切分点均得同一结果', () => {
  const full = 'event: state\r\ndata: hello\r\n\r\nevent: state\r\ndata: world\r\n\r\n';
  // 从每个位置切一刀，逐段拼回，都应得到同两条事件。
  for (let cut = 0; cut <= full.length; cut++) {
    const p = createSseParser();
    const out = [...p.feed(full.slice(0, cut)), ...p.feed(full.slice(cut))];
    assert.deepEqual(
      out,
      [
        { event: 'state', data: 'hello' },
        { event: 'state', data: 'world' },
      ],
      `cut=${cut} 分帧结果不一致`
    );
  }
});

// --- buildStateUrl ---

test('buildStateUrl 生成后端约定的 URL', () => {
  assert.equal(
    buildStateUrl({ host: '127.0.0.1', port: 3800, window: 180, interval: 2000 }),
    'http://127.0.0.1:3800/api/pet/state?window=180&interval=2000'
  );
  assert.equal(buildStateUrl({}), 'http://127.0.0.1:3800/api/pet/state?window=180&interval=2000');
});

// --- createStateClient ---

test('createStateClient：连接 → state 事件 → onState / onStatus / last', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const states = [];
  const statuses = [];
  const errors = [];
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    onState: (s) => states.push(s),
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
  });

  client.start();
  assert.equal(http.conns.length, 1);
  http.conns[0].respond();

  const payload = '{"state":"working","platform":"codex","sessionId":"s1","agent":null,"bubble":"b","updatedAt":1}';
  http.conns[0].data(`event: state\ndata: ${payload}\n\n`);

  assert.equal(states.length, 1);
  assert.equal(states[0].state, 'working');
  assert.deepEqual(client.last(), states[0]);
  assert.equal(client.isConnected(), true);
  assert.ok(statuses.some((s) => s.connected === true));
  assert.equal(errors.length, 0);
  client.stop();
});

test('createStateClient：畸形帧丢弃并 onError，但不断开连接', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const errors = [];
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    onError: (e) => errors.push(e),
  });
  client.start();
  http.conns[0].respond();
  http.conns[0].data('event: state\ndata: {bad json}\n\n');

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /解析失败/);
  assert.equal(client.isConnected(), true);
  assert.equal(http.conns.length, 1); // 未触发重连
  assert.equal(clock.pending().length, 0);
  client.stop();
});

test('createStateClient：event: error 只回调 onError，不断开连接', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const errors = [];
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    onError: (e) => errors.push(e),
  });
  client.start();
  http.conns[0].respond();
  http.conns[0].data('event: error\ndata: {"error":"boom"}\n\n');

  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'boom');
  assert.equal(client.isConnected(), true);
  assert.equal(clock.pending().length, 0);
  client.stop();
});

test('createStateClient：解析出的 event: error 帧刷新 lastLiveness（后端仍活着）', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  let t = 100;
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    now: () => t,
    onError: () => {},
  });
  client.start();
  http.conns[0].respond();
  t = 5000;
  http.conns[0].data('event: error\ndata: {"error":"aggregator boom"}\n\n');
  assert.equal(client.lastLiveness(), 5000); // 能解析出 error 帧 = 后端收到了心跳/仍存活
  assert.equal(client.isConnected(), true);
  client.stop();
});

test('createStateClient：传输层/socket 错误不刷新 lastLiveness（恰是不健康信号）', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  let t = 100;
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    now: () => t,
    onError: () => {},
  });
  client.start();
  http.conns[0].respond();
  t = 8000;
  http.conns[0].failRes(new Error('socket boom')); // res 'error' → 传输层错误，非解析出的帧
  assert.equal(client.lastLiveness(), null); // 不刷新
  client.stop();
});

test('createStateClient：ping 刷新存活时间且不下发状态', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const states = [];
  let t = 1000;
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    now: () => t,
    onState: (s) => states.push(s),
  });
  client.start();
  http.conns[0].respond();
  t = 5000;
  http.conns[0].data(': ping\n\n');
  assert.equal(states.length, 0);
  assert.equal(client.lastLiveness(), 5000);
  client.stop();
});

test('createStateClient：断线指数退避（baseMs*2^attempt）', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    reconnect: { baseMs: 1000, maxMs: 30000, jitter: 0 },
  });
  client.start();
  assert.equal(http.conns.length, 1);
  http.conns[0].respond();
  http.conns[0].end();
  assert.equal(clock.pending()[0].delay, 1000);
  clock.fireNext();
  assert.equal(http.conns.length, 2);

  http.conns[1].respond();
  http.conns[1].end();
  assert.equal(clock.pending()[0].delay, 2000);
  clock.fireNext();
  assert.equal(http.conns.length, 3);

  http.conns[2].respond();
  http.conns[2].end();
  assert.equal(clock.pending()[0].delay, 4000);
  client.stop();
});

test('createStateClient：stop() 后不再重连且清退避定时器', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    reconnect: { baseMs: 1000, maxMs: 30000, jitter: 0 },
  });
  client.start();
  http.conns[0].respond();
  http.conns[0].end(); // 触发退避定时器
  assert.equal(clock.pending().length, 1);

  client.stop();
  assert.equal(clock.pending().length, 0); // 定时器已清
  assert.equal(client.isConnected(), false);

  // 再次 end 不应触发重连（已 stop）。
  http.conns[0].end();
  assert.equal(http.conns.length, 1);
  assert.equal(clock.pending().length, 0);
});
