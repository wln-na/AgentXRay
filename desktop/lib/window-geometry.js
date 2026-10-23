// 桌面宠物窗口几何：纯模块，便于在无 Electron GUI 的环境下验证边界规则。

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

module.exports = { verticalBounds };
