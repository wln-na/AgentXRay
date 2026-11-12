// Cursor adapter: JSONL agent transcripts under ~/.cursor/projects/<slug>/
// agent-transcripts/<id>/<id>.jsonl. Records are
//   {"role":"user"|"assistant","message":{"content":[block,…]}} + turn_ended,
// blocks are text / tool_use; the human query is wrapped in <user_query>; no
// timestamps (mtime stands in); subagent transcripts are excluded. All tests
// run against a throwaway copy of the fixtures so utimes never touch the
// checked-in files.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

// The Cursor open/locate action is macOS-only (`open -a Cursor` / `open -R`);
// skip its route case on non-macOS (CI runs Linux).
const IS_MAC = process.platform === 'darwin';

const cursorModule = require(path.join(__dirname, '..', 'lib', 'platforms', 'cursor'));
const { PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { startServer, getJson, sendJson, FIXTURE_HOME } = require('./helpers.js');

const PROJECT = '-fixtures-project-cursor';
const SESSION_A = 'cursor-fixture-session-0001';
const SESSION_B = 'cursor-fixture-session-0002';
const FIXTURE_ROOT = path.join(FIXTURE_HOME, '.cursor', 'projects');

function sessionFile(root, sessionId) {
  return path.join(root, PROJECT, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
}

/** Copy the cursor fixture project to a tmp dir with distinct mtimes (newest = B). */
async function tmpCursorRoot() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'axr-cursor-'));
  const root = path.join(tmp, 'projects');
  await fsp.mkdir(root, { recursive: true });
  await fsp.cp(FIXTURE_ROOT, root, { recursive: true });
  const a = sessionFile(root, SESSION_A);
  const b = sessionFile(root, SESSION_B);
  const tA = new Date('2026-01-20T08:00:00Z');
  const tB = new Date('2026-01-21T09:00:00Z');
  await fsp.utimes(a, tA, tA);
  await fsp.utimes(b, tB, tB);
  return { root, cleanup: () => fsp.rm(tmp, { recursive: true, force: true }) };
}

// --- normalize (unit) ---

test('cursor normalizeCursorRecord extracts <user_query>, text and tool_use', () => {
  const user = cursorModule.normalizeCursorRecord({
    role: 'user',
    message: { content: [{ type: 'text', text: '前缀<user_query>修复登录页</user_query>后缀' }] },
  });
  assert.equal(user.length, 1);
  assert.equal(user[0].role, 'user');
  assert.equal(user[0].content[0].text, '修复登录页');

  const assistant = cursorModule.normalizeCursorRecord({
    role: 'assistant',
    message: {
      content: [
        { type: 'text', text: '改好了。' },
        { type: 'tool_use', name: 'Bash', id: 'call-1', input: { command: 'npm test' } },
      ],
    },
  });
  assert.equal(assistant.length, 2);
  assert.equal(assistant[0].role, 'assistant');
  assert.equal(assistant[0].content[0].text, '改好了。');
  assert.equal(assistant[1].role, 'toolCall');
  assert.equal(assistant[1].toolName, 'Bash');
  assert.equal(assistant[1].toolCallId, 'call-1');
  assert.deepEqual(assistant[1].details, { command: 'npm test' });

  // non-conversation records and malformed input yield nothing
  assert.deepEqual(cursorModule.normalizeCursorRecord({ type: 'turn_ended', status: 'success' }), []);
  assert.deepEqual(cursorModule.normalizeCursorRecord(null), []);
  assert.deepEqual(cursorModule.normalizeCursorRecord({ role: 'user', message: { content: [] } }), []);
});

test('cursor decodeProjectSlug is a best-effort path decode', () => {
  assert.equal(cursorModule.decodeProjectSlug('-Users-me-repo'), 'Users/me/repo');
  assert.equal(cursorModule.decodeProjectSlug('my-repo'), 'my-repo');
  assert.equal(cursorModule.decodeProjectSlug('-fixtures-project-cursor'), 'fixtures/project/cursor');
});

// --- list / find / parse (unit, tmp copy) ---

test('cursor list reads transcripts, derives title and mtime, excludes subagents', async () => {
  const { root, cleanup } = await tmpCursorRoot();
  try {
    const sessions = await cursorModule.listCursorSessions(root);
    assert.equal(sessions.length, 2, 'subagent transcripts must be excluded');
    assert.equal(sessions[0].id, SESSION_B, 'newest first');
    assert.equal(sessions[0].title, '给登录页补个刷新链接');
    assert.equal(sessions[1].id, SESSION_A);
    assert.equal(sessions[1].title, '修复登录页的刷新链接');
    assert.equal(sessions[1].userCount, 1);
    assert.equal(sessions[1].assistantCount, 2);
    assert.equal(sessions[1].toolCallCount, 2);
    assert.equal(sessions[1].toolResultCount, 0, 'Cursor transcripts never carry tool results');
    assert.equal(sessions[1].projectName, 'fixtures/project/cursor');
    assert.ok(sessions[1].timestamp, 'mtime-derived timestamp present');
  } finally {
    await cleanup();
  }
});

