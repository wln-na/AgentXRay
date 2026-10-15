// 桌面宠物壳的状态客户端：以 Node 原生 HTTP + SSE 消费后端 /api/pet/state。
//
// 为什么放主进程而不是 renderer：renderer 页面源自 file://（Origin: null），
// server.js 没有 CORS 头，跨源 EventSource 会被 Chromium 拦截。主进程用 Node
// 原生 http 流即可绕开 CORS，也省掉 eventsource 依赖。
//
// 本文件是【纯模块】：SSE 分帧器与状态客户端都做成可注入依赖（httpGet / now /
// setTimeout），因此可在根 `node --test` 下用假实现覆盖连接、退避、stop 等分支，
// 绝不真连 3800。

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3800;
const DEFAULT_WINDOW = 180; // 秒
const DEFAULT_INTERVAL = 2000; // ms
const PING_EVENT = '__ping__'; // 注释行（`: ping`）产出的内部事件名

// 事件分隔（空行）。**实际支持的恰好是这三种**：`\n\n`、`\r\n\r\n`、`\r\r`（即下面的 EVENT_SEP）。
// · 跨风格组合**不被识别**：`\n\r`、`\n\r\n`、`\r\n\r` 都不匹配 → 该处不切分，事件被留到下个匹配到的
//   空行为止（极端情况下返回 []，表现为「丢帧」）。**已知限制**。
// · 为何不能「用一行正则修」：`CR+LF` 与「单个 CRLF」在字节层完全同形（都是 `\r\n`），任何形如
//   `(?:\r\n|\r|\n){2}` 的写法都会因回溯把**单个 `\r\n`** 拆成 `\r`+`\n` 两个 token，从而被误当空行——
//   实测 `/(?:\r\n|\r|\n){2}/.match('\r\n')` 命中 `["\r\n"]`，且 `'event: state\r\ndata: x\r\n\r\n'.split(...)`
//   得到 3 段（应为 1 条事件）。采纳它 = 把每条 CRLF 流都切碎 → 引入回归。若将来真要加固，用
//   **贪婪行结束符分词器**（先消费 `\r\n`，再消费孤立 `\r` 或 `\n`；空行 = 连续两个 token），
//   **不要**用 `(?:\r\n|\r|\n){2}`。
// · 范围：设计 §3.5/§2 只要求按 `\n\n` 切事件（已满足）；CRLF/CR 属额外增强；后端
//   `lib/routes/pet.js` 只发 LF → 当前不可触发。属**已知限制**，非缺陷。
// 另注：**不要在 feed() 里做全局预替换**——那会把缓冲尾部的孤立 `\r` 立刻变成 `\n`，使下一 chunk
// 开头的 `\n` 被误判为「空行」，把跨 chunk 的 CRLF 拆成两条事件（见下方 bug 修复）。
const EVENT_SEP = /\r\n\r\n|\n\n|\r\r/;
// 事件块内切行：CRLF 优先（须排在 CR/LF 之前，否则 `\r\n` 会被切成两个空行）。
const LINE_SEP = /\r\n|\r|\n/;

/**
 * 纯 SSE 分帧器：把任意 chunk 累积、按空行切事件（**同风格** LF / CRLF / CR 各自支持，
 * 跨风格组合见上方 EVENT_SEP 注释的「已知限制」），解析 `event:`/`data:` 行。
 * 注释块（`: ping`）产出一个 `{ event: '__ping__', data: '' }`，供上层刷新存活时间。
 *
 * 健壮性契约（**限同一行结束符风格**）：LF / CRLF / CR 三种行结束符，且**任意 chunk 切分点**
 * （含切在 `\r` 与 `\n` 之间、切在 `\n` 与 `\n` 之间）都得到同一结果——残片（含尾部孤立 `\r`）
 * 留在缓冲里等下一 chunk 确认。
 */
