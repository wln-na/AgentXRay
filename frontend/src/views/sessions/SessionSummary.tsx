// Session overview: id/time/cwd/model header, time split + slowest turn,
// persisted collapse (axr-summary-collapsed), stat filter badges, retry jump,
// child-agent chips. 头部操作收在 HeaderActions 里（打开 ▾ / ⋯）。

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { SessionDetail } from '@/api/types';
import { useSharedClock } from '@/hooks/useSharedClock';
import { formatDurationCompact } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { loadStoredFlag, SUMMARY_COLLAPSED_KEY, saveStoredFlag, useAppStore } from '@/store';
import { ChildAgentsSection } from '@/views/trace/ChildAgentsSection';
import { ContextUsageCard } from './ContextUsageCard';
import { HeaderActions } from './HeaderActions';
import type { MsgFilter, TimingAnalysis } from './lib';
import { computeSessionStats, sessionCost, summarizeTokens } from './lib';
import { useSessionSummaries } from './queries';
import { StatusPill } from './StatusPill';
import { detailFacts, messageCount } from './sessionFacts';
import { deriveSessionStatus, formatRelativeTime } from './sessionStatus';

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
        'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
          : 'bg-secondary/70 text-muted-foreground hover:text-foreground',
        className
      )}
    >
      {children}
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
  const { data: sessions } = useSessionSummaries();
  const [collapsed, setCollapsed] = useState(() => loadStoredFlag(SUMMARY_COLLAPSED_KEY, true));
  const [pathCopied, setPathCopied] = useState(false);
  const clockNow = useSharedClock();

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
      ].filter((value): value is string => typeof value === 'string' && Boolean(value))
    )
  );

  const msgs = detail.messages;
  // Prefer server-computed stats (shipped by the session detail API) to skip
  // the O(n) client-side scan for large sessions; fall back when absent.
  const stats = useMemo(() => detail.stats || computeSessionStats(msgs), [detail.stats, msgs]);
  const tokenUsage = detail.tokenUsage || detail.session?.tokenUsage;
  const contextUsage = detail.contextUsage || detail.session?.contextUsage;
  const tokenSummary = useMemo(() => summarizeTokens(msgs, tokenUsage), [msgs, tokenUsage]);
  const cost = useMemo(() => sessionCost(msgs), [msgs]);
  const listModel = selectedSummary?.model || detail.session?.model;
  // 同一组事实喂给状态与计数：侧栏卡片、看板、这里取的是同一份数据。
  const facts = useMemo(() => detailFacts(detail, selectedSummary), [detail, selectedSummary]);
  const projectPath = selectedSummary?.projectPath || detail.session?.projectPath || detail.session?.cwd || null;
  const explicitProjectName = selectedSummary?.projectName || detail.session?.projectName || null;
  // cwd 回退时只显示最后一段目录名，完整路径放进 tooltip。
  const projectName =
    explicitProjectName ||
    (projectPath
      ? projectPath
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() || projectPath
      : null);
  const isArchived = facts.archived;
  const lastActivityAt = facts.lastActivityAt;
  const lastActivityTitle = lastActivityAt === null ? undefined : new Date(lastActivityAt).toLocaleString();
  const sessionDurationMs = timing.totalDurationMs;
  // 相对时间统一走 sessionStatus 的词表（秒/分钟/小时/天/月），不再混用绝对日期串。
  const activityLabel = lastActivityAt === null ? null : formatRelativeTime(lastActivityAt, clockNow);

  const status = useMemo(() => deriveSessionStatus(facts, clockNow), [facts, clockNow]);

  const total = timing.totalDurationMs;
  const toolMs = timing.totalToolDurationMs || 0;
  const modelMs = total !== null ? Math.max(0, total - toolMs) : 0;
  const topTools = Object.entries(stats.toolNames).length
    ? Object.entries(stats.toolNames)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
    : (selectedSummary?.topTools || []).map((tool) => [tool.name, tool.count] as [string, number]).slice(0, 8);
  const topSkills = Object.entries(stats.skillNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const topSkillFileReads = Object.entries(stats.skillFileReads)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const topMcpServers = Object.entries(stats.mcpServers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const toolCallCount = stats.toolCallCount || selectedSummary?.toolCallCount || 0;
  const toolResultCount = stats.toolResultCount || selectedSummary?.toolResultCount || 0;
  const userCount = facts.userCount;
  const assistantCount = facts.assistantCount;
  const conversationCount = messageCount(facts);
  const reasoningCount = msgs.filter((message) => message.role === 'reasoning').length;
  const totalItemCount = msgs.length;

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      saveStoredFlag(SUMMARY_COLLAPSED_KEY, !prev);
      return !prev;
    });
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-5 shadow-soft-md" data-testid="session-summary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2
            className="truncate text-lg font-semibold tracking-tight"
            title={selectedSummary?.title || detail.session?.id || selectedSessionId}
          >
            {selectedSummary?.title || detail.session?.id || selectedSessionId}
          </h2>
          {/* 一行元信息：状态是唯一的高亮胶囊，其余用「·」分隔的纯文字。
              日期不再单列（最近活动的 tooltip 里有完整时间，左侧卡片也有）。 */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span data-testid="session-summary-status" title={status.hint} className="inline-flex">
              <StatusPill
                tone={status.tone}
                label={status.label}
                hint={status.hint}
                pulse={status.kind === 'working'}
              />
            </span>
            {activityLabel ? (
              <span title={lastActivityTitle}>
                最近活动 <span className="text-foreground/80">{activityLabel}</span>
              </span>
            ) : null}
            {sessionDurationMs !== null ? (
              <span title="按首条至末条有效消息的时间跨度计算，不包含末次活动后的空闲时间">
                时长 <span className="text-foreground/80">{formatDurationCompact(sessionDurationMs)}</span>
              </span>
            ) : null}
            {listModel ? (
              <span className="max-w-[220px] truncate" title={listModel}>
                模型 <span className="text-foreground/80">{listModel.split('/').pop()}</span>
              </span>
            ) : null}
            {projectName ? (
              <span className="max-w-[220px] truncate" title={projectPath || projectName}>
                项目 <span className="text-foreground/80">{projectName}</span>
              </span>
            ) : null}
            <span title="按日志记录计数，与左侧会话列表、看板同一口径">
              👤 {userCount} · 🤖 {assistantCount}
            </span>
            <span>{toolCallCount} 次工具调用</span>
            {isArchived ? (
              <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1 py-px font-medium text-amber-700 dark:text-amber-300">
                已归档
              </span>
            ) : null}
            {detail.session?.contentAvailable === false ? (
              <span
                className="rounded border border-amber-500/50 bg-amber-500/10 px-1 py-px font-medium text-[#b7791f]"
                title="日志里没有保留正文，只能看到元信息与计数"
              >
                本地未保留正文
              </span>
            ) : null}
          </div>
        </div>
        <HeaderActions detail={detail} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      </div>

      {!collapsed ? (
        <div className="mt-3 space-y-3" data-testid="summary-body">
          <div className="rounded-md border border-border/70 p-2.5 text-[11px] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>会话 ID：{detail.session?.id || selectedSessionId}</span>
              {detail.session?.dataSource ? <span>来源：{detail.session.dataSource}</span> : null}
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
                  title={
                    timing.slowestStep.anchorId
                      ? `跳转到耗时最长的一轮（锚点：message-${timing.slowestStep.anchorId}）`
                      : '跳转到耗时最长的一轮'
                  }
                  onClick={() => timing.slowestStep?.anchorId && onScrollToMessage(timing.slowestStep.anchorId)}
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
                        toast.error(`复制失败: ${(error as Error).message}`);
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
                  👤 User: {userCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === 'assistant'}
                  onClick={() => setMsgFilter('assistant')}
                  title="Click to show only assistant messages"
                >
                  🤖 Assistant: {assistantCount}
                </FilterBadge>
                <span
                  className="rounded-full bg-secondary/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                  title="用户 + 助手记录条数（与列表、看板同一口径）"
                >
                  💬 消息合计：{conversationCount}
                </span>
              </div>
            </div>
            <div className="rounded-md border border-border/70 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Activity
              </div>
              <div className="flex flex-wrap gap-1">
                <span
                  className="rounded-full bg-secondary/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                  title="Model reasoning records"
                >
                  🧠 Reasoning: {reasoningCount}
                </span>
                <span
                  className="rounded-full bg-secondary/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                  title="All normalized transcript items, including conversation, reasoning, and tool records"
                >
                  📊 Total Items: {totalItemCount}
                </span>
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
                  🔧 Tool Calls: {toolCallCount}
                </FilterBadge>
                <FilterBadge
                  active={msgFilter === 'toolResult'}
                  onClick={() => setMsgFilter('toolResult')}
                  title="Click to show only tool results"
                >
                  📋 Tool Results: {toolResultCount}
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
            <div className="rounded-md border border-border/70 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Top Tools
              </div>
              {topTools.length ? (
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
              ) : (
                <div className="text-[11px] text-muted-foreground">本会话没有记录到工具调用</div>
              )}
            </div>
            <div className="rounded-md border border-border/70 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                MCP 使用（按 Server）
              </div>
              {topMcpServers.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {topMcpServers.map(([name, count]) => (
                    <span
                      key={name}
                      className="rounded border border-sky-500/30 bg-sky-500/5 px-1.5 py-0.5 text-[11px] text-foreground"
                    >
                      {name} ×{count}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground">本会话没有记录到 MCP 工具调用</div>
              )}
              <div className="mt-1 text-[10px] text-muted-foreground">按 mcp__server__tool 原生工具名汇总</div>
            </div>
            <div className="rounded-md border border-border/70 p-2.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Skill 使用
              </div>
              {topSkills.length ? (
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
              ) : (
                <div className="text-[11px] text-muted-foreground">本会话没有记录到 Skill 加载</div>
              )}
              <div className="mt-1 text-[10px] text-muted-foreground">
                按原生 Skill 工具调用及实际读取 SKILL.md 统计
              </div>
              <div className="mt-2 border-t border-border/60 pt-2 text-[10px] font-medium text-muted-foreground">
                Skill 目录文件读取
              </div>
              {topSkillFileReads.length ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {topSkillFileReads.map(([name, count]) => (
                    <span
                      key={name}
                      className="rounded border border-border bg-secondary/30 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    >
                      {name} ×{count}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-muted-foreground">本会话没有记录到 Skill 从属文件读取</div>
              )}
            </div>
            <ContextUsageCard
              usage={contextUsage}
              cumulative={{ tokens: tokenSummary, cost }}
              unavailableNote={
                detail.session?.dataSource === 'indexeddb'
                  ? 'Doubao 的 trajectory 与 IndexedDB 本地记录未提供 Token usage，无法计算上下文用量。'
                  : undefined
              }
            />
          </div>
          <ChildAgentsSection />
        </div>
      ) : null}
    </div>
  );
}
