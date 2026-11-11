// Shared copy-to-clipboard button with the 1.2s "Copied!" flash.
// 原先 Prompts 行与资产库卡片各写了一份，这里收敛成一个组件。

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CopyButton({
  text,
  className,
  label = 'Copy',
  copiedLabel = 'Copied!',
}: {
  text: string;
  className?: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn('h-6 px-2 text-xs', className)}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}
