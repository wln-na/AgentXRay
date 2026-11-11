// Sidebar session list: cards, >200-item virtualization, ↑↓ keyboard nav,
// auto-select-first — ported from legacy renderSessions/sessionCardHtml.

import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarRange, FolderTree, RotateCcw } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSharedClock } from '@/hooks/useSharedClock';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store';
import { filterSessionList, formatDate } from './lib';
import { useSessionsInfinite } from './queries';
import { StatusDot, StatusPill } from './StatusPill';
import type { SessionStatusKind } from './sessionStatus';
import { countSessionStatuses, SESSION_STATUS_KINDS, STATUS_META, sessionStatusOf } from './sessionStatus';

const VIRT_THRESHOLD = 200; // below this many sessions, render everything
const VIRT_OVERSCAN = 10; // extra cards above/below the visible range
const VIRT_ESTIMATE = 96; // estimated card height incl. gap
const EMPTY_SESSIONS: SessionSummary[] = [];

type SessionChip = {
  kind: 'user' | 'assistant' | 'tool' | 'spawn' | 'model';
  text: string;
};

function chipTexts(session: SessionSummary): SessionChip[] {
  const chips: SessionChip[] = [];
  if (session.userCount > 0) chips.push({ kind: 'user', text: `👤 ${session.userCount} 条用户消息` });
  if (session.assistantCount > 0) chips.push({ kind: 'assistant', text: `🤖 ${session.assistantCount} 条助手消息` });
  chips.push({ kind: 'tool', text: `🔧 ${session.toolCallCount || 0} 次工具调用` });
  const spawnCount = session.spawnCount || session.childCount || 0;
  if (spawnCount > 0) chips.push({ kind: 'spawn', text: `🌳 ${spawnCount} 个子 Agent` });
  if (session.model) chips.push({ kind: 'model', text: `🧠 ${session.model.split('/').pop() || session.model}` });
  return chips;
}

const CHIP_CLASSES: Record<SessionChip['kind'], string> = {
  user: 'border-[#58a6ff]/30 bg-[#58a6ff]/10 text-[#1f6feb] dark:text-[#79c0ff]',
  assistant: 'border-border bg-secondary text-muted-foreground',
  tool: 'border-[#d29922]/30 bg-[#d29922]/10 text-[#9a6700] dark:text-[#e3b341]',
  spawn: 'border-[#f0883e]/30 bg-[#f0883e]/10 text-[#bc4c00] hover:bg-[#f0883e]/20 dark:text-[#ffa657]',
  model: 'border-border bg-secondary text-muted-foreground',
};

// Status vocabulary (进行中 / 待跟进 / 已完成 / 空闲) is derived once in
// ./sessionStatus and rendered with the same primitives as the board/header.

const SessionCard = memo(function SessionCard({
  session,
  active,
  now,
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  now: number;
  onSelect: (id: string) => void;
}) {
  const onClick = () => onSelect(session.id);
  const onSpawnClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onSelect(session.id);
    useAppStore.getState().setSessionView('trace');
  };
  const status = sessionStatusOf(session, now);
  const preview = session.firstUserMessage
    ? session.firstUserMessage.length > 80
      ? `${session.firstUserMessage.slice(0, 80)}…`
      : session.firstUserMessage
    : '';
  return (
    <div
      tabIndex={0}
      role="option"
      aria-selected={active}
      data-session-id={session.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      className={cn(
        'cursor-pointer rounded-xl border px-3 py-2.5 text-xs transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-primary/30 bg-primary/[0.08] shadow-soft-sm ring-1 ring-primary/15'
          : 'border-transparent bg-transparent hover:border-border hover:bg-card hover:shadow-soft-sm'
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{formatDate(session.timestamp)}</span>
        <span className="flex shrink-0 items-center gap-1">
          <span data-testid="session-card-status" title={status.hint} className="inline-flex">
            <StatusPill tone={status.tone} label={status.label} hint={status.hint} pulse={status.kind === 'working'} />
          </span>
          {session.archived ? (
            <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1 py-px text-[10px] text-amber-700 dark:text-amber-300">
              已归档
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 truncate font-medium text-foreground">{session.title || session.id}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {chipTexts(session).map((chip) =>
          chip.kind === 'spawn' ? (
            <button
              key={chip.kind}
              type="button"
              onClick={onSpawnClick}
              onKeyDown={(event) => event.stopPropagation()}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                CHIP_CLASSES[chip.kind]
              )}
              aria-label={`${chip.text}，打开追踪视图`}
            >
              {chip.text}
            </button>
          ) : (
            <span key={chip.kind} className={cn('rounded border px-1.5 py-0.5 text-[10px]', CHIP_CLASSES[chip.kind])}>
              {chip.text}
            </span>
          )
        )}
      </div>
      {preview ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{preview}</div> : null}
    </div>
  );
});

