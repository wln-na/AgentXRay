// Turn-boundary facts (session summary `lastRole` / `lastTurnOutcome`).
//
// These two optional fields are what let the board distinguish 待跟进 from 已完成
// without trusting message counters (a failed assistant turn still increments
// assistantCount). Two layers are covered here:
//   1. the shared tracker helpers — pure state machine, no files involved;
//   2. real fixture sessions — every summary that reports a fact must report a
//      legal one, and an assistant-reported outcome always has a matching role.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createTurnFactsTracker,
  lastTurnFacts,
  noteAssistantTurn,
  noteInterruptedTurn,
  noteUserTurn,
  isSubstantiveAssistantText,
  textFromContentBlocks,
} = require(path.join(__dirname, '..', 'lib', 'platforms', 'shared'));
const { PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { FIXTURE_HOME } = require('./helpers.js');

const ROLES = new Set(['user', 'assistant']);
const OUTCOMES = new Set(['delivered', 'interrupted', 'empty']);

test('lastTurnFacts reports nothing until a conversation record is seen', () => {
  assert.deepEqual(lastTurnFacts(createTurnFactsTracker()), {});
});

test('lastTurnFacts: user prompt ends the turn as 待跟进-eligible', () => {
  const tracker = createTurnFactsTracker();
  noteUserTurn(tracker);
  const facts = lastTurnFacts(tracker);
  assert.equal(facts.lastRole, 'user');
  assert.equal(facts.lastTurnOutcome, undefined, 'an open user turn has no outcome yet');
});

test('lastTurnFacts: assistant without substantive text is "empty", not delivered', () => {
  const tracker = createTurnFactsTracker();
  noteUserTurn(tracker);
  noteAssistantTurn(tracker, false);
  const facts = lastTurnFacts(tracker);
  assert.equal(facts.lastRole, 'assistant');
  assert.equal(facts.lastTurnOutcome, 'empty');
});

test('lastTurnFacts: assistant with text is "delivered"; a new user turn clears it', () => {
  const tracker = createTurnFactsTracker();
  noteUserTurn(tracker);
  noteAssistantTurn(tracker, true);
  assert.deepEqual(lastTurnFacts(tracker), { lastRole: 'assistant', lastTurnOutcome: 'delivered' });

  noteUserTurn(tracker);
  assert.deepEqual(lastTurnFacts(tracker), { lastRole: 'user' });
});

test('lastTurnFacts: an abort marker outranks the assistant text behind it', () => {
  const tracker = createTurnFactsTracker();
  noteUserTurn(tracker);
  noteAssistantTurn(tracker, true);
  noteInterruptedTurn(tracker);
  assert.deepEqual(lastTurnFacts(tracker), { lastRole: 'assistant', lastTurnOutcome: 'interrupted' });

  // Only a real user prompt proves the aborted turn is over.
  noteUserTurn(tracker);
  assert.deepEqual(lastTurnFacts(tracker), { lastRole: 'user' });
});

test('isSubstantiveAssistantText rejects the "failed before producing content" placeholder', () => {
  assert.equal(isSubstantiveAssistantText(''), false);
  assert.equal(isSubstantiveAssistantText('   '), false);
  assert.equal(isSubstantiveAssistantText('[assistant turn failed before producing content]'), false);
  assert.equal(isSubstantiveAssistantText('这是真实回复'), true);
});

test('textFromContentBlocks only reads text-like blocks', () => {
  assert.equal(textFromContentBlocks('plain'), 'plain');
  assert.equal(
    textFromContentBlocks([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'shell' },
      { type: 'reasoning', text: 'thinking' },
      { type: 'output_text', text: 'world' },
    ]),
    'hello\nworld'
  );
});

/** Every fixture summary that carries a fact must carry a legal one, and the
 *  outcome only ever describes an assistant turn (or an explicit interrupt). */
async function assertLegalFacts(platformName, dir) {
  const platform = PLATFORMS[platformName];
  if (!platform?.list) return 0;
  const sessions = await platform.list(dir);
  let checked = 0;
  for (const summary of sessions) {
    if (!('lastRole' in summary) && !('lastTurnOutcome' in summary)) continue;
    checked += 1;
    assert.ok(ROLES.has(summary.lastRole), `${platformName}/${summary.id}: bad lastRole ${summary.lastRole}`);
    if (summary.lastTurnOutcome !== undefined) {
      assert.ok(
        OUTCOMES.has(summary.lastTurnOutcome),
        `${platformName}/${summary.id}: bad lastTurnOutcome ${summary.lastTurnOutcome}`
      );
      assert.equal(
        summary.lastRole,
        'assistant',
        `${platformName}/${summary.id}: outcome reported without an assistant turn`
      );
    }
  }
  return checked;
}

test('fixture summaries only report legal turn-boundary facts', async () => {
  const codex = await assertLegalFacts('codex', path.join(FIXTURE_HOME, '.codex', 'sessions'));
  const trae = await assertLegalFacts('trae', path.join(FIXTURE_HOME, '.trae', 'cli', 'sessions'));
  const claude = await assertLegalFacts('claude-code', path.join(FIXTURE_HOME, '.claude', 'projects'));
  // The fixtures must actually exercise the new fields, otherwise this guard is empty.
  assert.ok(codex + trae + claude > 0, 'no fixture session reported turn-boundary facts');
});
