// 桌面宠物窗口几何：纯模块，便于在无 Electron GUI 的环境下验证边界规则。
//
// 三个层次：
//   · horizontalBounds / verticalBounds —— 单块屏上、某个宽/高的窗口允许的坐标范围
//   · clampToDisplay                    —— 把期望位置夹进「这一块屏」
//   · clampAcrossDisplays               —— 多显示器仲裁：允许骑缝/跨屏拖动，但不许掉进
//                                          所有屏都不覆盖的 L 形空隙里「隐身」

function clamp(value, min, max) {
  const v = Number.isFinite(value) ? value : min;
  return Math.min(Math.max(v, min), Math.max(min, max));
}

/**
 * 计算窗口允许使用的垂直范围。
 * macOS 默认把窗口限制在 workArea 内（通常从菜单栏下沿开始）；开启
 * enableLargerThanScreen 后，窗口可覆盖屏幕顶部和底部的非 work area。
 *
 * @param {{displayBounds: {y: number, height: number}, workArea: {y: number, height: number}, windowHeight: number, allowLargerThanScreen?: boolean}} input
 * @returns {{min: number, max: number}}
 */
function verticalBounds(input) {
  const displayBounds = input?.displayBounds || {};
  const workArea = input?.workArea || {};
  const windowHeight = Number.isFinite(input?.windowHeight) ? input.windowHeight : 0;
  const allowLargerThanScreen = input?.allowLargerThanScreen === true;
  const area = allowLargerThanScreen ? displayBounds : workArea;
  const y = Number.isFinite(area.y) ? area.y : 0;
  const height = Number.isFinite(area.height) ? area.height : 0;
  return { min: y, max: Math.max(y, y + height - windowHeight) };
}

/**
 * 计算窗口允许使用的水平范围。
 * 水平方向始终按屏幕物理 bounds 算：宠物允许盖住左右两侧的 Dock（与纵向允许覆盖菜单栏一致）。
 *
 * @param {{displayBounds: {x: number, width: number}, windowWidth: number}} input
 * @returns {{min: number, max: number}}
 */
function horizontalBounds(input) {
  const displayBounds = input?.displayBounds || {};
  const windowWidth = Number.isFinite(input?.windowWidth) ? input.windowWidth : 0;
  const x = Number.isFinite(displayBounds.x) ? displayBounds.x : 0;
  const width = Number.isFinite(displayBounds.width) ? displayBounds.width : 0;
  return { min: x, max: Math.max(x, x + width - windowWidth) };
}

/**
 * 把期望位置夹进**单块**屏允许的范围。
 *
 * @param {{desired: {x: number, y: number}, windowSize: {w: number, h: number}, displayBounds: object, workArea: object, allowLargerThanScreen?: boolean}} input
 * @returns {{x: number, y: number}}
 */
function clampToDisplay(input = {}) {
  const desired = input.desired || {};
  const size = input.windowSize || {};
  const hb = horizontalBounds({ displayBounds: input.displayBounds, windowWidth: size.w });
  const vb = verticalBounds({
    displayBounds: input.displayBounds,
    workArea: input.workArea || input.displayBounds,
    windowHeight: size.h,
    allowLargerThanScreen: input.allowLargerThanScreen === true,
  });
  return {
    x: Math.round(clamp(desired.x, hb.min, hb.max)),
    y: Math.round(clamp(desired.y, vb.min, vb.max)),
  };
}

/** 矩形与屏幕 bounds 的重叠面积（像素²）。 */
function overlapArea(rect, bounds) {
  const w = Math.max(0, Math.min(rect.x + rect.w, bounds.x + bounds.width) - Math.max(rect.x, bounds.x));
  const h = Math.max(0, Math.min(rect.y + rect.h, bounds.y + bounds.height) - Math.max(rect.y, bounds.y));
  return w * h;
}