const ALL_PROJECTS = 'all-projects';
const UNASSIGNED_PROJECT = 'unassigned-project';

interface SessionProject {
  key: string;
  name: string;
  path: string | null;
}

function normalizedCwd(session: SessionSummary): string {
  return (session.cwd || '').replace(/[\\/]+$/, '');
}

function sessionProjectInfo(session: SessionSummary, platform: string): SessionProject {
  if (platform === 'doubao') {
    const projectId = session.projectId?.trim();
    const name = session.projectName?.trim();
    if (!projectId || !name) return { key: UNASSIGNED_PROJECT, name: '未归属项目', path: null };
    return {
      key: `doubao:${projectId}`,
      name,
      path: session.projectPath?.trim() || null,
    };
  }

  const cwd = normalizedCwd(session);
  if (!cwd) return { key: UNASSIGNED_PROJECT, name: '未归属项目', path: null };
  const name = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
  return { key: `cwd:${cwd}`, name, path: cwd };
}

function projectOptions(sessions: SessionSummary[], platform: string) {
  const projects = new Map<string, SessionProject & { count: number }>();
  for (const session of sessions) {
    const project = sessionProjectInfo(session, platform);
    const existing = projects.get(project.key);
    projects.set(project.key, existing ? { ...existing, count: existing.count + 1 } : { ...project, count: 1 });
  }
  const values = [...projects.values()];
  const nameCounts = new Map<string, number>();
  for (const project of values) nameCounts.set(project.name, (nameCounts.get(project.name) || 0) + 1);
  return values
    .map((project) => ({
      ...project,
      label:
        platform === 'doubao' && project.path
          ? `${project.name} — ${project.path}`
          : nameCounts.get(project.name) === 1 || !project.path
            ? project.name
            : project.path,
    }))
    .sort((a, b) => {
      if (a.key === UNASSIGNED_PROJECT) return 1;
      if (b.key === UNASSIGNED_PROJECT) return -1;
      return a.label.localeCompare(b.label, 'zh-CN');
    });
}

interface SessionPeriod {
  year: string;
  month: string;
}

const ALL_PERIODS = 'all';
const UNKNOWN_YEAR = 'unknown-year';
const UNKNOWN_MONTH = 'unknown-month';

function sessionPeriodValue(session: SessionSummary): SessionPeriod {
  const value = session.timestamp || session.lastActivity;
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return { year: UNKNOWN_YEAR, month: UNKNOWN_MONTH };
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
  };
}

function periodLabel(value: string, unit: 'year' | 'month'): string {
  if (value === ALL_PERIODS) return unit === 'year' ? '全部年份' : '全部月份';
  if (value === UNKNOWN_YEAR) return '时间未知';
  if (value === UNKNOWN_MONTH) return '月份未知';
  return unit === 'year' ? `${value}年` : `${value}月`;
}

