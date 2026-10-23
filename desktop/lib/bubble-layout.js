// 桌宠气泡布局：纯模块，供 Electron 主进程与 renderer 复用同一套尺寸规则。

((root, factory) => {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PetBubbleLayout = factory();
  }
})(globalThis, () => {
  const BUBBLE_LAYOUT = Object.freeze({
    titleFontSize: 13,
    subtitleFontSize: 12,
    cardHeight: 48,
    expandedCardGap: 12,
    collapsedStackStep: 20,
    maxCollapsed: 3,
    maxExpanded: 5,
    paddingX: 10,
    titleTextY: 15,
    subtitleTextY: 34,
    badgeRadius: 9,
    badgeOffsetX: 34,
    badgeFootOffsetY: 14,
    expandButtonRadius: 13,
    badgeButtonGap: 2,
    bubbleAnchorGap: 6,
    bubbleEdgeMargin: 4,
  });

  /**
   * 活跃会话徽标的中心点：固定挂在宠物脚边右侧，向下气泡模式下跟随宠物到窗口顶部。
   *
   * @param {{width: number, petHeight: number, height: number, bubbleBelow?: boolean}} input
   * @returns {{x: number, y: number}}
   */
  function badgeCenter(input) {
    const width = Number.isFinite(input?.width) ? input.width : 300;
    const petHeight = Number.isFinite(input?.petHeight) ? input.petHeight : 128;
    const height = Number.isFinite(input?.height) ? input.height : petHeight;
    const bubbleBelow = input?.bubbleBelow === true;
    const scale = Math.min(width, petHeight) / 160;
    const footY = bubbleBelow ? petHeight : height;
    return {
      x: Math.round(width / 2 + BUBBLE_LAYOUT.badgeOffsetX * scale),
      y: Math.round(footY - BUBBLE_LAYOUT.badgeFootOffsetY),
    };
  }

  /**
   * 展开按钮中心点：紧贴徽标右侧，与徽标同一水平中心。
   *
   * @param {{badgeCenter: {x: number, y: number}}} input
   * @returns {{x: number, y: number}}
   */
  function expandButtonCenter(input) {
    const badge = input?.badgeCenter || { x: 0, y: 0 };
    return {
      x: Math.round(
        badge.x + BUBBLE_LAYOUT.badgeRadius + BUBBLE_LAYOUT.expandButtonRadius + BUBBLE_LAYOUT.badgeButtonGap
      ),
      y: badge.y,
    };
  }

  /**
   * 计算一张气泡卡片的 top y。
   * 向上模式：卡片底边距宠物头顶 6px；向下模式：卡片顶边距宠物脚底 6px。
   * nearOffset = 距宠物最近的一端向外数第几层（0 = 最新会话，离宠物最近）。
   *
   * @param {object} input
   * @returns {number}
   */
  function bubbleStackY(input) {
    const bubbleBelow = input?.bubbleBelow === true;
    const cardHeight = Number.isFinite(input?.cardHeight) ? input.cardHeight : BUBBLE_LAYOUT.cardHeight;
    const step = Number.isFinite(input?.step) ? input.step : BUBBLE_LAYOUT.collapsedStackStep;
    const index = Number.isFinite(input?.index) ? input.index : 0;
    const listLength = Number.isFinite(input?.listLength) ? input.listLength : index + 1;
    const nearOffset = Math.max(0, listLength - 1 - index);
    const gap = BUBBLE_LAYOUT.bubbleAnchorGap;
    const edge = BUBBLE_LAYOUT.bubbleEdgeMargin;

    if (bubbleBelow) {
      const petAnchorBelow = Number.isFinite(input?.petAnchorBelow) ? input.petAnchorBelow : 0;
      const height = Number.isFinite(input?.height) ? input.height : petAnchorBelow + cardHeight;
      return Math.min(height - cardHeight - edge, petAnchorBelow + gap + nearOffset * step);
    }

    const anchorY = Number.isFinite(input?.anchorY) ? input.anchorY : null;
    if (anchorY === null) {
      return Math.max(edge, 8 + index * step);
    }
    return Math.max(edge, anchorY - gap - cardHeight - nearOffset * step);
  }

  /**
   * 展开态窗口高度 = 宠物壳高度 + 宠物头顶间距 + 5 张卡片 + 4 个间距 + 顶部余量。
   *
   * @param {{petHeight: number}} input
   * @returns {number}
   */
  function expandedWindowHeight(input) {
    const petHeight = Number.isFinite(input?.petHeight) ? input.petHeight : 128;
    const cardsHeight = BUBBLE_LAYOUT.maxExpanded * BUBBLE_LAYOUT.cardHeight;
    const gapsHeight = (BUBBLE_LAYOUT.maxExpanded - 1) * BUBBLE_LAYOUT.expandedCardGap;
    return petHeight + 6 + cardsHeight + gapsHeight + 8;
  }

  return { BUBBLE_LAYOUT, expandedWindowHeight, badgeCenter, expandButtonCenter, bubbleStackY };
});
