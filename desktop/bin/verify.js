#!/usr/bin/env node
// 无 GUI 环境自检：加载 desktop/lib/* 纯模块跑一遍冒烟。
// 供 CI / 无 Electron 环境替代 GUI 验收 —— **绝不加载 electron**，只 require lib/* 纯模块。
//
// 输出 PASS/FAIL 明细，并以退出码反映结果（全绿 → 0）。

const assert = require('node:assert');

function load(name) {
  return require(`../lib/${name}`);
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, message: err?.message ? err.message : String(err) });
  }
}

const config = load('config');
const { createSseParser, buildStateUrl } = load('sse');
const pixel = load('pixel');
const { decideWatchdog } = load('watchdog');
const { parseSizeTuple, decideHidden } = load('fullscreen');
const { buildPlist, resolveProgramArgs } = load('launchagent');
const { parseManifest, resolveFrame, selectPack } = load('sprite');
const { resolveNodeExec } = load('node-exec');
const { buildOpenRequest } = load('open-client');
const { resolveVisibility, nextUserHidden } = load('visibility');
const { hideButtonCenter, badgeCenter } = load('bubble-layout');
const { clampAcrossDisplays } = load('window-geometry');

check('config 默认值（HOST/PORT/PET_STATES）', () => {
  const c = config.createConfig({ HOME: '/tmp/home' });
  assert.equal(c.HOST, '127.0.0.1');
  assert.equal(c.PORT, 3800);
  assert.equal(c.PET_DIR, '/tmp/home/.agentxray/pet');
  assert.equal(config.PET_STATES.length, 6);
  assert.ok(Object.isFrozen(config.PET_STATES));
});

check('可见性仲裁：用户隐藏 × 全屏隐藏互不覆盖', () => {
  assert.equal(resolveVisibility({}).visible, true);
  assert.equal(resolveVisibility({ userHidden: true }).visible, false);
  assert.equal(resolveVisibility({ fullscreenHidden: true }).visible, false);
  // 用户先收起 → 进出全屏 → 仍然隐藏
  assert.equal(resolveVisibility({ userHidden: true, fullscreenHidden: false }).visible, false);
  assert.equal(nextUserHidden(false), true);
  assert.equal(nextUserHidden(true, true), false);
  // 严格布尔：脏值不得把宠物藏起来
  assert.equal(resolveVisibility({ userHidden: 'true' }).visible, true);
});

check('截屏保护默认开、快捷键有默认值', () => {
  const c = config.createConfig({ HOME: '/tmp/home' });
  assert.equal(c.SCREENSHOT_PROTECT, true);
  assert.equal(c.HOTKEY, 'CommandOrControl+Shift+H');
  assert.equal(
    config.createConfig({ HOME: '/tmp/home', AGENTXRAY_PET_SCREENSHOT_VISIBLE: '1' }).SCREENSHOT_PROTECT,
    false
  );
  assert.equal(config.createConfig({ HOME: '/tmp/home', AGENTXRAY_PET_HOTKEY: 'off' }).HOTKEY, '');
});

check('跨屏仲裁：并集内可骑缝、空隙吸附、重启保留副屏位置', () => {
  const primary = {
    bounds: { x: 0, y: 0, width: 1470, height: 956 },
    workArea: { x: 0, y: 38, width: 1470, height: 866 },
  };
  const secondary = { bounds: { x: 1470, y: 0, width: 1920, height: 1080 } };
  const size = { w: 300, h: 128 };
  const single = clampAcrossDisplays({
    desired: { x: 9999, y: 9999 },
    windowSize: size,
    displays: [primary],
    allowLargerThanScreen: true, // 桌宠始终开启 enableLargerThanScreen（可贴菜单栏）
  });
  assert.deepEqual(single, { x: 1170, y: 828 });
  const dual = [primary, secondary];
  // 跨屏中间态（骑缝）不被单屏边界卡住
  assert.deepEqual(clampAcrossDisplays({ desired: { x: 1320, y: 200 }, windowSize: size, displays: dual }), {
    x: 1320,
    y: 200,
  });
  // 副屏位置重启后保留
  assert.deepEqual(clampAcrossDisplays({ desired: { x: 2000, y: 300 }, windowSize: size, displays: dual }), {
    x: 2000,
    y: 300,
  });
});

check('隐藏按钮与活跃徽标左右对称', () => {
  const geom = { width: 300, petHeight: 128, height: 128, bubbleBelow: false };
  assert.equal(hideButtonCenter(geom).y, badgeCenter(geom).y);
  assert.equal(hideButtonCenter(geom).x + badgeCenter(geom).x, 300);
});

