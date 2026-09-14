// Trace waterfall view (Langfuse-style per-turn spans), ported from
// public/js/app.js renderTrace: one card per user turn, bars scaled to the
// turn's own timeline — blue model / green tool / red tool-error / purple
// spawned sub-agent (overlap = parallelism). Clicking a bar opens the span
// sidebar; clicking a purple bar loads that child agent's transcript.

import { useEffect, useMemo, useState } from 'react';
import { buildTraceTurns, formatDurationCompact, parseTimestampMs, toolMeta } from '@/lib/pure';
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
  // Per-turn span stats (borrowed from botmux's "已调用 N 次工具" badge)
  const stats = turn.spans.reduce(
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
          const left = ((s.start - turn.start) / dur) * 100;
          const width = Math.max(((s.end - s.start) / dur) * 100, 0.4);
          const durText = spanDurationText(s);
          const isAgent = s.kind === 'agent';
          const displayLabel = spanDisplayLabel(s);
          const title = isAgent
            ? `子 Agent ${s.label} — ${durText}，点击查看其执行记录`
            : `${displayLabel} — ${durText}，点击查看详情`;
          return (
            <div key={i} className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 sm:mb-1 sm:grid-cols-[150px_minmax(0,1fr)_110px] lg:grid-cols-[170px_minmax(0,1fr)_110px] sm:gap-2.5">
              <div
                className="truncate font-mono text-xs text-muted-foreground sm:text-right"
                title={displayLabel}
              >
                {spanIcon(s.kind, s.label)} {displayLabel}
              </div>
              <span
                className="whitespace-nowrap text-right font-mono text-[0.68rem] text-muted-foreground sm:col-start-3"
                title={durText}
              >
                {durText}
              </span>
              <div className="relative col-span-2 h-3.5 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                <div
                  className="absolute top-0 h-3.5 min-w-1 cursor-pointer rounded-sm opacity-90 hover:opacity-100 hover:outline hover:outline-1 hover:outline-foreground"
                  style={{
                    left: `${left.toFixed(2)}%`,
                    width: `${width.toFixed(2)}%`,
                    ...spanBarStyle(s),
                  }}
                  title={title}
                  onClick={() => {
                    if (isAgent) {
                      if (s.agentName) onAgentClick(s.agentName);
                    } else {
                      onSpanClick(s);
                    }
                  }}
                >
                </div>
              </div>
            </div>
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
