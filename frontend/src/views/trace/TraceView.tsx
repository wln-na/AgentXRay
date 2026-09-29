// Trace waterfall view (Langfuse-style per-turn spans), ported from
// public/js/app.js renderTrace: one card per user turn, bars scaled to the
// turn's own timeline — blue model / green tool / red tool-error / purple
// spawned sub-agent (overlap = parallelism). Clicking a bar opens the span
// sidebar; clicking a purple bar loads that child agent's transcript.

import { useEffect, useMemo, useState } from 'react';
import {
  analyzeHealth,
  buildTraceTurns,
  flattenSpans,
  formatDurationCompact,
  formatTokensCompact,
  healthColor,
  healthLabel,
  parseTimestampMs,
  toolMeta,
} from '@/lib/pure';
import type { TraceSpan, TraceTurn } from '@/lib/pure';
import { useAppStore } from '@/store';
import { SpanSidebar } from './SpanSidebar';
import { childAgentLabel, useActiveSessionDetail, useChildrenQuery } from './childAgents';

const BAR_COLORS: Record<TraceSpan['kind'], string> = {
  chat: '#58a6ff',
  tool: '#3fb950',
  'tool-error': '#f85149',
  agent: '#d2a8ff',
};
// Pure-reasoning chat spans (no text output) get a lighter, dashed bar so
// they are visually distinct from spans that produced a visible reply.
const CHAT_PURE_REASONING_COLOR = '#58a6ff66';
const CHAT_FINAL_REPLY_COLOR = '#1f6feb';

function spanBarColor(span: TraceSpan): string {
  if (span.kind === 'chat') {
    if (span.isFinalReply) return CHAT_FINAL_REPLY_COLOR;
    if (!span.hasText) return CHAT_PURE_REASONING_COLOR;
  }
  return BAR_COLORS[span.kind];
}

function spanBarStyle(span: TraceSpan): React.CSSProperties {
  const base: React.CSSProperties = { background: spanBarColor(span) };
  // Pure-reasoning chat spans: dashed border to signal "no visible output"
  if (span.kind === 'chat' && !span.hasText && !span.isFinalReply) {
    base.border = '1px dashed #58a6ff';
    base.background = 'transparent';
  }
  // Final reply: slightly thicker via outline
  if (span.isFinalReply) {
    base.outline = '1.5px solid #1f6feb';
    base.outlineOffset = '1px';
  }
  return base;
}

const LEGEND: { color: string; label: string; dashed?: boolean }[] = [
  { color: '#1f6feb', label: '最终回复' },
  { color: '#58a6ff', label: '模型推理（有文本）' },
  { color: '#58a6ff66', label: '纯思考（无文本）', dashed: true },
  { color: '#3fb950', label: '工具执行' },
  { color: '#f85149', label: '工具报错' },
  { color: '#d2a8ff', label: '子 Agent' },
];

function spanIcon(kind: TraceSpan['kind'], label?: string): string {
  if (kind === 'chat') return '🤖';
  if (kind === 'agent') return '🌳';
  // Tool spans: use the category icon from toolMeta (⌨️ 执行命令 / 📖 读取文件 / …)
  return label ? toolMeta(label).icon : '🔧';
}

/** Display label for a span: Chinese category + concrete subject for tools,
 *  raw label for chat/agent. e.g. `📖 读取文件 · src/foo.ts` */
function spanDisplayLabel(span: TraceSpan): string {
  if (span.kind === 'chat' || span.kind === 'agent') return span.label;
  const meta = toolMeta(span.label);
  return span.subject ? `${meta.label} · ${span.subject}` : meta.label;
}

function spanDurationText(span: TraceSpan): string {
  const duration = formatDurationCompact(span.end - span.start);
  if (span.durationSource === 'estimated') return `约 ${duration}（估算）`;
  if (span.durationSource === 'unknown') return '耗时未知';
  return duration;
}

/** Recursive tree row for a single span + its children.
 *  Chat spans with children get a collapse toggle; tool/agent spans are
 *  leaves (or parents in deeper nesting levels). Indentation grows with
 *  depth so the parent-child relationship is visually obvious. */
