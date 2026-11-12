// 30 秒共享时钟：状态推导依赖「现在」，但侧栏卡片、看板、详情头各有各的
// setInterval 时会各算各的，边界上的会话可能一块显示「进行中」、另一块显示
// 「已完成」。这里用一个模块级定时器 + 订阅表，所有消费方拿到同一个 now。

import { useEffect, useState } from 'react';

const TICK_MS = 30_000;

const listeners = new Set<(now: number) => void>();
let current = Date.now();
let timer: number | null = null;

function ensureTimer(): void {
  if (timer !== null) return;
  current = Date.now();
  timer = window.setInterval(() => {
    current = Date.now();
    for (const listener of listeners) listener(current);
  }, TICK_MS);
}

function releaseTimer(): void {
  if (timer === null || listeners.size > 0) return;
  window.clearInterval(timer);
  timer = null;
}

/** 所有调用方在同一个 30 秒边界上一起刷新，取到同一个时间戳。 */
export function useSharedClock(): number {
  const [now, setNow] = useState(current);
  useEffect(() => {
    current = Date.now();
    setNow(current);
    const listener = (next: number) => setNow(next);
    listeners.add(listener);
    ensureTimer();
    return () => {
      listeners.delete(listener);
      releaseTimer();
    };
  }, []);
  return now;
}
