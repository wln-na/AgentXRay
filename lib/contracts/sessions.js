// Contract schemas for the session surface.
//
// Field names/shape are derived from REAL responses sampled from a scratch
// server (test/fixtures/home, all platforms) — not from frontend/src/api/types.ts.
// Observed key sets are recorded in .tmp-perf-audit/arch-8-contract-layer.md.
//
// Rules kept deliberately conservative:
//   - List items differ per platform (workbuddy has no toolResultCount, dsh has
//     no model, ...), so only `id` is required on SessionSummary and everything
//     else that is not universal is optional.
//   - Objects are `open` by default: additive server fields must never fail the
//     contract.
//   - `limit`/`before` accept 0 because 0 is the existing "no limit" sentinel.

const {
  array,
  boolean,
  literal,
  named,
  nullable,
  number,
  object,
  optional,
  record,
  string,
  union,
} = require('./schema');

// ---------- Shared primitives ----------

const TopTool = named(
  'TopTool',
  object({
    name: string(),
    count: number({ integer: true }),
  })
);

const CountMap = named('CountMap', record(number({ integer: true })));

const MessageContentPart = named('MessageContentPart', object({ type: string() }));

const MessageUsage = named(
  'MessageUsage',
  object({
    input: optional(number()),
    output: optional(number()),
    cacheRead: optional(number()),
    cacheWrite: optional(number()),
    reasoning: optional(number()),
    contextWindow: optional(number()),
    totalTokens: optional(number()),
    // omp emits an object with per-bucket dollars + total; everyone else a number.
    cost: optional(nullable(union(number(), object({})))),
  })
);

const ContextUsage = named(
  'ContextUsage',
  object({
    used: optional(number()),
    limit: optional(nullable(number())),
    percent: optional(nullable(number())),
    source: optional(string()),
    input: optional(number()),
    cacheRead: optional(number()),
    cacheWrite: optional(number()),
    output: optional(number()),
    breakdownStatus: optional(string()),
    breakdown: optional(array(object({}, { open: true }))),
    note: optional(nullable(string())),
  })
);

// ---------- Session list ----------

const SessionSummary = named(
  'SessionSummary',
  object({
    id: string(),
    timestamp: optional(nullable(string())),
    lastActivity: optional(nullable(string())),
    messageCount: optional(number({ integer: true })),
    userCount: optional(number({ integer: true })),
    assistantCount: optional(number({ integer: true })),
    toolCallCount: optional(number({ integer: true })),
    toolResultCount: optional(number({ integer: true })),
    topTools: optional(array(TopTool)),
    firstUserMessage: optional(nullable(string())),
    title: optional(nullable(string())),
    file: optional(string()),
    cwd: optional(nullable(string())),
    slug: optional(nullable(string())),
    model: optional(nullable(string())),
    models: optional(array(string())),
    status: optional(nullable(string())),
    source: optional(nullable(string())),
    archived: optional(boolean()),
    // Turn-boundary facts (A): adapters that can see the last turn's boundary
    // report it; absent keys mean "unknown" and the frontend falls back to the
    // message-count heuristic.
    lastRole: optional(nullable(union(literal('user'), literal('assistant')))),
    lastTurnOutcome: optional(nullable(union(literal('delivered'), literal('interrupted'), literal('empty')))),
    parentThreadId: optional(nullable(string())),
    childCount: optional(number({ integer: true })),
    agentRole: optional(nullable(string())),
    agentNickname: optional(nullable(string())),
    tokenUsage: optional(nullable(MessageUsage)),
    contextUsage: optional(nullable(ContextUsage)),
  })
);

const ListPage = named(
  'ListPage',
  object({
    total: number({ integer: true }),
    limit: number({ integer: true }),
    start: number({ integer: true }),
    end: number({ integer: true }),
    hasMore: boolean(),
    nextBefore: nullable(string()),
  })
);

const SessionsPage = named(
  'SessionsPage',
  object({
    sessions: array(SessionSummary),
    page: ListPage,
  })
);

// ---------- Session detail / full ----------

