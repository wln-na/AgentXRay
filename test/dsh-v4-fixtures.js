// Builders for DeepSeek Harness **v4** session fixtures.
//
// dsh writes an event stream where the header is `{type:'session',version:4,…}`
// and the log file is named `session.v4.jsonl[.zstd]`. The compressed artifact
// is a concatenation of independent zstd frames (one per durable append), so
// these helpers compress groups of records into separate frames — a single-frame
// fixture would not exercise the multi-frame reader.
//
// Nothing here touches test/fixtures/home: callers either point writeSession at
// a throwaway directory or pass `installHomeFixtures` to `startServer`'s
// `prepareHome` hook, which runs after the base fixture home is copied and
// before the server boots.
//
// Kept out of `*.test.js` on purpose so `node --test test/*.test.js` does not
// execute it as a test file.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

// One independent zstd frame per durable append batch.
function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(String(text), 'utf8'), ZSTD_OPTS);
}

function toLine(record) {
  return typeof record === 'string' ? record : JSON.stringify(record);
}

// Compress `records` into concatenated frames. `groups` is a list of per-frame
// record counts; the last entry absorbs every remaining record (and a missing /
// empty `groups` produces a single frame). Each frame is newline-terminated so
// line-oriented readers see complete records at every frame boundary.
function packFrames(records, groups) {
  const chunks = [];
  const total = records.length;
  const sizes = Array.isArray(groups) && groups.length > 0 ? groups : [total];
  let at = 0;
  for (let i = 0; i < sizes.length && at < total; i++) {
    const take = i === sizes.length - 1 ? total - at : Math.max(0, sizes[i]);
    if (take === 0) continue;
    const body = records
      .slice(at, at + take)
      .map(toLine)
      .join('\n');
    at += take;
    if (body) chunks.push(frame(`${body}\n`));
  }
  if (at < total) {
    const body = records.slice(at).map(toLine).join('\n');
    if (body) chunks.push(frame(`${body}\n`));
  }
  return Buffer.concat(chunks);
}

