const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUBBLE_LAYOUT,
  expandedWindowHeight,
  badgeCenter,
  expandButtonCenter,
  hideButtonCenter,
  circleRect,
  bubbleStackY,
  dismissButtonRect,
} = require('../desktop/lib/bubble-layout');

test('气泡文字使用易读字号，并同步放大卡片布局', () => {
  assert.equal(BUBBLE_LAYOUT.titleFontSize, 13);
  assert.equal(BUBBLE_LAYOUT.subtitleFontSize, 12);
  assert.equal(BUBBLE_LAYOUT.cardHeight, 48);
  assert.equal(BUBBLE_LAYOUT.expandedCardGap, 12);
});

test('展开窗口高度可容纳 5 张放大后的卡片', () => {
  assert.equal(expandedWindowHeight({ petHeight: 128 }), 430);
});

test('活跃会话徽标锚定在宠物脚边右侧，且向下气泡模式跟随宠物到窗口顶部', () => {
  assert.deepEqual(badgeCenter({ width: 300, petHeight: 128, height: 128, bubbleBelow: false }), {
    x: 177,
    y: 114,
  });
  assert.deepEqual(badgeCenter({ width: 300, petHeight: 128, height: 430, bubbleBelow: true }), {
    x: 177,
    y: 114,
  });
});

test('展开按钮紧贴在徽标右侧，保持同一水平中心', () => {
  assert.deepEqual(expandButtonCenter({ badgeCenter: { x: 177, y: 114 } }), {
    x: 201,
    y: 114,
  });
});

test('向下气泡模式的卡片顶端距宠物脚底固定 6px，而不是被卡片高度撑远', () => {
  assert.equal(
    bubbleStackY({
      bubbleBelow: true,
      petAnchorBelow: 116,
      height: 430,
      cardHeight: 48,
      step: 20,
      index: 0,
      listLength: 1,
    }),
    122
  );
});

test('向上气泡模式的卡片底边距宠物头顶固定 6px', () => {
  assert.equal(
    bubbleStackY({
      bubbleBelow: false,
      anchorY: 318,
      height: 430,
      cardHeight: 48,
      step: 20,
      index: 0,
      listLength: 1,
    }),
    264
  );
});

test('忽略按钮锚定卡片右侧边缘垂直居中，并落在卡片命中区内', () => {
  const card = { x: 10, y: 20, w: 280, h: 48 };
  const b = dismissButtonRect(card);
  assert.equal(b.r, BUBBLE_LAYOUT.dismissButtonRadius);
  // 水平中心贴近右边缘（留 margin），垂直中心即卡片中心
  assert.equal(b.cx, card.x + card.w - b.r - BUBBLE_LAYOUT.dismissButtonMargin);
  assert.equal(b.cy, card.y + card.h / 2);
  // 命中矩形完整包住按钮且不越出卡片
  assert.equal(b.x, b.cx - b.r);
  assert.equal(b.w, b.r * 2);
  assert.ok(b.x >= card.x && b.x + b.w <= card.x + card.w, 'button stays inside the card');
  assert.ok(b.y >= card.y && b.y + b.h <= card.y + card.h, 'button stays inside the card vertically');
});

test('隐藏按钮与活跃徽标左右对称挂在宠物脚边', () => {
  const geom = { width: 300, petHeight: 128, height: 128, bubbleBelow: false };
  const badge = badgeCenter(geom);
  const hide = hideButtonCenter(geom);
  assert.equal(hide.y, badge.y);
  assert.equal(hide.x + badge.x, 300, '两侧按钮关于窗口中线对称');
  assert.ok(hide.x < geom.width / 2, '隐藏按钮在宠物左侧');
});

test('向下气泡模式下隐藏按钮跟随宠物贴到窗口顶部', () => {
  const geom = { width: 300, petHeight: 128, height: 430, bubbleBelow: true };
  assert.deepEqual(hideButtonCenter(geom), hideButtonCenter({ ...geom, height: 128, bubbleBelow: false }));
  assert.ok(hideButtonCenter(geom).y < 430 - 100, '按钮贴在宠物脚边，而不是展开窗底部');
});

test('circleRect 生成以中心点为中心的方形命中区，非法半径退化为零面积', () => {
  assert.deepEqual(circleRect({ x: 100, y: 50 }, 11), { x: 89, y: 39, w: 22, h: 22 });
  assert.deepEqual(circleRect({ x: 0, y: 0 }, -3), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(circleRect(null, 5), { x: -5, y: -5, w: 10, h: 10 });
});
