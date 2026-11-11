// 桌面宠物壳的可见性仲裁：纯模块，供 Electron 主进程调用。
//
// 宠物窗有两个**互不覆盖**的隐藏来源：
//   · userHidden       —— 用户主动收起（宠物上的隐藏按钮 / 托盘菜单 / 全局快捷键）
//   · fullscreenHidden —— 有 App 进入全屏（看视频、演示）时自动让位
//
// 语义：任一来源要求隐藏 → 隐藏；某个来源解除只解除自己那一票。这样「全屏退出」
// 不会把用户亲手藏起来的宠物抢回屏幕，「用户点显示」也不会在别人全屏时跳出来。
// 主进程只负责把结果应用到窗口（show/hide），不自己拼条件——条件全在这里，可单测。

/**
 * 组合两个隐藏来源，得出窗口最终是否可见。
 *
 * @param {object} [input]
 * @param {boolean} [input.userHidden]       用户主动隐藏
 * @param {boolean} [input.fullscreenHidden] 全屏自动隐藏
 * @returns {{visible: boolean, hidden: boolean, reason: 'none'|'user'|'fullscreen'|'user+fullscreen'}}
 */
function resolveVisibility(input) {
  const src = input && typeof input === 'object' ? input : {};
  const userHidden = src.userHidden === true;
  const fullscreenHidden = src.fullscreenHidden === true;
  const hidden = userHidden || fullscreenHidden;
  let reason = 'none';
  if (userHidden && fullscreenHidden) reason = 'user+fullscreen';
  else if (userHidden) reason = 'user';
  else if (fullscreenHidden) reason = 'fullscreen';
  return { visible: !hidden, hidden, reason };
}

/**
 * 用户「显示 / 隐藏」动作后的隐藏态。
 *
 * @param {boolean} currentHidden 当前是否由用户隐藏
 * @param {boolean} [explicitVisible] 给了布尔 = 直接设为「可见/隐藏」；省略 = 取反
 * @returns {boolean} 新的 userHidden
 */
function nextUserHidden(currentHidden, explicitVisible) {
  if (typeof explicitVisible === 'boolean') return !explicitVisible;
  return currentHidden !== true;
}

/**
 * 可见性变化是否需要真正调用窗口 show/hide（用于主进程去重）。
 *
 * @param {boolean} prevHidden 上一次实际应用的隐藏态
 * @param {boolean} hidden     本次算出的隐藏态
 * @returns {boolean}
 */
function needsApply(prevHidden, hidden) {
  return (prevHidden === true) !== (hidden === true);
}

module.exports = {
  resolveVisibility,
  nextUserHidden,
  needsApply,
};
