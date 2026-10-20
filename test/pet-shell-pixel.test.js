// 桌面宠物壳内置像素动画单测：PALETTE 覆盖 6 态、buildFrame 各态帧规范、hotZone 命中。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const config = require(path.join(__dirname, '..', 'desktop', 'lib', 'config'));
const pixel = require(path.join(__dirname, '..', 'desktop', 'lib', 'pixel'));
const { PALETTE, buildFrame, hotZone } = pixel;

test('PALETTE 覆盖 PET_STATES 全部 6 个 state（缺一即失败）', () => {
  for (const state of config.PET_STATES) {
    assert.ok(PALETTE[state], `PALETTE 缺少 state：${state}`);
    for (const key of ['base', 'accent', 'eye', 'mood']) {
      assert.equal(typeof PALETTE[state][key], 'string', `${state}.${key} 必须是颜色字符串`);
      assert.match(PALETTE[state][key], /^#[0-9a-fA-F]{6}$/);
    }
  }
  assert.equal(Object.keys(PALETTE).length, 6);
});

test('buildFrame 对每个 state 都产出 cells/hitCells/bubbleAnchor/bounceY/pulse', () => {
  for (const state of config.PET_STATES) {
    const frame = buildFrame({ state, elapsedMs: 123 });
    assert.ok(Array.isArray(frame.cells) && frame.cells.length > 0, `${state} cells 为空`);
    assert.ok(Array.isArray(frame.hitCells) && frame.hitCells.length > 0, `${state} hitCells 为空`);
    assert.ok(Number.isFinite(frame.bubbleAnchor.x) && Number.isFinite(frame.bubbleAnchor.y));
    assert.equal(typeof frame.bounceY, 'number');
    assert.equal(typeof frame.pulse, 'boolean');
    for (const c of frame.cells) {
      assert.equal(typeof c.x, 'number');
      assert.equal(typeof c.y, 'number');
      assert.ok(c.w > 0 && c.h > 0);
      assert.match(c.color, /^#[0-9a-fA-F]{6}$/);
    }
  }
});

test('buildFrame：pulse 只在 waiting_input / error 为 true', () => {
  assert.equal(buildFrame({ state: 'waiting_input', elapsedMs: 0 }).pulse, true);
  assert.equal(buildFrame({ state: 'error', elapsedMs: 0 }).pulse, true);
  for (const state of ['idle', 'thinking', 'working', 'done']) {
    assert.equal(buildFrame({ state, elapsedMs: 0 }).pulse, false, `${state} 不应 pulse`);
  }
});

test('buildFrame：waiting_input 弹跳幅度大于 idle 呼吸', () => {
  let maxIdle = 0;
  let maxWait = 0;
  for (let t = 0; t < 2000; t += 25) {
    maxIdle = Math.max(maxIdle, Math.abs(buildFrame({ state: 'idle', elapsedMs: t }).bounceY));
    maxWait = Math.max(maxWait, Math.abs(buildFrame({ state: 'waiting_input', elapsedMs: t }).bounceY));
  }
  assert.ok(maxIdle <= 1.001, `idle 呼吸应 ≤1px，实际 ${maxIdle}`);
  assert.ok(maxWait > 3, `waiting_input 弹跳应明显，实际 ${maxWait}`);
});

test('buildFrame：error 会左右抖动（cell x 发生变化）', () => {
  const a = buildFrame({ state: 'error', elapsedMs: 0 });
  const b = buildFrame({ state: 'error', elapsedMs: 90 });
  const xsA = a.hitCells.map((c) => c.x).join(',');
  const xsB = b.hitCells.map((c) => c.x).join(',');
  assert.notEqual(xsA, xsB);
});

test('buildFrame：未知 / 缺省 state 回退 idle 且不抛', () => {
  const unknown = buildFrame({ state: 'nope', elapsedMs: 0 });
  assert.equal(unknown.state, 'idle');
  const none = buildFrame({});
  assert.equal(none.state, 'idle');
  assert.ok(none.cells.length > 0);
});

test('hotZone：宠物本体内部命中、远处不命中', () => {
  const frame = buildFrame({ state: 'idle', elapsedMs: 0 });
  const cell = 4;
  // 身体中心 (≈8,8) → 像素 (32,32)。bounceY 极小，仍应命中。
  assert.equal(hotZone(frame, { pointer: { x: 32, y: 32 }, cell, pad: 0 }), true);
  // 远离宠物（画布左上角）。
  assert.equal(hotZone(frame, { pointer: { x: 0, y: 0 }, cell, pad: 0 }), false);
});

test('hotZone：pad 外扩使边缘外仍可命中；非法输入返回 false', () => {
  const frame = buildFrame({ state: 'idle', elapsedMs: 0 });
  const cell = 4;
  // 身体右边界外 2 个逻辑格 → 像素 8px；pad=8 时应命中，pad=0 时不应命中。
  const edgeX = (12 + 2) * cell;
  const edgeY = 8 * cell;
  assert.equal(hotZone(frame, { pointer: { x: edgeX, y: edgeY }, cell, pad: 0 }), false);
  assert.equal(hotZone(frame, { pointer: { x: edgeX, y: edgeY }, cell, pad: 8 }), true);

  assert.equal(hotZone(null, { pointer: { x: 1, y: 1 } }), false);
  assert.equal(hotZone(frame, { pointer: null }), false);
  assert.equal(hotZone(frame, { pointer: { x: Number.NaN, y: 0 } }), false);
});
