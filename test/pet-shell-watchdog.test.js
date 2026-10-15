// 桌面宠物壳看门狗纯决策单测：覆盖 §3.2 表格全部 7 条规则。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { decideWatchdog, DEFAULT_THRESHOLDS } = require(path.join(__dirname, '..', 'desktop', 'lib', 'watchdog'));

test('规则 1：启动宽限（存活 + 无 liveness + 有 startedAt 且在窗口内）→ ok/startup-grace', () => {
  const r = decideWatchdog({ now: 1000, lastLivenessAt: null, childAlive: true, restartCount: 0, startedAt: 200 });
  assert.deepEqual(r, { action: 'ok', reason: 'startup-grace' });
});

test('回归 (b)：存活 + 无 liveness + startedAt 1s 前 → ok/startup-grace', () => {
  const t = 1_000_000;
  const r = decideWatchdog({ now: t, lastLivenessAt: null, childAlive: true, restartCount: 0, startedAt: t - 1000 });
  assert.deepEqual(r, { action: 'ok', reason: 'startup-grace' });
});

test('回归 (a)：子进程启动即崩（childAlive:false + 无 liveness + 有 startedAt）→ restart/child-exited', () => {
  const t = 1_000_000;
  const r = decideWatchdog({ now: t, lastLivenessAt: null, childAlive: false, restartCount: 0, startedAt: t });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'child-exited');
  assert.equal(r.nextBackoffMs, 1000);
});

test('回归 (c)：存活 + 无 liveness + 宽限已过期（20s）→ restart/hung', () => {
  const t = 1_000_000;
  const r = decideWatchdog({ now: t, lastLivenessAt: null, childAlive: true, restartCount: 0, startedAt: t - 20000 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'hung');
});

test('回归 (d)：存活 + 无 liveness + startedAt=null（无启动时刻）→ 宽限不生效，restart/hung', () => {
  const r = decideWatchdog({
    now: 1_000_000,
    lastLivenessAt: null,
    childAlive: true,
    restartCount: 0,
    startedAt: null,
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'hung');
});

test('规则 2：存活且 liveness 新鲜 → ok/healthy（含边界 stallMs）', () => {
  const r = decideWatchdog({ now: 100000, lastLivenessAt: 99000, childAlive: true, restartCount: 0 });
  assert.deepEqual(r, { action: 'ok', reason: 'healthy' });
  // 恰好等于 stallMs（默认 20000）仍算健康（<=）。
  const edge = decideWatchdog({ now: 120000, lastLivenessAt: 100000, childAlive: true, restartCount: 0 });
  assert.equal(edge.action, 'ok');
  assert.equal(edge.reason, 'healthy');
});

test('规则 4：子进程退出 → restart/child-exited + 退避', () => {
  const r = decideWatchdog({ now: 100000, lastLivenessAt: 99999, childAlive: false, restartCount: 0 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'child-exited');
  assert.equal(r.nextBackoffMs, 1000);
});

test('规则 3：子进程退出且达重启上限 → giveup/max-restarts', () => {
  const r = decideWatchdog({ now: 100000, lastLivenessAt: 99999, childAlive: false, restartCount: 5 });
  assert.deepEqual(r, { action: 'giveup', reason: 'max-restarts' });
});

test('规则 6：存活但假死 → restart/hung + 指数退避', () => {
  const r = decideWatchdog({ now: 100000, lastLivenessAt: 1000, childAlive: true, restartCount: 1 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'hung');
  assert.equal(r.nextBackoffMs, 2000); // 1000 * 2^1
});

test('规则 6 边界：超过 stallMs 一格即判假死', () => {
  const r = decideWatchdog({ now: 120001, lastLivenessAt: 100000, childAlive: true, restartCount: 0 });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'hung');
});

test('规则 5：存活但假死且达重启上限 → giveup/max-restarts', () => {
  const r = decideWatchdog({ now: 100000, lastLivenessAt: 1000, childAlive: true, restartCount: 5 });
  assert.deepEqual(r, { action: 'giveup', reason: 'max-restarts' });
});

test('重启过后 liveness 仍为 null（存活，有 startedAt 但已过期）→ 判假死重启', () => {
  const t = 100000;
  const r = decideWatchdog({
    now: t,
    lastLivenessAt: null,
    childAlive: true,
    restartCount: 2,
    startedAt: t - 30000, // 宽限（8s）已过期
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'hung');
});

test('规则 7：其余情况 → ok/healthy（自定义阈值）', () => {
  const r = decideWatchdog({
    now: 100000,
    lastLivenessAt: 99000,
    childAlive: true,
    restartCount: 0,
    thresholds: { stallMs: 60000 },
  });
  assert.equal(r.reason, 'healthy');
});

test('退避封顶于 backoffMaxMs', () => {
  const r = decideWatchdog({
    now: 100000,
    lastLivenessAt: 99999,
    childAlive: false,
    restartCount: 10,
    thresholds: { maxRestarts: 20, backoffBaseMs: 1000, backoffMaxMs: 30000 },
  });
  assert.equal(r.action, 'restart');
  assert.equal(r.nextBackoffMs, 30000);
});

test('缺省入参容错：非法 now/lastLivenessAt 不抛（childAlive 缺省=false → child-exited）', () => {
  const r = decideWatchdog({});
  assert.equal(r.action, 'restart');
  assert.equal(r.reason, 'child-exited');
  assert.equal(DEFAULT_THRESHOLDS.maxRestarts, 5);
});
