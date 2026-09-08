const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { normalizeCodexTokenUsage } = require(path.join(ROOT, 'lib', 'platforms', 'codex'));
const { normalizeClaudeUsage, summarizeClaudeRequestUsage } = require(path.join(ROOT, 'lib', 'platforms', 'claude'));
const { sliceMessagesBeforeTarget } = require(path.join(ROOT, 'lib', 'context'));

// ---------------------------------------------------------------------------
// normalizeCodexTokenUsage
// ---------------------------------------------------------------------------

test('normalizeCodexTokenUsage: total_tokens=0 falls back to component sum', () => {
  const usage = normalizeCodexTokenUsage({
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 30,
    cache_write_input_tokens: 10,
    reasoning_output_tokens: 5,
    total_tokens: 0,
  });
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 50);
  assert.equal(usage.cacheRead, 30);
  assert.equal(usage.cacheWrite, 10);
  assert.equal(usage.reasoning, 5);
  // 100 + 50 + 30 + 10 + 5 = 195
  assert.equal(usage.totalTokens, 195);
});

test('normalizeCodexTokenUsage: missing total_tokens falls back to component sum', () => {
  const usage = normalizeCodexTokenUsage({
    input_tokens: 200,
    output_tokens: 80,
  });
  assert.equal(usage.totalTokens, 280);
});

test('normalizeCodexTokenUsage: null total_tokens falls back to component sum', () => {
  const usage = normalizeCodexTokenUsage({
    input_tokens: 200,
    output_tokens: 80,
    total_tokens: null,
  });
  assert.equal(usage.totalTokens, 280);
});

test('normalizeCodexTokenUsage: valid total_tokens is used', () => {
  const usage = normalizeCodexTokenUsage({
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
  });
  assert.equal(usage.totalTokens, 150);
});

test('normalizeCodexTokenUsage: raw total smaller than component sum takes the larger', () => {
  // Data anomaly: raw total_tokens is 100 but components sum to 195
  const usage = normalizeCodexTokenUsage({
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 30,
    cache_write_input_tokens: 10,
    reasoning_output_tokens: 5,
    total_tokens: 100,
  });
  assert.equal(usage.totalTokens, 195);
});

test('normalizeCodexTokenUsage: contextWindow preserved', () => {
  const usage = normalizeCodexTokenUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }, 200000);
  assert.equal(usage.contextWindow, 200000);
});

test('normalizeCodexTokenUsage: returns null for invalid input', () => {
  assert.equal(normalizeCodexTokenUsage(null), null);
  assert.equal(normalizeCodexTokenUsage(undefined), null);
  assert.equal(normalizeCodexTokenUsage('not-an-object'), null);
});

// ---------------------------------------------------------------------------
// normalizeClaudeUsage
// ---------------------------------------------------------------------------

test('normalizeClaudeUsage: raw total_tokens present is used (with max guard)', () => {
  const usage = normalizeClaudeUsage({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
    total_tokens: 200,
  });
  assert.equal(usage.input, 100);
  assert.equal(usage.output, 50);
  assert.equal(usage.cacheRead, 30);
  assert.equal(usage.cacheWrite, 10);
  // component sum = 190, raw total = 200 → max = 200
  assert.equal(usage.totalTokens, 200);
});

test('normalizeClaudeUsage: missing total_tokens falls back to component sum', () => {
  const usage = normalizeClaudeUsage({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
  });
  assert.equal(usage.totalTokens, 190);
});

test('normalizeClaudeUsage: raw total smaller than component sum takes the larger', () => {
  const usage = normalizeClaudeUsage({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
    total_tokens: 100,
  });
  // component sum = 190 > raw 100
  assert.equal(usage.totalTokens, 190);
});

test('normalizeClaudeUsage: contextWindow extracted from model_context_window', () => {
  const usage = normalizeClaudeUsage({
    input_tokens: 10,
    output_tokens: 5,
    model_context_window: 200000,
  });
  assert.equal(usage.contextWindow, 200000);
});

test('normalizeClaudeUsage: returns null for invalid input', () => {
  assert.equal(normalizeClaudeUsage(null), null);
  assert.equal(normalizeClaudeUsage(undefined), null);
});

// ---------------------------------------------------------------------------
// summarizeClaudeRequestUsage — session-level dedup
// ---------------------------------------------------------------------------

function makeUsage(overrides = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    contextWindow: 200000,
    ...overrides,
  };
}

