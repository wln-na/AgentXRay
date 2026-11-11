// AgentXRay 桌面宠物壳 —— Electron 主进程入口（唯一 require('electron') 的地方之一）。
//
// 职责：单实例锁、建透明置顶窗、托盘、IPC、click-through 仲裁、SSE 状态消费、
// 看门狗、全屏轮询、皮肤装配、退出清理。所有「可判定的逻辑」都下沉到 desktop/lib/*
// 纯模块，这里只做「依赖注入装配」（注入真实 http/spawn/osascript/screen）。
//
// 日志前缀统一 [pet:main] / [pet:state] / [pet:watchdog] / [pet:fullscreen] / [pet:launchagent] / [pet:sprite]。

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, clipboard, nativeImage, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const config = require('./lib/config');
const { createStateClient } = require('./lib/sse');
const { decideWatchdog } = require('./lib/watchdog');
const { createFullscreenProbe, decideHidden } = require('./lib/fullscreen');
const { clampAcrossDisplays } = require('./lib/window-geometry');
const {
  buildPlist,
  resolveProgramArgs,
  install: installAgent,
  uninstall: uninstallAgent,
} = require('./lib/launchagent');
const { createOpenClient } = require('./lib/open-client');
const { scanPacks, selectPack, listStateFrames } = require('./lib/sprite');
const { resolveNodeExec } = require('./lib/node-exec');
const { expandedWindowHeight } = require('./lib/bubble-layout');
const { resolveVisibility, nextUserHidden, needsApply } = require('./lib/visibility');

// 平台门控：点击穿透（forward:true 的 mousemove 转发）是 macOS 特有语义。
const IS_MAC = process.platform === 'darwin';

// 托盘图标：内联 16×16 PNG（amber 圆点 + 两只眼睛）。
// 说明：PRD 的「零图片资源」只约束**宠物动画**（renderer 用 lib/pixel.js 现画）；托盘图标
// 是唯一嵌入式小图标，避免运行时读额外资源文件、保证托盘在首帧即有线。
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAASUlEQVR4nGNgoAX4c9n3BDZMtOav87j/Y8MEDcGlER2TbDNBl5CiGashVDegwpQfjHHxae8C+htAcTRSJSER4xKS8gPZmYlUAADdNJ0UTEgmWAAAAABJRU5ErkJggg==';

// 窗口几何：16×16 逻辑格、每格 6px → 96px 精灵。窗口比正方形宽（300×128）：
// 吉祥物按 min(w,h)/160 等比缩放并以 w/2 居中，所以加宽只给顶部气泡让出长度，
// 宠物本身大小不变；非热区全程鼠标穿透，多出来的透明区域不影响交互。
const WINDOW = { w: 300, h: 128 };
// 展开态窗口高度：由气泡布局推导，保证放大后的 5 张卡片不裁切。
const WINDOW_EXPANDED_H = expandedWindowHeight({ petHeight: WINDOW.h });
const GRID = 16;
const CELL = 6;

// petH = 宠物壳基准高度（始终为收起高度，不随展开态变化）——渲染端用它锁定宠物缩放。
const GEOM = { w: WINDOW.w, h: WINDOW.h, cell: CELL, petH: WINDOW.h };

// 轮询参数（AGENTXRAY_PET_DEBUG=1 时调快全屏轮询便于调试）。
const FULLSCREEN_POLL_MS = config.DEBUG ? 500 : 1000;
const WATCHDOG_POLL_MS = 2000;
const LIVENESS_PROBE_MS = 5000;
const POINTER_IDLE_MS = 5000;
const WINDOW_STATE_SAVE_MS = 300;
// 被监督 server 的 stdout/stderr 落盘 + 前若干行打日志（避免刷屏，文件仍全量）。
const SERVER_LOG_TAIL_LINES = 40;

