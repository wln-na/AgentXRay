// Performance-focused unit tests: verify the three concurrency / double-read
// fixes behave correctly.
//
//   1. parseCodexSessionFile extracts systemContext in a single pass;
//      buildCodexContext reuses it instead of scanning the file a second time.
//   2. computeInsights dedups concurrent in-flight calls with the same key.
//   3. withInFlightDedup helper (and its use in codex/claude parsers) shares
//      one execution for concurrent same-key calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'home');
const CODEX_SESSIONS_DIR = path.join(FIXTURE_HOME, '.codex', 'sessions');
const CODEX_COMPACTION_FILE = path.join(
  CODEX_SESSIONS_DIR,
  '2026',
  '01',
  '17',
  'rollout-2026-01-17T10-00-00-01900000-0000-7000-8000-000000000006.jsonl'
);
const CODEX_COMPACTION_ID = '01900000-0000-7000-8000-000000000006';

// ---------------------------------------------------------------------------
// Issue 1: Codex context single read
// ---------------------------------------------------------------------------

test('parseCodexSessionFile returns systemContext extracted during the single pass', async () => {
  const { parseCodexSessionFile } = require(path.join(ROOT, 'lib', 'platforms', 'codex'));
  const { session, messages, tokenUsage, systemContext } = await parseCodexSessionFile(CODEX_COMPACTION_FILE);

  assert.ok(session, 'session should be present');
  assert.ok(Array.isArray(messages), 'messages should be an array');
  assert.ok(tokenUsage !== undefined, 'tokenUsage should be present');

  assert.ok(systemContext, 'systemContext should be present on the return value');
  assert.ok(Array.isArray(systemContext.systemComponents), 'systemComponents should be an array');
  assert.ok(systemContext.systemComponents.length > 0, 'systemComponents should not be empty');

  // environment_context synthetic message
  const env = systemContext.systemComponents.find((c) => c.type === 'environment');
  assert.ok(env, 'environment component should be present');
  assert.ok(env.content.includes('<environment_context>'));
  assert.equal(env.present, true);

  // user_instructions synthetic message
  const userInst = systemContext.systemComponents.find((c) => c.type === 'user-instructions');
  assert.ok(userInst, 'user-instructions component should be present');
  assert.ok(userInst.content.includes('Always use TypeScript'));

  // base_instructions from session_meta
  const baseInst = systemContext.systemComponents.find((c) => c.type === 'base-instructions');
  assert.ok(baseInst, 'base-instructions component should be present');

  // compaction record
  assert.ok(systemContext.compaction, 'compaction should be present');
  assert.ok(systemContext.compaction.timestamp, 'compaction should have a timestamp');
  assert.ok(Array.isArray(systemContext.compaction.replacementHistory), 'replacementHistory should be an array');
  assert.equal(systemContext.compaction.replacementHistory.length, 2, 'replacementHistory should have 2 entries');

  // messagesAfterCompaction: the two response_items after the compacted record
  assert.ok(Array.isArray(systemContext.messagesAfterCompaction), 'messagesAfterCompaction should be an array');
  assert.equal(systemContext.messagesAfterCompaction.length, 2, 'should capture 2 messages after compaction');
});

test('reconstructContext for codex respects compaction using systemContext from single parse', async () => {
  const { reconstructContext } = require(path.join(ROOT, 'lib', 'context'));

  // messages array: [env_context user, user_instructions user, "hello" user, assistant reply]
  // messageIndex 2 = the "hello from project-beta" user message (target turn)
  const context = await reconstructContext('codex', CODEX_SESSIONS_DIR, CODEX_COMPACTION_ID, { messageIndex: 2 });

  assert.equal(context.platform, 'codex');
  assert.equal(context.messages.compaction.applied, true);
  assert.equal(context.messages.compaction.source, 'compacted.payload.replacement_history');

  // effectiveHistory = replacementHistory (user + assistant) + messagesAfterCompaction
  // filtered by target timestamp. The target is the "hello" user message itself,
  // so no post-compaction messages precede it → only the 2 replacement entries.
  assert.deepEqual(
    context.messages.items.map((m) => m.role),
    ['user', 'assistant']
  );
  assert.ok(JSON.stringify(context.messages.items).includes('compressed earlier request'));
  assert.ok(!JSON.stringify(context.messages.items).includes('environment_context'));

  // System prompt assembled from systemComponents
  assert.ok(context.systemPrompt.content.includes('Always use TypeScript'));
  assert.ok(context.metadata.missingItems.includes('工具定义 (tool definitions)'));
});

test('buildCodexContext no longer calls extractCodexRequestContext', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'context.js'), 'utf8');
  // The old double-read call site passed session.filePath + targetMessage.timestamp.
  // extractCodexRequestContext is still defined/exported for backward compat, but
  // buildCodexContext must no longer invoke it.
  assert.ok(
    !src.includes('await extractCodexRequestContext(session.filePath'),
    'buildCodexContext must not call extractCodexRequestContext (would be a second file scan)'
  );
});

