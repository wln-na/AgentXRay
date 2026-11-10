const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ANALYSIS_DIR } = require('./config');
const { atomicWrite } = require('./fs-utils');
const { parseLlmJson } = require('./llm-json');
const { runLlm } = require('./llm');

const taskCache = new Map();
const taskInFlight = new Map();

function textOf(message) {
  return (message?.content || [])
    .map((part) => part?.text || '')
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function turnIdOf(message) {
  if (typeof message?.turnId === 'string' && message.turnId) return message.turnId;
  const value = message?.details?.turnId;
  return typeof value === 'string' && value ? value : null;
}

function compactValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function buildExecutionUnits(messages) {
  const units = [];
  const byTurn = new Map();
  let current = null;
  let sequence = 0;

  for (const message of messages || []) {
    if (!message || message.role === 'context') continue;
    const turnId = turnIdOf(message);
    let unit = turnId ? byTurn.get(turnId) : null;
    if (!unit && message.role === 'user') {
      unit = { id: `unit-${++sequence}`, turnId: null, messages: [] };
      if (turnId) {
        unit.id = `turn-${turnId}`;
        unit.turnId = turnId;
        byTurn.set(turnId, unit);
      }
      units.push(unit);
      current = unit;
    }
    if (!unit) unit = current;
    if (!unit) {
      unit = { id: `unit-${++sequence}`, turnId: turnId || null, messages: [] };
      units.push(unit);
      current = unit;
      if (turnId) byTurn.set(turnId, unit);
    }
    unit.messages.push(message);
  }

  return units.map((unit, index) => {
    const messagesInUnit = unit.messages;
    const user = messagesInUnit
      .filter((message) => message.role === 'user')
      .map(textOf)
      .filter(Boolean);
    const assistant = messagesInUnit
      .filter((message) => message.role === 'assistant')
      .map(textOf)
      .filter(Boolean);
    const tools = messagesInUnit
      .filter((message) => message.role === 'toolCall')
      .map((message) => message.toolName)
      .filter(Boolean);
    const errors = messagesInUnit
      .filter((message) => message.role === 'toolResult' && message.isError)
      .map(textOf)
      .filter(Boolean);
    const taskSignals = messagesInUnit.flatMap((message) => {
      if (message.role === 'toolCall' && message.toolName === 'update_plan') {
        return [compactValue(message.details)].filter(Boolean);
      }
      if (message.role !== 'assistant') return [];
      return (message.content || [])
        .filter((part) => part.type === 'toolCall' && part.name === 'TodoWrite')
        .map((part) => compactValue(part.arguments ?? part.input))
        .filter(Boolean);
    });
    const timestamps = messagesInUnit
      .map((message) => message.timestamp)
      .filter(Boolean)
      .sort();
    return {
      id: unit.id || `unit-${index + 1}`,
      turnId: unit.turnId,
      index,
      startAt: timestamps[0] || null,
      endAt: timestamps.at(-1) || null,
      messageIds: messagesInUnit.map((message) => message.id).filter(Boolean),
      user: user.join('\n').slice(0, 3000),
      assistant: assistant.join('\n').slice(-3000),
      tools: [...new Set(tools)].slice(0, 30),
      errors: errors.join('\n').slice(0, 1500),
      taskSignals: taskSignals.join('\n').slice(0, 2500),
    };
  });
}

function fingerprint(units) {
  return crypto.createHash('sha256').update(JSON.stringify(units)).digest('hex').slice(0, 24);
}

function storageKey(platform, sessionId, sourcePath) {
  return crypto
    .createHash('sha256')
    .update(`${platform}\0${sessionId}\0${sourcePath || ''}`)
    .digest('hex')
    .slice(0, 32);
}

function storagePath(platform, sessionId, sourcePath) {
  return path.join(ANALYSIS_DIR, `session-tasks-${storageKey(platform, sessionId, sourcePath)}.json`);
}

async function readPersisted(platform, sessionId, sourcePath) {
  try {
    return JSON.parse(await fsp.readFile(storagePath(platform, sessionId, sourcePath), 'utf8'));
  } catch {
    return null;
  }
}

async function writePersisted(platform, sessionId, sourcePath, result) {
  await atomicWrite(storagePath(platform, sessionId, sourcePath), `${JSON.stringify(result, null, 2)}\n`);
}

function normalizeStatus(value) {
  const status = String(value || '')
    .toLowerCase()
    .replace(/[- ]/g, '_');
  if (['pending', 'todo', 'not_started'].includes(status)) return 'pending';
  if (['in_progress', 'doing', 'started'].includes(status)) return 'in_progress';
  if (['completed', 'complete', 'done'].includes(status)) return 'completed';
  return 'in_progress';
}

function normalizeConfidence(value) {
  if (typeof value === 'number') {
    if (value >= 0.8) return 'high';
    if (value >= 0.5) return 'medium';
    return 'low';
  }
  return ['high', 'medium', 'low'].includes(value) ? value : 'medium';
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
  '请问',
  '问题',
  '任务',
]);

