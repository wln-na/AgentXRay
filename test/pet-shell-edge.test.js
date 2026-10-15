// 桌面宠物壳【破坏性 / 边界】单测（QA 严过关补充，独立于工程师自证用例）。
//
// 目标：主动构造跨 chunk 分帧、CRLF、逃逸路径、越界数值、优先级冲突、注入字符等
// 恶意/边界输入，验证纯模块在「设计之外的输入」下是否仍行为正确。
// 纯 Node，不 require electron，不碰真实桌面/网络/子进程。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsSync = require('node:fs');

const { createSseParser, createStateClient } = require(path.join(__dirname, '..', 'desktop', 'lib', 'sse'));
const { decideWatchdog } = require(path.join(__dirname, '..', 'desktop', 'lib', 'watchdog'));
const sprite = require(path.join(__dirname, '..', 'desktop', 'lib', 'sprite'));
const fullscreen = require(path.join(__dirname, '..', 'desktop', 'lib', 'fullscreen'));
const launchagent = require(path.join(__dirname, '..', 'desktop', 'lib', 'launchagent'));
const openClient = require(path.join(__dirname, '..', 'desktop', 'lib', 'open-client'));
const nodeExec = require(path.join(__dirname, '..', 'desktop', 'lib', 'node-exec'));

// ============ 通用假件 ============

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

// ============ A1. createSseParser 破坏性输入 ============

test('SseParser：一个事件被切成 3 段跨 chunk 仍是单个事件', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: sta'), []);
  assert.deepEqual(p.feed('te\ndata: {"s'), []);
  assert.deepEqual(p.feed('tate":"ok"}\n\n'), [{ event: 'state', data: '{"state":"ok"}' }]);
});

test('SseParser：chunk 内完整 CRLF 行结束符（\\r\\n）等价于 LF', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\r\ndata: x\r\n\r\n'), [{ event: 'state', data: 'x' }]);
});

test('SseParser：孤立 CR 作为行结束符也能分帧', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\rdata: x\r\r'), [{ event: 'state', data: 'x' }]);
});

test('SseParser：CRLF 恰好跨 chunk 边界（chunk1 以 \\r 结尾）仍是单个事件', () => {
  // 回归锁（第 1 轮发现、第 2 轮修复）：旧实现每次 feed 立即把缓冲尾部孤立 \r 归一成 \n，
  // 使跨 chunk 的 CRLF 被误判为两条事件；现实现保留原始 buffer、仅在 feed 时按空行正则切分，
  // 尾部孤立 \r 留待下一 chunk 确认。断言值保持不变（即「正确」语义）。
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\r'), []);
  assert.deepEqual(p.feed('\ndata: x\r\n\r\n'), [{ event: 'state', data: 'x' }]);
});

test('SseParser：event: 与 data: 顺序颠倒也能正确归属', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('data: payload\nevent: state\n\n'), [{ event: 'state', data: 'payload' }]);
});

test('SseParser：多行 data 用 \\n 拼接，且每行去掉一个前导空格', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('data:  one\ndata:  two\n\n'), [{ event: 'message', data: ' one\n two' }]);
});

test('SseParser：空 data（data: 无值）产出空字符串而非丢弃', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\ndata:\n\n'), [{ event: 'state', data: '' }]);
});

test('SseParser：注释/心跳行（: / : ping / 带前导空格）产出 __ping__', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed(':\n\n'), [{ event: '__ping__', data: '' }]);
  assert.deepEqual(p.feed(': ping\n\n'), [{ event: '__ping__', data: '' }]);
  assert.deepEqual(p.feed(':   keep-alive   \n\n'), [{ event: '__ping__', data: '' }]);
});

test('SseParser：注释与 data 混合块仍按 data 归属（注释仅刷新存活）', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: state\n: comment\ndata: z\n\n'), [{ event: 'state', data: 'z' }]);
});

test('SseParser：只含未知字段的块被忽略（不产出事件）', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('retry: 3000\nid: 7\n\n'), []);
});

test('SseParser：超长 chunk（~200KB data，含冒号与中文）完整解析', () => {
  const payload = `${'x'.repeat(200 * 1024)}:{"中文":1}`;
  const p = createSseParser();
  const out = p.feed(`event: state\ndata: ${payload}\n\n`);
  assert.equal(out.length, 1);
  assert.equal(out[0].event, 'state');
  assert.equal(out[0].data, payload);
  assert.equal(out[0].data.length, 200 * 1024 + ':{"中文":1}'.length);
});

test('SseParser：单个巨型 chunk 内多个事件全部分帧', () => {
  const p = createSseParser();
  let chunk = '';
  for (let i = 0; i < 500; i++) chunk += `event: state\ndata: {"i":${i}}\n\n`;
  const out = p.feed(chunk);
  assert.equal(out.length, 500);
  assert.equal(out[499].data, '{"i":499}');
});

