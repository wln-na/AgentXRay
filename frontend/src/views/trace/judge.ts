// LLM-as-judge transcript builder: flatten the session's messages into a
// readable, judge-friendly transcript. Unlike the trace waterfall (which only
// needs span metadata), the judge must SEE the evidence: user asks, assistant
// replies, tool commands with arguments, and tool outputs — otherwise it
// scores the summary instead of the session and complains about "missing
// execution evidence". Per-item caps + a global budget keep it within
// context windows; the head (task) and tail (outcome) survive truncation.

import type { SessionMessage } from '@/api/types';
import { getTextContent } from '@/lib/pure';

const MAX_CHARS = 30000;

function flat(text: string, max: number): string {
  const one = (text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return one.length <= max ? one : `${one.slice(0, max)}…（截断）`;
}

/** Compact tool-call arguments: pull the useful keys, stringify the rest. */
function argsSummary(m: SessionMessage): string {
  const parts = (m.content || []).filter((c) => c.type === 'toolCall' || c.type === 'tool_use');
  const args = parts.length > 0 ? (parts[0].input ?? parts[0].arguments) : (m.details?.arguments ?? m.details);
  if (args === undefined || args === null) return '';
  try {
    if (typeof args === 'string') return flat(args, 240);
    const obj = args as Record<string, unknown>;
    const preferred = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description'];
    const picked = preferred
      .filter((k) => typeof obj[k] === 'string' && obj[k])
      .map((k) => `${k}=${flat(obj[k] as string, 160)}`);
    const summary = picked.length > 0 ? picked.join(' ') : JSON.stringify(args);
    return flat(summary, 240);
  } catch {
    return '';
  }
}

/** Tool result output: standalone toolResult records keep it in text parts. */
function resultText(m: SessionMessage): string {
  return flat(getTextContent(m.content || []), 500);
}

function messageLines(m: SessionMessage): string[] {
  const lines: string[] = [];
  if (m.role === 'user') {
    const t = flat(getTextContent(m.content || []), 1200);
    if (t) lines.push(`[用户] ${t}`);
  } else if (m.role === 'assistant') {
    const t = flat(getTextContent(m.content || []), 800);
    if (t) lines.push(`[助手] ${t}`);
    // Tool calls carried inline on the assistant record (Claude-style)
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.name) {
        const args = c.input ?? c.arguments;
        lines.push(`[工具] ${c.name} ${flat(typeof args === 'string' ? args : JSON.stringify(args ?? ''), 240)}`);
      }
    }
    // DSH/OMP-style records sometimes carry reasoning separately; skip it —
    // the judge evaluates actions and outputs, not the old agent's thoughts.
  } else if (m.role === 'toolCall') {
    const args = argsSummary(m);
    lines.push(`[工具] ${m.toolName || '?'}${args ? ` ${args}` : ''}`);
  } else if (m.role === 'toolResult') {
    const out = resultText(m);
    lines.push(`[工具结果·${m.isError ? '出错' : '成功'}]${out ? ` ${out}` : ' （无输出）'}`);
  }
  // 'reasoning' / 'developer' / other system-ish roles: skipped on purpose.
  return lines;
}

export function buildJudgeTranscript(msgs: SessionMessage[]): string {
  const visible = (msgs || []).filter((m) => m.role !== 'reasoning');
  if (visible.length === 0) return '';

  // Group into turns at user-message boundaries so the judge can reason
  // per-turn the way the waterfall view does.
  const blocks: string[] = [];
  let current: string[] = [];
  let turnNo = 0;
  let sawUser = false;
  for (const m of visible) {
    if (m.role === 'user') {
      if (current.length > 0) blocks.push(current.join('\n'));
      turnNo += 1;
      sawUser = true;
      current = [`## 轮次 ${turnNo}`];
    }
    current.push(...messageLines(m));
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  // Sessions without user boundaries (subagent transcripts) get one block.
  const turnBlocks = sawUser ? blocks : [`## 会话记录\n${blocks.join('\n')}`];

  // Budget: head + tail survive, the middle collapses to a marker.
  if (turnBlocks.join('\n\n').length > MAX_CHARS) {
    const kept: string[] = [];
    let budget = MAX_CHARS;
    const head = turnBlocks.slice(0, 3);
    const tail = turnBlocks.slice(-6);
    const middleCount = turnBlocks.length - head.length - tail.length;
    for (const b of head) {
      if (b.length > budget) break;
      kept.push(b);
      budget -= b.length;
    }
    kept.push(`……（中间 ${middleCount} 轮过长，已省略）……`);
    for (const b of tail) {
      if (b.length > budget) {
        kept.push(flat(b, Math.max(500, budget)));
        budget = 0;
        continue;
      }
      kept.push(b);
      budget -= b.length;
      if (budget <= 0) break;
    }
    return kept.join('\n\n').slice(0, MAX_CHARS);
  }
  return turnBlocks.join('\n\n');
}