function topicTokens(text) {
  const normalized = String(text || '').toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9_]{2,}/g) || []);
  for (const block of normalized.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i < block.length - 1; i++) {
      const token = block.slice(i, i + 2);
      if (!TOPIC_STOPWORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function topicSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function fallbackTasks(units) {
  const groups = [];
  let current = null;
  for (const unit of units) {
    const text = unit.user || unit.assistant || '';
    const tokens = topicTokens(text);
    const previous = current?.units.at(-1);
    const gap = previous?.endAt && unit.startAt ? new Date(unit.startAt) - new Date(previous.endAt) : 0;
    const similarity = current ? topicSimilarity(tokens, current.tokens) : 1;
    const isShortContinuation = text.trim().length <= 12;
    const startsNewTopic = Boolean(current && !isShortContinuation && gap > 20 * 60 * 1000 && similarity < 0.12);

    if (startsNewTopic) current = null;
    if (!current) {
      current = { units: [], tokens: new Set() };
      groups.push(current);
    }
    current.units.push(unit);
    for (const token of tokens) current.tokens.add(token);
  }

  return groups.map((group, index) => {
    const first = group.units[0];
    const last = group.units.at(-1);
    const messageIds = group.units.flatMap((unit) => unit.messageIds);
    const completed = Boolean(last.assistant && last.endAt);
    return {
      key: `inferred-task-${first.id}`,
      title: (first.user || '会话任务').replace(/\s+/g, ' ').trim().slice(0, 160) || `会话任务 ${index + 1}`,
      summary: 'LLM 未返回可靠的任务分组，按用户请求主题和时间间隔推断。',
      status: completed ? 'completed' : 'in_progress',
      source: 'inferred',
      confidence: 'low',
      createdAt: first.startAt,
      startedAt: first.startAt,
      completedAt: completed ? last.endAt : null,
      statusMessageId: messageIds.at(-1) || null,
      unitIds: group.units.map((unit) => unit.id),
      evidenceMessageIds: messageIds,
    };
  });
}

function inferredResult(platform, sessionId, fp, units, llmError = null, classificationPending = false) {
  return {
    version: 1,
    platform,
    sessionId,
    fingerprint: fp,
    generatedAt: new Date().toISOString(),
    source: 'inferred',
    tasks: fallbackTasks(units),
    llmError,
    classificationPending,
  };
}

function normalizeTasks(raw, units) {
  const candidates = Array.isArray(raw?.tasks) ? raw.tasks : [];
  const unitMap = new Map(units.map((unit) => [unit.id, unit]));
  const claimed = new Set();
  const tasks = [];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const unitIds = Array.isArray(candidate.unitIds)
      ? candidate.unitIds.filter((id) => typeof id === 'string' && unitMap.has(id) && !claimed.has(id))
      : [];
    if (!unitIds.length) continue;
    unitIds.forEach((id) => claimed.add(id));
    const taskUnits = unitIds.map((id) => unitMap.get(id));
    const messageIds = taskUnits.flatMap((unit) => unit.messageIds);
    const timestamps = taskUnits
      .flatMap((unit) => [unit.startAt, unit.endAt])
      .filter(Boolean)
      .sort();
    const status = normalizeStatus(candidate.status);
    tasks.push({
      key: `task-${unitIds[0]}`,
      title: String(candidate.title || `任务 ${tasks.length + 1}`)
        .trim()
        .slice(0, 160),
      summary: typeof candidate.summary === 'string' ? candidate.summary.trim().slice(0, 500) : null,
      status,
      source: 'llm',
      confidence: normalizeConfidence(candidate.confidence),
      createdAt: timestamps[0] || null,
      startedAt: timestamps[0] || null,
      completedAt: status === 'completed' ? timestamps.at(-1) || null : null,
      statusMessageId: messageIds.at(-1) || null,
      unitIds,
      evidenceMessageIds: messageIds,
    });
  }

  const missing = units.filter((unit) => !claimed.has(unit.id));
  if (!tasks.length) return fallbackTasks(units);
  if (missing.length) tasks.push(...fallbackTasks(missing));

  // A single all-session LLM bucket is usually a low-quality response from a
  // small local model. Prefer an explainable topic/time fallback when it can
  // identify a real boundary instead of presenting a misleading one-task view.
  if (tasks.length === 1 && tasks[0].unitIds.length === units.length) {
    const inferred = fallbackTasks(units);
    if (inferred.length > 1) return inferred;
  }

  return tasks.sort(
    (a, b) => units.findIndex((unit) => unit.id === a.unitIds[0]) - units.findIndex((unit) => unit.id === b.unitIds[0])
  );
}

function promptForTasks(platform, units, previous) {
  const prior = previous?.tasks?.length
    ? `\n已有任务（如果语义仍然一致，请复用相同的任务，不要因为新增一条用户消息就新建任务）：\n${previous.tasks
        .map((task) => `- ${task.key}: ${task.title} [${task.status}] units=${task.unitIds.join(',')}`)
        .join('\n')}`
    : '';
  return `你是会话任务归类器。请把一条 AI agent 会话中的执行单元归并为“用户真正想完成的任务”。

重要规则：
1. 一个任务可以包含多条用户消息、多个 Codex turn、多个助手回复和工具调用；不要按 user message 或 turn_id 机械拆分。
2. 用户的追问、补充上下文、确认、修复上一步错误、继续检查同一个产物，都归入原任务。
3. 只有当目标、产物或工作主题明显改变时，才创建新任务。
4. 任务标题应概括最终目标，不要使用“处理第 N 条消息”这类标题。
5. status 只能是 pending、in_progress、completed。只有有明确最终产出或明确完成信号时才用 completed。
6. 必须覆盖所有 execution unit；不要丢弃无法判断的单元，低置信度时归入“未归类的会话内容”。
7. 只输出 JSON，不要 markdown 或解释。

平台：${platform}${prior}

Execution units:
${units
  .map(
    (unit) => `### ${unit.id} (${unit.startAt || 'unknown'} - ${unit.endAt || 'unknown'})
user: ${unit.user || '(none)'}
assistant: ${unit.assistant || '(none)'}
tools: ${unit.tools.join(', ') || '(none)'}
structured task signals: ${unit.taskSignals || '(none)'}
errors: ${unit.errors || '(none)'}`
  )
  .join('\n\n')}

输出结构：
{
  "tasks": [
    {
      "title": "任务标题",
      "summary": "任务摘要",
      "status": "pending|in_progress|completed",
      "confidence": "high|medium|low",
      "unitIds": ["unit-..."]
    }
  ]
}`;
}

async function classifySessionTasks({ platform, sessionId, payload, refresh = false, runLlmImpl = runLlm }) {
  const units = buildExecutionUnits(payload?.messages || []);
  if (!units.length) {
    return {
      version: 1,
      platform,
      sessionId,
      fingerprint: fingerprint(units),
      generatedAt: new Date().toISOString(),
      source: 'unavailable',
      tasks: [],
      llmError: null,
    };
  }
  const sourcePath = payload?.session?.filePath || payload?.session?.sourcePath || null;
  const fp = fingerprint(units);
  const key = storageKey(platform, sessionId, sourcePath);
  const cached = taskCache.get(key);
  if (!refresh && cached?.fingerprint === fp) return cached;

  const persisted = await readPersisted(platform, sessionId, sourcePath);
  if (!refresh && persisted?.fingerprint === fp) {
    const tasks = normalizeTasks(persisted, units);
    const source = tasks.some((task) => task.source === 'inferred') ? 'inferred' : persisted.source;
    const result = { ...persisted, source, tasks };
    taskCache.set(key, result);
    return result;
  }

  // The first request starts classification in the background and returns an
  // inferred result immediately. Keep that contract for every concurrent
  // request; polling must never wait behind a slow local model.
  if (taskInFlight.has(key)) return inferredResult(platform, sessionId, fp, units, null, true);

  const promise = (async () => {
    try {
      const raw = await runLlmImpl(promptForTasks(platform, units, persisted), 120_000, { purpose: 'sessionTasks' });
      const parsed = parseLlmJson(raw);
      const result = {
        version: 1,
        platform,
        sessionId,
        fingerprint: fp,
        generatedAt: new Date().toISOString(),
        source: 'llm',
        tasks: normalizeTasks(parsed, units),
        llmError: null,
        classificationPending: false,
      };
      taskCache.set(key, result);
      await writePersisted(platform, sessionId, sourcePath, result).catch(() => {});
      return result;
    } catch (error) {
      const result = inferredResult(platform, sessionId, fp, units, error.message, false);
      taskCache.set(key, result);
      return result;
    }
  })();
  taskInFlight.set(key, promise);
  void promise.finally(() => taskInFlight.delete(key));
  return inferredResult(platform, sessionId, fp, units, null, true);
}

module.exports = {
  buildExecutionUnits,
  normalizeTasks,
  classifySessionTasks,
};