function createSseParser() {
  let buffer = '';

  function parseBlock(block) {
    const lines = block.split(LINE_SEP);
    let event = null;
    let hasComment = false;
    const dataLines = [];
    for (const line of lines) {
      if (line === '') continue;
      if (line.startsWith(':')) {
        hasComment = true;
        continue;
      }
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      let value = idx === -1 ? '' : line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (event === null && dataLines.length === 0) {
      return hasComment ? { event: PING_EVENT, data: '' } : null;
    }
    return { event: event || 'message', data: dataLines.join('\n') };
  }

  /**
   * 喂入一段 chunk，返回其中已经完整（以空行结尾）的事件数组。
   *
   * 保留**原始 buffer**、不做任何 `.replace()` 归一：用空行正则切事件，未成完整事件的残片
   * （含尾部孤立 `\r`）留在 buffer，等下一 chunk 确认其是否与后续 `\n` 组成 CRLF。
   * @param {string} chunk
   * @returns {Array<{event: string, data: string}>}
   */
  function feed(chunk) {
    buffer += String(chunk);
    const out = [];
    for (;;) {
      const match = EVENT_SEP.exec(buffer); // 无 g 标志：每次都从 buffer 头搜索首个空行
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const evt = parseBlock(block);
      if (evt) out.push(evt);
    }
    return out;
  }

  /** 清空未完成的缓冲（重连前调用）。 */
  function reset() {
    buffer = '';
  }

  return { feed, reset };
}

/**
 * 纯 URL 构造：与后端 GET /api/pet/state 的 query 约定一致。
 * @param {{host?: string, port?: number, window?: number, interval?: number}} [opts]
 * @returns {string}
 */
function buildStateUrl(opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const port = opts.port || DEFAULT_PORT;
  const window = opts.window === undefined ? DEFAULT_WINDOW : opts.window;
  const interval = opts.interval === undefined ? DEFAULT_INTERVAL : opts.interval;
  return `http://${host}:${port}/api/pet/state?window=${window}&interval=${interval}`;
}

/**
 * 状态客户端：主进程内以 Node HTTP + SSE 消费 /api/pet/state；断线指数退避重连。
 *
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {number} [opts.window]   秒，对应后端 query
 * @param {number} [opts.interval] ms，对应后端 query
 * @param {Function} [opts.httpGet] 可注入：与 http.get 兼容的 (opts, cb) => req
 * @param {Function} [opts.now]     可注入时钟
 * @param {object}  [opts.reconnect] {baseMs, maxMs, jitter}
 * @param {Function} [opts.onState]  (petState) => void
 * @param {Function} [opts.onError]  (err) => void
 * @param {Function} [opts.onStatus] ({connected}) => void
 * @param {Function} [opts.setTimeout] / [opts.clearTimeout] 可注入定时器（单测用）
 * @returns {{start: Function, stop: Function, last: Function, isConnected: Function, lastLiveness: Function}}
 */
function createStateClient(opts = {}) {
  const host = opts.host || process.env.AGENTXRAY_PET_HOST || DEFAULT_HOST;
  const port = opts.port || Number(process.env.AGENTXRAY_PET_PORT) || DEFAULT_PORT;
  const windowSec = opts.window === undefined ? DEFAULT_WINDOW : opts.window;
  const interval = opts.interval === undefined ? DEFAULT_INTERVAL : opts.interval;

  // 惰性 require：避免在纯函数被 import 时就要求 http（也方便测试注入）。
  const httpGet = opts.httpGet || require('node:http').get;
  const now = opts.now || (() => Date.now());
  const reconnect = { baseMs: 1000, maxMs: 30000, jitter: 0.2, ...(opts.reconnect || {}) };
  const onState = opts.onState || (() => {});
  const onError = opts.onError || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const setTimeoutFn = opts.setTimeout || setTimeout;
  const clearTimeoutFn = opts.clearTimeout || clearTimeout;

  let stopped = false;
  let connected = false;
  let attempt = 0;
  let retryTimer = null;
  let lastState = null;
  let lastLivenessAt = null;
  let activeReq = null;
  let activeRes = null;
  // 每个连接独立的分帧器实例（重连时重建）。
  let parser = createSseParser();

  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    onStatus({ connected: value });
  }

  function backoffMs() {
    const raw = Math.min(reconnect.maxMs, reconnect.baseMs * 2 ** attempt);
    const jitterFactor = 1 + (Math.random() * 2 - 1) * reconnect.jitter;
    return Math.max(0, Math.round(raw * jitterFactor));
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    const delay = backoffMs();
    attempt += 1;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function handleEvent(evt) {
    if (evt.event === PING_EVENT) {
      // 心跳：只刷新存活时间，不下发状态。
      lastLivenessAt = now();
      return;
    }
    if (evt.event === 'error') {
      // 后端能**解析出**一条 error 帧说明它仍然活着 → 先刷新存活时间再回调错误（设计 §3.1：
      // 「收到任一 SSE 帧」即刷新）。注意：只有解析出来的 error 帧算 liveness；传输层/socket
      // 错误（res.on('error') / req.on('error')）不算，那恰恰是不健康信号，不在此处刷新。
      lastLivenessAt = now();
      let message = evt.data;
      try {
        const parsed = JSON.parse(evt.data);
        if (parsed?.error) message = parsed.error;
      } catch {
        /* data 不是 JSON → 用原始字符串 */
      }
      onError(new Error(String(message || '状态流错误')));
      return; // 后端仅瞬时错误，不断开连接
    }
    if (evt.event === 'state') {
      lastLivenessAt = now();
      attempt = 0; // 收到有效帧后重置退避
      try {
        const parsed = JSON.parse(evt.data);
        lastState = parsed;
        setConnected(true);
        onState(parsed);
      } catch (err) {
        onError(new Error(`状态帧解析失败：${err?.message ? err.message : err}`));
      }
      return;
    }
    // 未知事件：视为存活证据，不回调状态。
    lastLivenessAt = now();
  }

  function onDisconnect() {
    if (stopped) return;
    setConnected(false);
    scheduleReconnect();
  }

  function connect() {
    if (stopped) return;
    const path = `/api/pet/state?window=${windowSec}&interval=${interval}`;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeReq = null;
      activeRes = null;
      onDisconnect();
    };

    try {
      activeReq = httpGet({ host, port, path, headers: { Accept: 'text/event-stream' } }, (res) => {
        if (stopped) return;
        activeRes = res;
        setConnected(true);
        if (!res || typeof res.on !== 'function') return;
        res.on('data', (chunk) => {
          if (stopped) return;
          try {
            for (const evt of parser.feed(chunk)) handleEvent(evt);
          } catch (err) {
            onError(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on('end', release);
        res.on('error', (err) => {
          onError(err instanceof Error ? err : new Error(String(err)));
          release();
        });
      });
      if (activeReq && typeof activeReq.on === 'function') {
        activeReq.on('error', (err) => {
          onError(err instanceof Error ? err : new Error(String(err)));
          release();
        });
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
      release();
    }
  }

  function start() {
    if (!stopped && (activeReq || retryTimer)) return;
    stopped = false;
    attempt = 0;
    parser = createSseParser();
    connect();
  }

  function stop() {
    stopped = true;
    if (retryTimer) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
    parser.reset();
    if (activeRes && typeof activeRes.destroy === 'function') {
      try {
        activeRes.destroy();
      } catch {
        /* ignore */
      }
    }
    if (activeReq && typeof activeReq.destroy === 'function') {
      try {
        activeReq.destroy();
      } catch {
        /* ignore */
      }
    }
    activeReq = null;
    activeRes = null;
    setConnected(false);
  }

  return {
    start,
    stop,
    last: () => lastState,
    isConnected: () => connected,
    lastLiveness: () => lastLivenessAt,
  };
}

module.exports = {
  PING_EVENT,
  createSseParser,
  buildStateUrl,
  createStateClient,
};