// ---------------------------------------------------------------------------
// Issue 2: Insights in-flight dedup
// ---------------------------------------------------------------------------

test('computeInsights concurrent same-key calls share one in-flight promise', async () => {
  const { computeInsights, inFlight, getInsightsCacheKey } = require(path.join(ROOT, 'lib', 'insights'));

  const key = getInsightsCacheKey('codex', '', CODEX_SESSIONS_DIR);

  const p1 = computeInsights('codex', '', CODEX_SESSIONS_DIR);
  // inFlight is set synchronously before the first await inside computeInsights
  assert.ok(inFlight.has(key), 'inFlight should contain the key after the first call starts');

  const p2 = computeInsights('codex', '', CODEX_SESSIONS_DIR);

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.ok(r1, 'should return a non-null insights result');
  assert.equal(r1, r2, 'concurrent same-key calls should resolve to the same object');
  assert.equal(inFlight.size, 0, 'inFlight map should be cleared after completion');
});

test('computeInsights different keys execute independently', async () => {
  const { computeInsights, inFlight } = require(path.join(ROOT, 'lib', 'insights'));

  const claudeDir = path.join(FIXTURE_HOME, '.claude', 'projects');
  const p1 = computeInsights('codex', '', CODEX_SESSIONS_DIR);
  const p2 = computeInsights('claude-code', '', claudeDir);

  const [r1, r2] = await Promise.all([p1, p2]);

  assert.notEqual(r1, r2, 'different keys should produce independent result objects');
  assert.equal(inFlight.size, 0, 'inFlight map should be cleared after both complete');
});

// ---------------------------------------------------------------------------
// Issue 3: Generic withInFlightDedup helper + parser integration
// ---------------------------------------------------------------------------

test('withInFlightDedup concurrent same-key calls share one execution', async () => {
  const { withInFlightDedup } = require(path.join(ROOT, 'lib', 'platforms', 'shared'));

  let execCount = 0;
  const fn = withInFlightDedup(
    (key) => key,
    async (key) => {
      execCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { key, execCount };
    }
  );

  const [r1, r2] = await Promise.all([fn('alpha'), fn('alpha')]);

  assert.equal(execCount, 1, 'underlying function should execute exactly once');
  assert.equal(r1, r2, 'both calls should resolve to the same object');
  assert.equal(r1.key, 'alpha');
});

test('withInFlightDedup different keys execute independently', async () => {
  const { withInFlightDedup } = require(path.join(ROOT, 'lib', 'platforms', 'shared'));

  let execCount = 0;
  const fn = withInFlightDedup(
    (key) => key,
    async (key) => {
      execCount++;
      await new Promise((r) => setTimeout(r, 30));
      return { key };
    }
  );

  const [r1, r2] = await Promise.all([fn('alpha'), fn('beta')]);

  assert.equal(execCount, 2, 'different keys should each execute the underlying function');
  assert.notEqual(r1, r2, 'different keys should return different objects');
  assert.equal(r1.key, 'alpha');
  assert.equal(r2.key, 'beta');
});

test('withInFlightDedup cleans up after failure so subsequent calls re-execute', async () => {
  const { withInFlightDedup } = require(path.join(ROOT, 'lib', 'platforms', 'shared'));

  let attempt = 0;
  const fn = withInFlightDedup(
    (key) => key,
    async (key) => {
      attempt++;
      await new Promise((r) => setTimeout(r, 10));
      if (attempt === 1) throw new Error('boom');
      return `ok-${attempt}`;
    }
  );

  await assert.rejects(fn('alpha'), /boom/);
  // After rejection the in-flight entry must be gone; next call should run again
  const result = await fn('alpha');
  assert.equal(result, 'ok-2');
  assert.equal(attempt, 2);
});

test('parseCodexSessionFile concurrent calls share one file read via in-flight dedup', async () => {
  const { parseCodexSessionFile } = require(path.join(ROOT, 'lib', 'platforms', 'codex'));

  const originalCreateReadStream = fs.createReadStream;
  let readCount = 0;
  fs.createReadStream = function (p, options) {
    if (p === CODEX_COMPACTION_FILE) readCount++;
    return originalCreateReadStream.call(this, p, options);
  };

  try {
    const [r1, r2] = await Promise.all([
      parseCodexSessionFile(CODEX_COMPACTION_FILE),
      parseCodexSessionFile(CODEX_COMPACTION_FILE),
    ]);

    assert.equal(r1, r2, 'concurrent parse calls should return the same result object');
    assert.equal(readCount, 1, 'concurrent parse calls should open the file only once');
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
});