function log(scope, ...args) {
  console.log(`[pet:${scope}]`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 模块级状态 ----------
let mainWindow = null;
let tray = null;
let stateClient = null;
let openClient = null;
let serverChild = null;
let mode = 'external-server'; // 'own-server' | 'external-server'

let startedAt = null;
let lastLivenessAt = null;
let restartCount = 0;
let watchdogTimer = null;
let livenessTimer = null;
let fullscreenTimer = null;
let interactiveTimer = null;
let watchdogStopped = false;

let interactive = false;
let lastPointerAt = 0;
// 可见性：windowHidden 是**实际应用**到窗口的隐藏态；userHidden / fullscreenHidden 是两个
// 独立来源（见 lib/visibility.js），任一为真即隐藏，某个来源解除不会抢回另一个来源的隐藏。
let windowHidden = false;
let userHidden = false;
let fullscreenHidden = false;
let lastFullscreenAt = null;
let warnedProbeError = false;
// 截屏内容保护：true = 窗口不进系统截屏/录屏（NSWindowSharingNone）。
let screenshotProtect = config.SCREENSHOT_PROTECT;

let serverOutStream = null;
let serverErrStream = null;
let serverLogLines = 0;

let dragTimer = null;
let dragStartCursor = null;
let dragStartBounds = null;
// 拖动开始时的显示器快照：16ms/tick 的夹紧不必每次都同步查询显示器（跨屏拖动仍按并集仲裁）。
let dragDisplays = null;
// 当前长高方向：false = 向上生长（默认，宠物贴窗口底部），true = 向下生长（宠物贴屏幕顶时）。
let tallBelow = false;
let windowStateSaveTimer = null;

const fullscreenProbe = createFullscreenProbe({});

// ---------- IPC 推送封装 ----------
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function markLiveness() {
  lastLivenessAt = Date.now();
  trayReachable(true);
}

// ---------- 窗口位置持久化 ----------
// 记录 x/y/h：窗口高度会随气泡内容伸缩（底边锚定），还原时按底边对齐换算回收起态 y。
/** 所有显示器的几何快照，供 lib/window-geometry.js 的纯函数仲裁（不依赖 Electron 全局）。 */
function displayDescriptors() {
  return screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea }));
}

// 夹紧到「所有屏」而不是主屏：这样宠物可以被拖到副屏，重开也留在副屏；
// 副屏被拔掉/改分辨率时退回最近的一块屏，不会落到屏幕外「隐身」。
function clampWindowPosition(desired) {
  return clampAcrossDisplays({
    desired,
    windowSize: { w: WINDOW.w, h: WINDOW.h },
    displays: displayDescriptors(),
    // 桌宠窗口是最高层级（screen-saver），允许盖住菜单栏/Dock 贴到屏幕最顶端。
    allowLargerThanScreen: true,
  });
}

function loadWindowState() {
  try {
    const raw = require('node:fs').readFileSync(config.WINDOW_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      const savedH = Number.isFinite(parsed.h) ? parsed.h : WINDOW.h;
      // 底边对齐：还原为收起态高度，保证宠物脚底停在用户上次放置的位置。
      // 历史状态可能在展开态保存，底边换算后可能整窗落到屏幕外（宠物“隐身”且无法拖回），
      // 所以统一交给 clampWindowPosition 夹紧。
      return clampWindowPosition({
        x: Math.round(parsed.x),
        y: Math.round(parsed.y + savedH - WINDOW.h),
      });
    }
  } catch {
    // 无状态文件 → 用默认位置。
  }
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 16;
  return { x: workArea.x + workArea.width - WINDOW.w - margin, y: workArea.y + workArea.height - WINDOW.h - margin };
}

function scheduleWindowStateSave() {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(async () => {
    windowStateSaveTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { x, y, height } = mainWindow.getBounds();
    try {
      await fsp.mkdir(config.PET_DIR, { recursive: true });
      await fsp.writeFile(config.WINDOW_STATE, JSON.stringify({ x, y, h: height }, null, 2), 'utf8');
      log('main', '已保存窗口位置', x, y, height);
    } catch (err) {
      log('main', '保存窗口位置失败：', err?.message ? err.message : err);
    }
  }, WINDOW_STATE_SAVE_MS);
}

// ---------- 点击穿透仲裁（唯一调用 setIgnoreMouseEvents 处） ----------
// 语义（设计 §5）：**值没变 → 忽略；值变了 → 必须立即生效**。绝不做「距上次变化不足 N ms
// 就丢弃」的节流——那会把真实的 true→false 跳变吞掉，让窗口卡在可交互态。
// 平台门控：forward:true 的 mousemove 转发是 macOS 特有语义；非 macOS 一律不调用（窗口保持可交互），
// 否则 renderer 收不到 pointer → 热区永不触发 → 宠物永久点不动。
let warnedNonMacPassthrough = false;

function setPassthrough(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (on) mainWindow.setIgnoreMouseEvents(true, { forward: true });
  else mainWindow.setIgnoreMouseEvents(false);
}

function applyInteractive(value) {
  if (!IS_MAC) {
    if (!warnedNonMacPassthrough) {
      warnedNonMacPassthrough = true;
      log('main', '非 macOS：不做点击穿透（forward 语义不可用），窗口保持可交互');
    }
    return;
  }
  const next = !!value;
  if (next === interactive) return; // 值没变 → 忽略
  if (windowHidden) return; // 隐藏期间不处理 pointer（与全屏隐藏互斥）
  interactive = next;
  setPassthrough(!next);
}