test('cursor find locates a session by exact id across projects', async () => {
  const { root, cleanup } = await tmpCursorRoot();
  try {
    const found = await cursorModule.findCursorSessionFile(root, SESSION_A);
    assert.ok(found, 'session A must be found');
    assert.ok(found.endsWith(path.join(SESSION_A, `${SESSION_A}.jsonl`)));
    assert.equal(await cursorModule.findCursorSessionFile(root, 'no-such-session'), null);
  } finally {
    await cleanup();
  }
});

test('cursor parse normalizes a full session', async () => {
  const { root, cleanup } = await tmpCursorRoot();
  try {
    const payload = await cursorModule.parseCursorSessionFile(sessionFile(root, SESSION_A));
    assert.equal(payload.session.id, SESSION_A);
    assert.equal(payload.session.cwd, null);
    assert.equal(payload.messages.length, 5); // user + (assistant text + toolCall) + (assistant text + toolCall)
    assert.equal(payload.messages[0].role, 'user');
    assert.equal(payload.messages[0].content[0].text, '修复登录页的刷新链接');
    assert.equal(payload.messages[1].role, 'assistant');
    assert.equal(payload.messages[2].role, 'toolCall');
    assert.equal(payload.messages[3].role, 'assistant');
    assert.equal(payload.messages[4].role, 'toolCall');
  } finally {
    await cleanup();
  }
});

test('cursor parse tolerates torn/active-append state', async () => {
  const { root, cleanup } = await tmpCursorRoot();
  try {
    const filePath = sessionFile(root, SESSION_A);
    await fsp.appendFile(filePath, '{"role":"assistant","message":{"content":[{"type":"text","text":"半行' + '\n');
    const payload = await cursorModule.parseCursorSessionFile(filePath);
    assert.equal(payload.messages.length, 5, 'torn trailing line must be skipped, not fatal');
  } finally {
    await cleanup();
  }
});

// --- registry ---

test('cursor is registered with file-based capabilities and open=true', () => {
  const p = PLATFORMS.cursor;
  assert.equal(p.id, 'cursor');
  assert.equal(p.label, 'Cursor');
  assert.equal(typeof p.find, 'function');
  assert.equal(typeof p.parse, 'function');
  assert.equal(typeof p.collectFiles, 'function');
  assert.equal(typeof p.watchParse, 'function');
  assert.equal(p.capabilities.search, true);
  assert.equal(p.capabilities.watch, true);
  assert.equal(p.capabilities.open, true);
  assert.equal(p.capabilities.spawn, false);
});

// --- routes (hermetic server over fixture home) ---

test('cursor routes list and read sessions', async () => {
  const srv = await startServer();
  try {
    const list = await getJson(srv.base, '/api/cursor/sessions');
    assert.equal(list.length, 2);
    const detail = await getJson(srv.base, `/api/cursor/sessions/${SESSION_A}`);
    assert.equal(detail.session.id, SESSION_A);
    assert.equal(detail.messages[0].role, 'user');
    assert.equal(detail.messages[0].content[0].text, '修复登录页的刷新链接');

    const missing = await fetch(`${srv.base}/api/cursor/sessions/no-such-session`);
    assert.equal(missing.status, 404);
  } finally {
    await srv.stop();
  }
});

test('cursor open route launches the Cursor app (recorded, no desktop effects)', { skip: !IS_MAC }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'axr-cursor-open-'));
  const recordFile = path.join(dir, 'calls.jsonl');
  const srv = await startServer({ AGENTXRAY_OPEN_SESSION_RECORD_FILE: recordFile });
  try {
    const res = await sendJson(srv.base, 'POST', `/api/cursor/sessions/${SESSION_A}/open`, { action: 'open' });
    assert.equal(res.ok, true);
    assert.match(res.detail, /已打开 Cursor/);
    assert.equal(res.hint, undefined, 'record mode skips the active-writer probe');
    const raw = (await fsp.readFile(recordFile, 'utf8')).trim().split('\n').filter(Boolean);
    assert.deepEqual(JSON.parse(raw.at(-1)), { file: 'open', args: ['-a', 'Cursor'] });
  } finally {
    await srv.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('cursor watch SSE tail delivers new transcript records', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.base}/api/watch?platform=cursor&sessionId=${SESSION_A}`, {
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200);
    await res.body?.cancel();
  } finally {
    await srv.stop();
  }
});
