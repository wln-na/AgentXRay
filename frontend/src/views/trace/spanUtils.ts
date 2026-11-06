// Pure helpers shared by the trace waterfall and the span sidebar.

import type { TraceSpan } from '@/lib/pure';
import { formatDurationCompact } from '@/lib/pure';

export function spanDurationText(span: TraceSpan): string {
  const duration = formatDurationCompact(span.end - span.start);
  if (span.durationSource === 'estimated') return `约 ${duration}（估算）`;
  if (span.durationSource === 'unknown') return '耗时未知';
  return duration;
}