// ============ A1b. SseParser 分帧不变性（穷举切分点 / 混合行结束符）============

function wholeFeed(stream) {
  const p = createSseParser();
  return JSON.stringify(p.feed(stream));
}

test('SseParser：CRLF / LF / CR 三种流在【全部切分点】两段 feed 均与整段一致', () => {
  const streams = {
    CRLF: 'event: state\r\ndata: {"a":1}\r\n\r\n',
    LF: 'event: state\ndata: {"a":1}\n\n',
    CR: 'event: state\rdata: {"a":1}\r\r',
  };
  for (const [name, s] of Object.entries(streams)) {
    const expected = wholeFeed(s);
    for (let k = 0; k <= s.length; k++) {
      const p = createSseParser();
      const got = JSON.stringify(p.feed(s.slice(0, k)).concat(p.feed(s.slice(k))));
      assert.equal(got, expected, `${name} 在 k=${k} 切分不一致`);
    }
  }
});

test('SseParser：CRLF 流在【全部三段切分点】一致（i≤j 穷举）', () => {
  const s = 'event: state\r\ndata: {"a":1}\r\n\r\n';
  const expected = wholeFeed(s);
  for (let i = 0; i <= s.length; i++) {
    for (let j = i; j <= s.length; j++) {
      const p = createSseParser();
      const got = JSON.stringify(p.feed(s.slice(0, i)).concat(p.feed(s.slice(i, j)), p.feed(s.slice(j))));
      assert.equal(got, expected, `三段切分 i=${i},j=${j} 不一致`);
    }
  }
});

test('SseParser：同一流内混用不同风格的空行分隔符（各分隔符自身统一）均可分帧', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('data: a\r\n\r\ndata: b\n\ndata: c\r\r'), [
    { event: 'message', data: 'a' },
    { event: 'message', data: 'b' },
    { event: 'message', data: 'c' },
  ]);
});

test('SseParser：一个 chunk 内 3 条完整事件 + \\r\\r 相邻分隔 + data 值含 CR', () => {
  const p = createSseParser();
  assert.equal(p.feed('event: s\ndata: 1\n\nevent: s\ndata: 2\n\nevent: s\ndata: 3\n\n').length, 3);
  const q = createSseParser();
  assert.deepEqual(q.feed('data: 1\r\rdata: 2\r\r'), [
    { event: 'message', data: '1' },
    { event: 'message', data: '2' },
  ]);
  // data 值里的裸 CR 按 SSE 规范是行结束符 → 拆行，'b' 成为未知字段被忽略，data 仍为 'a'。
  const r = createSseParser();
  assert.deepEqual(r.feed('event: state\ndata: a\rb\n\n'), [{ event: 'state', data: 'a' }]);
});

test('SseParser：跨风格「两字符分隔符」为已知限制（设计仅要求 \\n\\n；此处锁定现状）', () => {
  // 现状锁定：跨风格两字符分隔 `\n\r`、`\n\r\n`、`\r\n\r` **不被识别** → 事件不切分、极端下返回
  //   []（丢帧）。范围：设计 §142 只要求按 `\n\n` 切事件（已满足）；后端 lib/routes/pet.js
  //   只发 LF → 当前**不可触发**；属已知限制，非缺陷。
  // ⚠️ 不要把修复写成 `EVENT_SEP = /(?:\r\n|\r|\n){2}/` 这类交替式正则：`CR+LF` 与「单个 CRLF」
  //   在字节层同形（都是 `\r\n`），该正则会**回溯**把单个 CRLF 拆成 `\r`+`\n` 两个 token → 误当空行。
  //   实测证据：`/(?:\r\n|\r|\n){2}/.match('\r\n')` 命中 `'\r\n'`，且
  //   `'event: state\r\ndata: x\r\n\r\n'.split(...)` 得到 **3 段**（应为 1 条）→ 采纳即回归。
  //   若将来真要加固：用**贪婪行结束符分词器**（先消费 `\r\n`，再消费孤立 `\r` 或 `\n`；空行 = 连续两个 token）。
  // 此用例**特征化锁定现状**，是该已知限制的凭据；断言不得因「修文案」而改动。
  const T = { L: '\n', C: '\r', R: '\r\n' };
  const recognized = ['LL', 'CC', 'RR', 'CR', 'RL']; // 同风格对，或含 \n\n / \r\r 子串者
  const limited = ['LC', 'LR', 'RC']; // 跨风格且不含 \n\n / \r\r 子串
  for (const key of recognized) {
    const p = createSseParser();
    const sep = T[key[0]] + T[key[1]];
    const out = p.feed(`data: A${sep}data: B${sep}`);
    assert.equal(out.length, 2, `分隔符 ${key} 应被识别`);
  }
  for (const key of limited) {
    const p = createSseParser();
    const sep = T[key[0]] + T[key[1]];
    assert.deepEqual(p.feed(`data: A${sep}data: B${sep}`), [], `分隔符 ${key} 现状：未识别（预期缺口）`);
  }
});