/** 矩形到屏幕 bounds 的最短距离（相交则为 0）。 */
function rectDistance(rect, bounds) {
  const dx = Math.max(bounds.x - (rect.x + rect.w), rect.x - (bounds.x + bounds.width), 0);
  const dy = Math.max(bounds.y - (rect.y + rect.h), rect.y - (bounds.y + bounds.height), 0);
  return Math.hypot(dx, dy);
}

const DEFAULT_MIN_VISIBLE_RATIO = 0.5;

/**
 * 多显示器仲裁：把期望位置夹成一个「用户还能看见宠物」的位置。
 *
 * 规则（顺序执行）：
 * 1. **并集夹紧**——所有屏 bounds 的并集矩形内夹紧。允许窗口骑在两块屏中间，
 *    所以跨屏拖动是连续的，不会在半路被单块屏的边界卡住；
 * 2. **可见面积校验**——窗口至少要有一半面积落在某块屏上；否则（竖向不齐、L 形摆位
 *    产生的空隙）退回离它最近的那块屏里，避免宠物被拖到「哪块屏都不显示」的地方。
 *
 * @param {object} input
 * @param {{x: number, y: number}} input.desired   期望位置（当前拖动目标）
 * @param {{w: number, h: number}} input.windowSize
 * @param {Array<{bounds: object, workArea?: object}>} input.displays
 * @param {number} [input.minVisibleRatio] 至少多少比例的面积要落在某块屏上（默认 0.5）
 * @returns {{x: number, y: number}}
 */
function clampAcrossDisplays(input = {}) {
  const desired = input.desired || {};
  const size = input.windowSize || {};
  const w = Number.isFinite(size.w) ? size.w : 0;
  const h = Number.isFinite(size.h) ? size.h : 0;
  const minVisibleRatio = Number.isFinite(input.minVisibleRatio) ? input.minVisibleRatio : DEFAULT_MIN_VISIBLE_RATIO;
  const displays = (Array.isArray(input.displays) ? input.displays : []).filter(
    (d) => d?.bounds && Number.isFinite(d.bounds.x) && Number.isFinite(d.bounds.y)
  );
  const x0 = Number.isFinite(desired.x) ? desired.x : 0;
  const y0 = Number.isFinite(desired.y) ? desired.y : 0;
  if (!displays.length) return { x: Math.round(x0), y: Math.round(y0) };

  // 1) 并集夹紧。水平一律用 bounds；纵向按 allowLargerThanScreen 决定能否覆盖菜单栏。
  const useBounds = input.allowLargerThanScreen === true;
  const verticalArea = (d) => {
    if (useBounds) return d.bounds;
    const area = d.workArea;
    return area && Number.isFinite(area.height) && area.height > 0 ? area : d.bounds;
  };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const d of displays) {
    const b = d.bounds;
    const v = verticalArea(d);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, v.y + v.height);
  }
  const x = Math.round(clamp(x0, minX, maxX - w));
  const y = Math.round(clamp(y0, minY, maxY - h));
  const rect = { x, y, w, h };

  // 2) 可见面积校验：过半面积必须落在某块屏上，否则吸附回最近的屏。
  const area = w * h;
  const bestOverlap = displays.reduce((best, d) => Math.max(best, overlapArea(rect, d.bounds)), 0);
  if (area > 0 && bestOverlap >= area * minVisibleRatio) return { x, y };
  const nearest = displays.reduce(
    (best, d) => (rectDistance(rect, d.bounds) < rectDistance(rect, best.bounds) ? d : best),
    displays[0]
  );
  return clampToDisplay({
    desired: { x, y },
    windowSize: { w, h },
    displayBounds: nearest.bounds,
    workArea: nearest.workArea,
    allowLargerThanScreen: input.allowLargerThanScreen === true,
  });
}

module.exports = {
  verticalBounds,
  horizontalBounds,
  clampToDisplay,
  clampAcrossDisplays,
  overlapArea,
  rectDistance,
};
