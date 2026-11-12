// Tone-coloured status primitives (botmux "Calm Console" design language):
// a dot that carries the status colour and a soft-filled pill. Colour values
// live in index.css as --st-* tokens and are selected through `data-tone`.

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { StatusTone } from './sessionStatus';

export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  return <span data-tone={tone} aria-hidden className={cn('status-dot', pulse && 'status-dot-pulse', className)} />;
}

export function StatusPill({
  tone,
  label,
  hint,
  pulse = false,
  className,
  children,
}: {
  tone: StatusTone;
  label: ReactNode;
  hint?: string;
  pulse?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span data-tone={tone} className={cn('status-pill', className)} title={hint}>
      <StatusDot tone={tone} pulse={pulse} />
      <span className="truncate">{label}</span>
      {children}
    </span>
  );
}