function forcePassThrough(reason) {
  if (!IS_MAC || !mainWindow || mainWindow.isDestroyed()) return;
  if (interactive) {
    interactive = false;
    setPassthrough(true);
    log('main', '强制恢复穿透：', reason);
  } else {
    setPassthrough(true);
  }
}

function startInteractiveSafety() {
  interactiveTimer = setInterval(() => {
    if (interactive && Date.now() - lastPointerAt > POINTER_IDLE_MS) {
      forcePassThrough('idle-timeout');
    }
  }, 1000);
}

// ---------- 显示 / 隐藏（用户主动） + 截屏保护 ----------
// 窗口的实际可见性由 lib/visibility.js 仲裁（用户隐藏 × 全屏自动隐藏），这里只做应用。
function syncWindowVisibility(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { hidden, visible } = resolveVisibility({ userHidden, fullscreenHidden });
  if (!needsApply(windowHidden, hidden)) return;
  windowHidden = hidden;
  if (visible) {
    mainWindow.showInactive();
    log('main', `显示宠物（${reason}）`);
  } else {
    forcePassThrough(reason); // 收起前把窗口恢复穿透，避免下次显示时卡在可交互态
    mainWindow.hide();
    log('main', `隐藏宠物（${reason}）`);
  }
  send('pet:visible', { visible, reason });
  refreshTrayMenu();
}

/**
 * 用户态显示/隐藏：由宠物上的按钮、托盘菜单、全局快捷键共用。
 *
 * @param {boolean} [explicitVisible] true = 显示，false = 隐藏；省略 = 取反
 * @returns {{visible: boolean, userHidden: boolean}} visible 为**实际**可见性
 */
function setUserVisible(explicitVisible) {
  userHidden = nextUserHidden(userHidden, explicitVisible);
  syncWindowVisibility('user'); // 可见性真的变化时，内部会重建托盘菜单（标签跟着改）
  return { visible: !windowHidden, userHidden };
}

function toggleWindow(source = 'tray') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 以「实际可见性」决定方向：可见 → 收起；已隐藏 → 显示。
  // 全屏自动隐藏期间「显示」不会生效（别人正在全屏，宠物不该跳出来），属预期行为。
  log('main', `切换可见性（${source}）`);
  setUserVisible(windowHidden);
}

/**
 * 截屏内容保护：win.setContentProtection(true) 在 macOS 上等价 NSWindowSharingNone，
 * 窗口不进系统截屏（⌘⇧3/4/5）、录屏与屏幕共享画面——下层桌面照常被拍到。
 *
 * @param {boolean} on
 * @param {{silent?: boolean}} [opts]
 */
function applyContentProtection(on, opts = {}) {
  screenshotProtect = !!on;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setContentProtection(screenshotProtect);
    } catch (err) {
      log('main', '截屏保护设置失败：', err?.message ? err.message : err);
    }
  }
  if (!opts.silent) {
    log('main', screenshotProtect ? '截屏保护：开（截屏/录屏里看不到宠物）' : '截屏保护：关（宠物会被截到）');
  }
  return screenshotProtect;
}

// 全局快捷键：宠物被收起后窗口点不到，除托盘外再留一条键盘通道。
// 注册失败（常被其他 App 占用）只打日志，托盘菜单仍然可用。
function setupHotkey() {
  if (!config.HOTKEY) {
    log('main', '未启用显示/隐藏快捷键（AGENTXRAY_PET_HOTKEY 为空或 off）');
    return;
  }
  try {
    const ok = globalShortcut.register(config.HOTKEY, () => toggleWindow('hotkey'));
    if (ok) log('main', `显示/隐藏快捷键：${config.HOTKEY}`);
    else log('main', `快捷键 ${config.HOTKEY} 注册失败（可能被其他 App 占用），请改用托盘菜单`);
  } catch (err) {
    log('main', '快捷键注册异常：', err?.message ? err.message : err);
  }
}

// ---------- 拖拽移动（⌘ / 右键）：用屏幕光标增量移动窗口 ----------
// 拖动期间的落点 = 拖拽起点 + 光标位移，再交给 lib/window-geometry.js 做**跨屏**仲裁：
// 允许骑在两块屏中间（所以跨副屏拖动是连续的），但窗口过半面积必须落在某块屏上，
// 否则吸附回最近的屏——不会出现「拖到 L 形空隙里看不见也拖不回来」。
// enableLargerThanScreen 开启后允许窗口覆盖菜单栏区域，顶边可落到 display.bounds.y。
function dragTargetPosition() {
  if (!dragStartBounds || !dragStartCursor) return null;
  const cur = screen.getCursorScreenPoint();
  return {
    x: dragStartBounds.x + (cur.x - dragStartCursor.x),
    y: dragStartBounds.y + (cur.y - dragStartCursor.y),
  };
}

