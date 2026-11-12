import type { Platform, SessionMessage } from '@/api/types';
import { parseTimestampMs, parseToolArguments } from '@/lib/pure';

export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed';
export type SessionTaskSource = 'explicit' | 'inferred' | 'llm';
export type SessionTaskConfidence = 'high' | 'medium' | 'low';

export interface SessionTask {
  key: string;
  title: string;
  status: SessionTaskStatus;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  statusMessageId: string | null;
  source: SessionTaskSource;
  confidence: SessionTaskConfidence;
}

interface TaskSnapshotItem {
  title: string;
  status: SessionTaskStatus;
}

function normalizeStatus(value: unknown): SessionTaskStatus | null {
  if (typeof value !== 'string') return null;
  const status = value.toLowerCase().replace(/[- ]/g, '_');
  if (['pending', 'not_started', 'todo'].includes(status)) return 'pending';
  if (['in_progress', 'started', 'doing'].includes(status)) return 'in_progress';
  if (['completed', 'complete', 'done'].includes(status)) return 'completed';
  return null;
}

function normalizeSnapshotItems(value: unknown, titleKey: 'content' | 'step'): TaskSnapshotItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const title = row[titleKey];
    const status = normalizeStatus(row.status);
    return typeof title === 'string' && title.trim() && status ? [{ title: title.trim(), status }] : [];
  });
}

function toolArgs(value: unknown): Record<string, unknown> | null {
  return parseToolArguments(value).object;
}

