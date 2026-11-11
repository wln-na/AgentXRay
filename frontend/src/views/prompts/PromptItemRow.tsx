// One extracted prompt row: timestamp, markdown body (>500 chars clamped with
// Show more), and the ⭐收藏 / Copy / 🗑隐藏 actions.
// 已移除：批量选择复选框、单条 LLM 改写（与簇级改写建议重复）。

import { useState } from 'react';

import type { PromptEntry } from '@/api/types';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function PromptItemRow({
  prompt,
  onHide,
  hidePending,
  onStar,
}: {
  prompt: PromptEntry;
  onHide: () => void;
  hidePending: boolean;
  onStar: () => void;
}) {
  const long = prompt.text.length > 500;
  const [clamped, setClamped] = useState(true);

  return (
    <div className="group relative rounded-md border border-border bg-background/40 p-3">
      <div className="min-w-0">
        {prompt.timestamp && (
          <div className="mb-1 text-[11px] text-muted-foreground">{new Date(prompt.timestamp).toLocaleString()}</div>
        )}
        <div className={cn('text-sm', long && clamped && 'max-h-48 overflow-hidden')}>
          <Markdown text={prompt.text} />
        </div>
        {long && (
          <button
            type="button"
            className="mt-1 text-xs text-primary hover:underline"
            onClick={() => setClamped(!clamped)}
          >
            {clamped ? 'Show more' : 'Show less'}
          </button>
        )}
      </div>

      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs" title="收藏到资产库" onClick={onStar}>
          ⭐ 收藏
        </Button>
        <CopyButton text={prompt.text} />
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          title="隐藏此 prompt（同文重复项一并隐藏，可恢复）"
          disabled={hidePending}
          onClick={onHide}
        >
          🗑
        </Button>
      </div>
    </div>
  );
}
