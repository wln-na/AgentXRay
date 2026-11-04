// 桌面宠物壳 renderer 的**无头**冒烟测试：用假的 document/canvas/rAF 跑真实 pet.js。
//
// 目的：隐藏按钮（新功能）与「点宠物跳回」的**控制流**在纯 Node 下就能验证——
// 不必装 Electron、不必有人机环境。canvas 2D 上下文是 Proxy 打桩，像素内容不做断言，
// 只断言「点击命中 → 调了哪个 window.pet.*」。
//
// 覆盖：
//   · getInfo 后画布按 geom 尺寸初始化，帧循环不抛错
//   · 鼠标进入窗口 → 隐藏按钮淡入 → 请求可交互（setInteractive(true)）
//   · 点隐藏按钮 → toggleVisible(false)（且不再触发「跳回会话」）
//   · 点宠物本体 → openSession（回归：按钮不能把宠物本身的可点区吃掉）
//   · 收到 pet:visible(false) → 停掉 rAF；恢复可见 → 循环重启

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', 'desktop', 'renderer');
const libDir = path.join(__dirname, '..', 'desktop', 'lib');

function makeCtx2d() {
  const ops = [];
  const target = {};
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 7 });
      return (...args) => {
        ops.push([prop, args]);
        return undefined;
      };
    },
    set(obj, prop, value) {
      obj[prop] = value;
      return true;
    },
  });
}