// ============ A2. createStateClient 破坏性输入 ============

test('createStateClient：连续畸形帧不影响后续正常帧，且不触发重连', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const errors = [];
  const states = [];
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    onError: (e) => errors.push(e),
    onState: (s) => states.push(s),
  });
  client.start();
  http.conns[0].respond();
  http.conns[0].data('event: state\ndata: {bad 1}\n\n');
  http.conns[0].data('event: state\ndata: {bad 2}\n\n');
  http.conns[0].data('event: state\ndata: {"state":"working"}\n\n');

  assert.equal(errors.length, 2);
  assert.equal(states.length, 1);
  assert.equal(states[0].state, 'working');
  assert.equal(client.isConnected(), true);
  assert.equal(http.conns.length, 1); // 未重连
  assert.equal(clock.pending().length, 0);
  client.stop();
});

test('createStateClient：退避按指数增长并封顶于 maxMs', () => {
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
  const delays = [];
  for (let i = 0; i < 7; i++) {
    http.conns[i].respond();
    http.conns[i].end();
    delays.push(clock.pending()[0].delay);
    clock.fireNext();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(http.conns.length, 8);
  client.stop();
});

test('createStateClient：收到有效 state 帧后 attempt 归零（退避回到 baseMs）', () => {
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
  http.conns[0].end(); // 第一次断线 → 1000
  assert.equal(clock.pending()[0].delay, 1000);
  clock.fireNext(); // conn1
  http.conns[1].respond();
  http.conns[1].data('event: state\ndata: {"state":"idle"}\n\n'); // attempt 归零
  http.conns[1].end();
  assert.equal(clock.pending()[0].delay, 1000); // 仍为 base
  client.stop();
});

test('createStateClient.lastLiveness：从未连接 → null', () => {
  const client = createStateClient({ host: 'h', port: 1, httpGet: makeFakeHttp().httpGet });
  assert.equal(client.lastLiveness(), null);
  client.stop();
});

test('createStateClient.lastLiveness：state 帧与 `: ping` 心跳都刷新（设计 §3.1）', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  let t = 1000;
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    now: () => t,
  });
  client.start();
  http.conns[0].respond();
  t = 4000;
  http.conns[0].data('event: state\ndata: {"state":"idle"}\n\n');
  assert.equal(client.lastLiveness(), 4000);
  t = 9000;
  http.conns[0].data(': ping\n\n');
  assert.equal(client.lastLiveness(), 9000);
  client.stop();
});

test('createStateClient：event: error 不断连、不产状态；但刷新 lastLiveness（后端仍活着）', () => {
  // 设计 §3.1 说 lastLiveness 来源是「成功 /api/version 或收到任一 SSE 帧」；因此**解析出来的
  // error 帧**也算存活证据（后端能发帧说明还活着），先刷新再回调 onError。
  // 注意：传输层 / socket 错误不算存活信号（另有独立用例锁定）。
  const http = makeFakeHttp();
  const clock = makeClock();
  const errors = [];
  const states = [];
  let t = 100;
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    now: () => t,
    onError: (e) => errors.push(e),
    onState: (s) => states.push(s),
  });
  client.start();
  http.conns[0].respond();
  t = 500;
  http.conns[0].data('event: error\ndata: {"error":"aggregator boom"}\n\n');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'aggregator boom');
  assert.equal(states.length, 0);
  assert.equal(client.isConnected(), true);
  assert.equal(client.lastLiveness(), 500); // 解析出的 error 帧刷新了存活时间
  assert.equal(clock.pending().length, 0); // 未重连
  client.stop();
});

test('createStateClient：未知事件名视为存活证据（刷新 lastLiveness，不下发状态）', () => {
  const http = makeFakeHttp();
  const clock = makeClock();
  const states = [];
  let t = 10;
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
  t = 7777;
  http.conns[0].data('event: heartbeat\ndata: {}\n\n');
  assert.equal(states.length, 0);
  assert.equal(client.lastLiveness(), 7777);
  client.stop();
});

test('createStateClient：传输层/socket 错误【不】刷新 lastLiveness（与解析出的 error 帧相对照）', () => {
  // 设计 §3.1：liveness 由「成功 /api/version 或收到任一 SSE 帧」刷新。socket 级错误不是
  // 「收到帧」，恰是不健康信号 → 不刷新。与上一条（解析出的 error 帧刷新）互为对照。
  const http = makeFakeHttp();
  const clock = makeClock();
  const errors = [];
  let t = 100;
  const client = createStateClient({
    host: 'h',
    port: 1,
    httpGet: http.httpGet,
    setTimeout: clock.setTimeoutFn,
    clearTimeout: clock.clearTimeoutFn,
    now: () => t,
    onError: (e) => errors.push(e),
  });
  client.start();
  http.conns[0].respond();
  t = 8000;
  http.conns[0].failRes(new Error('socket boom'));
  assert.equal(errors.length, 1);
  assert.equal(client.lastLiveness(), null); // 传输层错误不刷新
  assert.equal(client.isConnected(), false); // 触发断线
  client.stop();
});