function SpanRow({
  span,
  turnStart,
  dur,
  depth,
  repeat,
  onSpanClick,
  onAgentClick,
}: {
  span: TraceSpan;
  turnStart: number;
  dur: number;
  depth: number;
  repeat?: { count: number; isFirst: boolean };
  onSpanClick: (span: TraceSpan) => void;
  onAgentClick: (name: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = span.children && span.children.length > 0;
  const left = ((span.start - turnStart) / dur) * 100;
  const width = Math.max(((span.end - span.start) / dur) * 100, 0.4);
  const durText = spanDurationText(span);
  const isAgent = span.kind === 'agent';
  const displayLabel = spanDisplayLabel(span);
  const isAnomalous = repeat !== undefined || span.kind === 'tool-error';
  const title = isAgent
    ? `子 Agent ${span.label} — ${durText}，点击查看其执行记录`
    : `${displayLabel} — ${durText}${repeat ? ` · 连续重复 ${repeat.count} 次` : ''}，点击查看详情`;

  return (
    <div>
      <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 sm:mb-1 sm:grid-cols-[150px_minmax(0,1fr)_110px] lg:grid-cols-[170px_minmax(0,1fr)_110px] sm:gap-2.5">
        <div
          className="truncate font-mono text-xs text-muted-foreground sm:text-right"
          style={{ paddingLeft: depth > 0 ? `${depth * 16}px` : undefined }}
          title={displayLabel}
        >
          {hasChildren && (
            <button
              className="mr-1 inline-block w-3.5 text-center text-[0.65rem] text-muted-foreground hover:text-foreground"
              onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
              title={collapsed ? '展开子节点' : '折叠子节点'}
            >
              {collapsed ? '▶' : '▼'}
            </button>
          )}
          {!hasChildren && depth > 0 && <span className="mr-1 inline-block w-3.5 text-center text-[0.65rem] text-muted-foreground/40">└</span>}
          {spanIcon(span.kind, span.label)} {displayLabel}
          {repeat && repeat.isFirst && (
            <span
              className="ml-1 inline-block rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-amber-400"
              title={`连续重复调用 ${repeat.count} 次，可能存在循环`}
            >
              重复×{repeat.count}
            </span>
          )}
          {span.kind === 'tool-error' && (
            <span
              className="ml-1 inline-block rounded-full border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-red-400"
              title="工具调用失败"
            >
              错误
            </span>
          )}
        </div>
        <span
          className="whitespace-nowrap text-right font-mono text-[0.68rem] text-muted-foreground sm:col-start-3"
          title={durText}
        >
          {durText}
          {span.totalTokens && span.totalTokens > 0 ? (
            <span
              className="ml-1.5 inline-block rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-blue-400"
              title={`${formatTokensCompact(span.totalTokens)} tokens · 点击查看明细`}
            >
              {formatTokensCompact(span.totalTokens)}
            </span>
          ) : null}
        </span>
        <div className="relative col-span-2 h-3.5 sm:col-span-1 sm:col-start-2 sm:row-start-1">
          <div
            className={`absolute top-0 h-3.5 min-w-1 cursor-pointer rounded-sm opacity-90 hover:opacity-100 hover:outline hover:outline-1 hover:outline-foreground ${
              isAnomalous ? 'outline outline-1 outline-amber-500/60' : ''
            }`}
            style={{
              left: `${left.toFixed(2)}%`,
              width: `${width.toFixed(2)}%`,
              ...spanBarStyle(span),
            }}
            title={title}
            onClick={() => {
              if (isAgent) {
                if (span.agentName) onAgentClick(span.agentName);
              } else {
                onSpanClick(span);
              }
            }}
          >
          </div>
        </div>
      </div>
      {/* Recursively render children unless collapsed */}
      {hasChildren && !collapsed && (
        <div>
          {span.children!.map((child, ci) => {
            // Compute repeat info within this sibling group
            const prevChild = ci > 0 ? span.children![ci - 1] : null;
            const isTool = child.kind === 'tool' || child.kind === 'tool-error';
            let childRepeat: { count: number; isFirst: boolean } | undefined;
            if (isTool && prevChild && (prevChild.kind === 'tool' || prevChild.kind === 'tool-error') && prevChild.label === child.label) {
              // Count run length
              let runLen = 1;
              for (let j = ci - 1; j >= 0; j--) {
                const p = span.children![j];
                if ((p.kind === 'tool' || p.kind === 'tool-error') && p.label === child.label) runLen++;
                else break;
              }
              // Check if this is the first in the run
              const isFirst = ci - runLen + 1 === ci ? false : ci === 0 || span.children![ci - 1].label !== child.label;
              childRepeat = { count: runLen, isFirst: isFirst || runLen === 1 };
            }
            return (
              <SpanRow
                key={ci}
                span={child}
                turnStart={turnStart}
                dur={dur}
                depth={depth + 1}
                repeat={childRepeat}
                onSpanClick={onSpanClick}
                onAgentClick={onAgentClick}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function TurnCard({
  turn,
  onSpanClick,
  onAgentClick,
}: {
  turn: TraceTurn;
  onSpanClick: (span: TraceSpan) => void;
  onAgentClick: (name: string) => void;
}) {
  const dur = Math.max(turn.end - turn.start, 1);
  // Per-turn span stats — must flatten the tree to count nested tool/agent spans.
  const allSpans = flattenSpans(turn.spans);
  const stats = allSpans.reduce(
    (acc, s) => {
      if (s.kind === 'tool') acc.tools++;
      else if (s.kind === 'tool-error') acc.errors++;
      else if (s.kind === 'chat') acc.thinking++;
      else if (s.kind === 'agent') acc.agents++;
      return acc;
    },
    { tools: 0, errors: 0, thinking: 0, agents: 0 }
  );

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-border bg-[hsl(var(--panel-alt))] px-3 py-1.5 text-sm">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {new Date(turn.start).toLocaleTimeString()}
        </span>
        <span className="min-w-0 flex-1 truncate" title={turn.text}>
          👤 {turn.text}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {stats.thinking > 0 && (
            <span className="rounded-full border border-[#58a6ff]/30 bg-[#58a6ff]/10 px-1.5 py-0.5 font-mono text-[0.65rem] text-[#58a6ff]" title="模型推理阶段">
              🤔 {stats.thinking}
            </span>
          )}
          {stats.tools > 0 && (
            <span className="rounded-full border border-[#3fb950]/30 bg-[#3fb950]/10 px-1.5 py-0.5 font-mono text-[0.65rem] text-[#3fb950]" title="工具调用次数">
              🔧 {stats.tools}
            </span>
          )}
          {stats.errors > 0 && (
            <span className="rounded-full border border-[#f85149]/30 bg-[#f85149]/10 px-1.5 py-0.5 font-mono text-[0.65rem] text-[#f85149]" title="工具报错次数">
              ❌ {stats.errors}
            </span>
          )}
          {stats.agents > 0 && (
            <span className="rounded-full border border-[#d2a8ff]/30 bg-[#d2a8ff]/10 px-1.5 py-0.5 font-mono text-[0.65rem] text-[#d2a8ff]" title="子 Agent 调用">
              🌳 {stats.agents}
            </span>
          )}
        </span>
        <span className="shrink-0 font-mono text-xs text-[#58a6ff]">
          {formatDurationCompact(turn.end - turn.start)}
        </span>
      </div>
      <div className="px-3 pb-2.5 pt-1.5">
        {turn.spans.map((s, i) => {
          // Compute repeat info for root-level sibling spans
          const prev = i > 0 ? turn.spans[i - 1] : null;
          const isTool = s.kind === 'tool' || s.kind === 'tool-error';
          let rootRepeat: { count: number; isFirst: boolean } | undefined;
          if (isTool && prev && (prev.kind === 'tool' || prev.kind === 'tool-error') && prev.label === s.label) {
            let runLen = 1;
            for (let j = i - 1; j >= 0; j--) {
              const p = turn.spans[j];
              if ((p.kind === 'tool' || p.kind === 'tool-error') && p.label === s.label) runLen++;
              else break;
            }
            rootRepeat = { count: runLen, isFirst: i - runLen + 1 === i };
          }
          return (
            <SpanRow
              key={i}
              span={s}
              turnStart={turn.start}
              dur={dur}
              depth={0}
              repeat={rootRepeat}
              onSpanClick={onSpanClick}
              onAgentClick={onAgentClick}
            />
          );
        })}
      </div>
    </div>
  );
}

export function TraceView() {
  const platform = useAppStore((s) => s.platform);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const setViewingChildAgent = useAppStore((s) => s.setViewingChildAgent);
  const msgOrder = useAppStore((s) => s.msgOrder);
  const detail = useActiveSessionDetail();
  const childrenQuery = useChildrenQuery();
  const msgs = detail.data?.messages;
  const children = childrenQuery.data;
  const [activeSpan, setActiveSpan] = useState<TraceSpan | null>(null);

  // Transcript swap (session/child change) invalidates the open span
  useEffect(() => setActiveSpan(null), [msgs]);

  const turns = useMemo(() => {
    // Child trace must not embed sibling agent spans (legacy childAgentViewing guard)
    const agentSpans = viewingChildAgent
      ? []
      : (children ?? []).map((c) => ({
          name: c.name,
          label: childAgentLabel(c, platform),
          start: parseTimestampMs(c.timestamp),
          end: parseTimestampMs(c.lastActivity),
        }));
    const built = buildTraceTurns(msgs ?? [], agentSpans);
    // Mirror the message list's order toggle: newest-first = reverse (latest
    // turn on top); oldest-first = natural chronological order. Spans inside
    // each turn stay in time order — the waterfall is left-to-right per turn.
    return msgOrder === 'newest-first' ? [...built].reverse() : built;
  }, [msgs, children, viewingChildAgent, platform, msgOrder]);

  // Health score + per-turn segments for the timeline. Computed from the
  // chronological (un-reversed) turns so segment order is stable.
  const health = useMemo(() => {
    const chronological = msgOrder === 'newest-first' ? [...turns].reverse() : turns;
    return analyzeHealth(chronological);
  }, [turns, msgOrder]);

  if (detail.isLoading || (!viewingChildAgent && childrenQuery.isLoading)) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!turns.length) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        此会话没有可视化的时间数据（消息缺少时间戳或没有模型/工具活动）。
      </div>
    );
  }

  return (
    <div className="py-3">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {LEGEND.map((l) => (
          <span key={l.label}>
            <span
              className="mr-1 inline-block h-2.5 w-2.5 rounded-sm align-middle"
              style={
                l.dashed
                  ? { border: '1px dashed #58a6ff', background: 'transparent' }
                  : { background: l.color }
              }
            />
            {l.label}
          </span>
        ))}
        <span className="w-full sm:ml-auto sm:w-auto">
          每轮独立时间轴 · 点击色条查看详情 ·
          <span className="ml-1 text-[#58a6ff]">{msgOrder === 'newest-first' ? '最新在上' : '最早在上'}</span>
          （点上方「改为最早/最新在上」切换）
        </span>
      </div>

      {/* Health timeline: overall score badge + per-turn color bar.
          Green=healthy, yellow=good, orange=fair, red=anomalous.
          Clicking a segment scrolls to that turn's card. */}
      <div className="mb-4 rounded-lg border border-border bg-card/50 p-3">
        <div className="mb-2 flex items-center gap-3">
          <span
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold text-white"
            style={{ backgroundColor: healthColor(health.overall) }}
            title={`健康度 ${health.overall}/100 · ${healthLabel(health.overall)}`}
          >
            {health.overall}
          </span>
          <div className="flex-1">
            <div className="text-sm font-medium text-foreground">
              会话健康度 · {healthLabel(health.overall)}
            </div>
            <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
              <span>完成 {health.dimensions.completion}</span>
              <span>效率 {health.dimensions.efficiency}</span>
              <span>工具质量 {health.dimensions.toolQuality}</span>
              <span>错误恢复 {health.dimensions.errorResilience}</span>
            </div>
          </div>
          {health.flags.length > 0 && (
            <div className="max-w-xs text-right text-xs">
              {health.flags.slice(0, 2).map((f, i) => (
                <div key={i} className={f.type === 'error' ? 'text-red-500' : f.type === 'warning' ? 'text-amber-500' : 'text-muted-foreground'}>
                  {f.type === 'error' ? '❌' : f.type === 'warning' ? '⚠️' : 'ℹ️'} {f.message}
                </div>
              ))}
              {health.flags.length > 2 && <div className="text-muted-foreground">+{health.flags.length - 2} 更多标记</div>}
            </div>
          )}
        </div>
        {/* Per-turn health bar */}
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-secondary">
          {health.segments.map((seg, i) => {
            const totalDuration = health.segments.reduce((s, x) => s + (x.end - x.start), 0) || 1;
            const widthPct = ((seg.end - seg.start) / totalDuration) * 100;
            return (
              <div
                key={i}
                className="h-full cursor-pointer transition-opacity hover:opacity-80"
                style={{ width: `${widthPct}%`, backgroundColor: healthColor(seg.score) }}
                title={`${seg.label} · 健康度 ${seg.score}`}
              />
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[0.65rem] text-muted-foreground">
          <span>开始</span>
          <span>{health.segments.length} 轮</span>
          <span>结束</span>
        </div>
      </div>

      {turns.map((turn, i) => (
        <TurnCard
          key={`${turn.start}-${i}`}
          turn={turn}
          onSpanClick={setActiveSpan}
          onAgentClick={setViewingChildAgent}
        />
      ))}
      {activeSpan && (
        <SpanSidebar span={activeSpan} msgs={msgs ?? []} onClose={() => setActiveSpan(null)} />
      )}
    </div>
  );
}
