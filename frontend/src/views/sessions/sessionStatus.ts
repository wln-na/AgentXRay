// Session status: one derivation shared by the board, the sidebar cards and the
// session header — botmux's "Session Control" design language (status columns,
// tone-coloured dots/pills), but computed only from facts AgentXRay already has.
//
// AgentXRay reads log files; it has no daemon and cannot know whether an agent
// process is still alive. So the vocabulary is deliberately log-shaped:
//
//   进行中 working   — a record was written in the last 3 minutes
//   待跟进 needs_follow_up — the last turn did not close with real output
//   已完成 done      — the last turn produced output, activity is recent
//   空闲 idle        — nothing for 7+ days (or archived)
//
// Turn-boundary facts (summary.lastRole / summary.lastTurnOutcome, filled by the
// platform scanners) are the primary signal for 待跟进/已完成; message counters
// are only the fallback when an adapter cannot report them.
//
// `archived` is not its own kind: archived sessions are read as finished, the
// caller can still render its own "已归档" badge from the summary.

import type { SessionSummary } from '@/api/types';
import { LIVE_WINDOW_MS } from '@/lib/live';

import { type SessionFacts, summaryFacts } from './sessionFacts';

export type SessionStatusKind = 'working' | 'needs_follow_up' | 'done' | 'idle';

/** Visual tone. Mirrors the CSS tokens --st-work/--st-need/--st-done/--st-idle. */
export type StatusTone = 'work' | 'need' | 'done' | 'idle';

/** Same window as lib/live: "a record landed recently". Single source of truth. */
export const ACTIVE_WINDOW_MS = LIVE_WINDOW_MS;
/** No record for this long reads as idle rather than finished-today. */
export const IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_STATUS_KINDS: readonly SessionStatusKind[] = ['working', 'needs_follow_up', 'done', 'idle'];

export interface SessionStatusMeta {
  tone: StatusTone;
  label: string;
  hint: string;
}

export const STATUS_META: Record<SessionStatusKind, SessionStatusMeta> = {
  working: {
    tone: 'work',
    label: '进行中',
    hint: '近 3 分钟内有新的记录写入。AgentXRay 只读日志，这不代表 agent 进程一定还在运行',
  },
  needs_follow_up: {
    tone: 'need',
    label: '待跟进',
    hint: '最后一轮没有闭环：日志停在用户输入，或最后一轮被中断 / 没有实质产出。日志未记录轮边界时回退为按消息计数推断',
  },
  done: {
    tone: 'done',
    label: '已完成',
    hint: '最后一轮有实质助手回复，且近 7 天内有活动（日志未记录轮边界时回退为按消息计数推断）',
  },
  idle: {
    tone: 'idle',
    label: '空闲',
    hint: '超过 7 天没有任何记录写入',
  },
};

export interface SessionStatusInfo extends SessionStatusMeta {
  kind: SessionStatusKind;
  /** Epoch ms of the last activity, when the log gave us one. */
  at: number | null;
  /** Short "12 分钟前" phrase for the card/header subtitle. */
  detail: string;
  archived: boolean;
}

/** Coarse relative time — the same vocabulary as the board cards. */
export function formatRelativeTime(at: number | null, now: number = Date.now()): string {
  if (at === null) return '';
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  if (diff < 365 * 86_400_000) return `${Math.floor(diff / (30 * 86_400_000))} 个月前`;
  return `${Math.floor(diff / (365 * 86_400_000))} 年前`;
}

function info(kind: SessionStatusKind, at: number | null, archived: boolean, detail: string): SessionStatusInfo {
  return { kind, ...STATUS_META[kind], at, detail, archived };
}

/**
 * Derive the status. Order matters:
 * live beats archived (a file can be archived while still being written),
 * archived beats "unanswered" (the user already put it away),
 * turn facts beat counters (a failed/empty last turn is not "done"),
 * unanswered beats idle (a two-week-old unanswered question is still actionable).
 */
export function deriveSessionStatus(facts: SessionFacts, now: number = Date.now()): SessionStatusInfo {
  const at = facts.lastActivityAt ?? facts.startedAt;
  const archived = facts.archived;
  const userCount = facts.userCount;
  const assistantCount = facts.assistantCount;
  const relative = formatRelativeTime(at, now);
  const lastRole = facts.lastRole;
  const outcome = facts.lastTurnOutcome;
  const hasTurnFacts = lastRole !== null || outcome !== null;

  if (at !== null && now - at < ACTIVE_WINDOW_MS) {
    return info('working', at, archived, relative === '刚刚' ? '刚刚有活动' : `${relative}有活动`);
  }
  if (archived) {
    return info('done', at, archived, relative ? `已归档 · ${relative}有活动` : '已归档');
  }

  // Primary signal: the log's own turn boundary.
  if (hasTurnFacts) {
    // An explicit abort is the most informative reason, even when the aborted
    // turn left the log on a user record.
    if (outcome === 'interrupted') {
      return info('needs_follow_up', at, archived, relative ? `${relative}的最后一轮被中断` : '最后一轮被中断');
    }
    if (lastRole === 'user') {
      return info('needs_follow_up', at, archived, relative ? `${relative}提问，尚未回复` : '尚未回复');
    }
    if (outcome === 'empty') {
      return info('needs_follow_up', at, archived, relative ? `${relative}的最后一轮没有产出` : '最后一轮没有产出');
    }
    if (at !== null && now - at >= IDLE_AFTER_MS) {
      return info('idle', at, archived, `${relative}有活动`);
    }
    return info('done', at, archived, relative ? `最后一轮已完成 · ${relative}有活动` : '最后一轮已完成');
  }

  // Fallback: adapters that cannot expose turn boundaries — counters only.
  if (userCount > assistantCount) {
    return info('needs_follow_up', at, archived, relative ? `${relative}提问，尚未回复` : '尚未回复');
  }
  if (at !== null && now - at >= IDLE_AFTER_MS) {
    return info('idle', at, archived, `${relative}有活动`);
  }
  return info('done', at, archived, relative ? `最近活动 ${relative}` : '');
}

/** Convenience wrapper for a list item. */
export function sessionStatusOf(session: SessionSummary, now: number = Date.now()): SessionStatusInfo {
  return deriveSessionStatus(summaryFacts(session), now);
}

export interface StatusCounts extends Record<SessionStatusKind, number> {
  total: number;
}

export function countSessionStatuses(sessions: readonly SessionSummary[], now: number = Date.now()): StatusCounts {
  const counts: StatusCounts = { working: 0, needs_follow_up: 0, done: 0, idle: 0, total: sessions.length };
  for (const session of sessions) counts[sessionStatusOf(session, now).kind] += 1;
  return counts;
}