test('summarizeClaudeRequestUsage: input/cache take latest value, output summed', () => {
  // Simulate 3 assistant turns with cumulative input_tokens
  const requestUsage = new Map([
    ['req-1', makeUsage({ input: 500, output: 100, cacheRead: 200, cacheWrite: 50 })],
    ['req-2', makeUsage({ input: 800, output: 150, cacheRead: 400, cacheWrite: 60 })],
    ['req-3', makeUsage({ input: 1200, output: 200, cacheRead: 700, cacheWrite: 80 })],
  ]);
  const latestUsage = requestUsage.get('req-3');

  const { tokenUsage, contextUsage } = summarizeClaudeRequestUsage(requestUsage, latestUsage);

  // Input/cache: latest request values (cumulative), NOT summed
  assert.equal(tokenUsage.input, 1200);
  assert.equal(tokenUsage.cacheRead, 700);
  assert.equal(tokenUsage.cacheWrite, 80);
  // Output: sum of all responses
  assert.equal(tokenUsage.output, 450);
  // totalTokens = latest input + latest cacheRead + latest cacheWrite + sum(output)
  // = 1200 + 700 + 80 + 450 = 2430
  assert.equal(tokenUsage.totalTokens, 2430);

  // contextUsage.used based on latestUsage (unchanged logic)
  assert.equal(contextUsage.used, 1200 + 700 + 80);
  assert.equal(contextUsage.input, 1200);
  assert.equal(contextUsage.cacheRead, 700);
  assert.equal(contextUsage.cacheWrite, 80);
});

test('summarizeClaudeRequestUsage: single request works', () => {
  const requestUsage = new Map([['req-1', makeUsage({ input: 300, output: 50, cacheRead: 100, cacheWrite: 20 })]]);
  const latestUsage = requestUsage.get('req-1');
  const { tokenUsage } = summarizeClaudeRequestUsage(requestUsage, latestUsage);
  assert.equal(tokenUsage.input, 300);
  assert.equal(tokenUsage.output, 50);
  assert.equal(tokenUsage.cacheRead, 100);
  assert.equal(tokenUsage.cacheWrite, 20);
  assert.equal(tokenUsage.totalTokens, 300 + 100 + 20 + 50);
});

test('summarizeClaudeRequestUsage: empty map returns null', () => {
  const result = summarizeClaudeRequestUsage(new Map(), makeUsage());
  assert.equal(result.tokenUsage, null);
  assert.equal(result.contextUsage, null);
});

test('summarizeClaudeRequestUsage: dedup by request key (same key overwrites)', () => {
  // Same request key recorded twice (e.g. partial + final usage) — Map dedups
  const requestUsage = new Map();
  requestUsage.set('msg-1', makeUsage({ input: 500, output: 0 }));
  requestUsage.set('msg-1', makeUsage({ input: 500, output: 120 }));
  const latestUsage = requestUsage.get('msg-1');
  const { tokenUsage } = summarizeClaudeRequestUsage(requestUsage, latestUsage);
  assert.equal(requestUsage.size, 1);
  assert.equal(tokenUsage.output, 120);
  assert.equal(tokenUsage.input, 500);
});

// ---------------------------------------------------------------------------
// sliceMessagesBeforeTarget — integer validation
// ---------------------------------------------------------------------------

const sampleMessages = [
  { id: 'u1', role: 'user', content: [] },
  { id: 'a1', role: 'assistant', content: [] },
  { id: 'u2', role: 'user', content: [] },
];

test('sliceMessagesBeforeTarget: rejects non-integer messageIndex', () => {
  assert.throws(
    () => sliceMessagesBeforeTarget(sampleMessages, { messageIndex: 1.5 }),
    (err) => err.code === 'TARGET_NOT_FOUND'
  );
});

test('sliceMessagesBeforeTarget: rejects negative float', () => {
  assert.throws(
    () => sliceMessagesBeforeTarget(sampleMessages, { messageIndex: -0.5 }),
    (err) => err.code === 'TARGET_NOT_FOUND'
  );
});

test('sliceMessagesBeforeTarget: accepts valid integer index', () => {
  const result = sliceMessagesBeforeTarget(sampleMessages, { messageIndex: 2 });
  assert.equal(result.targetIndex, 2);
  assert.equal(result.targetMessage.id, 'u2');
  assert.equal(result.priorMessages.length, 2);
});

test('sliceMessagesBeforeTarget: messageId lookup still works (findIndex returns integer)', () => {
  const result = sliceMessagesBeforeTarget(sampleMessages, { messageId: 'u2' });
  assert.equal(result.targetIndex, 2);
  assert.equal(result.targetMessage.id, 'u2');
});

test('sliceMessagesBeforeTarget: index 0 is valid', () => {
  const result = sliceMessagesBeforeTarget(sampleMessages, { messageIndex: 0 });
  assert.equal(result.targetIndex, 0);
  assert.equal(result.targetMessage.id, 'u1');
});
