// 会话事实的单一来源。
//
// 侧栏卡片、看板卡片、会话详情头、本会话分析都从这一份事实出发：
//   · 事实（计数 / 最近活动 / 归档 / 轮边界）在这里归一
//   · sessionStatus 只负责「拿事实推状态」
//   · 展示侧只负责「拿事实摆数字」
// 这样同一会话在同一屏不会出现两个答案（曾经：侧栏「进行中 / 👤12」，详情头「已完成 / Conversation：7」）。

import type { SessionDetail, SessionSummary } from '@/api/types';
import { parseTimestampMs } from '@/lib/pure';

export type LastRole = 'user' | 'assistant';
export type LastTurnOutcome = 'delivered' | 'interrupted' | 'empty';

export interface SessionFacts {
  /** 最近一次记录写入时间（epoch ms）。 */
  lastActivityAt: number | null;
  /** 会话首条记录时间，仅在缺少 lastActivity 时作为兜底。 */
  startedAt: number | null;
  /** 日志里的用户/助手记录条数。列表、头部、看板共用这一组计数。 */
  userCount: number;
  assistantCount: number;
  archived: boolean;
  /** 日志自己记录的轮边界；缺失表示该平台无法判断，状态推导会回退计数。 */
  lastRole: LastRole | null;
  lastTurnOutcome: LastTurnOutcome | null;
}

function toTimestamp(value: unknown): number | null {
  return parseTimestampMs(typeof value === 'string' || typeof value === 'number' ? value : null);
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toLastRole(value: unknown): LastRole | null {
  return value === 'user' || value === 'assistant' ? value : null;
}

function toOutcome(value: unknown): LastTurnOutcome | null {
  return value === 'delivered' || value === 'interrupted' || value === 'empty' ? value : null;
}

/** SessionMeta 的索引签名允许带上轮边界字段；缺字段时回退 null。 */
function metaField(meta: unknown, key: string): unknown {
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>)[key] : undefined;
}

/**
 * 列表摘要 → 事实。侧栏卡片、看板、以及详情头（summary 已加载时）都以它为基准，
 * 保证同一时刻两处显示同一组数字。
 */
export function summaryFacts(session: SessionSummary): SessionFacts {
  return {
    lastActivityAt: toTimestamp(session.lastActivity),
    startedAt: toTimestamp(session.timestamp),
    userCount: toCount(session.userCount),
    assistantCount: toCount(session.assistantCount),
    archived: session.archived === true,
    lastRole: toLastRole(session.lastRole),
    lastTurnOutcome: toOutcome(session.lastTurnOutcome),
  };
}

/**
 * 详情 → 事实。摘要优先：列表每 5 秒对账一次，而详情可能来自 SSE 增量，
 * 让两处取同一个来源比「谁更新鲜」更重要。摘要尚未加载时用详情自带字段兜底。
 */
export function detailFacts(detail: SessionDetail, summary?: SessionSummary | null): SessionFacts {
  const meta = detail.session;
  const fromSummary = summary ? summaryFacts(summary) : null;
  const detailUserCount = toCount(detail.stats?.userCount ?? metaField(meta, 'userCount'));
  const detailAssistantCount = toCount(detail.stats?.assistantCount ?? metaField(meta, 'assistantCount'));

  return {
    lastActivityAt:
      fromSummary?.lastActivityAt ??
      toTimestamp(metaField(meta, 'lastActivity')) ??
      fromSummary?.startedAt ??
      toTimestamp(meta?.timestamp),
    startedAt: fromSummary?.startedAt ?? toTimestamp(meta?.timestamp),
    userCount: fromSummary?.userCount ?? detailUserCount,
    assistantCount: fromSummary?.assistantCount ?? detailAssistantCount,
    archived: fromSummary?.archived ?? meta?.archived === true,
    lastRole: fromSummary?.lastRole ?? toLastRole(metaField(meta, 'lastRole')),
    lastTurnOutcome: fromSummary?.lastTurnOutcome ?? toOutcome(metaField(meta, 'lastTurnOutcome')),
  };
}

/** 用户 + 助手记录条数。头部与世界面共用的「消息数」口径。 */
export function messageCount(facts: SessionFacts): number {
  return facts.userCount + facts.assistantCount;
}
