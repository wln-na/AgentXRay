// WorkBuddy adapter: JSONL sessions under ~/.workbuddy/projects/<slug>/.
// Records carry epoch-ms timestamps (normalized to ISO), block types
// input_text/output_text, and separate function_call / function_call_result
// records. Titles prefer the ai-title record over the first user prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const wb = require(path.join(__dirname, '..', 'lib', 'platforms', 'workbuddy'));
const { PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { deriveState } = require(path.join(__dirname, '..', 'lib', 'pet-state'));
const { FIXTURE_HOME } = require('./helpers.js');

const PROJECT = '-fixtures-project-workbuddy';
const ROOT = path.join(FIXTURE_HOME, '.workbuddy', 'projects');

test('normalizeWorkbuddyRecord maps all message-like records to ISO timestamps', () => {
  const user = wb.normalizeWorkbuddyRecord({
    id: 'u1',
    timestamp: 1792000001000,
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '你好' }],
  });
  assert.equal(user.role, 'user');
  assert.equal(user.timestamp, '2026-10-14T17:46:41.000Z');
  assert.equal(user.content[0].text, '你好');

  const assistant = wb.normalizeWorkbuddyRecord({
    id: 'a1',
    timestamp: 1792000002000,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: '好的' }],
    providerData: { model: 'hy3' },
  });
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.model, 'hy3');

  const toolCall = wb.normalizeWorkbuddyRecord({
    id: 'fc1',
    timestamp: 1792000003000,
    type: 'function_call',
    callId: 'call-1',
    name: 'Read',
    arguments: '{"path":"lib/pet-aggregator.js"}',
  });
  assert.equal(toolCall.role, 'toolCall');
  assert.equal(toolCall.toolCallId, 'call-1');
  assert.equal(toolCall.toolName, 'Read');
  assert.equal(toolCall.content[0].arguments.path, 'lib/pet-aggregator.js');

  const okResult = wb.normalizeWorkbuddyRecord({
    id: 'fr1',
    timestamp: 1792000004000,
    type: 'function_call_result',
    callId: 'call-1',
    name: 'Read',
    status: 'completed',
    output: { type: 'text', text: 'ok' },
  });
  assert.equal(okResult.role, 'toolResult');
  assert.equal(okResult.isError, false);

  const errResult = wb.normalizeWorkbuddyRecord({
    id: 'fr2',
    timestamp: 1792000004000,
    type: 'function_call_result',
    callId: 'call-2',
    name: 'Grep',
    status: 'error',
    output: { type: 'text', text: 'EACCES' },
  });
  assert.equal(errResult.isError, true);

  const reasoning = wb.normalizeWorkbuddyRecord({
    id: 'r1',
    timestamp: 1792000003500,
    type: 'reasoning',
    content: [{ type: 'reasoning_text', text: 'thinking…' }],
  });
  assert.equal(reasoning.role, 'reasoning');

  // 非消息类记录一律 null（ai-title / credit-usage / session-meta …）
  assert.equal(wb.normalizeWorkbuddyRecord({ type: 'ai-title', aiTitle: 'x' }), null);
  assert.equal(wb.normalizeWorkbuddyRecord({ type: 'credit-usage' }), null);
  assert.equal(wb.normalizeWorkbuddyRecord(null), null);
});

test('parseWorkbuddySessionFile returns session meta + ordered messages', async () => {
  const filePath = path.join(ROOT, PROJECT, 'wb-fixture-session-0001.jsonl');
  const { session, messages } = await wb.parseWorkbuddySessionFile(filePath);
  assert.equal(session.id, 'wb-fixture-session-0001');
  assert.equal(session.cwd, '/Users/linda/Projects/fixtures');
  assert.equal(session.title, '解读 pet 聚合器');
  assert.equal(session.sourcePath, filePath);
  const roles = messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'toolCall', 'toolResult', 'assistant']);
});

test('listWorkbuddySessions sorts newest-first with ai-title preferred', async () => {
  const sessions = await wb.listWorkbuddySessions(ROOT);
  const mine = sessions.filter((s) => s.id?.startsWith('wb-fixture-'));
  assert.ok(mine.length >= 2);
  assert.equal(mine[0].id, 'wb-fixture-session-0002'); // 0002 起始时间更晚
  const byTitle = new Map(mine.map((s) => [s.id, s.title]));
  assert.equal(byTitle.get('wb-fixture-session-0001'), '解读 pet 聚合器');
  assert.equal(byTitle.get('wb-fixture-session-0002'), '修复看门狗权限');
  for (const s of mine) {
    assert.ok(Number.isFinite(Date.parse(s.lastActivity)), `lastActivity not ISO: ${s.lastActivity}`);
  }
});