// Write one session log. `.zstd` file names are written as multi-frame zstd;
// plain `.jsonl` names are written as newline-delimited JSON. Returns the file
// path so callers can assert on discovery directly.
function writeSession(root, project, sessionId, records, groups, fileName = 'session.v4.jsonl.zstd') {
  const dir = path.join(root, project, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  if (fileName.endsWith('.zstd')) {
    fs.writeFileSync(file, packFrames(records, groups));
  } else {
    const body = records.map(toLine).join('\n');
    fs.writeFileSync(file, body ? `${body}\n` : '');
  }
  return file;
}

// --- fixture clock ---
// Event times are relative to the run so that the usage endpoint's trailing-day
// window (max 90 days) always includes the fixture. Sorted newest-first, the
// fixture ids line up as listed in FIXTURE_ORDER below.
const NOW_MS = Date.now();
const BASE_MS = NOW_MS - 2 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const TEXT = {
  fallbackTitle: 'fixture: fallback v4 title',
  providerTitle: 'fixture: provider v4 title',
  fallbackOnlyTitle: 'fixture: fallback-only-title',
  runtimeContext: 'fixture: v4-runtime-context-needle injected environment context',
  skillCatalog: `fixture: v4-skill-catalog-needle ${'skill '.repeat(300)}`.trim(),
  mainUserAlpha: 'fixture: v4-needle-alpha summarize the migration plan',
  mainAssistantAlpha: 'fixture: v4-alpha-answer from the model',
  mainUserBeta: 'fixture: v4-needle-beta verify the tool output',
  mainAssistantBeta: 'fixture: v4-beta-answer after the tool ran',
  mainToolError: 'fixture: v4-failure-output',
  mainToolOk: 'fixture: v4-file-body',
  mainTurnError: 'fixture: v4 turn failed',
  compactionOldUser: 'fixture: v4-compaction-old-user',
  compactionOldAssistant: 'fixture: v4-compaction-old-assistant',
  compactionSummary: 'fixture: v4-compaction-summary only the summary stays',
  compactionAfter: 'fixture: v4-compaction-after',
  subagentUser: 'fixture: v4-subagent-needle report back',
  subagentAssistant: 'fixture: v4-subagent-answer',
  mixedUser: 'fixture: v4-mixed-needle fresh generation',
  mixedStaleUser: 'fixture: v4-mixed-stale should never surface',
  mixedAssistant: 'fixture: v4-mixed-answer',
  fallbackUser: 'fixture: v4-fallback-real-prompt used as the title',
};

const TOOL_1 = { callId: 'call-v4-1', name: 'run_command', arguments: '{"command":"echo v4"}' };
const TOOL_2 = { callId: 'call-v4-2', name: 'read_file', arguments: '{"path":"a.txt"}' };

const MAIN = {
  project: '--fixtures-project-v4--',
  id: 'dsh-v4-fixture-0001',
  file: 'session.v4.jsonl.zstd',
  cwd: '/fixtures/project-v4',
  createdAt: BASE_MS,
};
const MIXED = {
  project: '--fixtures-project-v4-mixed--',
  id: 'dsh-v4-mixed-0003',
  file: 'session.v4.jsonl',
  staleFile: 'session.jsonl',
  cwd: '/fixtures/project-v4-mixed',
  createdAt: BASE_MS + 3 * MINUTE,
  staleId: 'dsh-v4-mixed-stale',
};
const SUBAGENT = {
  project: '--fixtures-project-v4--',
  id: 'dsh-v4-subagent-0002',
  file: 'session.v4.jsonl',
  cwd: '/fixtures/project-v4',
  createdAt: BASE_MS + 5 * MINUTE,
  parentSession: MAIN.id,
};
const COMPACTION = {
  project: '--fixtures-project-v4-compaction--',
  id: 'dsh-v4-compaction-0005',
  file: 'session.v4.jsonl',
  cwd: '/fixtures/project-v4-compaction',
  createdAt: BASE_MS + 6 * MINUTE,
};
const FALLBACK = {
  project: '--fixtures-project-v4-fallback--',
  id: 'dsh-v4-fallback-0009',
  file: 'session.v4.jsonl',
  cwd: '/fixtures/project-v4-fallback',
  createdAt: BASE_MS + 7 * MINUTE,
};
const V5 = {
  project: '--fixtures-project-v5--',
  id: 'dsh-v5-future-0006',
  file: 'session.v5.jsonl',
  cwd: '/fixtures/project-v5',
  createdAt: BASE_MS + 8 * MINUTE,
};
const V2 = {
  project: '--fixtures-project-v2--',
  id: 'dsh-v2-legacy-0007',
  file: 'session.v2.jsonl',
  cwd: '/fixtures/project-v2',
  createdAt: BASE_MS + 9 * MINUTE,
};
const MISMATCH = {
  project: '--fixtures-project-v4-mismatch--',
  id: 'dsh-v4-mismatch-0008',
  file: 'session.v4.jsonl',
  cwd: '/fixtures/project-v4-mismatch',
  createdAt: BASE_MS + 10 * MINUTE,
};

// Expected newest-first order of the fixture ids above (the two v0 sessions in
// the shared fixture home carry January-2026 timestamps and sort after these).
const FIXTURE_ORDER = [MISMATCH.id, V2.id, V5.id, FALLBACK.id, COMPACTION.id, SUBAGENT.id, MIXED.id, MAIN.id];

function header(meta, overrides = {}) {
  return {
    type: 'session',
    version: 4,
    id: meta.id,
    createdAt: meta.createdAt,
    cwd: meta.cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  };
}

function event(type, seq, time, data, surfaceOp) {
  const record = { type, seq, time, data };
  if (surfaceOp !== undefined) record.surfaceOp = surfaceOp;
  return record;
}

function userMessage(seq, time, text, kind = 'user', surfaceOp = 'append') {
  return event(
    'user/message',
    seq,
    time,
    {
      content: [{ type: 'text', text }],
      source: { kind },
      role: 'user',
      id: `user-v4-${seq}`,
    },
    surfaceOp
  );
}

function assistantMessage(seq, time, { reasoning = null, text = null, usage = null, toolCall = null } = {}) {
  const content = [];
  if (reasoning) content.push({ type: 'reasoning', text: reasoning });
  if (text) content.push({ type: 'text', text });
  if (toolCall)
    content.push({ type: 'tool-call', id: toolCall.callId, name: toolCall.name, arguments: toolCall.arguments });
  const data = {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' },
      id: `assistant-v4-${seq}`,
    },
  };
  if (usage) data.usage = usage;
  return event('assistant/message', seq, time, data, 'append');
}

