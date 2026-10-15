// 桌面宠物壳的全屏检测：probe（osascript + System Events）+ 纯判定 decideHidden。
//
// 目标：进入全屏应用时隐藏宠物窗，退出后延迟恢复（防抖），probe 失败一律不隐藏、不报错。
//
// 本文件是【纯模块】：`run`（子进程）与 `isMac`/`screenSize` 全部可注入，测试绝不真跑
// osascript。注意：System Events 需要 macOS「辅助功能/自动化」授权，未授权时探测失败退化
// 为「不隐藏」——这与 lib/open-session.js 的 osascript 同源权限风险，README 已写明。

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// 「最前台应用的前窗尺寸」——返回 "w, h"。
const APP_WIN_SCRIPT =
  'tell application "System Events" to tell (first process whose frontmost is true) to get size of front window';
// 「桌面（主屏）bounds」——返回 "x1, y1, x2, y2"。
const SCREEN_BOUNDS_SCRIPT = 'tell application "Finder" to get bounds of window of desktop';

/** 默认命令 runner（execFile，参数数组，无 shell 插值），与 lib/open-session.js 同款。 */
async function runCommand(file, args) {
  const { stdout } = await execFileAsync(file, args, { timeout: 8000 });
  return String(stdout).trim();
}

/**
 * 解析 osascript 返回的尺寸文本："w, h" / "{w, h}" / "w,h" / "w h" 等。
 * @param {string} text
 * @returns {{w: number, h: number} | null}
 */
function parseSizeTuple(text) {
  if (typeof text !== 'string') return null;
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const w = Number(nums[0]);
  const h = Number(nums[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

/** 解析桌面 bounds "x1, y1, x2, y2" → {w, h}（逻辑尺寸）。 */
function parseBounds(text) {
  if (typeof text !== 'string') return null;
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  const w = Number(nums[2]) - Number(nums[0]);
  const h = Number(nums[3]) - Number(nums[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

/**
 * 构造一个可注入的全屏 probe。
 *
 * @param {object} [opts]
 * @param {Function} [opts.run]        与 runCommand 同款 (file, args) => Promise<string>
 * @param {boolean} [opts.isMac]       默认 process.platform === 'darwin'
 * @param {{w: number, h: number}} [opts.screenSize] 不注入则经 osascript 查桌面 bounds
 * @returns {() => Promise<{fullscreen: boolean, appWin?: object|null, screen?: object|null, error?: string}>}
 */
function createFullscreenProbe(opts = {}) {
  const run = opts.run || runCommand;
  const isMac = opts.isMac === undefined ? process.platform === 'darwin' : !!opts.isMac;
  const injectedScreen = opts.screenSize && Number.isFinite(opts.screenSize.w) ? opts.screenSize : null;

  return async function probe() {
    if (!isMac) {
      return { fullscreen: false, appWin: null, screen: injectedScreen, error: 'unsupported' };
    }
    try {
      const appWin = parseSizeTuple(await run('osascript', ['-e', APP_WIN_SCRIPT]));
      let screen = injectedScreen;
      if (!screen) {
        screen = parseBounds(await run('osascript', ['-e', SCREEN_BOUNDS_SCRIPT]));
      }
      if (!appWin || !screen) {
        return { fullscreen: false, appWin: appWin || null, screen: screen || null, error: 'no-window' };
      }
      // 前窗高度 ≥ 屏幕高度即判定为全屏（覆盖菜单栏区域）。
      const fullscreen = appWin.h >= screen.h;
      return { fullscreen, appWin, screen };
    } catch (err) {
      return {
        fullscreen: false,
        appWin: null,
        screen: injectedScreen,
        error: err?.message ? err.message : String(err),
      };
    }
  };
}

const DEFAULT_THRESHOLDS = Object.freeze({ resumeDelayMs: 1500 });

/**
 * 纯判定：把 probe 结果 + 时间冷却成「是否隐藏」。
 *
 * @param {object} input
 * @param {object} input.probeResult  上一步 probe 的返回（{fullscreen, error?}）
 * @param {number} input.now
 * @param {number|null} input.lastFullscreenAt 最近一次观察到全屏的时间（无 → null）
 * @param {boolean} [input.prevHidden] 上一轮是否隐藏（advisory）
 * @param {object} [input.thresholds] {resumeDelayMs}
 * @returns {{hidden: boolean, reason: 'fullscreen'|'resume-delay'|'not-fullscreen'|'probe-error'}}
 */
function decideHidden(input = {}) {
  const probeResult = input.probeResult || {};
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const lastFullscreenAt = Number.isFinite(input.lastFullscreenAt) ? input.lastFullscreenAt : null;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };

  if (probeResult.fullscreen === true) {
    return { hidden: true, reason: 'fullscreen' };
  }
  if (probeResult.error) {
    // 权限不足 / probe 异常 → 视为不隐藏，绝不影响主功能。
    return { hidden: false, reason: 'probe-error' };
  }
  // 刚退出全屏：在恢复延迟窗口内保持隐藏，避免瞬间闪烁。
  if (lastFullscreenAt !== null && now - lastFullscreenAt < thresholds.resumeDelayMs) {
    return { hidden: true, reason: 'resume-delay' };
  }
  return { hidden: false, reason: 'not-fullscreen' };
}

module.exports = {
  APP_WIN_SCRIPT,
  SCREEN_BOUNDS_SCRIPT,
  DEFAULT_THRESHOLDS,
  runCommand,
  parseSizeTuple,
  parseBounds,
  createFullscreenProbe,
  decideHidden,
};
