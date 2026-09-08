// Context reconstruction panel — shows the decomposed system prompt a model
// likely saw before a given user turn, plus confidence metadata and a
// lightweight history summary. Full message history is intentionally NOT
// re-rendered here (it's already visible in the main message stream).

import { useEffect, useState } from 'react';
import type { ContextSnapshot, Platform, SessionMessage } from '@/api/types';
import { getSessionContext } from '@/api/client';
import { getTextContent } from '@/lib/pure';
import { cn } from '@/lib/utils';

const CONFIDENCE_STYLES: Record<string, { label: string; className: string }> = {
  high: { label: '高', className: 'border-green-600/40 bg-green-600/10 text-green-600' },
  medium: { label: '中', className: 'border-yellow-600/40 bg-yellow-600/10 text-yellow-600' },
  low: { label: '低', className: 'border-red-600/40 bg-red-600/10 text-red-600' },
};

function PromptComponent({ component }: { component: ContextSnapshot['systemPrompt']['components'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = component.present && component.content && component.content.length > 0;

  return (
    <div className="rounded border border-border/60 bg-secondary/20">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', component.present ? 'bg-green-500' : 'bg-muted-foreground/40')} />
          <span className="truncate text-[11px] font-medium text-foreground">{component.label}</span>
          {component.source ? (
            <span className="shrink-0 truncate text-[9px] text-muted-foreground">{component.source}</span>
          ) : null}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground transition-transform group-open:rotate-90">
          {expanded ? '▼' : '▶'}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-border/50 px-2 py-1.5">
          {!component.present ? (
            <div className="text-[11px] text-muted-foreground">
              {component.note || '无法从日志获取'}
            </div>
          ) : hasContent ? (
            <pre className="max-h-64 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[10.5px] leading-relaxed">
              {component.content}
            </pre>
          ) : (
            <div className="text-[11px] text-muted-foreground">（空）</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ContextMessageRow({ message, label }: { message: SessionMessage; label?: string }) {
  const text = getTextContent(message.content);
  const details = message.details && typeof message.details === 'object' ? JSON.stringify(message.details, null, 2) : '';
  const content = text || details || '（无可显示文本）';
  return (
    <details className="rounded border border-border/50 bg-secondary/10 px-2 py-1.5">
      <summary className="cursor-pointer text-[10px] font-medium text-foreground">
        {label || message.role}
        {message.toolName ? ` · ${message.toolName}` : ''}
      </summary>
      <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
        {content}
      </pre>
    </details>
  );
}

export function ContextPanel({
  platform,
  sessionId,
  messageIndex,
  messageId,
  dir,
}: {
  platform: Platform;
  sessionId: string;
  messageIndex?: number;
  messageId?: string;
  dir?: string;
}) {
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSessionContext(platform, sessionId, { messageIndex, messageId, dir })
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platform, sessionId, messageIndex, messageId, dir]);

  if (loading) {
    return <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">正在重建上下文…</div>;
  }

  if (error) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/5 px-2 py-2 text-[11px] text-destructive">
        上下文重建失败：{error}
      </div>
    );
  }

  if (!snapshot) return null;

  const confidence = CONFIDENCE_STYLES[snapshot.metadata.confidence] || CONFIDENCE_STYLES.medium;
  const history = snapshot.messages.summary;

  return (
    <div className="space-y-2">
      {/* Warning + metadata row */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded border border-yellow-600/30 bg-yellow-600/5 px-1.5 py-0.5 text-yellow-600">
          ⚠️ 基于日志重建，可能与模型实际收到的请求有差异
        </span>
        <span className={cn('rounded border px-1.5 py-0.5 font-medium', confidence.className)}>
          置信度：{confidence.label}
        </span>
      </div>

      {/* Sources + missing items */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span>
          来源：{snapshot.metadata.sources.join(' · ')}
        </span>
      </div>
      {snapshot.metadata.missingItems.length > 0 ? (
        <div className="text-[10px] text-muted-foreground">
          <span className="text-yellow-600">缺失项：</span>
          {snapshot.metadata.missingItems.join('、')}
        </div>
      ) : null}

      {/* System prompt components */}
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          System Prompt 组成 · {snapshot.systemPrompt.components.length} 项
        </div>
        <div className="space-y-1">
          {snapshot.systemPrompt.components.map((component, i) => (
            <PromptComponent key={`${component.type}-${i}`} component={component} />
          ))}
        </div>
      </div>

      {/* Current user input */}
      {snapshot.messages.target ? (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">本轮用户输入</div>
          <ContextMessageRow message={snapshot.messages.target} label="user" />
        </div>
      ) : null}

      {/* Recoverable message history */}
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>模型请求中的可恢复历史 · {history.total} 条</span>
          {snapshot.messages.compaction?.applied ? (
            <span className="normal-case font-normal text-yellow-600">已按最近一次上下文压缩结果重置</span>
          ) : null}
        </div>
        {snapshot.messages.included && snapshot.messages.items?.length ? (
          <div className="max-h-96 space-y-1 overflow-auto pr-1">
            {snapshot.messages.items.map((message, index) => (
              <ContextMessageRow key={`${message.id || message.timestamp || message.role}-${index}`} message={message} />
            ))}
          </div>
        ) : (
          <div className="rounded border border-border/50 bg-secondary/10 px-2 py-1.5 text-[10px] text-muted-foreground">
            未恢复到该轮之前的历史消息内容
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
          <span>{history.turns} 轮对话</span>
          <span>user {history.user}</span>
          <span>assistant {history.assistant}</span>
          <span>tool {history.toolCall + history.toolResult}</span>
        </div>
      </div>
    </div>
  );
}
