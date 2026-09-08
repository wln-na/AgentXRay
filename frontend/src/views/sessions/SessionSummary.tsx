// Session overview: id/time/cwd/model header, time split + slowest turn,
// persisted collapse (axr-summary-collapsed), stat filter badges, retry jump,
// child-agent chips, resume-command copy, export menu — legacy renderSummary.

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionDetail } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { formatCost, formatDurationCompact } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { dirForPlatform, loadStoredFlag, saveStoredFlag, SUMMARY_COLLAPSED_KEY, useAppStore } from '@/store';
import { ChildAgentsSection } from '@/views/trace/ChildAgentsSection';
import { ContextUsageCard } from './ContextUsageCard';
import type { ExportFormat } from './exports';
import { runExport } from './exports';
import type { MsgFilter, TimingAnalysis } from './lib';
import { computeSessionStats, formatDate, formatNumber, resumeCommand, sessionCost, summarizeTokens } from './lib';
import { useSessionsList } from './queries';

function FilterBadge({
  active,
  onClick,
  title,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'rounded border px-1.5 py-0.5 text-[11px]',
        active
          ? 'border-primary bg-primary/15 text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
        className
      )}
    >
      {children}
    </button>
  );
}

const ACTION_BTN =
  'rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground';

function ExportMenu({ detail }: { detail: SessionDetail }) {
  const platform = useAppStore((s) => s.platform);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const settings = useAppStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const onExport = async (format: ExportFormat) => {
    setOpen(false);
    const result = await runExport(
      format,
      detail,
      platform,
      selectedSessionId,
      dirForPlatform(settings, platform) || undefined,
      platform === 'openclaw' ? selectedAgent : undefined
    );
    if (result === 'copied') {
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const entries: [ExportFormat, string][] = [
    ['markdown', '📝 Markdown (.md)'],
    ...(DEMO ? [] : ([['html', '🌐 HTML (.html)']] as [ExportFormat, string][])),
    ['json', '📦 JSON (.json)'],
    ['clipboard', '📋 复制到剪贴板'],
  ];
  if (['codex', 'claude-code', 'claude-desktop', 'omp', 'dsh', 'gemini'].includes(platform)) entries.push(['otlp', '🔭 OTLP JSON']);

  return (
    <div className="relative">
      <button type="button" className={ACTION_BTN} onClick={() => setOpen((v) => !v)} data-testid="export-btn">
        {copied ? '✅ Copied!' : '📥 导出'}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-lg">
            {entries.map(([format, label]) => (
              <button
                key={format}
                type="button"
                data-export={format}
                onClick={() => void onExport(format)}
                className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ResumeButton({ cwd }: { cwd: string | null | undefined }) {
  const platform = useAppStore((s) => s.platform);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const [copied, setCopied] = useState(false);
  const cmd = resumeCommand(platform, selectedSessionId, cwd);
  if (!cmd) return null;
  return (
    <button
      type="button"
      className={ACTION_BTN}
      title={`复制在终端恢复此会话的命令：${cmd}`}
      data-testid="resume-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch (error) {
          toast.error('复制失败: ' + (error as Error).message);
        }
      }}
    >
      {copied ? '已复制' : '📋 复制恢复命令'}
    </button>
  );
}

export function SessionSummary({
  detail,
  timing,
  msgFilter,
  setMsgFilter,
  onScrollToMessage,
  onRetryJump,
}: {
  detail: SessionDetail;
  timing: TimingAnalysis;
  msgFilter: MsgFilter;
  setMsgFilter: (f: MsgFilter) => void;
  onScrollToMessage: (id: string) => void;
  onRetryJump: () => void;
}) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const msgOrder = useAppStore((s) => s.msgOrder);
  const setMsgOrder = useAppStore((s) => s.setMsgOrder);
  const { data: sessions } = useSessionsList();
  const [collapsed, setCollapsed] = useState(() => loadStoredFlag(SUMMARY_COLLAPSED_KEY, true));
  const [pathCopied, setPathCopied] = useState(false);

  const selectedSummary = sessions?.find((s) => s.id === selectedSessionId);
  const sessionFile = selectedSummary?.file;
  const localPaths = Array.from(
    new Set(
      [
        detail.session?.sourcePath,
        detail.session?.trajectoryPath,
        detail.session?.filePath,
        selectedSummary?.sourcePath,
        selectedSummary?.trajectoryPath,
        selectedSummary?.filePath,
        sessionFile,
      ]
        .filter((value): value is string => typeof value === 'string' && Boolean(value))
    )
  );

  const msgs = detail.messages;
  const stats = useMemo(() => computeSessionStats(msgs), [msgs]);
  const tokenUsage = detail.tokenUsage || detail.session?.tokenUsage;
  const contextUsage = detail.contextUsage || detail.session?.contextUsage;
  const tokenSummary = useMemo(() => summarizeTokens(msgs, tokenUsage), [msgs, tokenUsage]);
  const cost = useMemo(() => sessionCost(msgs), [msgs]);
  const listModel = selectedSummary?.model || detail.session?.model;

  const total = timing.totalDurationMs;
  const toolMs = timing.totalToolDurationMs || 0;
  const modelMs = total !== null ? Math.max(0, total - toolMs) : 0;
  const topTools = Object.entries(stats.toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const topSkills = Object.entries(stats.skillNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      saveStoredFlag(SUMMARY_COLLAPSED_KEY, !prev);
      return !prev;
    });
  };

  return (
    <div className="rounded-lg border border-border bg-card/60 p-3" data-testid="session-summary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold" title={selectedSummary?.title || detail.session?.id || selectedSessionId}>
            {selectedSummary?.title || detail.session?.id || selectedSessionId}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded border border-border px-1.5 py-0.5">{formatDate(detail.session?.timestamp)}</span>
            {selectedSummary?.projectName || detail.session?.projectName || detail.session?.cwd ? (
              <span className="max-w-[260px] truncate rounded border border-border px-1.5 py-0.5" title={selectedSummary?.projectPath || detail.session?.projectPath || detail.session?.cwd || ''}>
                {selectedSummary?.projectName || detail.session?.projectName || detail.session?.cwd}
              </span>
            ) : null}
            {listModel ? <span className="rounded border border-border px-1.5 py-0.5">模型：{listModel}</span> : null}
            <span className="rounded border border-border px-1.5 py-0.5">消息：{msgs.length}</span>
            <span className="rounded border border-border px-1.5 py-0.5">工具：{stats.toolCallCount}</span>
            {selectedSummary?.archived || detail.session?.archived ? (
              <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                已归档
              </span>
            ) : null}
            {detail.session?.contentAvailable === false ? (
              <span className="rounded border border-[#e3b341]/60 px-1.5 py-0.5 text-[#b7791f]">本地未保留正文</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            className={ACTION_BTN}
            title={msgOrder === 'newest-first' ? '当前：最新在上；点击改为最早在上' : '当前：最早在上；点击改为最新在上'}
            onClick={() => setMsgOrder(msgOrder === 'newest-first' ? 'oldest-first' : 'newest-first')}
          >
            {msgOrder === 'newest-first' ? '改为最早在上' : '改为最新在上'}
          </button>
          <button
            type="button"
            className={ACTION_BTN}
            title="折叠/展开会话统计详情"
            onClick={toggleCollapsed}
            data-testid="summary-toggle"
          >
            {collapsed ? '更多信息' : '收起信息'}
          </button>
          <ResumeButton cwd={detail.session?.cwd} />
          <ExportMenu detail={detail} />
        </div>
      </div>

      {!collapsed ? (
        <div className="mt-3 space-y-3" data-testid="summary-body">
          <div className="rounded-md border border-border/70 p-2.5 text-[11px] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>会话 ID：{detail.session?.id || selectedSessionId}</span>
              {detail.session?.dataSource ? <span>来源：{detail.session.dataSource}</span> : null}
              {total !== null ? <span>总耗时：{formatDurationCompact(total)}</span> : null}
              {total !== null && timing.totalToolDurationMs !== null && total > 0 ? (
                <span>
                  工具执行：{formatDurationCompact(toolMs)}（{Math.round((toolMs / total) * 100)}%） · 模型：
                  {formatDurationCompact(modelMs)}（{Math.round((modelMs / total) * 100)}%）
                </span>
              ) : null}
              {timing.slowestStep ? (
                <button
                  type="button"
                  className="text-[#b7791f] hover:underline"
                  title="跳转到耗时最长的一轮"
                  onClick={() => timing.slowestStep?.messageId && onScrollToMessage(timing.slowestStep.messageId)}
                >
                  最慢一轮：{formatDurationCompact(timing.slowestStep.deltaMs)}（{timing.slowestStep.label}）
                </button>
              ) : null}
            </div>
            {localPaths.length ? (
              <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
                <div className="font-medium text-foreground">本地路径</div>
                {localPaths.map((localPath) => (
                  <button
                    key={localPath}
                    type="button"
                    className="block max-w-full truncate text-left hover:text-foreground hover:underline"
                    title={`点击复制本地路径：${localPath}`}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(localPath);
                        setPathCopied(true);
                        setTimeout(() => setPathCopied(false), 1500);
                      } catch (error) {
                        toast.error('复制失败: ' + (error as Error).message);
                      }
                    }}
                  >
                    {pathCopied ? '已复制!' : localPath}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-md border border-border/70 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Messages
              </div>
              <div className="flex flex-wrap gap-1">
                <FilterBadge
                  active={msgFilter === 'user'}
                  onClick={() => setMsgFilter('user')}
                  title="Click to show only user messages"
                >
                  👤 User: {stats.userCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === 'assistant'}
                  onClick={() => setMsgFilter('assistant')}
                  title="Click to show only assistant messages"
                >
                  🤖 Assistant: {stats.assistantCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === null}
                  onClick={() => setMsgFilter(null)}
                  title="Click to show all messages"
                >
                  💬 Total: {msgs.length}
                </FilterBadge>
              </div>
            </div>
            <div className="rounded-md border border-border/70 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tools</div>
              <div className="flex flex-wrap gap-1">
                <FilterBadge
                  active={msgFilter === 'toolCall'}
                  onClick={() => setMsgFilter('toolCall')}
                  title="Click to show only tool calls"
                >
                  🔧 Tool Calls: {stats.toolCallCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === 'toolResult'}
                  onClick={() => setMsgFilter('toolResult')}
                  title="Click to show only tool results"
                >
                  📋 Tool Results: {stats.toolResultCount}
                </FilterBadge>
                {stats.errorCount ? (
                  <FilterBadge
                    active={msgFilter === 'error'}
                    onClick={() => setMsgFilter('error')}
                    title="Click to show only error tool results"
                    className="text-[#ff7b72]"
                  >
                    ❌ Errors: {stats.errorCount}
                  </FilterBadge>
                ) : null}
                {stats.totalRetryTools > 0 ? (
                  <button
                    type="button"
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-[#a5d6ff]"
                    title={`Click to jump to first retry · ${stats.totalRetryTools} tool${stats.totalRetryTools > 1 ? 's' : ''} retried (${stats.totalRetryAttempts} extra attempt${stats.totalRetryAttempts > 1 ? 's' : ''})`}
                    onClick={onRetryJump}
                    data-testid="retry-jump"
                  >
                    🔄 Retried: {stats.totalRetryTools} tool{stats.totalRetryTools > 1 ? 's' : ''} ·{' '}
                    {stats.totalRetryAttempts} extra attempt{stats.totalRetryAttempts > 1 ? 's' : ''}
                  </button>
                ) : null}
                {stats.spawnCount ? (
                  <FilterBadge
                    active={msgFilter === 'spawn'}
                    onClick={() => setMsgFilter('spawn')}
                    title="Click to show only spawn calls"
                    className="text-[#f0883e]"
                  >
                    🔗 Spawns: {stats.spawnCount}
                  </FilterBadge>
                ) : null}
              </div>
            </div>
            {topTools.length ? (
              <div className="rounded-md border border-border/70 p-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Top Tools
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {topTools.map(([name, count]) => (
                    <span
                      key={name}
                      className="rounded border border-border bg-secondary/30 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {name} ×{count}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {topSkills.length ? (
              <div className="rounded-md border border-border/70 p-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Skill 使用
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {topSkills.map(([name, count]) => (
                    <span
                      key={name}
                      className="rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[11px] text-foreground"
                    >
                      {name} ×{count}
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">按会话中读取 SKILL.md 的记录统计</div>
              </div>
            ) : null}
            <ContextUsageCard
              usage={contextUsage}
              unavailableNote={
                detail.session?.dataSource === 'indexeddb'
                  ? 'Doubao 的 trajectory 与 IndexedDB 本地记录未提供 Token usage，无法计算上下文用量。'
                  : undefined
              }
            />
            <div className="rounded-md border border-border/70 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Tokens</div>
              <div className="flex flex-wrap gap-1">
                {Object.keys(tokenSummary).length ? (
                  Object.entries(tokenSummary).map(([key, value]) => {
                    const label =
                      {
                        input: 'Input',
                        output: 'Output',
                        cacheRead: 'Cache Read',
                        cacheWrite: 'Cache Write',
                        reasoning: 'Reasoning',
                        totalTokens: 'Total',
                        contextWindow: 'Context Window',
                      }[key] || key;
                    return (
                      <span
                        key={key}
                        className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {label}: {formatNumber(value)}
                      </span>
                    );
                  })
                ) : (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    No token data
                  </span>
                )}
                {cost > 0 ? (
                  <span
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    title="按消息 usage.cost.total 合计"
                  >
                    💰 {formatCost(cost)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <ChildAgentsSection />
        </div>
      ) : null}
    </div>
  );
}
