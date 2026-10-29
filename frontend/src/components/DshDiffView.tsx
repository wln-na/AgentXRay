// DSH v4 tool results carry structured {path, oldText, newText} diffs.
// Render a compact line-level diff without introducing a diff dependency.
import { useMemo } from 'react';

export interface DshDiff {
  path?: string | null;
  oldText?: string | null;
  newText?: string | null;
}

type Line = { kind: 'ctx' | 'add' | 'del'; text: string };

function diffLines(oldText: string, newText: string): Line[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // LCS table; guard against pathological sizes.
  if (a.length * b.length > 250000) {
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] });
    } else {
      out.push({ kind: 'add', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

function DiffBlock({ diff }: { diff: DshDiff }) {
  const lines = useMemo(() => diffLines(diff.oldText || '', diff.newText || ''), [diff.oldText, diff.newText]);
  return (
    <div className="rounded border border-border/60 bg-muted/30">
      <div className="border-b border-border/50 px-2 py-1 font-mono text-[10px] text-muted-foreground">
        {diff.path || '文件变更'}
      </div>
      <div className="max-h-72 overflow-auto p-1 font-mono text-[10.5px] leading-relaxed">
        {lines.map((line, index) => (
          <div
            key={index}
            className={
              line.kind === 'add'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : line.kind === 'del'
                  ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                  : 'text-foreground/75'
            }
          >
            {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
            {line.text || '\u00A0'}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DshDiffView({ diffs }: { diffs?: DshDiff[] | null }) {
  if (!Array.isArray(diffs) || diffs.length === 0) return null;
  return (
    <div className="mt-1 space-y-1.5" data-testid="dsh-diff-view">
      {diffs.map((diff, index) => (
        <DiffBlock key={`${diff.path || 'diff'}-${index}`} diff={diff} />
      ))}
    </div>
  );
}
