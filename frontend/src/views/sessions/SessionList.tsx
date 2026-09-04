// Sidebar session list: cards, >200-item virtualization, ↑↓ keyboard nav,
// auto-select-first — ported from legacy renderSessions/sessionCardHtml.

import { useVirtualizer } from '@tanstack/react-virtual';
import { CalendarRange, FolderTree, RotateCcw } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDurationCompact, parseTimestampMs } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store';
import { filterSessionList, formatDate } from './lib';
import { useSessionsList } from './queries';

const VIRT_THRESHOLD = 200; // below this many sessions, render everything
const VIRT_OVERSCAN = 10; // extra cards above/below the visible range
const VIRT_ESTIMATE = 96; // estimated card height incl. gap

const SOURCE_ICONS: Record<string, string> = {
  cli: '⌨️',
  telegram: '✈️',
  discord: '🎮',
  weixin: '💬',
  wechat: '💬',
  slack: '💼',
  web: '🌐',
  feishu: '🐦',
  whatsapp: '📱',
};

function chipTexts(session: SessionSummary): string[] {
  const chips: string[] = [];
  if (session.userCount) chips.push(`👤 ${session.userCount}`);
  if (session.assistantCount) chips.push(`🤖 ${session.assistantCount}`);
  if (session.toolCallCount) chips.push(`🔧 ${session.toolCallCount}`);
  if (session.spawnCount) chips.push(`🌳 ${session.spawnCount} spawn`);
  if (session.childCount) chips.push(`🌳 ${session.childCount} 子 Agent`);
  if (session.model) chips.push(`🧠 ${session.model.split('/').pop()}`);
  if (session.source) chips.push(`${SOURCE_ICONS[session.source.toLowerCase()] || '📡'} ${session.source}`);
  const startMs = parseTimestampMs(session.timestamp);
  const endMs = parseTimestampMs(session.lastActivity);
  if (startMs && endMs && endMs - startMs >= 5000) chips.push(`⏱ ${formatDurationCompact(endMs - startMs)}`);
  return chips;
}

