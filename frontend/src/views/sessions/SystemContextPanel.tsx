// 系统上下文折叠区块 — dsh v4 把运行时注入的上下文（runtime/time/skill/指令…）
// 单独放在详情响应里（contextMessages），不混进 messages。这里默认折叠、按
// sourceKind 分组展示，避免机器文本淹没正常会话流。

import type { SessionMessage } from '@/api/types';
import { getTextContent } from '@/lib/pure';

const KIND_LABELS: Record<string, string> = {
  'runtime-context': '运行时上下文',
  'time-context': '时间上下文',
  'skill-catalog': '技能目录',
  'agent-instructions': 'Agent 指令',
  'working-directory': '工作目录',
  'model-selection': '模型选择',
  'user-approval': '审批',
  'tool-jobs': '后台任务',
};

function sourceKindOf(message: SessionMessage): string {
  const kind = message.details?.sourceKind;
  return typeof kind === 'string' && kind.trim() ? kind : 'unknown';
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] || (kind === 'unknown' ? '系统上下文' : kind);
}

/** Group by sourceKind, keeping first-appearance order so the panel mirrors the log. */
function groupByKind(messages: SessionMessage[]): { kind: string; items: SessionMessage[] }[] {
  const groups = new Map<string, SessionMessage[]>();
  for (const message of messages) {
    const kind = sourceKindOf(message);
    const items = groups.get(kind);
    if (items) items.push(message);
    else groups.set(kind, [message]);
  }
  return Array.from(groups, ([kind, items]) => ({ kind, items }));
}

function ContextMessage({ message, label, ordinal }: { message: SessionMessage; label: string; ordinal?: number }) {
  const text = getTextContent(message.content);
  return (
    <details className="rounded border border-border/50 bg-secondary/10 px-2 py-1.5">
      <summary className="cursor-pointer text-[11px] font-medium text-foreground">
        {label}
        {ordinal ? <span className="text-muted-foreground"> · #{ordinal}</span> : null}
      </summary>
      <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
        {text || '（空）'}
      </pre>
    </details>
  );
}

export function SystemContextPanel({ messages }: { messages?: SessionMessage[] | null }) {
  if (!messages || messages.length === 0) return null;
  const groups = groupByKind(messages);

  return (
    <details data-testid="dsh-context-panel" className="mb-2 rounded-lg border border-border bg-card/40 px-3 py-2">
      <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
        🧩 系统上下文 · {messages.length} 条（默认折叠）
      </summary>
      <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
        {groups.map((group) => (
          <div key={group.kind} className="space-y-1">
            {group.items.length > 1 ? (
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {kindLabel(group.kind)} · {group.items.length} 条
              </div>
            ) : null}
            {group.items.map((message, index) => (
              <ContextMessage
                key={message.id || `${group.kind}-${index}`}
                message={message}
                label={kindLabel(group.kind)}
                ordinal={group.items.length > 1 ? index + 1 : undefined}
              />
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}
