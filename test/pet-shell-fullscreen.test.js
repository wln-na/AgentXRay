// 桌面宠物壳全屏检测单测：parseSizeTuple / createFullscreenProbe（假 run）/ decideHidden。
// 绝不真跑 osascript。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSizeTuple, parseBounds, createFullscreenProbe, decideHidden } = require(
  path.join(__dirname, '..', 'desktop', 'lib', 'fullscreen')
);

test('parseSizeTuple 解析多种尺寸文本；非法输入返回 null', () => {
  assert.deepEqual(parseSizeTuple('123, 456'), { w: 123, h: 456 });
  assert.deepEqual(parseSizeTuple('{123, 456}'), { w: 123, h: 456 });
  assert.deepEqual(parseSizeTuple('123,456'), { w: 123, h: 456 });
  assert.deepEqual(parseSizeTuple('123 456'), { w: 123, h: 456 });
  assert.equal(parseSizeTuple(''), null);
  assert.equal(parseSizeTuple('abc'), null);
  assert.equal(parseSizeTuple('12'), null);
  assert.equal(parseSizeTuple(null), null);
});

test('parseBounds 解析桌面四元 bounds', () => {
  assert.deepEqual(parseBounds('0, 0, 1440, 900'), { w: 1440, h: 900 });
  assert.equal(parseBounds('0, 0'), null);
  assert.equal(parseBounds(null), null);
});

test('createFullscreenProbe：非 macOS 直接返回 {fullscreen:false, error:unsupported}', async () => {
  const probe = createFullscreenProbe({ isMac: false });
  const r = await probe();
  assert.equal(r.fullscreen, false);
  assert.equal(r.error, 'unsupported');
});

test('createFullscreenProbe：前窗小于屏幕 → 非全屏；等于屏幕 → 全屏', async () => {
  const screenSize = { w: 1440, h: 900 };
  const small = createFullscreenProbe({
    isMac: true,
    screenSize,
    run: async () => '800, 600',
  });
  assert.equal((await small()).fullscreen, false);

  const big = createFullscreenProbe({
    isMac: true,
    screenSize,
    run: async () => '1440, 900',
  });
  const r = await big();
  assert.equal(r.fullscreen, true);
  assert.deepEqual(r.appWin, { w: 1440, h: 900 });
  assert.deepEqual(r.screen, screenSize);
});

test('createFullscreenProbe：不注入 screenSize 时经 osascript 查桌面 bounds', async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args: args.slice() });
    const script = args.join(' ');
    if (script.includes('System Events')) return '1440, 900';
    if (script.includes('Finder')) return '0, 0, 1440, 900';
    return '';
  };
  const probe = createFullscreenProbe({ isMac: true, run });
  const r = await probe();
  assert.equal(r.fullscreen, true);
  assert.deepEqual(r.screen, { w: 1440, h: 900 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, 'osascript');
});

test('createFullscreenProbe：run 抛错 → 不隐藏、不抛，返回 error', async () => {
  const probe = createFullscreenProbe({
    isMac: true,
    screenSize: { w: 1440, h: 900 },
    run: async () => {
      throw new Error('not authorized (-25211)');
    },
  });
  const r = await probe();
  assert.equal(r.fullscreen, false);
  assert.match(r.error, /not authorized/);
});

test('decideHidden：全屏 → 隐藏', () => {
  assert.deepEqual(decideHidden({ probeResult: { fullscreen: true }, now: 1000 }), {
    hidden: true,
    reason: 'fullscreen',
  });
});

test('decideHidden：退出全屏后的恢复延迟窗口内保持隐藏', () => {
  const r = decideHidden({
    probeResult: { fullscreen: false },
    now: 2000,
    lastFullscreenAt: 1000, // 1000ms 前刚全屏，< 1500ms
  });
  assert.deepEqual(r, { hidden: true, reason: 'resume-delay' });
});

test('decideHidden：非全屏且已过恢复延迟 → 不隐藏', () => {
  const r = decideHidden({
    probeResult: { fullscreen: false },
    now: 3000,
    lastFullscreenAt: 1000, // 2000ms > 1500ms
  });
  assert.deepEqual(r, { hidden: false, reason: 'not-fullscreen' });
  assert.deepEqual(decideHidden({ probeResult: { fullscreen: false }, now: 5000, lastFullscreenAt: null }), {
    hidden: false,
    reason: 'not-fullscreen',
  });
});

test('decideHidden：probe 失败 → 不隐藏（probe-error），即便刚全屏过', () => {
  const r = decideHidden({
    probeResult: { fullscreen: false, error: 'unsupported' },
    now: 1100,
    lastFullscreenAt: 1000,
  });
  assert.deepEqual(r, { hidden: false, reason: 'probe-error' });
});

test('decideHidden：自定义 resumeDelayMs', () => {
  const r = decideHidden({
    probeResult: { fullscreen: false },
    now: 1500,
    lastFullscreenAt: 1000,
    thresholds: { resumeDelayMs: 2000 },
  });
  assert.equal(r.hidden, true);
  assert.equal(r.reason, 'resume-delay');
});
