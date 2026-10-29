// 用量 view — 每日 token 消耗：综合总量、分项统计、每日堆叠图和分应用明细。

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getDailyUsage } from '@/api/client';
import type { DailyUsageDay, DailyUsageTotals } from '@/api/types';
import { PLATFORM_LABELS } from '@/api/types';
import { SettingsDialog } from '@/components/SettingsDialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCost } from '@/lib/pure';
import { dirForPlatform, useAppStore } from '@/store';
import { fmtTokens, InsightSection, StatCard } from '@/views/insights/bits';

const RANGES = [7, 14, 30] as const;
type UsageScope = 'platform' | 'all';

const TOKEN_SEGMENTS: { key: keyof Omit<DailyUsageTotals, 'cost' | 'sessions'>; label: string; className: string }[] = [
  { key: 'reasoning', label: 'Reasoning', className: 'bg-purple-500' },
  { key: 'cacheWrite', label: '缓存写入', className: 'bg-sky-500' },
  { key: 'cacheRead', label: '缓存读取', className: 'bg-emerald-500' },
  { key: 'output', label: '输出', className: 'bg-[#d29922]' },
  { key: 'input', label: '输入', className: 'bg-primary' },
];

function tokensOf(t: DailyUsageTotals | undefined): number {
  return (t?.input || 0) + (t?.output || 0) + (t?.cacheRead || 0) + (t?.cacheWrite || 0) + (t?.reasoning || 0);
}

function platformLabel(id: string): string {
  return (PLATFORM_LABELS as Record<string, string>)[id] || id;
}

function breakdownOf(t: DailyUsageTotals): string {
  return `输入 ${fmtTokens(t.input)} · 输出 ${fmtTokens(t.output)} · 缓存读取 ${fmtTokens(
    t.cacheRead
  )} · 缓存写入 ${fmtTokens(t.cacheWrite)} · Reasoning ${fmtTokens(t.reasoning)}`;
}

function sumSeries(series: DailyUsageDay[]): DailyUsageTotals {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, sessions: 0 };
  for (const d of series) {
    out.input += d.total.input || 0;
    out.output += d.total.output || 0;
    out.cacheRead += d.total.cacheRead || 0;
    out.cacheWrite += d.total.cacheWrite || 0;
    out.reasoning += d.total.reasoning || 0;
    out.cost += d.total.cost || 0;
    out.sessions += d.total.sessions || 0;
  }
  return out;
}