const SessionMessage = named(
  'SessionMessage',
  object({
    id: nullable(string()),
    timestamp: nullable(string()),
    role: string(),
    content: nullable(array(MessageContentPart)),
    usage: nullable(MessageUsage),
    model: nullable(string()),
    provider: nullable(string()),
    toolCallId: nullable(string()),
    toolName: nullable(string()),
    details: nullable(object({})),
    isError: boolean(),
  })
);

const SessionMeta = named(
  'SessionMeta',
  object({
    id: string(),
    cwd: optional(nullable(string())),
    timestamp: optional(nullable(string())),
    // types.ts says number, but real responses carry a string for some
    // platforms (e.g. workbuddy) — pin what the server actually sends.
    version: optional(nullable(union(number(), string()))),
    formatVersion: optional(nullable(union(number(), string()))),
    model: optional(nullable(string())),
    title: optional(nullable(string())),
    source: optional(nullable(string())),
    provider: optional(nullable(string())),
    models: optional(array(string())),
    archived: optional(boolean()),
    parentThreadId: optional(nullable(string())),
    parentSession: optional(nullable(string())),
    agentRole: optional(nullable(string())),
    agentNickname: optional(nullable(string())),
    agentPreset: optional(nullable(string())),
    origin: optional(nullable(string())),
    historyAvailable: optional(boolean()),
    contentAvailable: optional(boolean()),
    tokenUsage: optional(nullable(MessageUsage)),
    contextUsage: optional(nullable(ContextUsage)),
  })
);

const SessionStats = named(
  'SessionStats',
  object({
    userCount: number({ integer: true }),
    assistantCount: number({ integer: true }),
    toolCallCount: number({ integer: true }),
    toolResultCount: number({ integer: true }),
    errorCount: number({ integer: true }),
    spawnCount: number({ integer: true }),
    toolNames: CountMap,
    skillNames: CountMap,
    skillFileReads: CountMap,
    mcpServers: CountMap,
    totalRetryTools: number({ integer: true }),
    totalRetryAttempts: number({ integer: true }),
  })
);

const SessionMessagePage = named(
  'SessionMessagePage',
  object({
    total: number({ integer: true }),
    limit: number({ integer: true }),
    start: number({ integer: true }),
    end: number({ integer: true }),
    loadedCount: number({ integer: true }),
    hasMoreBefore: boolean(),
    nextBefore: nullable(string()),
  })
);

// The paged detail payload (`messagePage` is always present, one URL = one shape).
const detailShape = {
  session: SessionMeta,
  messages: array(SessionMessage),
  messagePage: SessionMessagePage,
  contextMessages: optional(array(SessionMessage)),
  activityEvents: optional(array(object({ type: string() }))),
  tokenUsage: optional(nullable(MessageUsage)),
  contextUsage: optional(nullable(ContextUsage)),
  stats: optional(SessionStats),
};

const SessionDetail = named('SessionDetail', object(detailShape));

// The complete transcript (`/full`): same shape minus `messagePage`, plus the
// `complete: true` discriminator.
const SessionFull = named(
  'SessionFull',
  object({
    session: SessionMeta,
    messages: array(SessionMessage),
    complete: literal(true),
    contextMessages: optional(array(SessionMessage)),
    activityEvents: optional(array(object({ type: string() }))),
    tokenUsage: optional(nullable(MessageUsage)),
    contextUsage: optional(nullable(ContextUsage)),
    stats: optional(SessionStats),
  })
);

const SessionMessagesPage = named(
  'SessionMessagesPage',
  object({
    messages: array(SessionMessage),
    messagePage: SessionMessagePage,
  })
);

// ---------- Tasks / children / open ----------

const SessionTaskRecord = named(
  'SessionTaskRecord',
  object({
    key: string(),
    title: string(),
    summary: optional(nullable(string())),
    status: union(literal('pending'), literal('in_progress'), literal('completed')),
    source: union(literal('explicit'), literal('llm'), literal('inferred'), literal('unavailable')),
    confidence: union(literal('high'), literal('medium'), literal('low')),
    createdAt: nullable(string()),
    startedAt: nullable(string()),
    completedAt: nullable(string()),
    statusMessageId: nullable(string()),
    unitIds: optional(array(string())),
    evidenceMessageIds: optional(array(string())),
  })
);