function applyDragPosition(desired) {
  if (!mainWindow || mainWindow.isDestroyed() || !desired) return;
  const clamped = clampAcrossDisplays({
    desired,
    windowSize: { w: WINDOW.w, h: WINDOW.h },
    displays: dragDisplays || displayDescriptors(),
    allowLargerThanScreen: true,
  });
  mainWindow.setBounds({ x: clamped.x, y: clamped.y, width: WINDOW.w, height: WINDOW.h });
}

function finishDrag() {
  if (!mainWindow || mainWindow.isDestroyed() || !dragStartBounds || !dragStartCursor) return;
  applyDragPosition(dragTargetPosition());
}

function handleDrag(payload) {
  const phase = payload ? payload.phase : null;
  if (phase === 'start') {
    if (dragTimer || !mainWindow || mainWindow.isDestroyed()) return;
    dragStartBounds = mainWindow.getBounds();
    if (dragStartBounds.height !== WINDOW.h) {
      // 拖动统一在宠物壳高度（128）进行：按长高方向锚定宠物那一侧收拢，宠物原地不动，
      // 否则首个拖动 tick 会把窗口顶边压回、宠物从窗口底部跳位 244px，
      // 光标脱离宠物后 mouseup 收不到，拖拽会卡死。
      mainWindow.setBounds({
        x: dragStartBounds.x,
        y: tallBelow ? dragStartBounds.y : dragStartBounds.y + dragStartBounds.height - WINDOW.h,
        width: WINDOW.w,
        height: WINDOW.h,
      });
      dragStartBounds = mainWindow.getBounds();
    }
    dragStartCursor = screen.getCursorScreenPoint();
    dragDisplays = displayDescriptors();
    dragTimer = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const cur = screen.getCursorScreenPoint();
      // 光标离开窗口 = 用户在夹紧边缘外（菜单栏/Dock 区域）松手，mouseup 落在别的
      // 窗口上、渲染端收不到 mouseup。立即结束拖拽并把宠物留在贴边位置，
      // 否则拖拽定时器继续跟着光标跑，宠物看起来永远“贴不到上/下边缘”。
      const nb = mainWindow.getBounds();
      const cursorInside =
        cur.x >= nb.x - 2 && cur.x <= nb.x + nb.width + 2 && cur.y >= nb.y - 2 && cur.y <= nb.y + nb.height + 2;
      if (!cursorInside) {
        clearInterval(dragTimer);
        dragTimer = null;
        finishDrag();
        dragDisplays = null;
        send('pet:drag-cancel', {});
        scheduleWindowStateSave();
        log('main', '结束拖拽（光标离开窗口）');
        return;
      }
      // 先把窗口移到光标处，再夹紧（跨屏时窗口会跟着光标连续跨过去）。
      // 夹紧规则见 clampWindowPosition：并集内自由移动，过半面积必须在某块屏上。
      applyDragPosition({
        x: dragStartBounds.x + (cur.x - dragStartCursor.x),
        y: dragStartBounds.y + (cur.y - dragStartCursor.y),
      });
    }, 16);
    log('main', '开始拖拽');
  } else if (phase === 'end') {
    if (dragTimer) {
      clearInterval(dragTimer);
      dragTimer = null;
    }
    finishDrag();
    dragDisplays = null;
    scheduleWindowStateSave();
    log('main', '结束拖拽');
  }
}

// ---------- 皮肤装配 ----------
async function buildSkinPayload() {
  try {
    const packs = await scanPacks(config.PETS_DIR);
    const choice = selectPack({ requested: config.PACK, packs });
    if (choice.source === 'builtin' || !choice.pack) {
      return { manifest: null, frames: {}, source: choice.source, name: null };
    }
    const manifest = choice.pack.manifest;
    const frames = {};
    for (const state of config.PET_STATES) {
      const cfg = manifest.states ? manifest.states[state] : null;
      const dir = cfg?.dir ? cfg.dir : path.join(choice.pack.path, 'frames', state);
      const abs = await listStateFrames(dir);
      frames[state] = abs.map((p) => pathToFileURL(p).href);
    }
    log('sprite', `使用皮肤 ${choice.pack.name}（source=${choice.source}）`);
    return { manifest, frames, source: choice.source, name: choice.pack.name };
  } catch (err) {
    log('sprite', '皮肤加载失败，回退内置：', err?.message ? err.message : err);
    return { manifest: null, frames: {}, source: 'builtin', name: null };
  }
}