function DayBars({ series }: { series: DailyUsageDay[] }) {
  const max = Math.max(1, ...series.map((d) => tokensOf(d.total)));
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
      {series.map((d) => (
        <div
          key={d.date}
          className="flex min-w-8 flex-1 flex-col items-center gap-1"
          title={`${d.date}：${breakdownOf(d.total)}${d.total.cost > 0 ? ` · ${formatCost(d.total.cost)}` : ''}`}
        >
          <div className="flex h-[96px] w-full items-end justify-center">
            <div className="flex w-3.5 flex-col justify-end overflow-hidden rounded-t">
              {TOKEN_SEGMENTS.map((segment) => (
                <div
                  key={segment.key}
                  className={`w-full ${segment.className}`}
                  style={{ height: `${Math.round(((d.total[segment.key] || 0) / max) * 90)}px` }}
                />
              ))}
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground">{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function PlatformMatrix({ series, platforms }: { series: DailyUsageDay[]; platforms: string[] }) {
  if (!platforms.length)
    return <p className="text-sm text-muted-foreground">近 {series.length} 天没有检测到 token 用量。</p>;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-32">应用</TableHead>
            {series.map((d) => (
              <TableHead key={d.date} className="px-2 text-right text-[11px]">
                {d.date.slice(5)}
              </TableHead>
            ))}
            <TableHead className="px-3 text-right">合计</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {platforms.map((id) => {
            const rowTotal = series.reduce((sum, d) => sum + tokensOf(d.byPlatform[id]), 0);
            return (
              <TableRow key={id}>
                <TableCell className="min-w-32 font-medium">{platformLabel(id)}</TableCell>
                {series.map((d) => {
                  const t = d.byPlatform[id];
                  const val = tokensOf(t);
                  return (
                    <TableCell key={d.date} className="px-2 text-right tabular-nums" title={t ? breakdownOf(t) : '—'}>
                      {val > 0 ? fmtTokens(val) : <span className="text-muted-foreground/60">–</span>}
                    </TableCell>
                  );
                })}
                <TableCell className="px-3 text-right font-semibold tabular-nums">{fmtTokens(rowTotal)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function UsageView() {
  const [days, setDays] = useState<number>(14);
  const [scope, setScope] = useState<UsageScope>('platform');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const platform = useAppStore((s) => s.platform);
  const settings = useAppStore((s) => s.settings);
  const selectedDir = dirForPlatform(settings, platform);
  const customDirCount = Object.values(settings).filter(Boolean).length;
  const queriedPlatform = scope === 'platform' ? platform : 'all';

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['usage-daily', days, queriedPlatform, settings],
    queryFn: () => getDailyUsage({ days, platform: queriedPlatform, dirs: settings }),
    staleTime: 30_000,
  });

  const series = data?.series || [];
  const totals = sumSeries(series);
  const totalSessions = data?.totalSessions ?? totals.sessions;
  const hasData = tokensOf(totals) > 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            用量统计
            <span className="text-sm font-normal text-muted-foreground">每日 token 消耗</span>
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            包含输入、输出、缓存、Reasoning 与估算 token · 会话数含子代理
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-panel-alt p-1">
            {(['platform', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                className={`rounded-md px-3 py-1 text-sm transition-colors ${
                  scope === value
                    ? 'bg-primary/20 text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {value === 'platform' ? '当前平台' : '全部平台'}
              </button>
            ))}
          </div>
          <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-panel-alt p-1">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setDays(r)}
                className={`rounded-md px-3 py-1 text-sm transition-colors ${
                  days === r ? 'bg-primary/20 text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {r}天
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-panel-alt/60 px-3 py-2 text-xs text-muted-foreground">
        <span>统计范围：{scope === 'platform' ? platformLabel(platform) : '全部平台'}</span>
        <span>当前平台：{platformLabel(platform)}</span>
        <span className="max-w-[420px] truncate" title={selectedDir || '默认目录'}>
          目录：{selectedDir || '默认目录'}
        </span>
        <span>自定义目录：{customDirCount}/12</span>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="ml-auto rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-secondary"
        >
          目录设置
        </button>
      </div>

      {isPending ? (
        <p className="text-sm text-muted-foreground">正在扫描会话统计用量…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">加载失败：{error instanceof Error ? error.message : String(error)}</p>
      ) : !hasData ? (
        <p className="text-sm text-muted-foreground">
          近 {days} 天没有检测到 token 用量数据（会话日志里没有 usage / token 记录）。
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <StatCard value={fmtTokens(tokensOf(totals))} label="综合 token" tone="token" />
            <StatCard value={fmtTokens(totals.input)} label="输入" tone="token" />
            <StatCard value={fmtTokens(totals.output)} label="输出" tone="token" />
            <StatCard value={fmtTokens(totals.cacheRead)} label="缓存读取" />
            <StatCard value={fmtTokens(totals.cacheWrite)} label="缓存写入" />
            <StatCard value={fmtTokens(totals.reasoning)} label="Reasoning" />
            {totals.cost > 0 && <StatCard value={formatCost(totals.cost)} label="成本" tone="cost" />}
            <StatCard value={totalSessions.toLocaleString()} label="会话数（含子代理）" />
          </div>

          <InsightSection title={`每日用量（${days} 天）`}>
            <DayBars series={series} />
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
              {TOKEN_SEGMENTS.map((segment) => (
                <span key={segment.key} className="flex items-center gap-1">
                  <span className={`inline-block h-2.5 w-2.5 rounded-sm ${segment.className}`} /> {segment.label}
                </span>
              ))}
            </div>
          </InsightSection>

          <InsightSection title={`分应用每日明细（${days} 天）`}>
            <PlatformMatrix series={series} platforms={data?.platforms || []} />
          </InsightSection>
        </>
      )}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