test('stripWorkbuddySystemReminders drops injected context blocks only', () => {
  // 带属性开标签（WorkBuddy 真实形态）+ 块后紧跟真实提问
  assert.equal(
    wb.stripWorkbuddySystemReminders(
      '<system-reminder data-role="user-context">\n<user_info>\nOS Version: darwin\n</user_info>\n</system-reminder>\n给会话列表加个过滤框'
    ),
    '给会话列表加个过滤框'
  );
  // 纯注入块 → 空串（调用方据此跳过，继续找下一条真实提问）
  assert.equal(wb.stripWorkbuddySystemReminders('<system-reminder>x</system-reminder>'), '');
  // 没有注入块 → 原样返回
  assert.equal(wb.stripWorkbuddySystemReminders('  你好  '), '你好');
  // <user_query> 是纯包装标签，只留正文
  assert.equal(wb.stripWorkbuddySystemReminders('<user_query>加个过滤框</user_query>'), '加个过滤框');
  assert.equal(wb.stripWorkbuddySystemReminders(''), '');
  assert.equal(wb.stripWorkbuddySystemReminders(null), '');
});

test('list metadata preview skips system-reminder injections', async () => {
  const sessions = await wb.listWorkbuddySessions(ROOT);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // 0002 首条 user turn 只有注入块（跳过），第二条是「注入块 + 真实提问」→ 预览只留提问
  assert.equal(byId.get('wb-fixture-session-0002').firstUserMessage, '修复 pet 的看门狗 bug');
});

test('find + getSession resolve by session id', async () => {
  const filePath = await wb.findWorkbuddySessionFile(ROOT, 'wb-fixture-session-0001');
  assert.ok(filePath?.endsWith('wb-fixture-session-0001.jsonl'));
  const got = await wb.getWorkbuddySession(ROOT, 'wb-fixture-session-0001');
  assert.equal(got.session.id, 'wb-fixture-session-0001');
  assert.equal(await wb.findWorkbuddySessionFile(ROOT, 'no-such-session'), null);
});

test('collectWorkbuddyFiles enumerates session jsonl files', async () => {
  const files = await wb.collectWorkbuddyFiles(ROOT);
  const ids = files.map((f) => f.sessionId).sort();
  assert.ok(ids.includes('wb-fixture-session-0001'));
  assert.ok(ids.includes('wb-fixture-session-0002'));
});

test('deriveState works on WorkBuddy messages (done → waiting, error sticky)', async () => {
  const s1 = await wb.getWorkbuddySession(ROOT, 'wb-fixture-session-0001');
  // 最后事件后 20s（> waitingAfter 15s）→ waiting_input
  const last1 = Date.parse('2026-10-14T17:46:46.000Z');
  const st1 = deriveState(s1.messages, { now: last1 + 20_000 });
  assert.equal(st1.state, 'waiting_input');

  const s2 = await wb.getWorkbuddySession(ROOT, 'wb-fixture-session-0002');
  // 会话停在出错的 function_call_result 上 → error 粘滞
  const last2 = Date.parse('2026-10-14T17:46:44.000Z');
  const st2 = deriveState(s2.messages, { now: last2 + 10_000 });
  assert.equal(st2.state, 'error');
  assert.match(st2.bubble, /EACCES/);
});

test('watchParse maps session-meta to a session frame and messages to messages', () => {
  const sess = wb.watchParseWorkbuddyRecord({ type: 'session-meta', sessionId: 's1', timestamp: 1792000000000 });
  assert.equal(sess.session.id, 's1');
  assert.equal(sess.session.timestamp, '2026-10-14T17:46:40.000Z');

  const msg = wb.watchParseWorkbuddyRecord({
    id: 'u9',
    timestamp: 1792000001000,
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hi' }],
  });
  assert.equal(msg.messages[0].role, 'user');

  assert.deepEqual(wb.watchParseWorkbuddyRecord({ type: 'credit-usage' }), null);
});

test('registry exposes workbuddy with file-based contract', () => {
  const p = PLATFORMS.workbuddy;
  assert.equal(p.label, 'WorkBuddy');
  assert.equal(typeof p.defaultDir(), 'string');
  assert.ok(p.defaultDir().endsWith(path.join('.workbuddy', 'projects')));
  for (const fn of ['list', 'find', 'parse', 'getSession', 'collectFiles', 'watchParse']) {
    assert.equal(typeof p[fn], 'function', `workbuddy missing ${fn}`);
  }
  assert.equal(p.capabilities.open, true);
  assert.equal(p.capabilities.search, true);
});