function createHarness() {
  const calls = { toggleVisible: [], openSession: [], setInteractive: [], setExpanded: [], drag: [] };
  const ctx2d = makeCtx2d();
  const canvasListeners = {};
  const windowListeners = {};
  const rafQueue = [];
  let now = 0;

  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx2d,
    addEventListener(type, fn) {
      (canvasListeners[type] ||= []).push(fn);
    },
  };

  let onStateCb = null;
  let onVisibleCb = null;

  const pet = {
    getInfo: async () => ({
      host: '127.0.0.1',
      port: 3800,
      geom: { w: 300, h: 128, cell: 6, petH: 128, bubbleBelow: false },
      grid: 16,
      states: ['idle', 'thinking', 'working', 'done', 'waiting_input', 'error'],
      skin: { manifest: null, frames: {}, source: 'builtin', name: null },
      debug: false,
    }),
    openSession: (payload) => {
      calls.openSession.push(payload);
      return Promise.resolve({ ok: true, detail: '已跳转' });
    },
    ignoreSession: () => Promise.resolve({ ok: true }),
    setInteractive: (value) => {
      calls.setInteractive.push(value);
      return Promise.resolve(true);
    },
    drag: (payload) => {
      calls.drag.push(payload);
      return Promise.resolve(true);
    },
    setExpanded: (value) => {
      calls.setExpanded.push(value);
      return Promise.resolve(true);
    },
    toggleVisible: (value) => {
      calls.toggleVisible.push(value);
      return Promise.resolve({ visible: false, userHidden: true });
    },
    onState: (cb) => {
      onStateCb = cb;
      return () => {};
    },
    onGeom: () => () => {},
    onDragCancel: () => () => {},
    onStatus: () => () => {},
    onFullscreen: () => () => {},
    onVisible: (cb) => {
      onVisibleCb = cb;
      return () => {};
    },
    onOpenResult: () => () => {},
  };

  const sandbox = {
    console,
    document: { getElementById: () => canvas },
    performance: { now: () => now },
    devicePixelRatio: 2,
    innerWidth: 300,
    innerHeight: 128,
    requestAnimationFrame: (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    addEventListener(type, fn) {
      (windowListeners[type] ||= []).push(fn);
    },
    focus() {},
    pet,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', context);

  const load = (file) => {
    const code = fs.readFileSync(file, 'utf8');
    vm.runInContext(code, context, { filename: file });
  };
  // 与 renderer/index.html 完全一致的加载顺序。
  load(path.join(libDir, 'bubble-layout.js'));
  load(path.join(libDir, 'pixel.js'));
  load(path.join(rendererDir, 'codex-pet.js'));
  load(path.join(rendererDir, 'sprite-render.js'));
  load(path.join(rendererDir, 'pet.js'));

  const step = (frames = 1) => {
    for (let i = 0; i < frames; i += 1) {
      now += 16;
      const cb = rafQueue.shift();
      if (!cb) return false;
      cb(now);
    }
    return true;
  };
  const emit = (type, event) => {
    for (const fn of windowListeners[type] || []) fn(event);
  };

  return {
    calls,
    canvas,
    canvasListeners,
    rafQueue,
    pet,
    step,
    emit,
    movePointer: (x, y) => emit('mousemove', { clientX: x, clientY: y }),
    click: () => (canvasListeners.click || []).forEach((fn) => fn({ button: 0 })),
    pushState: (payload) => onStateCb?.(payload),
    pushVisible: (payload) => onVisibleCb?.(payload),
    // 让 getInfo 的 promise 链先跑完（renderer 用它来初始化几何与首个 rAF）。
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('renderer 启动后按 geom 初始化画布，帧循环可跑且不抛错', async () => {
  const h = createHarness();
  await h.flush();
  assert.equal(h.canvas.width, 600, '300 × dpr(2)');
  assert.equal(h.canvas.height, 256);
  assert.ok(h.rafQueue.length >= 1, '启动后应排入首个 rAF');
  h.step(3); // 帧循环内部若有异常，这里会直接抛出来
});

test('隐藏按钮只在自身命中区内请求可交互（透明区仍然穿透）', async () => {
  const h = createHarness();
  await h.flush();

  // 窗口左上透明区：按钮会淡入，但不能因此把整个窗口变成可交互（那会挡住下层应用）。
  h.movePointer(20, 20);
  h.step(6);
  assert.ok(!h.calls.setInteractive.includes(true), '透明区域不应请求可交互');

  // 移到隐藏按钮中心：必须请求可交互，否则按钮点不到。
  h.movePointer(123, 114); // 宠物左脚边（hiddenButtonCenter(300,128) = {123,114}）
  h.step(6); // 0.18/帧 → 6 帧后超过命中阈值
  assert.equal(h.calls.setInteractive.at(-1), true, '悬停隐藏按钮时应请求可交互');
});

test('点隐藏按钮 → toggleVisible(false)，且不触发「跳回会话」', async () => {
  const h = createHarness();
  await h.flush();
  h.pushState({ state: 'working', platform: 'codex', sessionId: 's1', bubble: '工作中', activeCount: 1, sessions: [] });
  h.movePointer(123, 114);
  h.step(6);
  h.click();
  assert.deepEqual(h.calls.toggleVisible, [false]);
  assert.deepEqual(h.calls.openSession, [], '隐藏按钮不能穿透成「打开会话」');
});

test('点宠物本体仍然跳回会话（隐藏按钮没有吃掉宠物可点区）', async () => {
  const h = createHarness();
  await h.flush();
  h.pushState({ state: 'working', platform: 'codex', sessionId: 's1', bubble: '工作中', activeCount: 1, sessions: [] });
  h.movePointer(150, 70); // 宠物身体中间
  h.step(6);
  h.click();
  assert.equal(h.calls.openSession.length, 1);
  assert.equal(h.calls.openSession[0].sessionId, 's1');
  assert.deepEqual(h.calls.toggleVisible, [], '点身体不该收起宠物');
});

test('收起后停掉 rAF 循环，恢复可见后重新启动', async () => {
  const h = createHarness();
  await h.flush();
  h.step(2);
  h.pushVisible({ visible: false, reason: 'user' });
  // 已排队的那一帧会立刻返回且不再续排
  while (h.rafQueue.length) h.step(1);
  assert.equal(h.rafQueue.length, 0, '收起后不应再有动画帧');
  h.pushVisible({ visible: true, reason: 'user' });
  assert.equal(h.rafQueue.length, 1, '恢复可见应重启循环');
  h.step(2);
  assert.equal(h.rafQueue.length, 1, '循环保持单条链，不叠加');
});