// ---------- 点击跳回 ----------
async function handleOpenSession(payload) {
  const platform = payload ? payload.platform : null;
  const sessionId = payload ? payload.sessionId : null;
  const agent = payload ? payload.agent : null;
  if (!platform || !sessionId) {
    return { ok: false, error: '缺少 platform/sessionId' };
  }
  const result = await openClient.open({ platform, sessionId, agent, action: 'open' });
  if (!result.ok) {
    const fb = openClient.copyFallback(result);
    if (fb) {
      clipboard.writeText(fb);
      log('main', '跳转失败，已复制 fallback：', fb);
    } else {
      log('main', '跳转失败：', result.error || '未知错误');
    }
  }
  send('pet:open-result', result);
  return result;
}

// ---------- 忽略会话（dismiss，气泡不再提醒） ----------
async function handleIgnoreSession(payload) {
  const platform = payload ? payload.platform : null;
  const sessionId = payload ? payload.sessionId : null;
  if (!platform || !sessionId) {
    return { ok: false, error: '缺少 platform/sessionId' };
  }
  const result = await openClient.ignoreSession({
    platform,
    sessionId,
    agent: payload.agent || undefined,
    durationMs: payload.durationMs,
  });
  // 复用 open-result 通道给渲染层 toast 反馈（已是同一套气泡提示）。
  send('pet:open-result', {
    ok: result.ok,
    detail: result.ok ? '已忽略该会话' : result.error || '忽略失败',
  });
  return result;
}

// ---------- SSE 状态客户端 ----------
function startStateClient() {
  stateClient = createStateClient({
    host: config.HOST,
    port: config.PORT,
    httpGet: http.get,
    onState: (petState) => {
      markLiveness();
      send('pet:state', petState);
    },
    onStatus: ({ connected }) => {
      if (connected) markLiveness();
      else trayReachable(false);
      send('pet:status', { connected });
    },
    onError: (err) => log('state', '错误：', err?.message ? err.message : err),
  });
  stateClient.start();
}

// ---------- 后端探测 / spawn ----------
function probeVersion() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const req = http.get({ host: config.HOST, port: config.PORT, path: '/api/version', timeout: 1500 }, (res) => {
        res.resume();
        done(res.statusCode === 200 || res.statusCode === 204);
      });
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

async function detectServer() {
  const up = await probeVersion();
  if (up) {
    mode = 'external-server';
    markLiveness();
    log('main', '检测到后端已在运行（external-server 模式）');
    return;
  }
  mode = 'own-server';
  spawnServer();
}

function closeServerStreams() {
  for (const s of [serverOutStream, serverErrStream]) {
    if (s && !s.destroyed) {
      try {
        s.end();
      } catch {
        // 忽略。
      }
    }
  }
  serverOutStream = null;
  serverErrStream = null;
}

