// 系统上下文通道：Claude Code 的 rec.rendered（渲染后的 <system-reminder>）
// 与 Codex 的 role=developer 注入块，都要进入 contextMessages 侧通道，供前端
// 按版本折叠（见 test/context-versions.test.js）。这里直接调解析器，不起服务。

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parseClaudeCodeSessionFile } = require(path.join(__dirname, '..', 'lib', 'platforms', 'claude'));
const { PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { parseWatchLines } = require(path.join(__dirname, '..', 'lib', 'watch'));
const { parseCodexSessionFile } = require(path.join(__dirname, '..', 'lib', 'platforms', 'codex'));
const { foldContextVersions } = require(path.join(__dirname, '..', 'public', 'js', 'pure.js'));

const TMP_PREFIX = 'axr-context-messages-';

async function writeJsonl(records) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  const file = path.join(dir, 'session.jsonl');
  await fsp.writeFile(file, `${records.map((rec) => JSON.stringify(rec)).join('\n')}\n`);
  return file;
}

test.after(async () => {
  const dirs = (await fsp.readdir(os.tmpdir())).filter((name) => name.startsWith(TMP_PREFIX));
  await Promise.all(dirs.map((name) => fsp.rm(path.join(os.tmpdir(), name), { recursive: true, force: true })));
});

function userRecord(uuid, text) {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 'claude-context-fixture',
    cwd: '/fixtures/project',
    timestamp: '2026-02-01T10:00:00.000Z',
    message: { role: 'user', content: text },
  };
}

function attachmentRecord({ uuid, parentUuid, type, rendered, extra = {} }) {
  const rec = {
    type: 'attachment',
    uuid,
    parentUuid,
    sessionId: 'claude-context-fixture',
    cwd: '/fixtures/project',
    timestamp: '2026-02-01T10:00:01.000Z',
    attachment: { type, ...extra },
  };
  if (rendered) rec.rendered = [{ content: rendered }];
  return rec;
}

test('claude attachment rendered blocks become contextMessages with the attachment type as kind', async () => {
  const file = await writeJsonl([
    userRecord('u1', '你好'),
    attachmentRecord({
      uuid: 'a1',
      parentUuid: 'u1',
      type: 'environment',
      rendered: '<system-reminder>\n# Environment\ncwd: /fixtures/project\n</system-reminder>',
    }),
    attachmentRecord({ uuid: 'a2', parentUuid: 'u1', type: 'image' }),
  ]);

  const payload = await parseClaudeCodeSessionFile(file);
  assert.equal(payload.contextMessages.length, 1, 'only the rendered attachment is lifted');
  const [context] = payload.contextMessages;
  assert.equal(context.role, 'context');
  assert.equal(context.details.sourceKind, 'environment');
  assert.match(context.content[0].text, /<system-reminder>/);
  assert.match(context.content[0].text, /cwd: \/fixtures\/project/);
});

test('claude keeps the legacy <skill-context> merge for mapped attachments', async () => {
  const file = await writeJsonl([
    userRecord('u1', '你好'),
    attachmentRecord({
      uuid: 'a1',
      parentUuid: 'u1',
      type: 'skill_listing',
      rendered: '<system-reminder>\nskills\n</system-reminder>',
      extra: { skillCount: 1, names: ['fixture-skill-a'], isInitial: true },
    }),
  ]);

  const payload = await parseClaudeCodeSessionFile(file);
  const firstUser = payload.messages.find((message) => message.id === 'u1');
  assert.ok(firstUser.content.some((part) => part.text.includes('<skill-context>')));
  // The rendered version also flows into the context channel — panel and bubble
  // show different presentations of the same injection.
  assert.equal(payload.contextMessages.length, 1);
});

test('repeated identical claude reminders fold into a single version', async () => {
  const rendered = '<system-reminder>\n# Environment\ncwd: /fixtures/project\n</system-reminder>';
  const file = await writeJsonl([
    userRecord('u1', '你好'),
    attachmentRecord({ uuid: 'a1', parentUuid: 'u1', type: 'environment', rendered }),
    attachmentRecord({ uuid: 'a2', parentUuid: 'u1', type: 'environment', rendered }),
    attachmentRecord({ uuid: 'a3', parentUuid: 'u1', type: 'environment', rendered }),
  ]);

  const payload = await parseClaudeCodeSessionFile(file);
  assert.equal(payload.contextMessages.length, 3);
  const fold = foldContextVersions(
    payload.contextMessages.map((message) => ({
      kind: message.details.sourceKind,
      text: message.content.map((part) => part.text || '').join(''),
      timestampMs: Date.parse(message.timestamp),
    }))
  );
  assert.equal(fold.totalRecords, 3);
  assert.equal(fold.totalVersions, 1, 'identical reminders must not be listed N times');
  assert.equal(fold.groups[0].versions[0].occurrences, 3);
});

function codexDeveloperRecord(text) {
  return {
    timestamp: '2026-02-01T10:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] },
  };
}

test('codex developer messages become contextMessages keyed by their leading tag', async () => {
  const file = await writeJsonl([
    {
      timestamp: '2026-02-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-context-fixture', cwd: '/fixtures/project', cli_version: '0.1.0' },
    },
    codexDeveloperRecord('<app-context>\n# Codex desktop context\n</app-context>'),
    codexDeveloperRecord('<codex_apps_client_time_context>\n{"date":"2026-02-01"}\n</codex_apps_client_time_context>'),
    codexDeveloperRecord('plain developer note without a tag'),
    {
      timestamp: '2026-02-01T10:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    },
  ]);

  const payload = await parseCodexSessionFile(file);
  assert.deepEqual(
    payload.contextMessages.map((message) => message.details.sourceKind),
    ['app-context', 'codex_apps_client_time_context', 'developer']
  );
  assert.match(payload.contextMessages[0].content[0].text, /Codex desktop context/);
  // developer blocks never appear in the conversation stream (they used to be
  // carried there and hidden by the UI) and user messages are not duplicated.
  assert.equal(payload.contextMessages.length, 3);
  assert.equal(payload.messages.filter((message) => message.role === 'developer').length, 0);
  assert.deepEqual(
    payload.messages.map((message) => message.role),
    ['user']
  );
});

