const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verticalBounds,
  horizontalBounds,
  clampToDisplay,
  clampAcrossDisplays,
  overlapArea,
} = require('../desktop/lib/window-geometry');

// 本机实测的显示器参数（MacBook 15" 默认缩放）：逻辑 1470×956、scaleFactor 2。
const PRIMARY = {
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  workArea: { x: 0, y: 38, width: 1470, height: 866 },
};
const PET = { w: 300, h: 128 };

test('允许窗口超出 work area 时，屏幕顶端边界应为 display bounds.y', () => {
  assert.deepEqual(
    verticalBounds({
      displayBounds: { y: 0, height: 956 },
      workArea: { y: 38, height: 868 },
      windowHeight: 128,
      allowLargerThanScreen: true,
    }),
    { min: 0, max: 828 }
  );
});

test('未允许超出 work area 时，保留菜单栏下沿作为边界', () => {
  assert.deepEqual(
    verticalBounds({
      displayBounds: { y: 0, height: 956 },
      workArea: { y: 38, height: 868 },
      windowHeight: 128,
      allowLargerThanScreen: false,
    }),
    { min: 38, max: 778 }
  );
});

test('水平范围 = 屏宽 − 窗宽（所以 1470 的屏上 x 上限是 1170）', () => {
  assert.deepEqual(horizontalBounds({ displayBounds: PRIMARY.bounds, windowWidth: 300 }), { min: 0, max: 1170 });
  // 副屏坐标不从 0 开始时，下限跟着屏的 x 走。
  assert.deepEqual(horizontalBounds({ displayBounds: { x: 1470, width: 1920 }, windowWidth: 300 }), {
    min: 1470,
    max: 3090,
  });
});

test('clampToDisplay：夹进单块屏（水平用 bounds，纵向可覆盖菜单栏）', () => {
  const base = {
    windowSize: PET,
    displayBounds: PRIMARY.bounds,
    workArea: PRIMARY.workArea,
    allowLargerThanScreen: true,
  };
  assert.deepEqual(clampToDisplay({ ...base, desired: { x: 5000, y: 5000 } }), { x: 1170, y: 828 });
  assert.deepEqual(clampToDisplay({ ...base, desired: { x: -100, y: -100 } }), { x: 0, y: 0 });
  assert.deepEqual(clampToDisplay({ ...base, desired: { x: 600, y: 300 } }), { x: 600, y: 300 });
});

test('只有一块屏时，跨屏仲裁与单屏夹紧结果一致（行为不回归）', () => {
  for (const desired of [
    { x: 5000, y: 5000 },
    { x: -999, y: 9999 },
    { x: 600, y: 300 },
  ]) {
    const single = clampToDisplay({
      desired,
      windowSize: PET,
      displayBounds: PRIMARY.bounds,
      workArea: PRIMARY.workArea,
      allowLargerThanScreen: true,
    });
    assert.deepEqual(
      clampAcrossDisplays({ desired, windowSize: PET, displays: [PRIMARY], allowLargerThanScreen: true }),
      single
    );
  }
});

test('并集内允许骑在两块屏中间（跨屏拖动不会被单屏边界卡住）', () => {
  const displays = [{ ...PRIMARY }, { bounds: { x: 1470, y: 0, width: 1920, height: 1080 } }];
  // 窗口 1320..1620：左 150px 在主屏、右 150px 在副屏，这是跨屏过程中的正常中间态。
  assert.deepEqual(clampAcrossDisplays({ desired: { x: 1320, y: 200 }, windowSize: PET, displays }), {
    x: 1320,
    y: 200,
  });
});

test('拖到两块屏的最右侧：夹在并集右边界，不会跑出桌面', () => {
  const displays = [{ ...PRIMARY }, { bounds: { x: 1470, y: 0, width: 1920, height: 1080 } }];
  const out = clampAcrossDisplays({ desired: { x: 9999, y: 200 }, windowSize: PET, displays });
  assert.equal(out.x, 1470 + 1920 - 300);
  // 副屏更高：纵向并集到 1080，窗口可落到副屏底部。
  assert.deepEqual(clampAcrossDisplays({ desired: { x: 2000, y: 9999 }, windowSize: PET, displays }), {
    x: 2000,
    y: 1080 - 128,
  });
});

test('L 形空隙（两块屏竖向不齐）：过半面积不在任何屏上时吸附回最近的屏', () => {
  // 主屏 0..956；副屏从 y=400 开始且更矮的一段区域里，x∈主屏、y>956 是「谁都不覆盖」的空隙。
  const displays = [{ ...PRIMARY }, { bounds: { x: 1470, y: 400, width: 1920, height: 1080 } }];
  const out = clampAcrossDisplays({
    desired: { x: 200, y: 1000 },
    windowSize: PET,
    displays,
    allowLargerThanScreen: true,
  });
  // 距离主屏最近（44px）→ 吸附回主屏底部，且完整落在主屏内。
  assert.deepEqual(out, { x: 200, y: 956 - 128 });
  assert.ok(
    overlapArea({ x: out.x, y: out.y, w: PET.w, h: PET.h }, PRIMARY.bounds) === PET.w * PET.h,
    '吸附后必须完整落在某块屏上'
  );
});

test('不开启 enableLargerThanScreen 时，吸附目标用 workArea（菜单栏下方）', () => {
  const displays = [{ ...PRIMARY }, { bounds: { x: 1470, y: 400, width: 1920, height: 1080 } }];
  const out = clampAcrossDisplays({ desired: { x: 200, y: 1000 }, windowSize: PET, displays });
  // 主屏 workArea = y 38 起、高 866 → 窗口顶边最多到 38 + 866 − 128 = 776。
  assert.equal(out.y, 776);
});

test('副屏位置重启后保留（不再被拉回主屏）', () => {
  const dual = [{ ...PRIMARY }, { bounds: { x: 1470, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(clampAcrossDisplays({ desired: { x: 2000, y: 300 }, windowSize: PET, displays: dual }), {
    x: 2000,
    y: 300,
  });
});

test('副屏被拔掉后，保存的副屏坐标会回到主屏内（不会隐身）', () => {
  assert.deepEqual(clampAcrossDisplays({ desired: { x: 2000, y: 300 }, windowSize: PET, displays: [PRIMARY] }), {
    x: 1170,
    y: 300,
  });
});

test('没有显示器信息/脏输入时不抛错', () => {
  assert.deepEqual(clampAcrossDisplays({ desired: { x: 12.4, y: 30.6 }, windowSize: PET, displays: [] }), {
    x: 12,
    y: 31,
  });
  assert.deepEqual(clampAcrossDisplays({}), { x: 0, y: 0 });
  assert.equal(overlapArea({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 100, width: 10, height: 10 }), 0);
});
