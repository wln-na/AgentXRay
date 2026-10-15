// 桌面宠物壳的看门狗（纯决策，无副作用）。
//
// 只做「该不该重启 / 该不该放弃」的判定，真正的 kill/spawn 由 main.js 执行：
// main.js 在 action==='restart' 时 await sleep(nextBackoffMs) 后再重启，并在
// 成功观测到 liveness 后把 restartCount 归零。
//
// 本文件是【纯模块】：时间戳、阈值全部由调用方注入，可被根 `node --test` 覆盖全分支。

const DEFAULT_THRESHOLDS = Object.freeze({
  // 超过此时长无 liveness → 视为假死。
  stallMs: 20000,
  // 首次启动宽限：startedAt 起算，期内且未观测到 liveness 不判定（见规则 1）。
  startupGraceMs: 8000,
  // 超过则 giveup，避免无限重启风暴。
  maxRestarts: 5,
  backoffBaseMs: 1000,
  backoffMaxMs: 30000,
});

function clampThresholds(override) {
  return { ...DEFAULT_THRESHOLDS, ...(override || {}) };
}

function backoffFor(thresholds, restartCount) {
  return Math.min(thresholds.backoffMaxMs, thresholds.backoffBaseMs * 2 ** restartCount);
}

/**
 * 纯决策函数。规则顺序即优先级（见 docs/pet-shell-design.md §3.2 表格），勿重排。
 *
 * @param {object} input
 * @param {number} input.now              当前 epoch ms
 * @param {number|null} input.lastLivenessAt 最近一次「后端存活」证据时间（unknown → null）
 * @param {boolean} input.childAlive      被监督子进程是否仍在运行（external 模式恒 true）
 * @param {number} input.restartCount     本会话内已重启次数
 * @param {number|null} [input.startedAt] 本轮看门狗会话启动的 epoch ms（未提供/null = 无启动时刻）
 * @param {object} [input.thresholds]     覆盖 stallMs/startupGraceMs/maxRestarts/backoff*
 * @returns {{action: 'ok'|'restart'|'giveup', reason: string, nextBackoffMs?: number}}
 */
function decideWatchdog(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const lastLivenessAt = Number.isFinite(input.lastLivenessAt) ? input.lastLivenessAt : null;
  const childAlive = !!input.childAlive;
  const restartCount = Number.isFinite(input.restartCount) ? input.restartCount : 0;
  const startedAt = Number.isFinite(input.startedAt) ? input.startedAt : null;
  const thresholds = clampThresholds(input.thresholds);

  // 规则 1：启动宽限——子进程存活 + 从未观测到 liveness + 有启动时刻 + 仍在宽限窗口内。
  // 三条件与：缺 startedAt 时宽限不生效（避免「无启动时刻」被当成永久宽限，从而永不重启）。
  if (childAlive && lastLivenessAt === null && startedAt !== null && now - startedAt <= thresholds.startupGraceMs) {
    return { action: 'ok', reason: 'startup-grace' };
  }

  // 规则 2：子进程存活且 liveness 新鲜 → 健康。
  if (childAlive && lastLivenessAt !== null && now - lastLivenessAt <= thresholds.stallMs) {
    return { action: 'ok', reason: 'healthy' };
  }

  // 规则 3：子进程已退出且已达重启上限 → 放弃。
  if (!childAlive && restartCount >= thresholds.maxRestarts) {
    return { action: 'giveup', reason: 'max-restarts' };
  }

  // 规则 4：子进程已退出 → 重启。
  // 注意：即便 lastLivenessAt 仍为 null（启动即崩，从未产生 liveness）也必须落到这里，
  // 否则「首次 liveness 之前的崩溃」会永久静默。
  if (!childAlive) {
    return { action: 'restart', reason: 'child-exited', nextBackoffMs: backoffFor(thresholds, restartCount) };
  }

  // 至此 childAlive === true 但 liveness 过期（null 或超过 stallMs）。
  // startedAt === null 时 lastLivenessAt === null 视为 liveness 过期（external 模式后端不可达
  // 不会永远静默）。
  const stalled = lastLivenessAt === null || now - lastLivenessAt > thresholds.stallMs;

  // 规则 5：存活但假死且已达重启上限 → 放弃。
  if (stalled && restartCount >= thresholds.maxRestarts) {
    return { action: 'giveup', reason: 'max-restarts' };
  }

  // 规则 6：存活但假死 → 重启。
  if (stalled) {
    return { action: 'restart', reason: 'hung', nextBackoffMs: backoffFor(thresholds, restartCount) };
  }

  // 规则 7：其余 → 健康。
  return { action: 'ok', reason: 'healthy' };
}

module.exports = { decideWatchdog, DEFAULT_THRESHOLDS };
