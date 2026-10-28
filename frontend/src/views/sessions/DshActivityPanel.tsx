// DSH v4 task/approval/retry timeline. Collapsed by default: the panel is a
// debugging aid, not part of the conversational transcript.
import type { DshActivityEvent } from '@/api/types';

function clock(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return new Date(value).toLocaleTimeString();
}

function duration(start?: number | null, end?: number | null): string {
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return '';
  const ms = end - start;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function statusLabel(status?: string | null): string {
  if (!status) return 'settled';
  return status;
}

function JobRow({ event }: { event: Extract<DshActivityEvent, { type: 'job' }> }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
      <span className="text-muted-foreground">{clock(event.startedAt || event.timestamp)}</span>
      <span className="rounded border border-border px-1 text-[10px] uppercase">{statusLabel(event.status)}</span>
      <span className="font-medium text-foreground">{event.label || event.id || 'job'}</span>
      {event.finishedAt ? (
        <span className="text-muted-foreground">· {duration(event.startedAt, event.finishedAt)}</span>
      ) : null}
      {event.cause ? <span className="text-[#ff7b72]">· {event.cause}</span> : null}
    </div>
  );
}

function ApprovalRow({ event }: { event: Extract<DshActivityEvent, { type: 'approval' }> }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
      <span className="text-muted-foreground">{clock(event.timestamp)}</span>
      <span className="rounded border border-border px-1 text-[10px] uppercase">{event.action}</span>
      <span className="font-medium text-foreground">{event.toolName || 'approval'}</span>
      {event.decision ? <span className="text-emerald-600 dark:text-emerald-300">· {event.decision}</span> : null}
      {event.reason ? <span className="min-w-0 truncate text-muted-foreground">· {event.reason}</span> : null}
    </div>
  );
}

function RetryRow({ event }: { event: Extract<DshActivityEvent, { type: 'retry' }> }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
      <span className="text-muted-foreground">{clock(event.timestamp)}</span>
      <span className="rounded border border-border px-1 text-[10px] uppercase">retry</span>
      <span className="font-medium text-foreground">
        {event.provider || 'provider'} · {event.attempt ?? '?'}/{event.maxRetries ?? '?'}
      </span>
      <span className="text-muted-foreground">
        turn {event.turn ?? '?'} / step {event.step ?? '?'}
      </span>
      {event.failure?.message ? (
        <span className="text-[#ff7b72]">
          · {event.failure.code || 'error'}: {event.failure.message}
        </span>
      ) : null}
    </div>
  );
}

export function DshActivityPanel({ events }: { events?: DshActivityEvent[] | null }) {
  if (!Array.isArray(events) || events.length === 0) return null;
  return (
    <details className="mb-2 rounded-lg border border-border bg-card/40 px-3 py-2" data-testid="dsh-activity-panel">
      <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
        🛠 任务与审批 · {events.length} 条（默认折叠）
      </summary>
      <div className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
        {events.map((event, index) => {
          if (event.type === 'job') return <JobRow key={`job-${event.id}-${index}`} event={event} />;
          if (event.type === 'approval') return <ApprovalRow key={`approval-${event.id}-${index}`} event={event} />;
          return <RetryRow key={`retry-${event.id}-${index}`} event={event} />;
        })}
      </div>
    </details>
  );
}
