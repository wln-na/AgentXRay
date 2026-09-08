import type { ContextUsage } from '@/api/types';
import { fmtTokens } from '@/views/insights/bits';

function safePercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

export function ContextUsageCard({ usage, unavailableNote }: { usage?: ContextUsage | null; unavailableNote?: string }) {
  const used = typeof usage?.used === 'number' ? usage.used : null;
  const limit = typeof usage?.limit === 'number' && usage.limit > 0 ? usage.limit : null;
  const percent = safePercent(
    typeof usage?.percent === 'number' ? usage.percent : used !== null && limit ? (used / limit) * 100 : null
  );
  const breakdown = usage?.breakdown || [];

  return (
    <div className="rounded-md border border-border/70 p-2.5" data-testid="context-usage">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">上下文用量</div>
      {used !== null ? (
        <>
          <div className="text-lg font-semibold text-foreground">
            {fmtTokens(used)}
            {limit ? ` / ${fmtTokens(limit)}` : ' / 上限未记录'}
            {percent !== null ? <span className="ml-1 text-xs font-normal text-muted-foreground">· {percent.toFixed(1)}%</span> : null}
          </div>
          {percent !== null ? (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary" aria-label={`上下文已使用 ${percent.toFixed(1)}%`}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            {typeof usage?.input === 'number' ? <span>Input {fmtTokens(usage.input)}</span> : null}
            {typeof usage?.cacheRead === 'number' ? <span>Cache Read {fmtTokens(usage.cacheRead)}</span> : null}
            {typeof usage?.cacheWrite === 'number' ? <span>Cache Write {fmtTokens(usage.cacheWrite)}</span> : null}
            {typeof usage?.output === 'number' ? <span>Output {fmtTokens(usage.output)}</span> : null}
          </div>
          {breakdown.length ? (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {breakdown.map((item) => (
                <div key={item.key} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-muted-foreground">{item.label}{item.estimated ? '（估算）' : ''}</span>
                  <span className="font-medium text-foreground">
                    {typeof item.percent === 'number' ? `${item.percent.toFixed(1)}%` : typeof item.tokens === 'number' ? fmtTokens(item.tokens) : '—'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-muted-foreground">
              对话消息 / 系统提示词 / 工具及子智能体 / 技能：日志未提供分类 Token 明细
            </div>
          )}
          {usage?.note ? <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{usage.note}</div> : null}
        </>
      ) : (
        <div className="text-[11px] leading-5 text-muted-foreground">
          {usage?.note || unavailableNote || '当前本地日志未记录上下文 Token。'}
        </div>
      )}
    </div>
  );
}