function spawnServer() {
  if (watchdogStopped) return; // before-quit 之后不再拉起，避免孤儿进程
  if (serverChild && serverChild.exitCode === null) return;
  const repoRoot = path.join(__dirname, '..');
  const serverPath = path.join(repoRoot, 'server.js');

  // 优先真 node（ABI 安全），回退 Electron 内置 Node（会带 warning）。
  const resolved = resolveNodeExec({ env: process.env, execPath: process.execPath });
  if (resolved.warning) log('main', resolved.warning);
  const env = { ...process.env };
  if (resolved.injectElectronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';

  // stdout/stderr 接管道：全量追加写盘 + 前若干行打日志（崩溃时不再零线索）。
  try {
    fs.mkdirSync(config.PET_DIR, { recursive: true });
    serverOutStream = fs.createWriteStream(config.PET_LOG, { flags: 'a' });
    serverErrStream = fs.createWriteStream(config.PET_ERR_LOG, { flags: 'a' });
  } catch (err) {
    log('main', '创建 server 日志文件失败：', err?.message ? err.message : err);
    closeServerStreams();
  }
  serverLogLines = 0;

  try {
    serverChild = spawn(resolved.exec, [serverPath], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logLine = (scope) => (chunk) => {
      const lines = String(chunk)
        .split('\n')
        .filter((l) => l.trim() !== '');
      for (const line of lines) {
        if (serverLogLines < SERVER_LOG_TAIL_LINES) log('main', `[server:${scope}] ${line}`);
        serverLogLines += 1;
      }
    };
    if (serverChild.stdout) {
      serverChild.stdout.on('data', logLine('out'));
      // pipe 自带背压（会 pause/resume 源）；无落盘文件时也要 drain 防卡死子进程。
      if (serverOutStream) serverChild.stdout.pipe(serverOutStream);
      else serverChild.stdout.resume();
    }
    if (serverChild.stderr) {
      serverChild.stderr.on('data', logLine('err'));
      if (serverErrStream) serverChild.stderr.pipe(serverErrStream);
      else serverChild.stderr.resume();
    }
    serverChild.on('exit', (code, signal) => {
      log('main', `被监督的 server.js 退出 code=${code} signal=${signal}`);
      closeServerStreams();
    });
    log('main', `已启动被监督的 server.js（${resolved.exec}，source=${resolved.source}，PID ${serverChild.pid}）`);
  } catch (err) {
    log('main', 'spawn server.js 失败：', err?.message ? err.message : err);
    serverChild = null;
    closeServerStreams();
  }
}

function childAlive() {
  if (mode === 'external-server') return true;
  return !!(serverChild && serverChild.exitCode === null);
}

// ---------- 看门狗 ----------
function startWatchdog() {
  if (config.NO_WATCHDOG) {
    log('watchdog', '已通过 AGENTXRAY_PET_NO_WATCHDOG 关闭');
    return;
  }
  startedAt = Date.now();
  watchdogTimer = setInterval(async () => {
    if (watchdogStopped) return;
    // 存活时间取两源最大值：主进程自己的 markLiveness()（SSE state 帧 + 周期 HTTP 探测，
    // 经 onState/onStatus 回调刷新）+ stateClient.lastLiveness()（帧级：state / `: ping` 心跳 /
    // error / 未知事件都能刷新，覆盖主进程 onState 未覆盖到的帧）。二者互补，缺一会误判假死。
    const clientLiveness = stateClient ? stateClient.lastLiveness() : null;
    const effLivenessAt = Math.max(lastLivenessAt ?? 0, clientLiveness ?? 0) || null;
    const decision = decideWatchdog({
      now: Date.now(),
      lastLivenessAt: effLivenessAt,
      childAlive: childAlive(),
      restartCount,
      startedAt,
    });
    if (decision.action === 'ok') {
      if (lastLivenessAt !== null && restartCount !== 0) restartCount = 0;
      if (decision.reason === 'healthy') trayReachable(true);
      return;
    }
    if (decision.action === 'giveup') {
      log('watchdog', `已达重启上限，放弃（${decision.reason}）`);
      trayReachable(false);
      stopWatchdog(); // 停掉定时器，避免每 2s 无限重复告警
      return;
    }
    // action === 'restart'
    restartCount += 1;
    log('watchdog', `重启（${decision.reason}），退避 ${decision.nextBackoffMs}ms`);
    if (decision.nextBackoffMs) await sleep(decision.nextBackoffMs);
    if (watchdogStopped) return; // 退避期间被 before-quit 停掉 → 不再拉起
    await doRestart(decision.reason);
    if (watchdogStopped) return;
    startedAt = Date.now();
    lastLivenessAt = null;
  }, WATCHDOG_POLL_MS);

  // 周期性 HTTP liveness 探测（配合 SSE 帧共同刷新 lastLivenessAt）。
  livenessTimer = setInterval(async () => {
    if (watchdogStopped) return;
    if (await probeVersion()) markLiveness();
  }, LIVENESS_PROBE_MS);
}

function stopWatchdog() {
  watchdogStopped = true;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (livenessTimer) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }
}

async function doRestart(reason) {
  if (watchdogStopped) return; // before-quit 之后不再重启，避免孤儿 server 进程
  if (mode === 'own-server') {
    if (serverChild && serverChild.exitCode === null) {
      try {
        serverChild.kill('SIGTERM');
      } catch {
        // 子进程可能已退出。
      }
    }
    serverChild = null;
    spawnServer();
  } else {
    // external-server：重启动作退化为「重建 SSE + 重试 HTTP」。
    log('main', `external-server 模式，重建 SSE（${reason}）`);
    if (stateClient) {
      stateClient.stop();
      stateClient.start();
    }
    await probeVersion();
  }
}

// ---------- 全屏轮询 ----------
function startFullscreenPoll() {
  if (process.platform !== 'darwin') {
    log('fullscreen', '非 macOS，跳过多显示器/全屏隐藏轮询');
    return;
  }
  fullscreenTimer = setInterval(async () => {
    const now = Date.now();
    const pr = await fullscreenProbe();
    if (pr.fullscreen) lastFullscreenAt = now;
    if (pr.error && !warnedProbeError) {
      warnedProbeError = true;
      log('fullscreen', 'probe 不可用（可能未授权「辅助功能」），退化为不隐藏：', pr.error);
    }
    const { hidden } = decideHidden({ probeResult: pr, now, lastFullscreenAt, prevHidden: fullscreenHidden });
    if (hidden !== fullscreenHidden) {
      fullscreenHidden = hidden;
      syncWindowVisibility(hidden ? 'fullscreen' : 'fullscreen-exit');
      // 渲染层据此暂停/恢复动画；窗口是否真的出现仍由 syncWindowVisibility 决定
      // （用户主动隐藏时，退出全屏也不会把宠物放回来）。
      send('pet:fullscreen', { hidden });
      log('fullscreen', hidden ? '进入全屏 → 隐藏宠物' : '退出全屏 → 恢复宠物');
    }
  }, FULLSCREEN_POLL_MS);
}

// ---------- 托盘 ----------
function trayReachable(ok) {
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(ok ? 'AgentXRay Pet · 已连接' : 'AgentXRay Pet · 后端不可达');
  }
}

