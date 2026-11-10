// Contract schemas for context reconstruction.
//
// Two response modes on one URL:
//   GET …/context?messageIndex=N | ?messageId=x  → ContextSnapshot
//   GET …/context?messageIds=a,b,c               → { snapshots, errors }
//
// Shapes sampled from live responses (codex + dsh fixtures); see
// .tmp-perf-audit/arch-8-contract-layer.md for the observed key sets.

const { array, boolean, literal, named, nullable, number, object, optional, string, union } = require('./schema');

const ContextPromptComponent = named(
  'ContextPromptComponent',
  object({
    type: string(),
    label: string(),
    present: boolean(),
    content: nullable(string()),
    source: nullable(string()),
    note: nullable(string()),
  })
);

const ContextSystemPrompt = named(
  'ContextSystemPrompt',
  object({
    source: string(),
    content: string(),
    components: array(ContextPromptComponent),
  })
);

const ContextHistorySummary = named(
  'ContextHistorySummary',
  object({
    total: number({ integer: true }),
    turns: number({ integer: true }),
    user: number({ integer: true }),
    assistant: number({ integer: true }),
    toolCall: number({ integer: true }),
    toolResult: number({ integer: true }),
    reasoning: number({ integer: true }),
    other: number({ integer: true }),
  })
);

const ContextHistory = named(
  'ContextHistory',
  object({
    summary: ContextHistorySummary,
    included: boolean(),
    items: optional(array(object({ role: optional(string()) }))),
    target: optional(nullable(object({}))),
    compaction: optional(
      nullable(
        object({
          applied: boolean(),
          timestamp: nullable(string()),
          source: string(),
        })
      )
    ),
  })
);

const ContextTools = named(
  'ContextTools',
  object({
    available: boolean(),
    count: number({ integer: true }),
    source: nullable(string()),
    definitions: nullable(array(object({}))),
  })
);

const ContextMetadata = named(
  'ContextMetadata',
  object({
    confidence: union(literal('high'), literal('medium'), literal('low')),
    reconstructedAt: string(),
    sources: array(string()),
    missingItems: array(string()),
    note: string(),
    platform: string(),
  })
);

const ContextSnapshot = named(
  'ContextSnapshot',
  object({
    platform: string(),
    sessionId: string(),
    messageIndex: number({ integer: true }),
    targetMessageId: nullable(string()),
    systemPrompt: ContextSystemPrompt,
    messages: ContextHistory,
    tools: ContextTools,
    metadata: ContextMetadata,
  })
);

const ContextError = named(
  'ContextError',
  object({
    messageId: string(),
    error: string(),
  })
);

const ContextBatch = named(
  'ContextBatch',
  object({
    snapshots: array(ContextSnapshot),
    errors: array(ContextError),
  })
);

// Raw query params of the context route. `messageIds` stays a raw comma-joined
// string here; each parsed id is validated with ContextMessageIds below.
const ContextQuery = named(
  'ContextQuery',
  object({
    messageIds: optional(string()),
    messageId: optional(string({ minLength: 1, maxLength: 512, pattern: /^\S+$/ })),
    agent: optional(string({ maxLength: 128, pattern: /^[A-Za-z0-9._-]+$/ })),
    dir: optional(string()),
  })
);

const ContextMessageIds = named('ContextMessageIds', array(string({ minLength: 1, maxLength: 512, pattern: /^\S+$/ })));

module.exports = {
  ContextPromptComponent,
  ContextSystemPrompt,
  ContextHistorySummary,
  ContextHistory,
  ContextTools,
  ContextMetadata,
  ContextSnapshot,
  ContextError,
  ContextBatch,
  ContextQuery,
  ContextMessageIds,
};
