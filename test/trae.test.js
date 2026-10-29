// Trae (CN) CLI adapter: rollout JSONL under ~/.trae/cli/sessions/<Y>/<M>/<D>/.
// Same rollout shape as Codex (session_meta / response_item / event_msg), but
// trae-cli writes the live activity in the event_msg stream (user_message /
// agent_message / agent_reasoning_raw_content / item_completed), so the adapter
// maps both record families. Titles come from the first user_message event.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const trae = require(path.join(__dirname, '..', 'lib', 'platforms', 'trae'));
const { PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { deriveState } = require(path.join(__dirname, '..', 'lib', 'pet-state'));
const { FIXTURE_HOME } = require('./helpers.js');

const ROOT = path.join(FIXTURE_HOME, '.trae', 'cli', 'sessions');
const S1 = 'aaaa1111-2222-3333-4444-555566667777';
const S2 = 'bbbb2222-3333-4444-5555-666677778888';

test('normalizeTraeRecord maps event_msg payloads to normalized messages', () => {
  const user = trae.normalizeTraeRecord({
    timestamp: '2026-10-15T10:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: '你好', images: [] },
  });
  assert.equal(user.role, 'user');
  assert.equal(user.timestamp, '2026-10-15T10:00:02.000Z');
  assert.equal(user.content[0].text, '你好');

  const reasoning = trae.normalizeTraeRecord({
    timestamp: '2026-10-15T10:00:03.000Z',
    type: 'event_msg',
    payload: { type: 'agent_reasoning_raw_content', text: 'thinking…' },
  });
  assert.equal(reasoning.role, 'reasoning');

  const toolCall = trae.normalizeTraeRecord({
    timestamp: '2026-10-15T10:00:04.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'function_call', id: 'call-1', call_id: 'call-1', name: 'shell', arguments: '{"cmd":["ls"]}' },
    },
  });
  assert.equal(toolCall.role, 'toolCall');
  assert.equal(toolCall.toolCallId, 'call-1');
  assert.equal(toolCall.toolName, 'shell');

  const assistant = trae.normalizeTraeRecord({
    timestamp: '2026-10-15T10:00:06.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: '搞定', phase: 'final_answer' },
  });
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content[0].text, '搞定');

  // response_item 走 codex 归一化（exit_code → isError）
  const errResult = trae.normalizeTraeRecord({
    timestamp: '2026-10-15T10:00:05.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call-1',
      output: { output: 'boom', metadata: { exit_code: 1 } },
    },
  });
  assert.equal(errResult.role, 'toolResult');
  assert.equal(errResult.isError, true);

  // 非消息类记录一律 null
  assert.equal(trae.normalizeTraeRecord({ type: 'event_msg', payload: { type: 'token_count', info: {} } }), null);
  assert.equal(trae.normalizeTraeRecord({ type: 'event_msg', payload: { type: 'task_started' } }), null);
  assert.equal(trae.normalizeTraeRecord({ type: 'turn_context', payload: {} }), null);
  assert.equal(trae.normalizeTraeRecord(null), null);
});

test('parseTraeSessionFile returns session meta + ordered messages from event stream', async () => {
  const sessions = await trae.listTraeSessions(ROOT);
  const mine = sessions.find((s) => s.id === S1);
  assert.ok(mine, 'fixture session 1 not listed');
  const { session, messages } = await trae.parseTraeSessionFile(mine.filePath);
  assert.equal(session.id, S1);
  assert.equal(session.cwd, '/Users/linda/Projects/fixtures');
  assert.equal(session.provider, 'trae');
  const roles = messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'reasoning', 'toolCall', 'toolResult', 'assistant']);
});

test('listTraeSessions sorts newest-first with title from first user_message', async () => {
  const sessions = await trae.listTraeSessions(ROOT);
  const mine = sessions.filter((s) => [S1, S2].includes(s.id));
  assert.equal(mine.length, 2);
  assert.equal(mine[0].id, S2); // S2 起始时间更晚
  const byTitle = new Map(mine.map((s) => [s.id, s.title]));
  assert.equal(byTitle.get(S1), '检查看门狗重试逻辑');
  assert.equal(byTitle.get(S2), '读取 /etc/hosts 并整理');
  for (const s of mine) {
    assert.ok(Number.isFinite(Date.parse(s.lastActivity)), `lastActivity not ISO: ${s.lastActivity}`);
  }
});

test('find + getSession resolve by session id (nested YYYY/MM/DD layout)', async () => {
  const filePath = await trae.findTraeSessionFile(ROOT, S1);
  assert.ok(filePath?.endsWith(`${S1}.jsonl`));
  const got = await trae.getTraeSession(ROOT, S2);
  assert.equal(got.session.id, S2);
  assert.equal(await trae.findTraeSessionFile(ROOT, 'no-such-session'), null);
});

test('deriveState works on Trae event streams (done → waiting, error sticky)', async () => {
  const s1 = await trae.getTraeSession(ROOT, S1);
  // 最后事件 10:00:08，20s 后（> waitingAfter 15s）→ waiting_input
  const st1 = deriveState(s1.messages, { now: Date.parse('2026-10-15T10:00:28.000Z') });
  assert.equal(st1.state, 'waiting_input');

  const s2 = await trae.getTraeSession(ROOT, S2);
  // 会话停在 exit_code=1 的工具结果上 → error 粘滞
  const st2 = deriveState(s2.messages, { now: Date.parse('2026-10-15T10:05:15.000Z') });
  assert.equal(st2.state, 'error');
});

test('working-state derivation from toolCall event (pet priority path)', async () => {
  const { messages } = await trae.parseTraeSessionFile(
    path.join(ROOT, '2026', '10', '15', `rollout-2026-10-15T18-00-00-${S1}.jsonl`)
  );
  // 只保留到 toolCall 为止 → working（工具未回）
  const upto = messages.slice(0, 3); // user, reasoning, toolCall
  const st = deriveState(upto, { now: Date.parse('2026-10-15T10:00:04.500Z') });
  assert.equal(st.state, 'working');
  assert.match(st.bubble, /shell/);
});

test('registry exposes trae with file-based contract', () => {
  const p = PLATFORMS.trae;
  assert.equal(p.label, 'Trae CN');
  assert.ok(p.defaultDir().endsWith(path.join('.trae', 'cli', 'sessions')));
  for (const fn of ['list', 'find', 'parse', 'getSession', 'collectFiles', 'watchParse']) {
    assert.equal(typeof p[fn], 'function', `trae missing ${fn}`);
  }
  assert.equal(p.capabilities.open, true);
  assert.equal(p.capabilities.backup, true);
});
