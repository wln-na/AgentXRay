// 桌面宠物壳「桥」契约单测：不启动 Electron，只用源码文本交叉校验
//   renderer 调用的 window.pet.* → preload 是否真的暴露
//   preload invoke 的通道        → main 是否真的 handle
//   main 推送的通道              → preload 白名单是否放行
//   renderer 订阅的通道          → 推送白名单是否包含
// 这层单向契约最容易在改功能时漏改一处（例如新增 pet:visible 只改了半边），
// 而纯 Node 测试能零成本抓住它。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.join(__dirname, '..', 'desktop');
const read = (rel) => fs.readFileSync(path.join(desktopDir, rel), 'utf8');

const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const rendererSrc = read('renderer/pet.js');

const uniq = (arr) => [...new Set(arr)];
const matchAll = (src, re) => uniq([...src.matchAll(re)].map((m) => m[1]));

const mainHandled = matchAll(mainSrc, /ipcMain\.handle\('([^']+)'/g);
const preloadInvoked = matchAll(preloadSrc, /ipcRenderer\.invoke\('([^']+)'/g);
const mainPushed = matchAll(mainSrc, /\bsend\('([^']+)'/g);

// 只取 ALLOWED_PUSH 集合字面量里的通道，避免把 invoke('pet:xxx') 也当成「白名单」。
function allowedPushChannels(src) {
  const start = src.indexOf('const ALLOWED_PUSH = new Set([');
  assert.ok(start >= 0, 'preload 必须定义 ALLOWED_PUSH');
  const end = src.indexOf(']);', start);
  assert.ok(end > start, 'ALLOWED_PUSH 定义不完整');
  return matchAll(src.slice(start, end), /'(pet:[a-z-]+)'/g);
}
const preloadAllowedPush = allowedPushChannels(preloadSrc);

function bridgeKeys(src) {
  const start = src.indexOf("exposeInMainWorld('pet'");
  assert.ok(start >= 0, 'preload 必须暴露 window.pet');
  const body = src.slice(start);
  return matchAll(body, /^\s{2}([A-Za-z]\w*):/gm);
}

const bridge = bridgeKeys(preloadSrc);
const rendererUsed = matchAll(rendererSrc, /window\.pet\.(\w+)\s*\(/g);

test('preload 暴露了渲染层用到的每一个 window.pet.*', () => {
  assert.ok(rendererUsed.length > 0, '渲染层应当通过 window.pet 调用主进程');
  for (const fn of rendererUsed) {
    assert.ok(bridge.includes(fn), `window.pet.${fn} 未在 preload.js 中暴露（渲染层会拿到 undefined）`);
  }
});

test('渲染层订阅的每个推送通道都在 preload 白名单里', () => {
  const subscribed = matchAll(rendererSrc, /window\.pet\.(on[A-Z]\w*)\(/g);
  const map = {
    onState: 'pet:state',
    onGeom: 'pet:geom',
    onDragCancel: 'pet:drag-cancel',
    onStatus: 'pet:status',
    onFullscreen: 'pet:fullscreen',
    onVisible: 'pet:visible',
    onOpenResult: 'pet:open-result',
  };
  for (const fn of subscribed) {
    assert.ok(bridge.includes(fn), `window.pet.${fn} 未暴露`);
    const channel = map[fn];
    assert.ok(channel, `新增订阅 ${fn} 未登记到本测试的通道映射`);
    assert.ok(preloadAllowedPush.includes(channel), `${channel} 不在 preload 的 ALLOWED_PUSH 白名单里`);
  }
});

test('主进程推送的每个通道都能被 preload 放行（否则渲染层静默收不到）', () => {
  assert.ok(mainPushed.length > 0);
  for (const ch of mainPushed) {
    assert.ok(preloadAllowedPush.includes(ch), `main.js 推送 ${ch}，但 preload ALLOWED_PUSH 不含它`);
  }
});

test('preload invoke 的通道都有对应的 ipcMain.handle', () => {
  for (const ch of preloadInvoked) {
    assert.ok(mainHandled.includes(ch), `preload 调 ${ch}，但 main.js 没有 ipcMain.handle('${ch}')`);
  }
});

test('显示/隐藏按钮的通道已端到端接通', () => {
  assert.ok(bridge.includes('toggleVisible'), 'window.pet.toggleVisible 未暴露');
  assert.ok(preloadInvoked.includes('pet:toggle-visible'), 'preload 未 invoke pet:toggle-visible');
  assert.ok(mainHandled.includes('pet:toggle-visible'), 'main 未 handle pet:toggle-visible');
  assert.ok(rendererUsed.includes('toggleVisible'), '渲染层未调用 toggleVisible（隐藏按钮点不动）');
  assert.ok(preloadAllowedPush.includes('pet:visible'));
  assert.ok(mainPushed.includes('pet:visible'));
});

test('点击穿透与截屏保护开关仍在主进程（渲染层不得直接碰窗口能力）', () => {
  assert.ok(/setContentProtection\(/.test(mainSrc), '截屏保护必须在 main.js 调用 win.setContentProtection');
  assert.equal(
    /setContentProtection\(/.test(rendererSrc),
    false,
    'renderer 无 Node/electron，不该出现 setContentProtection'
  );
  assert.ok(/setIgnoreMouseEvents\(/.test(mainSrc));
  assert.equal(/setIgnoreMouseEvents\(/.test(rendererSrc), false);
});