test('createStateClient：stop() 在退避等待中也会清定时器，之后再 start() 可重连', () => {
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
  http.conns[0].end();
  assert.equal(clock.pending().length, 1);
  client.stop();
  assert.equal(clock.pending().length, 0);
  client.start();
  assert.equal(http.conns.length, 2);
  client.stop();
});

// ============ A3. watchdog.decideWatchdog 优先级与边界 ============

test('watchdog 优先级：同时满足「启动宽限」与「达上限」时取规则 1', () => {
  const r = decideWatchdog({ now: 1000, lastLivenessAt: null, childAlive: true, restartCount: 99, startedAt: 900 });
  assert.deepEqual(r, { action: 'ok', reason: 'startup-grace' });
});

test('watchdog：childAlive=false 时 restartCount = maxRestarts-1 重启 / = maxRestarts 放弃', () => {
  const below = decideWatchdog({ now: 1e6, lastLivenessAt: 1, childAlive: false, restartCount: 4 });
  assert.equal(below.action, 'restart');
  assert.equal(below.reason, 'child-exited');
  const at = decideWatchdog({ now: 1e6, lastLivenessAt: 1, childAlive: false, restartCount: 5 });
  assert.deepEqual(at, { action: 'giveup', reason: 'max-restarts' });
});

test('watchdog：childAlive=true 假死时 restartCount = maxRestarts-1 重启 / = maxRestarts 放弃', () => {
  const below = decideWatchdog({ now: 1e6, lastLivenessAt: 1, childAlive: true, restartCount: 4 });
  assert.equal(below.reason, 'hung');
  assert.equal(below.action, 'restart');
  const at = decideWatchdog({ now: 1e6, lastLivenessAt: 1, childAlive: true, restartCount: 5 });
  assert.deepEqual(at, { action: 'giveup', reason: 'max-restarts' });
});

test('watchdog：nextBackoffMs 被 backoffMaxMs 夹住（极大 restartCount 不溢出为 Infinity）', () => {
  const r = decideWatchdog({
    now: 1e6,
    lastLivenessAt: 1,
    childAlive: false,
    restartCount: 1000,
    thresholds: { maxRestarts: 5000, backoffBaseMs: 1000, backoffMaxMs: 30000 },
  });
  assert.equal(r.nextBackoffMs, 30000);
});

test('watchdog：startedAt=0（finite，非 null）在 now 很小时仍命中启动宽限', () => {
  const r = decideWatchdog({ now: 1000, lastLivenessAt: null, childAlive: true, restartCount: 0, startedAt: 0 });
  assert.deepEqual(r, { action: 'ok', reason: 'startup-grace' });
});