export function SessionList({
  filterTerm,
  matchedSessionIds,
  isSearching = false,
  onSessionSelected,
}: {
  filterTerm: string;
  matchedSessionIds?: Set<string> | null;
  isSearching?: boolean;
  onSessionSelected?: () => void;
}) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const platform = useAppStore((s) => s.platform);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const selectSession = (id: string) => {
    setSelectedSessionId(id);
    onSessionSelected?.();
  };

  const now = useSharedClock();
  const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useSessionsInfinite();
  // Cursor pagination: `data.pages` holds the newest page plus every older page
  // the user explicitly loaded, in order. Flatten for the existing list pipeline
  // (filter/search/group/virtualize) so none of that logic changes.
  const sessions = useMemo(() => data?.pages.flatMap((page) => page.sessions) ?? EMPTY_SESSIONS, [data]);
  const totalCount = data?.pages[0]?.page.total ?? sessions.length;
  /** null = 不过滤状态；否则只看该状态（与看板时代的四列语义一致，但只有一列）。 */
  const [selectedStatus, setSelectedStatus] = useState<SessionStatusKind | null>(null);
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [selectedYear, setSelectedYear] = useState(ALL_PERIODS);
  const [selectedMonth, setSelectedMonth] = useState(ALL_PERIODS);

  useEffect(() => {
    setSelectedStatus(null);
    setSelectedProject(ALL_PROJECTS);
    setSelectedYear(ALL_PERIODS);
    setSelectedMonth(ALL_PERIODS);
  }, [platform, selectedAgent]);

  const availableProjects = useMemo(() => projectOptions(sessions, platform), [sessions, platform]);

  useEffect(() => {
    if (selectedProject !== ALL_PROJECTS && !availableProjects.some((project) => project.key === selectedProject)) {
      setSelectedProject(ALL_PROJECTS);
    }
  }, [availableProjects, selectedProject]);

  const projectScopedSessions = useMemo(
    () =>
      sessions.filter(
        (session) => selectedProject === ALL_PROJECTS || sessionProjectInfo(session, platform).key === selectedProject
      ),
    [sessions, selectedProject, platform]
  );

  const yearOptions = useMemo(() => {
    const values = new Set(projectScopedSessions.map((session) => sessionPeriodValue(session).year));
    return [...values].sort((a, b) => {
      if (a === UNKNOWN_YEAR) return 1;
      if (b === UNKNOWN_YEAR) return -1;
      return Number(b) - Number(a);
    });
  }, [projectScopedSessions]);

  useEffect(() => {
    if (selectedYear !== ALL_PERIODS && !yearOptions.includes(selectedYear)) {
      setSelectedYear(ALL_PERIODS);
      setSelectedMonth(ALL_PERIODS);
    }
  }, [yearOptions, selectedYear]);

  const monthOptions = useMemo(() => {
    const values = new Set(
      projectScopedSessions
        .filter((session) => selectedYear === ALL_PERIODS || sessionPeriodValue(session).year === selectedYear)
        .map((session) => sessionPeriodValue(session).month)
    );
    return [...values].sort((a, b) => {
      if (a === UNKNOWN_MONTH) return 1;
      if (b === UNKNOWN_MONTH) return -1;
      return Number(b) - Number(a);
    });
  }, [projectScopedSessions, selectedYear]);

  useEffect(() => {
    if (selectedMonth !== ALL_PERIODS && !monthOptions.includes(selectedMonth)) {
      setSelectedMonth(ALL_PERIODS);
    }
  }, [monthOptions, selectedMonth]);

  // When a full-text search is active (matchedSessionIds != null), ignore the
  // local title/ID filter — the search result set is authoritative.
  const baseFiltered = useMemo(
    () => (matchedSessionIds ? sessions : filterSessionList(sessions, filterTerm)),
    [sessions, filterTerm, matchedSessionIds]
  );
  const searchFiltered = useMemo(
    () => (matchedSessionIds ? baseFiltered.filter((session) => matchedSessionIds.has(session.id)) : baseFiltered),
    [baseFiltered, matchedSessionIds]
  );
  const projectFiltered = useMemo(
    () =>
      searchFiltered.filter(
        (session) => selectedProject === ALL_PROJECTS || sessionProjectInfo(session, platform).key === selectedProject
      ),
    [searchFiltered, selectedProject, platform]
  );
  const periodFiltered = useMemo(
    () =>
      projectFiltered.filter((session) => {
        const period = sessionPeriodValue(session);
        return (
          (selectedYear === ALL_PERIODS || period.year === selectedYear) &&
          (selectedMonth === ALL_PERIODS || period.month === selectedMonth)
        );
      }),
    [projectFiltered, selectedYear, selectedMonth]
  );
  // 计数基于「搜索 + 项目 + 年月」之后的结果：切换状态 chip 时数字不会乱跳。
  const statusCounts = useMemo(() => countSessionStatuses(periodFiltered, now), [periodFiltered, now]);
  const filtered = useMemo(
    () =>
      selectedStatus === null
        ? periodFiltered
        : periodFiltered.filter((session) => sessionStatusOf(session, now).kind === selectedStatus),
    [periodFiltered, selectedStatus, now]
  );
  const projectFilterActive = selectedProject !== ALL_PROJECTS;
  const periodFilterActive = selectedYear !== ALL_PERIODS || selectedMonth !== ALL_PERIODS;
  const structuredFilterActive = projectFilterActive || periodFilterActive || selectedStatus !== null;
  const virtualized = filtered.length > VIRT_THRESHOLD;

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => VIRT_ESTIMATE,
    overscan: VIRT_OVERSCAN,
    enabled: virtualized,
    // Defers measurement flushes out of React's commit phase (flushSync warning)
    useAnimationFrameWithResizeObserver: true,
  });

  // Auto-select first session when nothing valid is selected (legacy loadSessions).
  // With cursor pagination only the first page is loaded, so a selection that is
  // missing from `sessions` may simply live on an older, not-yet-loaded page —
  // never clear it while `hasNextPage` is still true.
  useEffect(() => {
    if (!data) return;
    const current = useAppStore.getState().selectedSessionId;
    if (sessions.some((session) => session.id === current)) return;
    if (current && hasNextPage) return;
    setSelectedSessionId(sessions[0]?.id || '');
  }, [data, sessions, hasNextPage, setSelectedSessionId]);

  // ↑↓ keyboard navigation over the filtered list (legacy document keydown)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select') || target.closest('[role="dialog"]')) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const state = useAppStore.getState();
      if (state.view !== 'sessions' || !filtered.length) return;
      const index = filtered.findIndex((item) => item.id === state.selectedSessionId);
      const nextIndex = event.key === 'ArrowDown' ? Math.min(index + 1, filtered.length - 1) : Math.max(index - 1, 0);
      const next = filtered[nextIndex];
      if (!next || next.id === state.selectedSessionId) return;
      event.preventDefault();
      setSelectedSessionId(next.id);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [filtered, setSelectedSessionId]);

  // Keep the selected card visible (legacy scrollSessionIntoView) — also covers
  // ⌘K jumps landing on a card far outside the rendered window.
  useEffect(() => {
    if (!selectedSessionId) return;
    const idx = filtered.findIndex((s) => s.id === selectedSessionId);
    if (idx === -1) return;
    if (virtualized) {
      // rAF: scrollToIndex flushes synchronously — illegal inside the commit phase
      const raf = requestAnimationFrame(() => virtualizer.scrollToIndex(idx, { align: 'auto' }));
      return () => cancelAnimationFrame(raf);
    } else {
      parentRef.current
        ?.querySelector(`[data-session-id="${CSS.escape(selectedSessionId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, virtualized]);

  if (isLoading) {
    return <div className="p-2 text-xs text-muted-foreground">正在加载会话…</div>;
  }
  if (error) {
    return (
      <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        <div>会话加载失败：{(error as Error).message}</div>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void refetch()}>
          重新加载
        </Button>
      </div>
    );
  }

  const resetStructuredFilters = () => {
    setSelectedStatus(null);
    setSelectedProject(ALL_PROJECTS);
    setSelectedYear(ALL_PERIODS);
    setSelectedMonth(ALL_PERIODS);
  };

  // "Load older sessions" footer (mirrors MessageList's #loadMoreBar). With cursor
  // pagination nothing older is fetched until the user asks: the first page is the
  // cheapest possible sidebar load, older pages are opt-in.
  const loadMoreBar = hasNextPage ? (
    <div className="flex justify-center py-2" id="sessionLoadMoreBar">
      <button
        type="button"
        onClick={() => void fetchNextPage()}
        disabled={isFetchingNextPage}
        title={`已加载 ${sessions.length} / 共 ${totalCount} 个会话`}
        className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground disabled:cursor-default disabled:opacity-60"
      >
        {isFetchingNextPage ? '正在加载更早的会话…' : '▼ 加载更早的会话'}
      </button>
    </div>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 状态筛选：看板取消后，四列语义收成这一行 chips，点一下只看该状态。 */}
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="按状态筛选会话">
        <button
          type="button"
          data-testid="status-chip-all"
          aria-pressed={selectedStatus === null}
          title="显示全部状态的会话"
          onClick={() => setSelectedStatus(null)}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
            selectedStatus === null
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border/70 bg-card/70 text-muted-foreground hover:border-border hover:text-foreground'
          )}
        >
          全部
          <span className="text-foreground/80">{statusCounts.total}</span>
        </button>
        {SESSION_STATUS_KINDS.map((kind) => {
          const meta = STATUS_META[kind];
          const count = statusCounts[kind];
          const active = selectedStatus === kind;
          return (
            <button
              key={kind}
              type="button"
              data-tone={meta.tone}
              data-testid={`status-chip-${kind}`}
              aria-pressed={active}
              title={active ? `取消筛选，显示全部状态（${meta.hint}）` : `${meta.hint} — 只看该状态`}
              onClick={() => setSelectedStatus(active ? null : kind)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
                active
                  ? 'border-[color:var(--tone)] bg-[color:var(--tone-soft)] text-[color:var(--tone)]'
                  : 'border-border/70 bg-card/70 text-muted-foreground hover:border-border hover:text-foreground'
              )}
            >
              <StatusDot tone={meta.tone} pulse={kind === 'working' && count > 0} />
              {meta.label}
              <span className="text-foreground/80">{count}</span>
            </button>
          );
        })}
      </div>
      <fieldset className="rounded-xl border border-border/60 bg-card/70 p-3 shadow-soft-sm" aria-label="会话筛选">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <FolderTree className="h-3.5 w-3.5" />
            项目与创建时间
          </span>
          <span>{isSearching ? '搜索中…' : `${filtered.length}/${sessions.length} 个会话`}</span>
        </div>
        <div className="space-y-1.5">
          <Select
            value={selectedProject}
            onValueChange={(value) => {
              setSelectedProject(value);
              setSelectedYear(ALL_PERIODS);
              setSelectedMonth(ALL_PERIODS);
            }}
          >
            <SelectTrigger className="h-8 w-full text-xs" aria-label="筛选项目">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>全部项目（{sessions.length}）</SelectItem>
              {availableProjects.map((project) => (
                <SelectItem
                  key={project.key}
                  value={project.key}
                  className="text-xs"
                  title={project.path || project.name}
                >
                  {project.label}（{project.count}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <CalendarRange className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Select
              value={selectedYear}
              onValueChange={(value) => {
                setSelectedYear(value);
                setSelectedMonth(ALL_PERIODS);
              }}
            >
              <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label="筛选年份">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PERIODS}>全部年份</SelectItem>
                {yearOptions.map((year) => (
                  <SelectItem key={year} value={year}>
                    {periodLabel(year, 'year')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedMonth} onValueChange={setSelectedMonth}>
              <SelectTrigger className="h-8 min-w-0 flex-1 text-xs" aria-label="筛选月份">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PERIODS}>全部月份</SelectItem>
                {monthOptions.map((month) => (
                  <SelectItem key={month} value={month}>
                    {periodLabel(month, 'month')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {structuredFilterActive ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={resetStructuredFilters}
                title="清除状态、项目和年月筛选"
                aria-label="清除状态、项目和年月筛选"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </fieldset>

      {isSearching ? (
        <div className="p-2 text-xs text-muted-foreground">正在搜索当前平台会话…</div>
      ) : !sessions.length ? (
        <div className="p-2 text-xs text-muted-foreground">当前平台暂无会话。</div>
      ) : !filtered.length ? (
        <div className="space-y-2 p-2 text-xs text-muted-foreground">
          <div>没有符合当前搜索、状态、项目或年月条件的会话。</div>
          {structuredFilterActive ? (
            <button type="button" onClick={resetStructuredFilters} className="text-primary hover:underline">
              清除状态、项目和年月筛选
            </button>
          ) : null}
          {/* The matching session may be on an older, not-yet-loaded page. */}
          {loadMoreBar}
        </div>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="session-list">
          {virtualized ? (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((row) => {
                const session = filtered[row.index];
                return (
                  <div
                    key={session.id}
                    ref={virtualizer.measureElement}
                    data-index={row.index}
                    className="absolute left-0 top-0 w-full pb-2"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <SessionCard
                      session={session}
                      active={session.id === selectedSessionId}
                      now={now}
                      onSelect={selectSession}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  active={session.id === selectedSessionId}
                  now={now}
                  onSelect={setSelectedSessionId}
                />
              ))}
            </div>
          )}
          {loadMoreBar}
        </div>
      )}
    </div>
  );
}