function messageText(message: SessionMessage): string {
  return (message.content || [])
    .map((part) => part.text || '')
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

const TOPIC_STOPWORDS = new Set([
  '一个',
  '可以',
  '怎么',
  '这个',
  '当前',
  '进行',
  '需要',
  '希望',
  '是否',
  '然后',
  '继续',
  '刚才',
  '任务',
]);

function topicTokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9_]{2,}/g) || []);
  for (const block of normalized.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i < block.length - 1; i++) {
      const token = block.slice(i, i + 2);
      if (!TOPIC_STOPWORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function topicSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function snapshotsForMessage(message: SessionMessage, platform: Platform): TaskSnapshotItem[][] {
  if (platform === 'claude-code' && message.role === 'assistant') {
    return (message.content || []).flatMap((part) => {
      if (part.type !== 'toolCall' || part.name !== 'TodoWrite') return [];
      const args = toolArgs(part.arguments ?? part.input);
      return args ? [normalizeSnapshotItems(args.todos, 'content')] : [];
    });
  }

  if (platform === 'codex' && message.role === 'toolCall' && message.toolName === 'update_plan') {
    const args = toolArgs(message.details);
    return args ? [normalizeSnapshotItems(args.plan ?? args.steps, 'step')] : [];
  }

  return [];
}

function explicitTaskTimeline(messages: SessionMessage[], platform: Platform): SessionTask[] {
  const tasks = new Map<string, SessionTask>();
  for (const message of messages) {
    for (const snapshot of snapshotsForMessage(message, platform)) {
      const occurrences = new Map<string, number>();
      for (const item of snapshot) {
        const baseKey = item.title.toLowerCase();
        const occurrence = occurrences.get(baseKey) || 0;
        occurrences.set(baseKey, occurrence + 1);
        const key = `${baseKey}\u0000${occurrence}`;
        const existing = tasks.get(key);
        const timestamp = message.timestamp || null;

        if (!existing) {
          tasks.set(key, {
            key,
            title: item.title,
            status: item.status,
            createdAt: timestamp,
            startedAt: item.status === 'in_progress' ? timestamp : null,
            completedAt: item.status === 'completed' ? timestamp : null,
            statusMessageId: message.id || null,
            source: 'explicit',
            confidence: 'high',
          });
          continue;
        }

        const statusChanged = item.status !== existing.status;
        if (item.status === 'in_progress' && !existing.startedAt) existing.startedAt = timestamp;
        existing.completedAt = item.status === 'completed' ? timestamp : null;
        if (statusChanged) existing.statusMessageId = message.id || null;
        existing.status = item.status;
      }
    }
  }
  return [...tasks.values()];
}

function inferredCodexTasks(messages: SessionMessage[]): SessionTask[] {
  const units: { id: string; user: string; messages: SessionMessage[]; tokens: Set<string> }[] = [];
  const byTurn = new Map<string, (typeof units)[number]>();
  let current: (typeof units)[number] | null = null;

  for (const [index, message] of messages.entries()) {
    const turnId = message.turnId || `message-${index}`;
    let unit = byTurn.get(turnId);
    if (!unit && message.role === 'user') {
      unit = { id: `inferred:${turnId}`, user: messageText(message), messages: [], tokens: new Set() };
      byTurn.set(turnId, unit);
      units.push(unit);
      current = unit;
    }
    if (!unit) unit = current || undefined;
    if (!unit) continue;
    unit.messages.push(message);
    if (message.role === 'user' && !unit.user) unit.user = messageText(message);
    for (const token of topicTokens(unit.user)) unit.tokens.add(token);
  }

  if (!units.length) return [];
  const groups: (typeof units)[] = [];
  let group: (typeof units)[number][] = [];
  let groupTokens = new Set<string>();
  for (const unit of units) {
    const previous = group.at(-1);
    const previousTime = parseTimestampMs(previous?.messages.at(-1)?.timestamp);
    const currentTime = parseTimestampMs(unit.messages[0]?.timestamp);
    const gap = previousTime !== null && currentTime !== null ? currentTime - previousTime : 0;
    const similarity = topicSimilarity(unit.tokens, groupTokens);
    if (group.length && gap > 20 * 60 * 1000 && similarity < 0.12) {
      groups.push(group);
      group = [];
      groupTokens = new Set();
    }
    group.push(unit);
    for (const token of unit.tokens) groupTokens.add(token);
  }
  if (group.length) groups.push(group);

  return groups.map((taskUnits, index) => {
    const first = taskUnits[0];
    const last = taskUnits.at(-1);
    const firstMessage = first.messages.find((message) => message.role === 'user') || first.messages[0];
    const lastAssistant = [...(last?.messages || [])].reverse().find((message) => message.role === 'assistant');
    const lastMessage = last?.messages.at(-1) || firstMessage;
    return {
      key: `inferred:task:${index}`,
      title: first.user.slice(0, 120) || `会话任务 ${index + 1}`,
      status: lastAssistant ? 'completed' : 'in_progress',
      createdAt: firstMessage?.timestamp || null,
      startedAt: firstMessage?.timestamp || null,
      completedAt: lastAssistant?.timestamp || null,
      statusMessageId: lastMessage?.id || firstMessage?.id || null,
      source: 'inferred',
      confidence: 'low',
    };
  });
}

function sortTasks(tasks: SessionTask[]): SessionTask[] {
  const rank: Record<SessionTaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
  return tasks.sort((a, b) => {
    const statusOrder = rank[a.status] - rank[b.status];
    if (statusOrder) return statusOrder;
    const aTime = parseTimestampMs(a.createdAt) ?? 0;
    const bTime = parseTimestampMs(b.createdAt) ?? 0;
    return aTime - bTime;
  });
}

/**
 * Fold explicit task snapshots first. Codex sessions without update_plan still
 * get inferred tasks grouped by topic and time, with the source shown in the UI.
 */
export function extractTaskTimeline(messages: SessionMessage[], platform: Platform): SessionTask[] {
  if (platform !== 'claude-code' && platform !== 'codex') return [];

  const explicitTasks = explicitTaskTimeline(messages, platform);
  if (platform === 'codex' && !explicitTasks.length) return sortTasks(inferredCodexTasks(messages));
  return sortTasks(explicitTasks);
}