const SessionCard = memo(function SessionCard({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const onClick = () => onSelect(session.id);
  const preview = session.firstUserMessage
    ? session.firstUserMessage.length > 80
      ? session.firstUserMessage.slice(0, 80) + '…'
      : session.firstUserMessage
    : '';
  return (
    <div
      tabIndex={0}
      data-session-id={session.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      className={cn(
        'cursor-pointer rounded-md border px-2.5 py-2 text-xs transition-colors',
        active
          ? 'border-primary/70 bg-primary/10'
          : 'border-border bg-card/60 hover:border-primary/40 hover:bg-card'
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{formatDate(session.timestamp)}</span>
        {session.archived ? (
          <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1 py-px text-[10px] text-amber-700 dark:text-amber-300">
            已归档
          </span>
        ) : session.status ? (
          <span className="rounded border border-border px-1 py-px text-[10px] uppercase">{session.status}</span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {chipTexts(session).map((chip) => (
          <span key={chip} className="rounded bg-secondary px-1 py-px text-[10px] text-muted-foreground">
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-1 truncate font-medium text-foreground">{session.title || session.id}</div>
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

function sessionProject(session: SessionSummary, platform: string): string {
  return sessionProjectInfo(session, platform).name;
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

function sessionPeriod(session: SessionSummary): SessionPeriod {
  const { year, month } = sessionPeriodValue(session);
  return {
    year: year === UNKNOWN_YEAR ? '时间未知' : `${year}年`,
    month: month === UNKNOWN_MONTH ? '月份未知' : `${month}月`,
  };
}

function periodLabel(value: string, unit: 'year' | 'month'): string {
  if (value === ALL_PERIODS) return unit === 'year' ? '全部年份' : '全部月份';
  if (value === UNKNOWN_YEAR) return '时间未知';
  if (value === UNKNOWN_MONTH) return '月份未知';
  return unit === 'year' ? `${value}年` : `${value}月`;
}

function groupedSessions(sessions: SessionSummary[], platform: string) {
  const groups = new Map<string, Map<string, Map<string, SessionSummary[]>>>();
  const sortedSessions = [...sessions].sort((a, b) => {
    const aMs = parseTimestampMs(a.lastActivity || a.timestamp) || 0;
    const bMs = parseTimestampMs(b.lastActivity || b.timestamp) || 0;
    return bMs - aMs;
  });
  for (const session of sortedSessions) {
    const project = sessionProject(session, platform) || '会话';
    const { year, month } = sessionPeriod(session);
    if (!groups.has(year)) groups.set(year, new Map());
    const projects = groups.get(year) as Map<string, Map<string, SessionSummary[]>>;
    if (!projects.has(project)) projects.set(project, new Map());
    const months = projects.get(project) as Map<string, SessionSummary[]>;
    const items = months.get(month) || [];
    items.push(session);
    months.set(month, items);
  }
  return groups;
}

function SessionGroups({
  sessions,
  platform,
  selectedSessionId,
  onSelect,
}: {
  sessions: SessionSummary[];
  platform: string;
  selectedSessionId: string;
  onSelect: (id: string) => void;
}) {
  const groups = useMemo(() => groupedSessions(sessions, platform), [sessions, platform]);
  return (
    <div className="flex flex-col gap-4">
      {Array.from(groups).map(([year, projects]) => {
        const yearCount = Array.from(projects.values()).reduce(
          (yearSum, months) =>
            yearSum + Array.from(months.values()).reduce((monthSum, items) => monthSum + items.length, 0),
          0
        );
        return (
          <section
            key={year}
            className="space-y-3"
            style={{ contentVisibility: 'auto', containIntrinsicSize: '0 520px' }}
          >
            <div className="sticky top-0 z-[3] rounded bg-background/95 px-1 py-1 text-xs font-semibold text-foreground backdrop-blur">
              {year} <span className="font-normal text-muted-foreground">({yearCount})</span>
            </div>
            {Array.from(projects).map(([project, months]) => {
              const projectCount = Array.from(months.values()).reduce((sum, items) => sum + items.length, 0);
              return (
                <div key={`${year}:${project}`} className="space-y-2 pl-1">
                  <div className="sticky top-7 z-[2] bg-background/95 px-2 py-0.5 text-[11px] font-semibold text-foreground backdrop-blur">
                    {project} <span className="font-normal text-muted-foreground">· {projectCount}</span>
                  </div>
                  {Array.from(months).map(([month, items]) => (
                    <div key={`${year}:${project}:${month}`} className="space-y-2 pl-2">
                      <div className="sticky top-12 z-[1] border-l-2 border-primary/30 bg-background/95 px-2 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
                        {month} · {items.length}
                      </div>
                      {items.map((session) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          active={session.id === selectedSessionId}
                          onSelect={onSelect}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

export function SessionList({
  filterTerm,
  matchedSessionIds,
  isSearching = false,
}: {
  filterTerm: string;
  matchedSessionIds?: Set<string> | null;
  isSearching?: boolean;
}) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const platform = useAppStore((s) => s.platform);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const { data, isLoading, error, refetch } = useSessionsList();
  const sessions = data ?? [];
  const [selectedProject, setSelectedProject] = useState(ALL_PROJECTS);
  const [selectedYear, setSelectedYear] = useState(ALL_PERIODS);
  const [selectedMonth, setSelectedMonth] = useState(ALL_PERIODS);

  useEffect(() => {
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
        (session) =>
          selectedProject === ALL_PROJECTS || sessionProjectInfo(session, platform).key === selectedProject
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
    () =>
      matchedSessionIds ? baseFiltered.filter((session) => matchedSessionIds.has(session.id)) : baseFiltered,
    [baseFiltered, matchedSessionIds]
  );
  const projectFiltered = useMemo(
    () =>
      searchFiltered.filter(
        (session) =>
          selectedProject === ALL_PROJECTS || sessionProjectInfo(session, platform).key === selectedProject
      ),
    [searchFiltered, selectedProject, platform]
  );
  const filtered = useMemo(
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
  const projectFilterActive = selectedProject !== ALL_PROJECTS;
  const periodFilterActive = selectedYear !== ALL_PERIODS || selectedMonth !== ALL_PERIODS;
  const structuredFilterActive = projectFilterActive || periodFilterActive;
  const groupedPlatform = platform === 'doubao' || platform === 'codex';
  const virtualized = !groupedPlatform && filtered.length > VIRT_THRESHOLD;

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

  // Auto-select first session when nothing valid is selected (legacy loadSessions)
  useEffect(() => {
    if (!data) return;
    if (!data.some((s) => s.id === useAppStore.getState().selectedSessionId)) {
      setSelectedSessionId(data[0]?.id || '');
    }
  }, [data, setSelectedSessionId]);

  // ↑↓ keyboard navigation over the filtered list (legacy document keydown)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select') || target.closest('[role="dialog"]')) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const state = useAppStore.getState();
      if (state.view !== 'sessions' || !filtered.length) return;
      const index = filtered.findIndex((item) => item.id === state.selectedSessionId);
      const nextIndex =
        event.key === 'ArrowDown' ? Math.min(index + 1, filtered.length - 1) : Math.max(index - 1, 0);
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
    setSelectedProject(ALL_PROJECTS);
    setSelectedYear(ALL_PERIODS);
    setSelectedMonth(ALL_PERIODS);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="rounded-md border border-border bg-card/60 p-2" aria-label="会话筛选">
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
                <SelectItem key={project.key} value={project.key} className="text-xs" title={project.path || project.name}>
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
                title="清除项目和年月筛选"
                aria-label="清除项目和年月筛选"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {isSearching ? (
        <div className="p-2 text-xs text-muted-foreground">正在搜索当前平台会话…</div>
      ) : !sessions.length ? (
        <div className="p-2 text-xs text-muted-foreground">当前平台暂无会话。</div>
      ) : !filtered.length ? (
        <div className="space-y-2 p-2 text-xs text-muted-foreground">
          <div>没有符合当前搜索、项目或年月条件的会话。</div>
          {structuredFilterActive ? (
            <button type="button" onClick={resetStructuredFilters} className="text-primary hover:underline">
              清除项目和年月筛选
            </button>
          ) : null}
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
                  onSelect={setSelectedSessionId}
                />
              </div>
            );
          })}
        </div>
      ) : groupedPlatform ? (
        <SessionGroups
          sessions={filtered}
          platform={platform}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              active={session.id === selectedSessionId}
              onSelect={setSelectedSessionId}
            />
          ))}
        </div>
      )}
        </div>
      )}
    </div>
  );
}