// Main happy-path session: fallback→provider title, two injections, a real
// user/assistant turn, a failed tool call (message.isError only — no data.error),
// a second turn with a successful tool call, and a failing turn/end.
function mainSessionRecords() {
  const t = MAIN.createdAt;
  return [
    header(MAIN),
    event('session/title', 1, t + 1000, { title: TEXT.fallbackTitle, source: { kind: 'fallback' } }),
    userMessage(2, t + 2000, TEXT.runtimeContext, 'runtime-context'),
    userMessage(3, t + 3000, TEXT.skillCatalog, 'skill-catalog'),
    userMessage(4, t + 4000, TEXT.mainUserAlpha),
    assistantMessage(5, t + 5000, {
      reasoning: 'fixture: v4 reasoning about alpha',
      text: TEXT.mainAssistantAlpha,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, totalTokens: 160 },
    }),
    event('tool/call', 6, t + 6000, { turn: 1, step: 1, ...TOOL_1 }),
    event('tool/result', 7, t + 7000, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: TOOL_1.callId },
        toolCallId: TOOL_1.callId,
        isError: true,
        content: [{ type: 'text', text: TEXT.mainToolError }],
      },
    }),
    userMessage(8, t + 8000, TEXT.mainUserBeta),
    assistantMessage(9, t + 9000, {
      reasoning: 'fixture: v4 reasoning about beta',
      text: TEXT.mainAssistantBeta,
      usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 20, totalTokens: 80 },
    }),
    event('tool/call', 10, t + 10000, { turn: 2, step: 1, ...TOOL_2 }),
    event('tool/result', 11, t + 11000, {
      turn: 2,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: TOOL_2.callId },
        toolCallId: TOOL_2.callId,
        isError: false,
        content: [{ type: 'text', text: TEXT.mainToolOk }],
      },
    }),
    event('session/title', 12, t + 12000, {
      title: TEXT.providerTitle,
      messageSeqs: [8],
      source: { kind: 'provider' },
    }),
    event('turn/end', 13, t + 13000, {
      turn: 2,
      reason: { kind: 'error', error: { message: TEXT.mainTurnError } },
    }),
  ];
}

// Groups: header / titles+injections / alpha turn / beta turn / title+turn end.
const MAIN_FRAMES = [1, 3, 4, 4, 2];

function subagentSessionRecords() {
  const t = SUBAGENT.createdAt;
  return [
    header(SUBAGENT, {
      parentSession: SUBAGENT.parentSession,
      origin: 'subagent',
      delegationDepth: 1,
    }),
    userMessage(1, t + 1000, TEXT.subagentUser),
    assistantMessage(2, t + 2000, { text: TEXT.subagentAssistant }),
    event('turn/end', 3, t + 3000, { turn: 1, reason: { kind: 'completed' } }),
  ];
}

// Stale v0 generation in the v0+v4 coexistence directory; the adapter must
// ignore it once session.v4.jsonl exists.
function staleV0Records() {
  const t = MIXED.createdAt - 1000;
  return [
    { type: 'session', version: 0, id: MIXED.staleId, createdAt: t, cwd: MIXED.cwd, delegationDepth: 0 },
    userMessage(1, t + 1000, TEXT.mixedStaleUser),
    assistantMessage(2, t + 2000, { text: 'fixture: v4-mixed-stale-answer' }),
    event('turn/end', 3, t + 3000, { turn: 1, reason: { kind: 'completed' } }),
  ];
}

