// Tool-call argument viewer (page component).
// Unescapes persisted JSON strings (Codex/OMP), renders apply_patch payloads
// as colour-coded unified diffs, pretty-prints JSON args, and clamps long
// payloads behind a Show more toggle.

import { useMemo, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { detectPatch, diffLineSegments, extractEmbeddedPatch, parseToolArguments } from '@/lib/pure';
import { cn } from '@/lib/utils';

type View =
  | { kind: 'diff'; text: string; note: string; rawCode?: string }
  | { kind: 'json'; text: string; note?: string }
  | { kind: 'text'; text: string };

const DIFF_LINE_CLS: Record<string, string> = {
  file: 'font-semibold text-muted-foreground',
  hunk: 'text-[#0969da]',
  add: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  del: 'bg-red-500/10 text-red-700 dark:text-red-400',
  context: 'text-foreground/80',
};

function DiffView({ text }: { text: string }) {
  const segments = useMemo(() => diffLineSegments(text), [text]);
  return (
    <div className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-1.5 font-mono text-[11px]">
      {segments.map((s, i) => (
        <div key={i} className={cn('min-h-[1.25em] px-1.5', DIFF_LINE_CLS[s.type])}>
          {s.text || '\u00A0'}
        </div>
      ))}
    </div>
  );
}

function Clamp({ len, children }: { len: number; children: React.ReactNode }) {
  const [clamped, setClamped] = useState(len > 600);
  return (
    <>
      <div
        className={
          clamped
            ? 'max-h-[16em] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'
            : undefined
        }
      >
        {children}
      </div>
      {len > 600 && (
        <button
          type="button"
          className="mt-1 text-xs text-[#58a6ff] hover:underline"
          onClick={() => setClamped((v) => !v)}
        >
          {clamped ? 'Show more' : 'Show less'}
        </button>
      )}
    </>
  );
}

/** Render persisted tool-call arguments in the most readable form:
 *  1. JSON-string payloads are parsed first, so `\"`/`\n` become real text;
 *  2. apply_patch payloads (object.patch or an embedded quoted patch in raw
 *     Codex tool code) render as a colour-coded diff;
 *  3. other objects render as pretty JSON; everything else stays raw text. */
export function ToolCallViewer({
  args,
  className,
}: {
  args: unknown;
  /** Optional class merged onto the root container. */
  className?: string;
}) {
  const view = useMemo<View>(() => {
    const parsed = parseToolArguments(args);
    // apply_patch args: {"patch": "*** Update File: …"} → diff view
    if (parsed.object && typeof parsed.object.patch === 'string' && parsed.object.patch.trim()) {
      if (detectPatch(parsed.object.patch)) {
        return {
          kind: 'diff',
          text: parsed.object.patch,
          note: parsed.wasJsonString ? '补丁（已还原转义）' : '补丁',
        };
      }
    }
    // Codex custom_tool_call raw code: const patch = "…"; text(await …) →
    // best-effort extract the embedded patch, keep the raw code collapsed.
    if (!parsed.object && parsed.text) {
      const embedded = extractEmbeddedPatch(parsed.text);
      if (embedded) {
        return { kind: 'diff', text: embedded, note: '从调用代码中提取的补丁', rawCode: parsed.text };
      }
    }
    if (parsed.object) {
      return { kind: 'json', text: parsed.text, note: parsed.wasJsonString ? '已还原转义' : undefined };
    }
    return { kind: 'text', text: parsed.text };
  }, [args]);

  if (view.kind === 'text' && !view.text) {
    return <div className="text-[11px] text-muted-foreground">无参数数据</div>;
  }

  if (view.kind === 'diff') {
    return (
      <div className={cn('space-y-1.5', className)}>
        {view.note ? <div className="text-[10px] text-muted-foreground">{view.note}</div> : null}
        <Clamp len={view.text.length}>
          <DiffView text={view.text} />
        </Clamp>
        {view.rawCode ? (
          <details className="group/raw">
            <summary className="cursor-pointer list-none text-[10px] text-muted-foreground [&::-webkit-details-marker]:hidden">
              <span className="group-open/raw:hidden">查看原始调用代码 ▸</span>
              <span className="hidden group-open/raw:inline">收起原始调用代码 ▾</span>
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px]">
              {view.rawCode}
            </pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (view.kind === 'json') {
    return (
      <div className={cn('space-y-1.5', className)}>
        {view.note ? <div className="text-[10px] text-muted-foreground">{view.note}</div> : null}
        <Clamp len={view.text.length}>
          <Markdown text={`\`\`\`json\n${view.text}\n\`\`\``} />
        </Clamp>
      </div>
    );
  }

  return (
    <div className={className}>
      <Clamp len={view.text.length}>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px]">
          {view.text}
        </pre>
      </Clamp>
    </div>
  );
}
