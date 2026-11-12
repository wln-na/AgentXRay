const fsp = require('node:fs/promises');
const { sessionMetaCache } = require('../config');
const { createCache } = require('../cache');
const { withInFlightDedup } = require('../shared');

// --- Shared platform-adapter skeleton helpers ---
// Every adapter used to hand-roll these three pieces; they live here once.

// Wrap a raw metadata parser with the mtime cache: a file whose mtime hasn't
// changed since the last parse is served from sessionMetaCache.
function withMetadataCache(parseRaw) {
  return async function cachedMetadataParse(filePath, ...rest) {
    try {
      const stat = await fsp.stat(filePath);
      const cached = sessionMetaCache.get(filePath);
      if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    } catch {
      // If stat fails, fall through to parse
    }

    const data = await parseRaw(filePath, ...rest);

    try {
      const stat = await fsp.stat(filePath);
      sessionMetaCache.set(filePath, { mtime: stat.mtimeMs, data });
    } catch {
      // Non-critical — just skip caching
    }

    return data;
  };
}

// --- Conversation turn-boundary facts ---
// The session list tells "waiting on the user" apart from "assistant replied"
// from the LAST conversation record, not from userCount/assistantCount (a failed
// turn still increments assistantCount; doubao counts from two sources). The
// facts are optional by design: a platform that cannot determine one omits it
// and the frontend falls back to the old count heuristic.
//   lastRole:        'user' | 'assistant' — role of the last *conversation*
//                    record. Tool results, system/context/compaction rows and
//                    injected user records are not conversation records.
//   lastTurnOutcome: 'delivered' (last assistant record carried substantive
//                    text) | 'empty' (it carried none: tool-only, reasoning-only
//                    or a literal placeholder) | 'interrupted' (the log carries
//                    an explicit this-turn-aborted marker). Omitted when the
//                    last turn has no outcome yet.
//
// Trackers are mutated in place by the parser, exactly like the counters.
function createTurnFactsTracker() {
  return {
    lastRole: null,
    lastAssistantHasText: false,
    turnInterrupted: false,
  };
}

// A real human turn starts: the previous turn's outcome no longer applies.
function noteUserTurn(tracker) {
  if (!tracker) return;
  tracker.lastRole = 'user';
  tracker.turnInterrupted = false;
}

// An assistant conversation record. `hasText` is whether it carried substantive
// text (see isSubstantiveAssistantText); tool-only turns are `false` → empty.
// An interruption marker is deliberately NOT cleared here: only a new user turn
// proves the aborted turn is over.
function noteAssistantTurn(tracker, hasText) {
  if (!tracker) return;
  tracker.lastRole = 'assistant';
  tracker.lastAssistantHasText = hasText === true;
}

// Explicit "this turn was aborted / failed before finishing" marker. Order
// matters: a user prompt after it (noteUserTurn) starts a fresh turn and clears
// the flag. Markers that only prove *some* turn failed must not be recorded.
function noteInterruptedTurn(tracker) {
  if (!tracker) return;
  tracker.turnInterrupted = true;
}

// Text of a normalized content block list. Covers the block type names the
// adapters use for real assistant/user text; tool/reasoning blocks are ignored.
const TEXT_CONTENT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text']);

function textFromContentBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && TEXT_CONTENT_BLOCK_TYPES.has(block.type) && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// Placeholder some CLIs write into an "assistant" record that actually produced
// nothing. Counting it as text would report a delivered turn that never landed.
const EMPTY_ASSISTANT_TEXT_MARKER = 'turn failed before producing content';

function isSubstantiveAssistantText(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !trimmed.toLowerCase().includes(EMPTY_ASSISTANT_TEXT_MARKER);
}

// Project the tracker onto a session summary. Only known keys are returned, so
// `...lastTurnFacts(stats)` never adds an undefined/null field: an absent key is
// what tells the frontend to fall back to counts.
function lastTurnFacts(tracker) {
  const facts = {};
  const role = tracker?.lastRole;
  if (role !== 'user' && role !== 'assistant') return facts;
  facts.lastRole = role;
  if (tracker.turnInterrupted === true) {
    facts.lastTurnOutcome = 'interrupted';
  } else if (role === 'assistant') {
    facts.lastTurnOutcome = tracker.lastAssistantHasText ? 'delivered' : 'empty';
  }
  return facts;
}

// Fresh per-parse session statistics. Every adapter's metadata parser used to
// declare the same counter block by hand; this is the single definition site.
// Fields are mutated in place by the parser and read back when assembling the
// session summary (topTools via topToolsOf(stats.toolNames)).
function createSessionStatsCollector() {
  return {
    messageCount: 0,
    userCount: 0,
    assistantCount: 0,
    toolCallCount: 0,
    toolResultCount: 0,
    lastTimestamp: null,
    firstUserMessage: null,
    toolNames: {},
    ...createTurnFactsTracker(),
  };
}

// The normalized message shape served by every session endpoint. This is the
// single definition site of the 11-field literal; adapters override only the
// fields their record actually carries.
function makeMessage(overrides) {
  return {
    id: null,
    timestamp: null,
    role: null,
    content: [],
    usage: null,
    model: null,
    provider: null,
    toolCallId: null,
    toolName: null,
    details: null,
    isError: false,
    ...overrides,
  };
}

// In-place newest-first sort by session start timestamp (list* tail sort).
function sortSessionsByTimestampDesc(sessions) {
  sessions.sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : 0;
    const bTime = b.timestamp ? Date.parse(b.timestamp) : 0;
    return bTime - aTime;
  });
  return sessions;
}

// Top-5 most used tools from a name → count histogram.
function topToolsOf(toolNames) {
  return Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
}

// Module-level memo cache for deterministic tool-duration estimates.
// LRU-bounded (key space is tool names, but bounded is safer than unbounded).
const toolDurationCache = createCache({ max: 500 });

// Estimate tool execution duration in ms based on tool name.
// Generic across platforms: maps well-known tool name substrings to
// representative latencies. Lives here (not in a platform adapter) so
// both doubao.js and doubao-store.js can import it without a cycle.
function estimateToolDurationMs(toolName) {
  const name = (toolName || '').toLowerCase();
  const cached = toolDurationCache.get(name);
  if (cached !== undefined) return cached;
  let result;
  if (name.includes('bash')) result = 3000;
  else if (name.includes('taskoutput')) result = 2000;
  else if (name.includes('edit') || name.includes('write')) result = 1000;
  else if (name.includes('read')) result = 500;
  else if (name.includes('grep') || name.includes('glob')) result = 800;
  else if (name.includes('todowrite')) result = 100;
  else if (name.includes('wait')) result = 5000;
  else if (name.includes('search')) result = 1500;
  else if (name.includes('computer') || name.includes('browser')) result = 4000;
  else result = 1000;
  toolDurationCache.set(name, result);
  return result;
}

module.exports = {
  withMetadataCache,
  createSessionStatsCollector,
  createTurnFactsTracker,
  noteUserTurn,
  noteAssistantTurn,
  noteInterruptedTurn,
  textFromContentBlocks,
  isSubstantiveAssistantText,
  lastTurnFacts,
  withInFlightDedup,
  makeMessage,
  sortSessionsByTimestampDesc,
  topToolsOf,
  estimateToolDurationMs,
  toolDurationCache,
};
