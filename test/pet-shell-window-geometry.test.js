const test = require('node:test');
const assert = require('node:assert/strict');

const { verticalBounds } = require('../desktop/lib/window-geometry');

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
