// Trace span detail sidebar (420px, fixed right). Ported from public/js/app.js
// openSpanSidebar/findSpanToolData/toolResultPartText: tool spans show the
// arguments JSON + the toolCallId-paired result (+ error banner); chat spans
// show the assistant markdown with model/token badges.

import { useEffect, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { formatDurationCompact, getTextContent, resultLanguage, toolMeta } from '@/lib/pure';
import type { TraceSpan } from '@/lib/pure';
import { useAppStore } from '@/store';
import type { MessageContentPart, SessionMessage } from '@/api/types';

function formatNumber(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString() : '0';
}

/** Text of a Claude-style tool_result content part (string / part array / plain text). */
function toolResultPartText(part: MessageContentPart): string {
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) {
    return part.content
      .map((p: unknown) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && 'text' in p && typeof p.text === 'string') return p.text;
        return '';
      })
      .join('\n');
  }
  return part.text || '';
}

/** Locate the arguments + paired result for a tool span by toolCallId. */
function findSpanToolData(
  toolCallId: string | undefined,
  msgs: SessionMessage[]
): { args: unknown; hasArgs: boolean; result: { text: string } | null } {
  let args: unknown = null;
  let hasArgs = false;
  let result: { text: string } | null = null;
  if (!toolCallId) return { args, hasArgs, result };
  for (const m of msgs) {
    if (m.role === 'toolCall' && m.toolCallId === toolCallId && m.details != null) {
      args = m.details;
      hasArgs = true;
    }
    if (m.role === 'toolResult' && m.toolCallId === toolCallId) {
      result = { text: getTextContent(m.content || []) };
    }
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.id === toolCallId) {
        args = c.arguments ?? c.input ?? null;
        hasArgs = args != null;
      }
      if (c.type === 'tool_result' && c.tool_use_id === toolCallId) {
        result = { text: toolResultPartText(c) };
      }
    }
  }
  return { args, hasArgs, result };
}