check('SseParser 分帧', () => {
  const p = createSseParser();
  const events = p.feed('event: state\ndata: {"state":"idle"}\n\nevent: state\ndata: {"state":"working"}\n\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'state');
  assert.ok(events[1].data.includes('working'));
  assert.equal(
    buildStateUrl({ host: '127.0.0.1', port: 3800, window: 180, interval: 2000 }).includes('/api/pet/state'),
    true
  );
});

check('buildFrame 6 态均有帧 + PALETTE 覆盖', () => {
  for (const state of config.PET_STATES) {
    assert.ok(pixel.PALETTE[state], `PALETTE 缺少 ${state}`);
    const frame = pixel.buildFrame({ state, elapsedMs: 100 });
    assert.ok(frame.cells.length > 0, `${state} 无 cells`);
    assert.ok(frame.hitCells.length > 0, `${state} 无 hitCells`);
    assert.ok(Number.isFinite(frame.bounceY));
  }
});

check('decideWatchdog 健康 / 假死 / 启动即崩', () => {
  const healthy = decideWatchdog({ now: 100000, lastLivenessAt: 99000, childAlive: true, restartCount: 0 });
  assert.equal(healthy.action, 'ok');
  const hung = decideWatchdog({ now: 100000, lastLivenessAt: 1000, childAlive: true, restartCount: 1 });
  assert.equal(hung.action, 'restart');
  // 启动即崩（首次 liveness 之前 child 退出）必须重启，而非静默 ok（回归锁）。
  const crashed = decideWatchdog({
    now: 100000,
    lastLivenessAt: null,
    childAlive: false,
    restartCount: 0,
    startedAt: 100000,
  });
  assert.equal(crashed.action, 'restart');
  assert.equal(crashed.reason, 'child-exited');
});

check('decideHidden 全屏 / probe 失败', () => {
  assert.equal(decideHidden({ probeResult: { fullscreen: true }, now: 1000 }).hidden, true);
  assert.equal(decideHidden({ probeResult: { fullscreen: false, error: 'x' }, now: 1000 }).hidden, false);
  assert.deepEqual(parseSizeTuple('{123, 456}'), { w: 123, h: 456 });
});

check('buildPlist 生成合法 plist', () => {
  const xml = buildPlist({ label: 'com.agentxray.pet', programArgs: ['/x/Electron', '/x/main.js'] });
  assert.ok(xml.includes('<plist version="1.0">'));
  assert.ok(xml.includes('com.agentxray.pet'));
});

check('resolveProgramArgs dev（纯 node → warning）', () => {
  const r = resolveProgramArgs({ mode: 'dev', execPath: '/usr/local/bin/node', desktopDir: '/x/desktop' });
  assert.ok(r.warning, 'node 下应给出 warning');
});

check('parseManifest / resolveFrame 冒烟', () => {
  const { ok, manifest } = parseManifest(JSON.stringify({ name: 'p', fps: 8 }), { dir: '/x/pack' });
  assert.equal(ok, true);
  const f = resolveFrame(manifest, 'idle', 500, 4);
  assert.equal(f.index, 4 % 4);
  assert.equal(selectPack({ requested: 'p', packs: [{ name: 'p', path: '/x' }] }).source, 'requested');
});

check('buildOpenRequest openclaw 特例', () => {
  const r = buildOpenRequest({ platform: 'openclaw', agent: 'a1', sessionId: 's1', action: 'open' });
  assert.equal(r.path, '/api/agents/a1/sessions/s1/open');
  assert.deepEqual(r.body, { action: 'open' });
});

check('resolveNodeExec 分支（env / electron 回退）', () => {
  const viaEnv = resolveNodeExec({
    env: { AGENTXRAY_PET_NODE: '/custom/node' },
    execPath: '/electron',
    whichImpl: () => null,
    existsImpl: (p) => p === '/custom/node',
  });
  assert.equal(viaEnv.source, 'env');
  assert.equal(viaEnv.injectElectronRunAsNode, false);
  // 默认/回退分支：无真 node → Electron 内置 Node + warning。
  const fallback = resolveNodeExec({ env: {}, execPath: '/electron', whichImpl: () => null, existsImpl: () => false });
  assert.equal(fallback.source, 'electron');
  assert.equal(fallback.injectElectronRunAsNode, true);
  assert.ok(fallback.warning, '回退分支必须带 warning');
});

let failures = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`PASS  ${r.name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${r.name} — ${r.message}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures === 0 ? 0 : 1);