// 菜单标签随可见性/截屏保护状态重建（托盘菜单是隐藏后唯一常驻入口，必须反映当前状态）。
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: windowHidden ? '显示宠物' : '隐藏宠物', click: () => toggleWindow('tray') },
    { label: `快捷键：${config.HOTKEY || '未启用'}`, enabled: false },
    { label: '定位当前会话', click: () => locateCurrentSession() },
    { type: 'separator' },
    {
      label: '截屏/录屏时不拍到宠物',
      type: 'checkbox',
      checked: screenshotProtect,
      click: (item) => applyContentProtection(item.checked),
    },
    { type: 'separator' },
    { label: '安装开机自启（LaunchAgent）', click: () => trayInstallAgent() },
    { label: '卸载开机自启', click: () => trayUninstallAgent() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

async function locateCurrentSession() {
  const st = stateClient ? stateClient.last() : null;
  if (!st?.platform || !st.sessionId) {
    log('main', '当前没有可定位的会话');
    return;
  }
  await openClient.locate({
    platform: st.platform,
    sessionId: st.sessionId,
    agent: st.agent || undefined,
  });
}

async function trayInstallAgent() {
  const resolved = resolveProgramArgs({
    mode: app.isPackaged ? 'packaged' : 'dev',
    execPath: process.execPath,
    desktopDir: __dirname,
    override: config.EXEC || undefined,
  });
  if (resolved.warning) {
    log('launchagent', resolved.warning);
    return;
  }
  const plist = buildPlist({
    label: config.LAUNCH_AGENT_LABEL,
    programArgs: resolved.programArgs,
    workingDir: __dirname,
    stdoutPath: config.PET_LOG,
    stderrPath: config.PET_ERR_LOG,
  });
  const result = await installAgent({
    label: config.LAUNCH_AGENT_LABEL,
    plist,
    plistDir: path.dirname(config.PLIST_PATH),
  });
  log('launchagent', result.ok ? `已安装：${result.plistPath}` : `安装失败：${result.error}`);
}

async function trayUninstallAgent() {
  const result = await uninstallAgent({
    label: config.LAUNCH_AGENT_LABEL,
    plistDir: path.dirname(config.PLIST_PATH),
  });
  log('launchagent', result.ok ? `已卸载：${result.plistPath}` : `卸载失败：${result.error}`);
}

function setupTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  tray = new Tray(icon);
  tray.setToolTip('AgentXRay Pet');
  refreshTrayMenu();
  tray.on('click', () => toggleWindow('tray-click'));
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('pet:get-info', async () => ({
    host: config.HOST,
    port: config.PORT,
    geom: { ...GEOM, bubbleBelow: tallBelow },
    grid: GRID,
    states: config.PET_STATES,
    skin: await buildSkinPayload(),
    debug: config.DEBUG,
  }));

  ipcMain.handle('pet:open-session', (_event, payload) => handleOpenSession(payload));
  ipcMain.handle('pet:ignore-session', (_event, payload) => handleIgnoreSession(payload));

  ipcMain.handle('pet:set-interactive', (_event, value) => {
    lastPointerAt = Date.now();
    applyInteractive(!!value);
    return true;
  });

  ipcMain.handle('pet:drag', (_event, payload) => {
    handleDrag(payload);
    return true;
  });

  // 宠物上的「隐藏」按钮：window.pet.toggleVisible()（Toggle）或 toggleVisible(false)（收起）。
  ipcMain.handle('pet:toggle-visible', (_event, value) =>
    setUserVisible(typeof value === 'boolean' ? value : undefined)
  );

  // 展开/收起会话卡片列表：底边锚定，向上生长/收回，并把新几何推给渲染层。
  ipcMain.handle('pet:set-expanded', (_event, value) => {
    const want = !!value;
    const b = mainWindow.getBounds();
    if (want) {
      if (b.height !== WINDOW_EXPANDED_H) {
        // 方向仲裁：哪边剩余空间大就往哪边生长。向上 = 底边锚定（宠物贴窗口底）；
        // 向下 = 顶边锚定（渲染端把宠物画到窗口顶部，宠物屏幕位置不变）。
        const wa = screen.getDisplayMatching(b).workArea;
        const spaceAbove = b.y - wa.y;
        const spaceBelow = wa.y + wa.height - (b.y + WINDOW.h);
        tallBelow = spaceBelow > spaceAbove;
        const y = tallBelow ? b.y + b.height - WINDOW.h : b.y + b.height - WINDOW_EXPANDED_H;
        mainWindow.setBounds({ x: b.x, y, width: b.width, height: WINDOW_EXPANDED_H });
      }
    } else if (b.height !== WINDOW.h) {
      // 收拢时按当前方向锚定宠物侧，保证宠物屏幕位置不变。
      const y = tallBelow ? b.y : b.y + b.height - WINDOW.h;
      mainWindow.setBounds({ x: b.x, y, width: b.width, height: WINDOW.h });
    }
    const nb = mainWindow.getBounds();
    send('pet:geom', { w: nb.width, h: nb.height, cell: CELL, petH: WINDOW.h, bubbleBelow: tallBelow });
    return true;
  });
}