const SessionTaskAnalysis = named(
  'SessionTaskAnalysis',
  object({
    version: number({ integer: true }),
    platform: string(),
    sessionId: string(),
    generatedAt: string(),
    source: union(literal('llm'), literal('inferred'), literal('unavailable')),
    tasks: array(SessionTaskRecord),
    llmError: optional(nullable(string())),
    classificationPending: optional(boolean()),
    fingerprint: optional(nullable(string())),
  })
);

const ChildAgentSummary = named(
  'ChildAgentSummary',
  object({
    name: string(),
    messageCount: optional(number({ integer: true })),
    toolCallCount: optional(number({ integer: true })),
    timestamp: optional(nullable(string())),
    lastActivity: optional(nullable(string())),
    file: optional(nullable(string())),
    title: optional(nullable(string())),
    agentType: optional(nullable(string())),
    description: optional(nullable(string())),
  })
);

const OpenSessionResult = named(
  'OpenSessionResult',
  object({
    ok: boolean(),
    action: optional(union(literal('locate'), literal('open'))),
    detail: optional(string()),
    error: optional(string()),
    fallback: optional(
      nullable(
        object({
          type: union(literal('copy-path'), literal('copy-command')),
          path: optional(string()),
          command: optional(string()),
        })
      )
    ),
    hint: optional(nullable(object({ pid: string(), process: nullable(string()) }))),
  })
);

const ErrorResponse = named(
  'ErrorResponse',
  object({
    error: string(),
    code: optional(string()),
  })
);

// ---------- Request query params ----------

const AgentParam = optional(string({ maxLength: 128, pattern: /^[A-Za-z0-9._-]+$/ }));
const LimitParam = optional(number({ integer: true, min: 0, from: 'query' }));
const BeforeParam = optional(number({ integer: true, min: 0, from: 'query' }));
const DirParam = optional(string());

const SessionsListQuery = named(
  'SessionsListQuery',
  object({
    agent: AgentParam,
    limit: LimitParam,
    before: BeforeParam,
    dir: DirParam,
    include_subagents: optional(boolean({ from: 'query' })),
    include_archived: optional(boolean({ from: 'query' })),
  })
);

const SessionDetailQuery = named(
  'SessionDetailQuery',
  object({ agent: AgentParam, limit: LimitParam, before: BeforeParam, dir: DirParam })
);

const SessionFullQuery = named('SessionFullQuery', object({ agent: AgentParam, dir: DirParam }));

const SessionMessagesQuery = named(
  'SessionMessagesQuery',
  object({ agent: AgentParam, limit: LimitParam, before: BeforeParam, dir: DirParam })
);

const SessionTasksQuery = named(
  'SessionTasksQuery',
  object({ agent: AgentParam, dir: DirParam, refresh: optional(boolean({ from: 'query' })) })
);

const SessionChildrenQuery = named('SessionChildrenQuery', object({ agent: AgentParam, dir: DirParam }));

const SessionOpenQuery = named('SessionOpenQuery', object({ agent: AgentParam, dir: DirParam }));

module.exports = {
  TopTool,
  CountMap,
  MessageContentPart,
  MessageUsage,
  ContextUsage,
  SessionSummary,
  ListPage,
  SessionsPage,
  SessionMessage,
  SessionMeta,
  SessionStats,
  SessionMessagePage,
  SessionDetail,
  SessionFull,
  SessionMessagesPage,
  SessionTaskRecord,
  SessionTaskAnalysis,
  ChildAgentSummary,
  OpenSessionResult,
  ErrorResponse,
  SessionsListQuery,
  SessionDetailQuery,
  SessionFullQuery,
  SessionMessagesQuery,
  SessionTasksQuery,
  SessionChildrenQuery,
  SessionOpenQuery,
};
