import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Circle, Clock3, ListTodo } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getSessionTaskAnalysis } from '@/api/client';
import type { Platform, SessionMessage, SessionTaskRecord } from '@/api/types';
import { formatDurationCompact, parseTimestampMs } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { extractTaskTimeline, type SessionTask, type SessionTaskStatus } from './taskTimeline';

const STATUS_META: Record<SessionTaskStatus, { label: string; className: string }> = {
  pending: { label: '待开始', className: 'text-muted-foreground' },
  in_progress: { label: '进行中', className: 'text-sky-700 dark:text-sky-300' },
  completed: { label: '已完成', className: 'text-emerald-700 dark:text-emerald-300' },
};

function TaskRow({ task, onJump, now }: { task: SessionTask; onJump: (id: string) => void; now: number }) {
  const startedAt = parseTimestampMs(task.startedAt);
  const completedAt = parseTimestampMs(task.completedAt);
  const elapsed = startedAt === null ? null : Math.max(0, (completedAt ?? now) - startedAt);
  const meta = STATUS_META[task.status];
  const statusMessageId = task.statusMessageId;

  return (
    <div className="flex min-w-0 items-center gap-3 border-t border-border/60 py-2.5 first:border-t-0">
      <span className={cn('shrink-0', meta.className)} title={meta.label}>
        {task.status === 'completed' ? (
          <Check className="h-4 w-4" />
        ) : task.status === 'in_progress' ? (
          <Clock3 className="h-4 w-4" />
        ) : (
          <Circle className="h-3.5 w-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn('truncate text-sm', task.status === 'completed' && 'text-muted-foreground')}
          title={task.title}
        >
          {task.title}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {meta.label}
          {task.source === 'llm' ? ' · LLM 归类' : ''}
          {task.source === 'inferred' ? ' · 根据会话轨迹推断' : ''}
          {elapsed !== null ? ` · ${formatDurationCompact(elapsed)}` : ''}
        </div>
      </div>
      {statusMessageId ? (
        <button
          type="button"
          className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="跳转到这项任务最近一次状态记录"
          onClick={() => onJump(statusMessageId)}
        >
          查看记录
        </button>
      ) : null}
    </div>
  );
}

function mapLlmTasks(tasks: SessionTaskRecord[]): SessionTask[] {
  return tasks.map((task) => ({
    key: task.key,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    statusMessageId: task.statusMessageId,
    source: task.source === 'llm' ? 'llm' : 'inferred',
    confidence: task.confidence,
  }));
}

export function TaskPanel({
  messages,
  platform,
  sessionId,
  agent,
  dir,
  onJump,
}: {
  messages: SessionMessage[];
  platform: Platform;
  sessionId?: string | null;
  agent?: string;
  dir?: string;
  onJump: (id: string) => void;
}) {
  const localTasks = useMemo(() => extractTaskTimeline(messages, platform), [messages, platform]);
  const analysisQuery = useQuery({
    queryKey: ['session-tasks', platform, sessionId || '', agent || '', dir || ''],
    queryFn: () => getSessionTaskAnalysis(platform, sessionId || '', { agent, dir }),
    enabled: !!sessionId,
    staleTime: 5 * 60 * 1000,
    // A local 7B model may need tens of seconds for a large transcript. Keep
    // the inferred panel responsive and check for the refined names less often.
    refetchInterval: (query) => (query.state.data?.classificationPending ? 15_000 : false),
  });
  const tasks = useMemo(() => {
    if (analysisQuery.data?.tasks.length && ['llm', 'inferred'].includes(analysisQuery.data.source)) {
      return mapLlmTasks(analysisQuery.data.tasks);
    }
    return localTasks;
  }, [analysisQuery.data, localTasks]);
  const [collapsed, setCollapsed] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!tasks.some((task) => task.status === 'in_progress')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [tasks]);

  if (!tasks.length) {
    if (!analysisQuery.isPending) return null;
    return (
      <section className="mb-3 rounded-lg border border-border/70 bg-card px-4 py-3" data-testid="task-panel-loading">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ListTodo className="h-4 w-4 text-muted-foreground" />
          正在归类会话任务…
        </div>
      </section>
    );
  }

  const isLlm = analysisQuery.data?.source === 'llm' && tasks.some((task) => task.source === 'llm');

  const groups: Record<SessionTaskStatus, SessionTask[]> = {
    in_progress: tasks.filter((task) => task.status === 'in_progress'),
    pending: tasks.filter((task) => task.status === 'pending'),
    completed: tasks.filter((task) => task.status === 'completed'),
  };
  const completedCount = groups.completed.length;
  const progress = tasks.length ? (completedCount / tasks.length) * 100 : 0;

  return (
    <section className="mb-3 rounded-lg border border-border/70 bg-card px-4 py-3" data-testid="task-panel">
      <div className="flex flex-wrap items-center gap-2">
        <ListTodo className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">任务进度</h3>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">{tasks.length}</span>
        <span
          className="text-[11px] text-muted-foreground"
          title={isLlm ? '任务由 LLM 根据多条用户消息、执行轮次和工具轨迹归类' : '来自会话中的结构化任务记录'}
        >
          {analysisQuery.isFetching && !analysisQuery.isPending
            ? '正在更新'
            : analysisQuery.data?.classificationPending
              ? 'LLM 分类中'
              : isLlm
                ? 'LLM 归类'
                : tasks.some((task) => task.source === 'inferred')
                  ? '轨迹兜底'
                  : '任务记录'}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {completedCount} / {tasks.length} 已完成
        </span>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={collapsed ? '展开任务面板' : '折叠任务面板'}
          title={collapsed ? '展开任务面板' : '折叠任务面板'}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', collapsed && '-rotate-90')} />
        </button>
      </div>
      {!collapsed ? (
        <>
          <div
            className="mt-2 h-1 overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            aria-label="任务完成进度"
            aria-valuemin={0}
            aria-valuemax={tasks.length}
            aria-valuenow={completedCount}
          >
            <div className="h-full rounded-full bg-emerald-600 transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          {groups.in_progress.length ? (
            <div className="mt-2.5">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-sky-700 dark:text-sky-300">
                进行中 <span className="font-normal text-muted-foreground">{groups.in_progress.length}</span>
              </div>
              {groups.in_progress.map((task) => (
                <TaskRow key={task.key} task={task} onJump={onJump} now={now} />
              ))}
            </div>
          ) : null}
          {groups.pending.length ? (
            <div className="mt-2.5">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
                待开始 <span className="font-normal">{groups.pending.length}</span>
              </div>
              {groups.pending.map((task) => (
                <TaskRow key={task.key} task={task} onJump={onJump} now={now} />
              ))}
            </div>
          ) : null}
          {completedCount ? (
            <div className="mt-2.5">
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 dark:text-emerald-300"
                onClick={() => setShowCompleted((value) => !value)}
              >
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !showCompleted && '-rotate-90')} />
                已完成 {completedCount}
              </button>
              {showCompleted ? (
                <div className="mt-1">
                  {groups.completed.map((task) => (
                    <TaskRow key={task.key} task={task} onJump={onJump} now={now} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