// ---------- 窗口 ----------
function createWindow() {
  const bounds = loadWindowState();
  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: WINDOW.w,
    height: WINDOW.h,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // 截屏/录屏不可见：必须在窗口创建后立即设置（macOS: NSWindowSharingNone）。
  applyContentProtection(screenshotProtect, { silent: true });
  log('main', screenshotProtect ? '截屏保护：开（系统截屏/录屏拍不到宠物）' : '截屏保护：关（宠物会被截到）');
  if (IS_MAC) {
    // 默认穿透；forward:true 让窗口仍能收到 mousemove（热区仍可点的关键）。
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    // 非 macOS 不做穿透：窗口保持可交互（否则 renderer 收不到 pointer → 宠物永久点不动）。
    warnedNonMacPassthrough = true;
    log('main', '非 macOS：不做点击穿透（forward 语义不可用），窗口保持可交互');
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (windowHidden) return; // 用户此前已收起（重建窗口时），不要自己冒出来
    mainWindow.showInactive();
  });

  mainWindow.on('blur', () => forcePassThrough('blur'));
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // renderer 崩溃 → 重载窗口（状态由 SSE 重推），不走看门狗。
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('main', 'renderer 进程消失，重载窗口：', details ? details.reason : 'unknown');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });
}

// ---------- 生命周期 ----------
async function bootstrap() {
  if (app.dock) app.dock.hide(); // 后台应用：只留托盘，不占 Dock。

  setupIpc();
  createWindow();
  setupTray();
  setupHotkey();

  openClient = createOpenClient({ host: config.HOST, port: config.PORT, httpRequest: http.request });

  await detectServer();
  startStateClient();
  startWatchdog();
  startFullscreenPoll();
  startInteractiveSafety();

  // 安全阀不再用全局快捷键：裸 `Escape` 注册为系统级热键时，macOS 下通常注册不上
  // （register() 返回 false → 阀形同虚设），万一成功又会劫持**全系统** Esc。
  // 改为 renderer 本地响应（点宠物获得焦点后按 Esc → window.pet.setInteractive(false)）；
  // 另两道阀保持：win.on('blur') + POINTER_IDLE_MS 空闲阀（startInteractiveSafety）。
}

function cleanup() {
  stopWatchdog();
  if (fullscreenTimer) clearInterval(fullscreenTimer);
  if (interactiveTimer) clearInterval(interactiveTimer);
  if (dragTimer) clearInterval(dragTimer);
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer); // 这个是 setTimeout
  fullscreenTimer = null;
  interactiveTimer = null;
  dragTimer = null;
  windowStateSaveTimer = null;
  if (stateClient) stateClient.stop();
  globalShortcut.unregisterAll();
  if (mode === 'own-server' && serverChild && serverChild.exitCode === null) {
    try {
      serverChild.kill('SIGTERM');
    } catch {
      // 忽略。
    }
  }
  closeServerStreams();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      setUserVisible(true); // 再次启动 = 用户想看到宠物（即使之前收起来了）
      mainWindow.showInactive();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);
  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else setUserVisible(true);
  });
  app.on('window-all-closed', () => {
    // 托盘常驻，不随窗口关闭退出。
  });
  app.on('before-quit', () => {
    app.isQuitting = true;
    cleanup();
  });
}