function mixedV4Records() {
  const t = MIXED.createdAt;
  return [
    header(MIXED),
    userMessage(1, t + 1000, TEXT.mixedUser),
    assistantMessage(2, t + 2000, { text: TEXT.mixedAssistant }),
    event('turn/end', 3, t + 3000, { turn: 1, reason: { kind: 'completed' } }),
  ];
}

// v4 compaction: surfaceOp{op:'replace',startSeq,endSeq} uses event seq numbers
// and a CLOSED interval, so endSeq=2 masks both seq 1 and seq 2.
function compactionRecords() {
  const t = COMPACTION.createdAt;
  return [
    header(COMPACTION),
    userMessage(1, t + 1000, TEXT.compactionOldUser),
    assistantMessage(2, t + 2000, { text: TEXT.compactionOldAssistant }),
    userMessage(3, t + 3000, TEXT.compactionSummary, 'compact-checkpoint', {
      op: 'replace',
      startSeq: 1,
      endSeq: 2,
    }),
    userMessage(4, t + 4000, TEXT.compactionAfter),
    event('turn/end', 5, t + 5000, { turn: 2, reason: { kind: 'completed' } }),
  ];
}

// Only a fallback title: the adapter must fall back to the first human prompt,
// not to the fallback event's text.
function fallbackTitleRecords() {
  const t = FALLBACK.createdAt;
  return [
    header(FALLBACK),
    event('session/title', 1, t + 1000, { title: TEXT.fallbackOnlyTitle, source: { kind: 'fallback' } }),
    userMessage(2, t + 2000, TEXT.fallbackUser),
    assistantMessage(3, t + 3000, { text: 'fixture: v4-fallback-answer' }),
    event('turn/end', 4, t + 4000, { turn: 1, reason: { kind: 'completed' } }),
  ];
}

// Write the whole fixture tree into a dsh sessions root.
function writeAll(root) {
  writeSession(root, MAIN.project, MAIN.id, mainSessionRecords(), MAIN_FRAMES, MAIN.file);
  writeSession(root, SUBAGENT.project, SUBAGENT.id, subagentSessionRecords(), null, SUBAGENT.file);
  writeSession(root, MIXED.project, MIXED.id, staleV0Records(), null, MIXED.staleFile);
  writeSession(root, MIXED.project, MIXED.id, mixedV4Records(), null, MIXED.file);
  writeSession(root, COMPACTION.project, COMPACTION.id, compactionRecords(), null, COMPACTION.file);
  writeSession(root, FALLBACK.project, FALLBACK.id, fallbackTitleRecords(), null, FALLBACK.file);
  writeSession(root, V5.project, V5.id, [header(V5, { version: 5 })], null, V5.file);
  writeSession(root, V2.project, V2.id, [header(V2, { version: 2 })], null, V2.file);
  writeSession(root, MISMATCH.project, MISMATCH.id, [header(MISMATCH, { version: 0 })], null, MISMATCH.file);
  return root;
}

// `prepareHome` hook for test/helpers.js startServer: writes the v4 fixtures
// into the throwaway home's dsh sessions root, leaving the shared fixture home
// (and every other platform's counts) untouched.
function installHomeFixtures(home) {
  return writeAll(path.join(home, '.dsh', 'sessions'));
}

module.exports = {
  frame,
  packFrames,
  writeSession,
  writeAll,
  installHomeFixtures,
  header,
  event,
  userMessage,
  assistantMessage,
  mainSessionRecords,
  subagentSessionRecords,
  staleV0Records,
  mixedV4Records,
  compactionRecords,
  fallbackTitleRecords,
  TEXT,
  TOOL_1,
  TOOL_2,
  MAIN,
  MIXED,
  SUBAGENT,
  COMPACTION,
  FALLBACK,
  V5,
  V2,
  MISMATCH,
  FIXTURE_ORDER,
  BASE_MS,
  NOW_MS,
};