test('watchdog：startedAt=0 但 now 已远超宽限 → 判假死重启（0 不被当 null）', () => {
  const r = decideWatchdog({ now: 100000, lastLivenessAt: null, childAlive: true, restartCount: 0, startedAt: 0 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'hung');
});

test('watchdog：thresholds 部分覆盖只改指定项，其余沿用默认', () => {
  // 仅把 stallMs 改小：默认 20000 下本应 healthy，改为 1000 后应判假死。
  const healthy = decideWatchdog({ now: 1e6, lastLivenessAt: 1e6 - 5000, childAlive: true, restartCount: 0 });
  assert.equal(healthy.reason, 'healthy');
  const hung = decideWatchdog({
    now: 1e6,
    lastLivenessAt: 1e6 - 5000,
    childAlive: true,
    restartCount: 0,
    thresholds: { stallMs: 1000 },
  });
  assert.equal(hung.action, 'restart');
  assert.equal(hung.reason, 'hung');
});

test('watchdog：childAlive=true + liveness 新鲜 + 已达上限 → 仍 healthy（规则 2 先于 5）', () => {
  const r = decideWatchdog({ now: 1e6, lastLivenessAt: 1e6 - 1000, childAlive: true, restartCount: 99 });
  assert.deepEqual(r, { action: 'ok', reason: 'healthy' });
});

test('watchdog：childAlive=false + liveness 新鲜 → 仍判 child-exited（规则 3/4 先于 2）', () => {
  const r = decideWatchdog({ now: 1e6, lastLivenessAt: 1e6 - 10, childAlive: false, restartCount: 0 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'child-exited');
});

// ============ A4. sprite.parseManifest 恶意清单 ============

function manifestErr(obj, dir = '/packs/p1') {
  return sprite.parseManifest(JSON.stringify(obj), { dir }).errors.join(' | ');
}

test('parseManifest：dir 逃逸 —— ../ / 嵌套 .. / 反斜杠 .. / 绝对路径 全部拦截', () => {
  assert.match(manifestErr({ name: 'p', fps: 8, states: { idle: { dir: '../evil' } } }), /"\.\."|逃逸/);
  assert.match(manifestErr({ name: 'p', fps: 8, states: { idle: { dir: 'a/../../b' } } }), /"\.\."|逃逸/);
  assert.match(manifestErr({ name: 'p', fps: 8, states: { idle: { dir: '..\\evil' } } }), /"\.\."|逃逸/);
  assert.match(manifestErr({ name: 'p', fps: 8, states: { idle: { dir: '/etc/passwd' } } }), /逃逸/);
});

test('parseManifest：states 传数组 → 错误', () => {
  const r = sprite.parseManifest(JSON.stringify({ name: 'p', fps: 8, states: [] }), { dir: '/p' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /"states" 必须是一个对象/);
});

test('parseManifest：全局与 per-state 的 fps 越界（0 / 61）→ 错误', () => {
  assert.match(manifestErr({ name: 'p', fps: 0 }), /"fps" 必须是 1–60/);
  assert.match(manifestErr({ name: 'p', fps: 61 }), /"fps" 必须是 1–60/);
  assert.match(manifestErr({ name: 'p', fps: 8, states: { idle: { fps: 0 } } }), /idle\.fps 必须是 1–60/);
  assert.match(manifestErr({ name: 'p', fps: 8, states: { idle: { fps: 99 } } }), /idle\.fps 必须是 1–60/);
});

test('parseManifest：scale 0 / 9 越界；8 合法', () => {
  assert.match(manifestErr({ name: 'p', fps: 8, scale: 0 }), /"scale" 必须是 1–8/);
  assert.match(manifestErr({ name: 'p', fps: 8, scale: 9 }), /"scale" 必须是 1–8/);
  const ok = sprite.parseManifest(JSON.stringify({ name: 'p', fps: 8, scale: 8 }), { dir: '/p' });
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.scale, 8);
});

test('parseManifest：anchor 越界 / 数组 / 非对象 → 错误', () => {
  assert.match(manifestErr({ name: 'p', fps: 8, anchor: { x: -0.1, y: 0.5 } }), /"anchor"/);
  assert.match(manifestErr({ name: 'p', fps: 8, anchor: { x: 0.5, y: 1.1 } }), /"anchor"/);
  assert.match(manifestErr({ name: 'p', fps: 8, anchor: [0.5, 1] }), /"anchor"/);
  assert.match(manifestErr({ name: 'p', fps: 8, anchor: 'nope' }), /"anchor"/);
});

test('parseManifest：version=0 → 错误；version=2 → 保留真实值 2 + 告警（按版本 1 字段规则解析）', () => {
  assert.match(manifestErr({ name: 'p', fps: 8, version: 0 }), /"version" 必须是正整数/);
  const r = sprite.parseManifest(JSON.stringify({ name: 'p', fps: 8, version: 2 }), { dir: '/p' });
  assert.equal(r.ok, true);
  // 第 2 轮已消解第 1 轮报告的「文案 vs 取值」矛盾：现实现刻意**保留真实 version=2**
  // （丢弃信息更糟），并将告警改为「将按当前版本(1)的字段规则解析」→ 取值与文案自洽。
  assert.equal(r.manifest.version, 2);
  assert.match(r.warnings.join(), /未知的包格式版本 2/);
  assert.match(r.warnings.join(), /按当前版本\(1\)的字段规则解析/);
});

test('parseManifest：name 恰好 64 合法，65 越界', () => {
  const ok = sprite.parseManifest(JSON.stringify({ name: 'x'.repeat(64), fps: 8 }), { dir: '/p' });
  assert.equal(ok.ok, true);
  const bad = sprite.parseManifest(JSON.stringify({ name: 'x'.repeat(65), fps: 8 }), { dir: '/p' });
  assert.equal(bad.ok, false);
});

test('parseManifest：未知 state 键仅 warning，不影响 ok；非对象 state 值为错误', () => {
  const warn = sprite.parseManifest(JSON.stringify({ name: 'p', fps: 8, states: { bogus: {} } }), { dir: '/p' });
  assert.equal(warn.ok, true);
  assert.match(warn.warnings.join(), /未知的 state 键 "bogus"/);
  const bad = sprite.parseManifest(JSON.stringify({ name: 'p', fps: 8, states: { idle: 5 } }), { dir: '/p' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /states\.idle 必须是一个对象/);
});

test('parseManifest：非对象顶层（null / [] / 数字 / 布尔 / 字符串）全部返回 ok:false 不抛', () => {
  for (const raw of [null, '[]', '123', 'true', '"str"']) {
    const r = sprite.parseManifest(raw, { dir: '/p' });
    assert.equal(r.ok, false, `raw=${raw} 应失败`);
    assert.equal(r.manifest, null);
    assert.ok(r.errors.length > 0);
  }
});

// ============ A5. sprite.resolveFrame / triangle 边界 ============

function manifestOf(obj) {
  return sprite.parseManifest(JSON.stringify(obj), { dir: '/p' }).manifest;
}

test('resolveFrame：frameCount=1 在 loop/pingpong/不循环下均为 index 0', () => {
  assert.equal(sprite.resolveFrame(manifestOf({ name: 'p', fps: 10 }), 'idle', 5000, 1).index, 0);
  assert.equal(
    sprite.resolveFrame(manifestOf({ name: 'p', fps: 10, states: { idle: { pingpong: true } } }), 'idle', 5000, 1)
      .index,
    0
  );
  assert.equal(sprite.resolveFrame(manifestOf({ name: 'p', fps: 10, loop: false }), 'idle', 5000, 1).index, 0);
});

test('resolveFrame：loop=false 且 raw 极大 → 停在末帧', () => {
  const m = manifestOf({ name: 'p', fps: 60, loop: false });
  assert.equal(sprite.resolveFrame(m, 'idle', 1e9, 5).index, 4);
});

test('resolveFrame：loop 与 pingpong 同时为真 → pingpong 优先（triangle）', () => {
  const m = manifestOf({ name: 'p', fps: 10, loop: true, states: { idle: { pingpong: true } } });
  // raw=4, frameCount=4 → period 6 → 6-4=2
  assert.equal(sprite.resolveFrame(m, 'idle', 400, 4).index, 2);
  assert.equal(sprite.resolveFrame(m, 'idle', 400, 4).pingpong, true);
});

test('resolveFrame：loop=false 与 pingpong=true 同真 → 不循环优先，停末帧', () => {
  const m = manifestOf({ name: 'p', fps: 10, loop: false, states: { idle: { pingpong: true } } });
  assert.equal(sprite.resolveFrame(m, 'idle', 1000, 4).index, 3); // min(10,3)
});

test('resolveFrame：elapsedMs 为负 —— 任意模式下 index 都夹在 [0, frameCount-1]', () => {
  const loopM = manifestOf({ name: 'p', fps: 10 });
  const neg = sprite.resolveFrame(loopM, 'idle', -1000, 4);
  assert.ok(neg.index >= 0 && neg.index < 4, `循环模式应回卷为非负，实际 ${neg.index}`);
  const ppM = manifestOf({ name: 'p', fps: 10, states: { idle: { pingpong: true } } });
  assert.ok(sprite.resolveFrame(ppM, 'idle', -1000, 4).index >= 0);
  const noLoopM = manifestOf({ name: 'p', fps: 10, loop: false });
  // 修复后：loop=false 分支也夹下界，负 elapsed 不再产负索引（原 min(raw, count-1) 缺陷）。
  assert.equal(sprite.resolveFrame(noLoopM, 'idle', -1000, 4).index, 0);
});

test('resolveFrame：【全域穷举】elapsedMs × frameCount × loop × pingpong 下 index 恒在 [0, frameCount-1]', () => {
  let checked = 0;
  for (const elapsedMs of [-1e6, -1, 0, 1, 999, 1e9]) {
    for (const frameCount of [1, 2, 3, 8]) {
      for (const loop of [true, false]) {
        for (const pingpong of [true, false]) {
          const m = { fps: 10, loop, states: { idle: { pingpong, loop } } };
          const { index } = sprite.resolveFrame(m, 'idle', elapsedMs, frameCount);
          assert.ok(
            Number.isInteger(index) && index >= 0 && index <= frameCount - 1,
            `越界：elapsed=${elapsedMs} count=${frameCount} loop=${loop} pingpong=${pingpong} → ${index}`
          );
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 96);
  // index===-1 仅保留给 frameCount<=0 或 manifest 非对象。
  assert.equal(sprite.resolveFrame(manifestOf({ name: 'p', fps: 10 }), 'idle', 100, 0).index, -1);
  assert.equal(sprite.resolveFrame(manifestOf({ name: 'p', fps: 10 }), 'idle', 100, -1).index, -1);
  assert.equal(sprite.resolveFrame(null, 'idle', 100, 4).index, -1);
});

test('resolveFrame：极端 fps（Infinity / 0）不抛，返回可判定结果', () => {
  assert.equal(sprite.resolveFrame({ fps: Number.POSITIVE_INFINITY, loop: true, states: {} }, 'idle', 100, 4).index, 0);
  assert.equal(sprite.resolveFrame({ fps: 0, loop: true, states: {} }, 'idle', 100, 4).index, 0);
});

test('triangle：m<=1 → 0；负 n 回卷；m=2 交替', () => {
  assert.equal(sprite.triangle(5, 1), 0);
  assert.equal(sprite.triangle(5, 0), 0);
  assert.equal(sprite.triangle(7, 2), 1); // period 2 → 7%2=1
  assert.equal(sprite.triangle(-1, 4), 1); // ((-1%6)+6)%6=5 → 6-5=1
});

// ============ A5b. sprite.listStateFrames 自然序与目录缺失 ============

test('listStateFrames：真实 fs 下自然序（1,2,10）且仅收 .png、排除子目录', async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'axr-edge-frames-'));
  try {
    for (const n of ['10.png', '2.png', '1.png', 'note.txt', 'UP.PNG']) {
      fsSync.writeFileSync(path.join(dir, n), '');
    }
    fsSync.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    const frames = await sprite.listStateFrames(dir);
    assert.deepEqual(
      frames.map((p) => path.basename(p)),
      ['1.png', '2.png', '10.png', 'UP.PNG']
    );
    assert.ok(frames.every((p) => path.isAbsolute(p)));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test('listStateFrames：目录不存在 → []', async () => {
  assert.deepEqual(await sprite.listStateFrames('/no/such/dir/at/all'), []);
});

// ============ A6. fullscreen 解析与判定边界 ============

test('parseSizeTuple：多余数字取前两个、负数/小数/带单位文本', () => {
  assert.deepEqual(fullscreen.parseSizeTuple('1,2,3'), { w: 1, h: 2 });
  assert.deepEqual(fullscreen.parseSizeTuple('{1, 2}'), { w: 1, h: 2 });
  assert.deepEqual(fullscreen.parseSizeTuple('1 2'), { w: 1, h: 2 });
  assert.deepEqual(fullscreen.parseSizeTuple('-5, -6'), { w: -5, h: -6 });
  assert.deepEqual(fullscreen.parseSizeTuple('1.5, 2.5'), { w: 1.5, h: 2.5 });
  assert.deepEqual(fullscreen.parseSizeTuple('1440px, 900px'), { w: 1440, h: 900 });
  assert.equal(fullscreen.parseSizeTuple('12'), null);
  assert.equal(fullscreen.parseSizeTuple(''), null);
});

test('parseBounds：不足四个数字 → null；负数差值为负也返回', () => {
  assert.equal(fullscreen.parseBounds('1,2,3'), null);
  assert.deepEqual(fullscreen.parseBounds('0 0 10 20'), { w: 10, h: 20 });
  assert.deepEqual(fullscreen.parseBounds('-5, -5, 5, 5'), { w: 10, h: 10 });
});

test('decideHidden：fullscreen:true 优先于 error 字段', () => {
  const r = fullscreen.decideHidden({ probeResult: { fullscreen: true, error: 'x' }, now: 1 });
  assert.deepEqual(r, { hidden: true, reason: 'fullscreen' });
});

test('decideHidden：lastFullscreenAt=0（finite，非 null）参与恢复延迟判定', () => {
  const within = fullscreen.decideHidden({ probeResult: { fullscreen: false }, now: 500, lastFullscreenAt: 0 });
  assert.deepEqual(within, { hidden: true, reason: 'resume-delay' });
  const past = fullscreen.decideHidden({ probeResult: { fullscreen: false }, now: 5000, lastFullscreenAt: 0 });
  assert.deepEqual(past, { hidden: false, reason: 'not-fullscreen' });
});

// ============ A7. launchagent.buildPlist 注入字符 ============

test('buildPlist：label/args 含 & < > " \' 时转义安全（文本节点）', () => {
  const xml = launchagent.buildPlist({
    label: 'he said "hi" & <tag>',
    programArgs: ['a&b', '<x>', "it's"],
  });
  assert.ok(xml.includes('<string>he said "hi" &amp; &lt;tag&gt;</string>'));
  assert.ok(xml.includes('<string>a&amp;b</string>'));
  assert.ok(xml.includes('<string>&lt;x&gt;</string>'));
  assert.ok(xml.includes("<string>it's</string>"));
  // 不应残留未转义的裸 & < >
  assert.equal(/&(?!amp;|lt;|gt;)/.test(xml), false);
  assert.equal(/<(?!\/?(plist|dict|array|string|key|true|false)\b|\?xml|!DOCTYPE)/.test(xml), false);
});

test('buildPlist：空 programArgs 抛错', () => {
  assert.throws(() => launchagent.buildPlist({ label: 'x', programArgs: [] }), /programArgs/);
});

test('buildPlist：programArgs 含非字符串被安全 String() 化，不抛', () => {
  const xml = launchagent.buildPlist({ label: 'x', programArgs: [123, null, true] });
  assert.ok(xml.includes('<string>123</string>'));
  assert.ok(xml.includes('<string>null</string>'));
  assert.ok(xml.includes('<string>true</string>'));
});

test('buildPlist：keepAlive/runAtLoad=false 与自定义 processType', () => {
  const xml = launchagent.buildPlist({
    label: 'x',
    programArgs: ['p'],
    keepAlive: false,
    runAtLoad: false,
    processType: 'Interactive',
  });
  assert.ok(xml.includes('<key>KeepAlive</key>\n  <false/>'));
  assert.ok(xml.includes('<key>RunAtLoad</key>\n  <false/>'));
  assert.ok(xml.includes('<key>ProcessType</key>\n  <string>Interactive</string>'));
});

// ============ A8. open-client.buildOpenRequest 边界 ============

test('buildOpenRequest：openclaw 但 agent 为空 → 与前端 client.ts 一致地产生空 agent 段', () => {
  // frontend/src/api/client.ts openSession(): `/api/agents/${encodeURIComponent(opts.agent || '')}/sessions`
  // 两端对空 agent 行为一致（后端会 400），此处锁定一致契约。
  const r = openClient.buildOpenRequest({ platform: 'openclaw', sessionId: 's1' });
  assert.equal(r.path, '/api/agents//sessions/s1/open');
});

test('buildOpenRequest：sessionId 含 / 与空格被百分号编码，含 .. 则点号保留（斜杠已编码）', () => {
  assert.equal(
    openClient.buildOpenRequest({ platform: 'codex', sessionId: 'a/b c' }).path,
    '/api/codex/sessions/a%2Fb%20c/open'
  );
  // '.' 不被 encodeURIComponent 编码，但 '/' 被编码 → 后端按单段收到，sanitizeSessionId 会拒绝 '..' 组合
  assert.equal(openClient.buildOpenRequest({ platform: 'codex', sessionId: '..' }).path, '/api/codex/sessions/../open');
  assert.equal(
    openClient.buildOpenRequest({ platform: 'codex', sessionId: 'a/../b' }).path,
    '/api/codex/sessions/a%2F..%2Fb/open'
  );
});

test('buildOpenRequest：未知平台按字面拼路径；action 非 locate 一律回退 open', () => {
  assert.equal(openClient.buildOpenRequest({ platform: 'weird', sessionId: 's' }).path, '/api/weird/sessions/s/open');
  assert.deepEqual(openClient.buildOpenRequest({ platform: 'codex', sessionId: 's', action: 'delete' }).body, {
    action: 'open',
  });
  assert.deepEqual(openClient.buildOpenRequest({ platform: 'codex', sessionId: 's', action: 'locate' }).body, {
    action: 'locate',
  });
});

// ============ A9. node-exec.resolveNodeExec 边界 ============

test('resolveNodeExec：候选为空字符串被跳过', () => {
  const r = nodeExec.resolveNodeExec({
    env: { AGENTXRAY_PET_NODE: '' },
    execPath: '/electron',
    whichImpl: () => '',
    existsImpl: () => true,
  });
  assert.equal(r.source, 'electron');
  assert.equal(r.injectElectronRunAsNode, true);
});

test('resolveNodeExec：env 传 undefined 不抛，回退真实 process.env', () => {
  const r = nodeExec.resolveNodeExec({
    env: undefined,
    whichImpl: () => null,
    existsImpl: () => false,
    execPath: '/e',
  });
  assert.equal(r.source, 'electron');
  assert.equal(typeof r.exec, 'string');
});

test('resolveNodeExec：注入的 existsImpl 被如实采用（默认实现另测「目录即拒绝」）', () => {
  // 本用例锁定的是**可注入契约**：existsImpl 返回 true 即视为命中（fake 说了算）。
  // 默认实现 defaultExists 已改为「存在且是普通文件」（目录会被拒），由 nodeexec 专属用例覆盖。
  const r = nodeExec.resolveNodeExec({
    env: { AGENTXRAY_PET_NODE: '/a/dir' },
    execPath: '/electron',
    whichImpl: () => null,
    existsImpl: () => true, // 注入 fake：目录也算「存在」
  });
  assert.equal(r.source, 'env');
  assert.equal(r.exec, '/a/dir');
});

test('resolveNodeExec.defaultExists：目录/文件/符号链接/不存在/权限异常的真实行为', () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'axr-exists-'));
  try {
    const file = path.join(dir, 'node');
    fsSync.writeFileSync(file, '#!/bin/sh\n');
    const link = path.join(dir, 'link');
    fsSync.symlinkSync(file, link);
    assert.equal(nodeExec.defaultExists(dir), false, '目录应被拒');
    assert.equal(nodeExec.defaultExists(file), true, '普通文件应通过');
    assert.equal(nodeExec.defaultExists(link), true, '符号链接→文件：statSync 跟随链接，应通过');
    assert.equal(nodeExec.defaultExists(path.join(dir, 'nope')), false, '不存在应被拒');
    // 权限/读取异常一律吞掉视为不存在（statSync 抛错 → catch → false）。
    assert.equal(nodeExec.defaultExists('/root/.no-such-secret-xyz'), false);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveNodeExec：which 返回不存在的路径 → 落到下一候选', () => {
  const r = nodeExec.resolveNodeExec({
    env: {},
    execPath: '/electron',
    whichImpl: () => '/ghost/node',
    existsImpl: (p) => p === '/npm/node',
  });
  // which 命中但不存在 → 跳过；npm_node_execpath 未设 → 最终 electron
  assert.equal(r.source, 'electron');
});
