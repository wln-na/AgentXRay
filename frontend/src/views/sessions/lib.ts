// Pure helpers for the sessions view — ported from public/js/app.js (algorithms unchanged).

import type { MessageContentPart, MessageUsage, Platform, SessionMessage, SessionSummary } from '@/api/types';
import { getTextContent, parseTimestampMs } from '@/lib/pure';

export type MsgFilter = null | 'user' | 'assistant' | 'toolCall' | 'toolResult' | 'error' | 'spawn';

export function formatDate(value: string | number | null | undefined): string {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function formatNumber(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString() : '0';
}

export function truncateId(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value.length > 14 ? value.slice(0, 14) + '…' : value;
}

// DOM anchor for a message. Codex records carry id:null — fall back to
// toolCallId, then a timestamp-derived synthetic id so scroll-to-message
// (⌘K / insights jumps) still lands on those platforms.
export function messageAnchorId(msg: SessionMessage): string | null {
  if (msg.id) return msg.id;
  if (msg.toolCallId) return msg.toolCallId;
  const ts = parseTimestampMs(msg.timestamp);
  return ts !== null ? `ts${ts}` : null;
}

export function isDisplayableMessage(msg: SessionMessage | null | undefined): boolean {
  if (!msg || msg.role === 'developer') return false;
  if (msg.role === 'assistant') {
    const hasText = (msg.content || []).some((c) => c.type === 'text' && (c.text || '').trim());
    const hasTools = (msg.content || []).some((c) => c.type === 'toolCall');
    return hasText || hasTools;
  }
  if (msg.role === 'reasoning') {
    return (msg.content || []).some((c) => c.type === 'text' && (c.text || '').trim());
  }
  return true;
}

/** legacy exec/claude spawn detection on a toolCall content part */
export function isSpawnPart(c: MessageContentPart): boolean {
  if (c.type !== 'toolCall') return false;
  if (c.name === 'sessions_spawn' || c.name === 'delegate_task') return true;
  if (c.name === 'exec') {
    const command = (c.arguments as { command?: unknown } | undefined)?.command;
    if (typeof command === 'string') {
      const cmd = command.toLowerCase();
      return cmd.includes('codex ') || cmd.includes('claude ');
    }
  }
  return false;
}

export interface TimingMeta {
  timestampMs: number | null;
  deltaMs: number | null;
  toolDurationMs: number | null;
}

export interface TimingAnalysis {
  visibleMessages: SessionMessage[];
  timingByMessage: Map<SessionMessage, TimingMeta>;
  totalDurationMs: number | null;
  slowestStep: { deltaMs: number; label: string; messageId: string | null } | null;
  totalToolDurationMs: number | null;
  toolPairCount: number;
}

export function buildTimingAnalysis(messagesData: SessionMessage[] | null | undefined): TimingAnalysis {
  const visibleMessages = (messagesData || []).filter(isDisplayableMessage);
  const timingByMessage = new Map<SessionMessage, TimingMeta>();
  let previousTimed: { timestampMs: number } | null = null;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  // Per-message delta (for badges)
  visibleMessages.forEach((message) => {
    const timestampMs = parseTimestampMs(message.timestamp);
    const meta: TimingMeta = { timestampMs, deltaMs: null, toolDurationMs: null };
    if (timestampMs !== null) {
      if (firstTimestamp === null) firstTimestamp = timestampMs;
      lastTimestamp = timestampMs;
      if (previousTimed !== null) {
        meta.deltaMs = Math.max(0, timestampMs - previousTimed.timestampMs);
      }
      previousTimed = { timestampMs };
    }
    timingByMessage.set(message, meta);
  });

  // Tool call durations: pair toolCall ↔ toolResult by toolCallId
  const toolCallTsById = new Map<string, { ts: number }>();
  let totalToolDurationMs = 0;
  let toolPairCount = 0;

  for (const msg of visibleMessages) {
    const ts = parseTimestampMs(msg.timestamp);
    if (ts === null) continue;
    if (msg.role === 'toolCall') {
      if (msg.toolCallId) toolCallTsById.set(msg.toolCallId, { ts });
    } else if (msg.role === 'assistant') {
      for (const c of msg.content || []) {
        if (c.type === 'toolCall' && c.id) toolCallTsById.set(c.id, { ts });
      }
    } else if (msg.role === 'toolResult') {
      const id = msg.toolCallId;
      const call = id ? toolCallTsById.get(id) : undefined;
      if (id && call) {
        const duration = Math.max(0, ts - call.ts);
        const meta = timingByMessage.get(msg);
        if (meta) meta.toolDurationMs = duration;
        totalToolDurationMs += duration;
        toolPairCount++;
        toolCallTsById.delete(id);
      }
    }
  }

  // Slowest turn: from user message to end of agent work (next user or end)
  let slowestTurn: TimingAnalysis['slowestStep'] = null;
  let turnStart: number | null = null;
  let turnFirstAgentId: string | null = null;
  let turnToolCount = 0;

  const checkTurn = (endTs: number, lastAgentMsg: SessionMessage) => {
    const duration = Math.max(0, endTs - (turnStart as number));
    if (duration > 0 && (!slowestTurn || duration > slowestTurn.deltaMs)) {
      const parts = ['assistant'];
      if (turnToolCount > 0) parts.push(`${turnToolCount} tool calls`);
      slowestTurn = {
        deltaMs: duration,
        label: parts.join(' + '),
        messageId: turnFirstAgentId || lastAgentMsg.id || lastAgentMsg.toolCallId || null,
      };
    }
  };

  const finalizeTurn = (endIdx: number) => {
    const endMsg = visibleMessages[endIdx];
    const endTs = parseTimestampMs(endMsg?.timestamp);
    if (endTs === null || endMsg.role === 'user') {
      // Look backwards for last non-user message
      for (let j = endIdx; j >= 0; j--) {
        const m = visibleMessages[j];
        if (m.role !== 'user') {
          const t = parseTimestampMs(m.timestamp);
          if (t !== null) {
            checkTurn(t, m);
            return;
          }
        }
      }
      return;
    }
    checkTurn(endTs, endMsg);
  };

  for (let i = 0; i < visibleMessages.length; i++) {
    const msg = visibleMessages[i];
    const ts = parseTimestampMs(msg.timestamp);
    if (msg.role === 'user' && ts !== null) {
      if (turnStart !== null) finalizeTurn(i - 1);
      turnStart = ts;
      turnFirstAgentId = null;
      turnToolCount = 0;
    } else if (turnStart !== null && ts !== null) {
      if (!turnFirstAgentId) turnFirstAgentId = msg.id || msg.toolCallId || null;
      if (msg.role === 'toolCall' || msg.role === 'toolResult') turnToolCount++;
    }
  }
  if (turnStart !== null) finalizeTurn(visibleMessages.length - 1);

  return {
    visibleMessages,
    timingByMessage,
    totalDurationMs:
      firstTimestamp !== null && lastTimestamp !== null ? Math.max(0, lastTimestamp - firstTimestamp) : null,
    slowestStep: slowestTurn,
    totalToolDurationMs: toolPairCount > 0 ? totalToolDurationMs : null,
    toolPairCount,
  };
}

export function summarizeTokens(
  messagesData: SessionMessage[],
  sessionUsage?: MessageUsage | null
): Record<string, number> {
  if (sessionUsage) {
    return Object.entries(sessionUsage).reduce<Record<string, number>>((acc, [key, value]) => {
      if (typeof value === 'number') acc[key] = value;
      return acc;
    }, {});
  }
  return messagesData.reduce<Record<string, number>>((acc, message) => {
    const usage = message.usage || {};
    Object.entries(usage).forEach(([key, value]) => {
      if (typeof value === 'number') acc[key] = (acc[key] || 0) + value;
    });
    return acc;
  }, {});
}

export function sessionCost(messagesData: SessionMessage[]): number {
  return messagesData.reduce((sum, m) => {
    const cost = m.usage?.cost;
    if (typeof cost === 'number') return sum + cost;
    return sum + (typeof cost?.total === 'number' ? cost.total : 0);
  }, 0);
}

export interface SessionStats {
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  errorCount: number;
  spawnCount: number;
  toolNames: Record<string, number>;
  skillNames: Record<string, number>;
  totalRetryTools: number;
  totalRetryAttempts: number;
}

export function compactAssistantFragments(messages: SessionMessage[]): SessionMessage[] {
  const compacted: SessionMessage[] = [];
  for (const message of messages) {
    const previous = compacted.at(-1);
    const sameAssistantFragment =
      previous?.role === 'assistant' &&
      message.role === 'assistant' &&
      previous.timestamp === message.timestamp &&
      previous.model === message.model &&
      previous.provider === message.provider;
    if (!sameAssistantFragment) {
      compacted.push(message);
      continue;
    }
    compacted[compacted.length - 1] = {
      ...previous,
      content: [...(previous.content || []), ...(message.content || [])],
      reasoning: [previous.reasoning, message.reasoning].filter(Boolean).join('\n\n') || null,
      usage: message.usage || previous.usage,
    };
  }
  return compacted;
}

export function compactUserContextFragments(messages: SessionMessage[]): SessionMessage[] {
  const compacted: SessionMessage[] = [];
  for (const message of messages) {
    const previous = compacted.at(-1);
    if (previous?.role !== 'user' || message.role !== 'user') {
      compacted.push(message);
      continue;
    }

    const previousParts = splitUserMessageContext(getTextContent(previous.content));
    const currentParts = splitUserMessageContext(getTextContent(message.content));
    const previousOnlyContext = !previousParts.input && previousParts.contexts.length > 0;
    const currentHasInput = Boolean(currentParts.input);
    const previousTime = parseTimestampMs(previous.timestamp);
    const currentTime = parseTimestampMs(message.timestamp);
    const exactTimestamp = previous.timestamp === message.timestamp;
    const nearbyForwardContext =
      previousOnlyContext &&
      currentHasInput &&
      previousTime !== null &&
      currentTime !== null &&
      currentTime >= previousTime &&
      currentTime - previousTime <= 2000;
    const hasContextFragment = previousParts.contexts.length > 0 || currentParts.contexts.length > 0;
    if ((!exactTimestamp && !nearbyForwardContext) || !hasContextFragment) {
      compacted.push(message);
      continue;
    }

    compacted[compacted.length - 1] = {
      ...previous,
      id: message.id || previous.id,
      timestamp: message.timestamp || previous.timestamp,
      content: [...(previous.content || []), ...(message.content || [])],
      usage: message.usage || previous.usage,
    };
  }
  return compacted;
}

export interface UserMessageParts {
  input: string;
  contexts: { label: string; text: string }[];
}

const USER_CONTEXT_LABELS: Record<string, string> = {
  'system-reminder': '系统附带上下文',
  agents_md: '项目规则',
  'in-app-browser-context': '浏览器上下文',
  environment_context: '运行环境上下文',
  user_instructions: '用户规则上下文',
  information: '附件信息',
  attachments: '附件信息',
  image: '图片附件',
  'current-date': '日期上下文',
  'current-state': 'Agent 状态',
  constraint: '执行约束',
  usage_guide: '行为指南',
  retained_skills: 'Skill 上下文',
  sender: '发送者上下文',
  mentions: '提及对象',
  available_bots: '可用 Agent',
  botmux_reminder: 'Agent 提醒',
  botmux_skills: 'Skill 上下文',
  botmux_skills_refresh: 'Skill 更新上下文',
  bridge_context: '桥接上下文',
  bridge_instructions: '桥接规则',
  'agent-context': 'Agent 上下文',
  'mcp-context': 'MCP 上下文',
  'skill-context': 'Skill 上下文',
  'task-context': '任务上下文',
  'permissions-context': '权限上下文',
  'date-context': '日期上下文',
  'file-context': '文件上下文',
  'openclaw-context': '会话元数据',
  'subagent-context': '子 Agent 上下文',
};

function extractTaggedContext(remaining: string, contexts: UserMessageParts['contexts']): string {
  const tagNames = Object.keys(USER_CONTEXT_LABELS).join('|');
  const pairedPattern = new RegExp(`<(${tagNames})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi');
  const selfClosingPattern = new RegExp(`<(${tagNames})(?:\\s[^>]*)?\\/\\s*>`, 'gi');
  const extract = (input: string, pattern: RegExp) =>
    input.replace(pattern, (block, tag: string) => {
      const normalizedTag = tag.toLowerCase();
      contexts.push({ label: USER_CONTEXT_LABELS[normalizedTag] || normalizedTag, text: block.trim() });
      return '\n';
    });
  return extract(extract(remaining, pairedPattern), selfClosingPattern);
}

function extractOpenClawContext(remaining: string, contexts: UserMessageParts['contexts']): string {
  const metadataBlock = /^[A-Za-z][^\n]*(?:\([^\n]*\))?:\n```(?:json)?\n[\s\S]*?^```\s*$/gim;
  return remaining.replace(metadataBlock, (block) => {
    contexts.push({ label: '会话元数据', text: `<openclaw-context>\n${block.trim()}\n</openclaw-context>` });
    return '\n';
  });
}

export function splitUserMessageContext(text: string): UserMessageParts {
  const contexts: UserMessageParts['contexts'] = [];
  let remaining = text;
  const agentsInstructions = /^AGENTS\.md instructions for [^\n]+\n+[\s\S]*$/i;
  if (agentsInstructions.test(remaining.trim())) {
    contexts.push({ label: '项目规则', text: remaining.trim() });
    remaining = '';
  }
  remaining = extractTaggedContext(remaining, contexts);
  remaining = extractOpenClawContext(remaining, contexts);
  const userMessageWrapper = remaining.trim().match(/^<user_message(?:\s[^>]*)?>([\s\S]*?)<\/user_message>$/i);
  if (userMessageWrapper) remaining = userMessageWrapper[1];
  const input = remaining.replace(/\n{3,}/g, '\n\n').trim();
  return { input, contexts };
}

function skillNamesFromValue(value: unknown): string[] {
  const names = new Set<string>();
  const skillPathPattern = /(?:^|[\\/])([^\\/"'\s<>$]+)[\\/]SKILL\.md\b/gi;
  const addPathMatches = (text: string) => {
    for (const match of text.matchAll(skillPathPattern)) {
      const name = match[1];
      if (name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) names.add(name);
    }
  };
  const stripHeredocs = (command: string) =>
    command.replace(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n[\s\S]*?\n\1(?=\n|$)/g, '');
  const scanCommand = (rawCommand: string) => {
    let command = stripHeredocs(rawCommand);
    command = command.replace(
      /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+);\s*do([\s\S]*?)\bdone\b/g,
      (whole, variable: string, rawItems: string, body: string) => {
        const variablePath = new RegExp(`\\$\\{?${variable}\\}?[\\\\/]SKILL\\.md\\b`);
        const readsSkill = /\b(?:cat|sed|head|tail|less|more|bat|batcat|nl|awk|grep|rg)\b/.test(body);
        if (readsSkill && variablePath.test(body)) {
          for (const item of rawItems.trim().split(/\s+/)) {
            const name = item.replace(/^['"]|['"]$/g, '');
            if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) names.add(name);
          }
        }
        return whole.replace(body, '');
      }
    );
    for (const segment of command.split(/(?:\n|;|&&|\|\|)/)) {
      if (!/\b(?:cat|sed|head|tail|less|more|bat|batcat|nl|awk|grep|rg)\b/.test(segment)) continue;
      addPathMatches(segment);
    }
  };
  const scan = (candidate: unknown, key = '') => {
    if (typeof candidate === 'string') {
      if (key === 'cmd' || key === 'command') {
        scanCommand(candidate);
        return;
      }
      if (['path', 'file_path', 'filename', 'notebook_path'].includes(key)) {
        addPathMatches(candidate);
        return;
      }
      if (key === '' || key === 'arguments' || key === 'input' || key === 'details') {
        try {
          scan(JSON.parse(candidate), key);
        } catch {
          // Unstructured prose and tool output are not evidence of a Skill read.
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) scan(item, key);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [childKey, childValue] of Object.entries(candidate)) scan(childValue, childKey);
  };
  scan(value);
  return [...names];
}

function skillNamesFromToolCall(toolName: string | null | undefined, value: unknown): string[] {
  const names = new Set(skillNamesFromValue(value));
  if (String(toolName || '').toLowerCase() !== 'skill') return [...names];

  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const args =
    record?.arguments && typeof record.arguments === 'object'
      ? (record.arguments as Record<string, unknown>)
      : record?.input && typeof record.input === 'object'
        ? (record.input as Record<string, unknown>)
        : record;
  for (const key of ['skill', 'skill_name', 'name']) {
    const candidate = args?.[key];
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) names.add(name);
  }
  return [...names];
}

// Stats block of legacy renderSummary (counts + per-turn retry tally)
export function computeSessionStats(msgs: SessionMessage[]): SessionStats {
  const stats: SessionStats = {
    userCount: 0,
    assistantCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    errorCount: 0,
    spawnCount: 0,
    toolNames: {},
    skillNames: {},
    totalRetryTools: 0,
    totalRetryAttempts: 0,
  };
  let turnToolErrors: Record<string, number> = {};
  for (const msg of msgs) {
    if (msg.role === 'user') {
      turnToolErrors = {};
      stats.userCount++;
    }
    if (msg.role === 'assistant') stats.assistantCount++;
    if (msg.role === 'toolResult') {
      stats.toolResultCount++;
      const name = msg.toolName || (msg.name as string | undefined) || '?';
      if (msg.isError) {
        stats.errorCount++;
        turnToolErrors[name] = (turnToolErrors[name] || 0) + 1;
      } else if (turnToolErrors[name] > 0) {
        stats.totalRetryTools++;
        stats.totalRetryAttempts += turnToolErrors[name];
        turnToolErrors[name] = 0;
      }
    }
    if (msg.role === 'toolCall') {
      stats.toolCallCount++;
      const name = msg.toolName || 'unknown';
      stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
      for (const skill of skillNamesFromToolCall(msg.toolName, msg.details)) {
        stats.skillNames[skill] = (stats.skillNames[skill] || 0) + 1;
      }
    }
    for (const c of msg.content || []) {
      if (c.type === 'toolCall') {
        stats.toolCallCount++;
        const name = c.name || 'unknown';
        stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
        for (const skill of skillNamesFromToolCall(c.name, c)) {
          stats.skillNames[skill] = (stats.skillNames[skill] || 0) + 1;
        }
        if (isSpawnPart(c)) stats.spawnCount++;
      }
    }
  }
  return stats;
}

// Message list stat filter (legacy renderMessages filter block)
export function applyMsgFilter(msgs: SessionMessage[], f: MsgFilter): SessionMessage[] {
  if (!f) return msgs;
  return msgs.filter((msg) => {
    if (f === 'user') return msg.role === 'user';
    if (f === 'assistant') return msg.role === 'assistant';
    if (f === 'toolCall') {
      if (msg.role === 'toolCall') return true;
      return (msg.content || []).some((c) => c.type === 'toolCall');
    }
    if (f === 'toolResult') return msg.role === 'toolResult';
    if (f === 'error') return msg.role === 'toolResult' && msg.isError;
    if (f === 'spawn') {
      if (msg.role === 'toolCall' && msg.toolName === 'sessions_spawn') return true;
      return (msg.content || []).some(isSpawnPart);
    }
    return true;
  });
}

export function filterSessionList(sessions: SessionSummary[], term: string): SessionSummary[] {
  const t = term.trim().toLowerCase();
  if (!t) return sessions;
  return sessions.filter(
    (session) =>
      session.id.toLowerCase().includes(t) ||
      session.file.toLowerCase().includes(t) ||
      (session.firstUserMessage || '').toLowerCase().includes(t)
  );
}

/** Terminal command that resumes a session (legacy resumeCmdBtn); null when unsupported. */
export function resumeCommand(platform: Platform, id: string, cwd: string | null | undefined): string | null {
  let cmd = '';
  if (platform === 'codex') cmd = `codex resume ${id} --yolo`;
  else if (platform === 'claude-code') cmd = `claude --dangerously-skip-permissions --resume ${id}`;
  else if (platform === 'omp') cmd = `omp --auto-approve --resume=${id}`;
  else return null;
  return cwd ? `cd ${cwd} && ${cmd}` : cmd;
}

export { getTextContent };