test('codex turn_context becomes one deduped runtime-context record', async () => {
  const turnContext = (overrides) => ({
    timestamp: '2026-02-01T10:00:00.000Z',
    type: 'turn_context',
    payload: {
      turn_id: 'turn-1',
      cwd: '/fixtures/project',
      model: 'gpt-fixture',
      approval_policy: 'never',
      sandbox_policy: { type: 'workspace-write' },
      ...overrides,
    },
  });
  const file = await writeJsonl([
    {
      timestamp: '2026-02-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-turn-ctx', cwd: '/fixtures/project' },
    },
    turnContext({ turn_id: 'turn-1' }),
    turnContext({ turn_id: 'turn-2' }),
    turnContext({ turn_id: 'turn-3' }),
    turnContext({ turn_id: 'turn-4', approval_policy: 'on-request' }),
  ]);

  const payload = await parseCodexSessionFile(file);
  const runtime = payload.contextMessages.filter((message) => message.details.sourceKind === 'runtime-context');
  assert.equal(runtime.length, 2, 'identical snapshots collapse; only the approval change is a new record');
  assert.match(runtime[0].content[0].text, /^cwd: \/fixtures\/project$/m);
  assert.match(runtime[0].content[0].text, /approval_policy: never/);
  assert.match(runtime[1].content[0].text, /approval_policy: on-request/);
  assert.ok(!runtime[0].content[0].text.includes('turn-1'), 'volatile turn ids are not part of the snapshot');
});

test('unchanged codex context folds to one version while a changed block adds one', async () => {
  const file = await writeJsonl([
    {
      timestamp: '2026-02-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-context-fixture', cwd: '/fixtures/project', cli_version: '0.1.0' },
    },
    codexDeveloperRecord('<current_date>\n2026-02-01\n</current_date>'),
    codexDeveloperRecord('<current_date>\n2026-02-01\n</current_date>'),
    codexDeveloperRecord('<current_date>\n2026-02-02\n</current_date>'),
  ]);

  const payload = await parseCodexSessionFile(file);
  const fold = foldContextVersions(
    payload.contextMessages.map((message) => ({
      kind: message.details.sourceKind,
      text: message.content[0].text,
      timestampMs: Date.parse(message.timestamp),
    }))
  );
  assert.equal(fold.totalRecords, 3);
  assert.equal(fold.totalVersions, 2);
  const [group] = fold.groups;
  assert.equal(group.versions[0].occurrences, 2);
  assert.equal(group.versions[1].addedLines, 1);
  assert.equal(group.versions[1].removedLines, 1);
});

// --- SSE tail (watchParse) -------------------------------------------------
// 系统上下文 面板必须能在会话进行中更新，所以 watch 的逐行归一化也要产出
// contextMessages，而不只是 messages。

test('watchParse surfaces claude attachment reminders as contextMessages', () => {
  const line = JSON.stringify({
    type: 'attachment',
    uuid: 'a1',
    parentUuid: 'u1',
    timestamp: '2026-02-01T10:00:01.000Z',
    attachment: { type: 'date_change', newDate: '2026-02-01' },
    rendered: [{ content: '<system-reminder>\nToday is 2026-02-01\n</system-reminder>' }],
  });
  const parsed = parseWatchLines(PLATFORMS['claude-code'], [line]);
  assert.equal(parsed.messages.length, 0);
  assert.equal(parsed.contextMessages.length, 1);
  assert.equal(parsed.contextMessages[0].details.sourceKind, 'date_change');
  assert.match(parsed.contextMessages[0].content[0].text, /Today is 2026-02-01/);
});

test('watchParse surfaces codex developer blocks and turn_context snapshots', () => {
  const developer = JSON.stringify({
    timestamp: '2026-02-01T10:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<app-context>\nctx\n</app-context>' }],
    },
  });
  const turnContext = JSON.stringify({
    timestamp: '2026-02-01T10:00:02.000Z',
    type: 'turn_context',
    payload: { turn_id: 't1', cwd: '/w', model: 'm', approval_policy: 'never' },
  });
  const parsed = parseWatchLines(PLATFORMS.codex, [developer, turnContext]);
  assert.equal(parsed.messages.length, 0, 'developer context must not hit the conversation stream');
  assert.deepEqual(
    parsed.contextMessages.map((message) => message.details.sourceKind),
    ['app-context', 'runtime-context']
  );
  assert.match(parsed.contextMessages[1].content[0].text, /^cwd: \/w$/m);
});

test('watchParse surfaces dsh injected user/message context', () => {
  const line = JSON.stringify({
    type: 'user/message',
    time: 1767225600000,
    data: {
      id: 'ctx-1',
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
      source: { kind: 'runtime-context' },
    },
  });
  const parsed = parseWatchLines(PLATFORMS.dsh, [line]);
  assert.equal(parsed.messages.length, 0, 'injected context stays out of the conversation stream');
  assert.equal(parsed.contextMessages.length, 1);
  assert.equal(parsed.contextMessages[0].details.sourceKind, 'runtime-context');
});

test('watchParse leaves plain user messages on the message channel', () => {
  const line = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-02-01T10:00:03.000Z',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  });
  const parsed = parseWatchLines(PLATFORMS.codex, [line]);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.contextMessages.length, 0);
});
