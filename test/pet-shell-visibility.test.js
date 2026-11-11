// 桌面宠物壳「显示/隐藏」仲裁单测：用户隐藏 × 全屏自动隐藏组合、动作语义、去重。
// 纯 Node——不 require electron，不碰真实桌面。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveVisibility, nextUserHidden, needsApply } = require(
  path.join(__dirname, '..', 'desktop', 'lib', 'visibility')
);

test('两个隐藏来源任一为真 → 不可见，并给出可读 reason', () => {
  assert.deepEqual(resolveVisibility({}), { visible: true, hidden: false, reason: 'none' });
  assert.deepEqual(resolveVisibility({ userHidden: true }), { visible: false, hidden: true, reason: 'user' });
  assert.deepEqual(resolveVisibility({ fullscreenHidden: true }), {
    visible: false,
    hidden: true,
    reason: 'fullscreen',
  });
  assert.deepEqual(resolveVisibility({ userHidden: true, fullscreenHidden: true }), {
    visible: false,
    hidden: true,
    reason: 'user+fullscreen',
  });
});

test('只认严格布尔：字符串/数字等脏值不得把宠物藏起来', () => {
  assert.equal(resolveVisibility({ userHidden: 'true' }).visible, true);
  assert.equal(resolveVisibility({ userHidden: 1 }).visible, true);
  assert.equal(resolveVisibility({ fullscreenHidden: 'yes' }).visible, true);
  assert.equal(resolveVisibility(null).visible, true);
  assert.equal(resolveVisibility(undefined).visible, true);
});

test('退出全屏不会抢回用户主动收起的宠物（反之亦然）', () => {
  // 用户先收起，随后 App 进全屏、再退出：用户那一票仍然有效。
  let state = { userHidden: true, fullscreenHidden: false };
  assert.equal(resolveVisibility(state).visible, false);
  state = { userHidden: true, fullscreenHidden: true };
  assert.equal(resolveVisibility(state).visible, false);
  state = { userHidden: true, fullscreenHidden: false };
  assert.equal(resolveVisibility(state).visible, false, '全屏退出后仍保持用户隐藏');

  // 反向：全屏期间点「显示」，全屏还在 → 仍然不可见；退出全屏才出现。
  assert.equal(resolveVisibility({ userHidden: false, fullscreenHidden: true }).visible, false);
  assert.equal(resolveVisibility({ userHidden: false, fullscreenHidden: false }).visible, true);
});

test('nextUserHidden：省略参数为取反，布尔参数为直接设置', () => {
  assert.equal(nextUserHidden(false), true);
  assert.equal(nextUserHidden(true), false);
  assert.equal(nextUserHidden(false, false), true, '显式隐藏');
  assert.equal(nextUserHidden(true, true), false, '显式显示');
  assert.equal(nextUserHidden(undefined), true, '脏值按未隐藏处理');
  assert.equal(nextUserHidden('x'), true);
});

test('needsApply：隐藏态没变就不重复 show/hide（避免窗口闪烁）', () => {
  assert.equal(needsApply(false, false), false);
  assert.equal(needsApply(true, true), false);
  assert.equal(needsApply(false, true), true);
  assert.equal(needsApply(true, false), true);
});

test('完整切换序列：隐藏 → 全屏 → 退出全屏 → 显示', () => {
  let userHidden = false;
  let fullscreenHidden = false;
  const applied = [];
  let appliedHidden = false;
  const sync = () => {
    const { hidden } = resolveVisibility({ userHidden, fullscreenHidden });
    if (needsApply(appliedHidden, hidden)) {
      appliedHidden = hidden;
      applied.push(hidden);
    }
  };

  userHidden = nextUserHidden(userHidden); // 点隐藏按钮
  sync();
  fullscreenHidden = true; // 进全屏
  sync();
  fullscreenHidden = false; // 退出全屏
  sync();
  assert.deepEqual(applied, [true], '整个过程中窗口只隐藏一次，不出现「退出全屏又冒出来」');

  userHidden = nextUserHidden(userHidden, true); // 托盘「显示宠物」
  sync();
  assert.deepEqual(applied, [true, false]);
  assert.equal(resolveVisibility({ userHidden, fullscreenHidden }).visible, true);
});