/** Legacy .prompt-text clamp: contents >600 chars start clamped with a Show more toggle. */
function ClampBlock({ len, children }: { len: number; children: React.ReactNode }) {
  const [clamped, setClamped] = useState(len > 600);
  return (
    <>
      <div
        className={
        clamped
          ? 'max-h-[8em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
          : undefined
        }
      >
        {children}
      </div>
      {len > 600 && (
        <button
          className="mt-1 text-xs text-[#58a6ff] hover:underline"
          onClick={() => setClamped((v) => !v)}
        >
          {clamped ? 'Show more' : 'Show less'}
        </button>
      )}
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function Pre({ text }: { text: string }) {
  return (
    <pre className="m-0 whitespace-pre-wrap break-words rounded-md border border-border bg-[hsl(var(--panel-alt))] px-2.5 py-2 font-mono text-xs leading-relaxed">
      {text}
    </pre>
  );
}

const EMPTY_CLS = 'text-xs text-muted-foreground';

function spanDurationText(span: TraceSpan): string {
  const duration = formatDurationCompact(span.end - span.start);
  if (span.durationSource === 'estimated') return `约 ${duration}（估算）`;
  if (span.durationSource === 'unknown') return '耗时未知';
  return duration;
}

export function SpanSidebar({
  span,
  msgs,
  onClose,
}: {
  span: TraceSpan;
  msgs: SessionMessage[];
  onClose: () => void;
}) {
  const requestScrollToMessage = useAppStore((s) => s.requestScrollToMessage);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const durText = spanDurationText(span);
  const isTool = span.kind === 'tool' || span.kind === 'tool-error';
  // Display label: Chinese category + subject for tools (matches TraceView bar labels)
  const displayLabel = isTool
    ? span.subject
      ? `${toolMeta(span.label).label} · ${span.subject}`
      : toolMeta(span.label).label
    : span.label;

  let body: React.ReactNode;
  if (isTool) {
    const { args, hasArgs, result } = findSpanToolData(span.toolCallId, msgs);
    const argsJson = hasArgs ? JSON.stringify(args, null, 2) : '';
    const resultText = result ? (result.text || '').trim() : '';
    // Resolve syntax-highlight language for the result: shell tools → bash,
    // file tools → extension-based (ts/py/json/…), search tools → plain.
    const resultLang = resultLanguage(span.label, span.subject);
    body = (
      <>
        {span.kind === 'tool-error' && (
          <div className="mt-3 rounded-md border border-[rgba(248,81,73,0.4)] bg-[rgba(248,81,73,0.08)] px-2.5 py-1.5 text-sm text-[#f85149]">
            ❌ 工具执行报错
          </div>
        )}
        <SectionTitle>Arguments</SectionTitle>
        {argsJson ? (
          <ClampBlock len={argsJson.length}>
            <Markdown text={`\`\`\`json\n${argsJson}\n\`\`\``} />
          </ClampBlock>
        ) : (
          <div className={EMPTY_CLS}>无参数数据</div>
        )}
        <SectionTitle>Result{resultLang ? ` · ${resultLang}` : ''}</SectionTitle>
        {result ? (
          <ClampBlock len={resultText.length}>
            {resultLang ? (
              <Markdown text={`\`\`\`${resultLang}\n${resultText || '(空输出)'}\n\`\`\``} />
            ) : (
              <Pre text={resultText || '(空输出)'} />
            )}
          </ClampBlock>
        ) : (
          <div className={EMPTY_CLS}>未找到配对的工具结果</div>
        )}
      </>
    );
  } else {
    const msg = msgs.find((m) => m.id === span.msgId);
    const text = msg ? getTextContent(msg.content || []) : '';
    const usageBadges = Object.entries(msg?.usage || {}).filter(
      ([, v]) => typeof v === 'number' && v > 0
    );
    // Analyse what this assistant message actually contains. Claude Code
    // writes one assistant record per API response: it may carry only
    // `thinking` (model reasoning), only `tool_use` (tool invocation), or
    // actual `text` (the visible reply). A chat span with no text is NOT
    // empty — it is the model's reasoning time before a tool call or the
    // final answer. We surface that explicitly instead of "无文本内容".
    const contentParts = msg?.content || [];
    const hasThinking = contentParts.some(
      (p) => p.type === 'thinking' || p.type === 'reasoning' || p.type === 'reasoning_text'
    );
    const hasToolUse = contentParts.some(
      (p) => p.type === 'tool_use' || p.type === 'toolCall' || p.type === 'function_call'
    );
    const thinkingText = contentParts
      .filter((p) => (p.type === 'thinking' || p.type === 'reasoning') && typeof p.text === 'string')
      .map((p) => p.text || '')
      .join('\n\n');
    const reasoningLabel = hasThinking && hasToolUse
      ? '推理 + 工具调用（无文本回复）'
      : hasThinking
        ? '模型思考（无文本回复）'
        : hasToolUse
          ? '工具调用前推理（无文本回复）'
          : '无文本内容';
    body = (
      <>
        {msg?.model && (
          <>
            <SectionTitle>Model</SectionTitle>
            <span className="inline-block rounded-full border border-border bg-secondary px-2 py-0.5 text-xs">
              🧠 {msg.model}
            </span>
          </>
        )}
        {usageBadges.length > 0 ? (
          <>
            <SectionTitle>Tokens</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {usageBadges.map(([k, v]) => (
                <span
                  key={k}
                  className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs"
                >
                  {k}: {formatNumber(v)}
                </span>
              ))}
            </div>
          </>
        ) : (
          <>
            <SectionTitle>Tokens</SectionTitle>
            <div className={EMPTY_CLS}>
              此阶段无独立 token 统计 — Claude Code 通常把 token 用量汇总在最终文本回复的那条消息中，中间推理/工具调用阶段不单独计数。
            </div>
          </>
        )}
        <SectionTitle>{text ? '回复内容' : '阶段说明'}</SectionTitle>
        {text ? (
          <ClampBlock len={text.length}>
            <Markdown text={text} />
          </ClampBlock>
        ) : (
          <div className="rounded-md border border-[#58a6ff]/30 bg-[#58a6ff]/5 px-2.5 py-2 text-xs text-[#58a6ff]">
            💡 此阶段是模型的<strong>推理/思考时间</strong>（{reasoningLabel}），不是 bug。
            模型在生成文本回复或调用工具之前都会花费时间推理，Trace 瀑布图用蓝色条记录这段耗时。
          </div>
        )}
        {thinkingText && (
          <>
            <SectionTitle>思考过程</SectionTitle>
            <ClampBlock len={thinkingText.length}>
              <Pre text={thinkingText} />
            </ClampBlock>
          </>
        )}
      </>
    );
  }

  return (
    <aside className="fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-full flex-col border-l border-border bg-card shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span>{isTool ? toolMeta(span.label).icon : '🤖'}</span>
        <span className="truncate font-semibold" title={displayLabel}>
          {displayLabel}
        </span>
        {span.isFinalReply && (
          <span className="shrink-0 rounded-full border border-[#1f6feb]/40 bg-[#1f6feb]/10 px-1.5 py-0.5 text-[0.65rem] text-[#1f6feb]">
            ★ 最终回复
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {durText} · {new Date(span.start).toLocaleTimeString()}
        </span>
        <button
          className="rounded-md border border-border px-1.5 text-muted-foreground hover:border-muted-foreground hover:text-foreground"
          title="关闭 (Esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{body}</div>
      <div className="border-t border-border px-4 py-3">
        {span.msgId != null && (
          <button
            className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              const msgId = span.msgId;
              onClose();
              if (msgId) requestScrollToMessage(msgId);
            }}
          >
            ↪ 跳到消息
          </button>
        )}
        <div className={`text-xs text-muted-foreground ${span.msgId ? 'mt-2' : ''}`}>
          提示：复制恢复命令可在终端接管此会话
        </div>
      </div>
    </aside>
  );
}
