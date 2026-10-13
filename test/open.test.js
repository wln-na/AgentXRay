// One-click locate/open of a collected session: command construction,
// platform dispatch, macOS gating and graceful fallbacks — unit-tested with an
// injected command runner (never touches the real desktop), plus route
// validation against the fixture home. The happy path is exercised at the unit
// level only; the route-level tests stop before any `open`/`osascript` call so
// running the suite never pops Finder or opens terminal windows.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The open/locate feature is macOS-only: it drives Finder (`open -R`),
// LaunchServices (`open -a` / `open <scheme>`), AppleScript terminal windows
// (iTerm2 / Terminal) and iTerm2's own presence check. Unit tests inject a
// fake runner, but the terminal-script cases and the route cases exercise
// real platform detection, so they are skipped on non-macOS (CI runs Linux).
const IS_MAC = process.platform === 'darwin';

const openSessionModule = require(path.join(__dirname, '..', 'lib', 'open-session'));
const { PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { startServer, sendJson } = require('./helpers.js');

const {
  resumeCommandFor,
  shellCommandLine,
  shellQuote,
  escapeAppleScript,
  locateSession,
  openSession,
  RESUME_PLATFORMS,
} = openSessionModule;

const CODEX_ID = 'rollout-2026-01-16T11-00-00-01900000-0000-7000-8000-000000000002';
const CLAUDE_ID = 'aaaa1111-2222-4333-8444-555566667777';
const OMP_ID = '2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa';
const GEMINI_ID = 'gemini-fixture-session-0002';

// A fake runner that records (file, args) instead of executing anything.
function recordingRunner() {
  const calls = [];
  async function run(file, args) {
    calls.push({ file, args });
    return '';
  }
  return { run, calls };
}

// Like recordingRunner, but `open` fails for both the codex deep link and the
// plain app launch (`open -a <app>`), so the app-first fallback chains can be
// exercised end to end.
function failAppLaunchRunner() {
  const calls = [];
  async function run(file, args) {
    calls.push({ file, args });
    if (file === 'open' && (args[0] === '-a' || String(args[0]).startsWith('codex://'))) {
      throw new Error('The application "ChatGPT" cannot be found');
    }
    return '';
  }
  return { run, calls };
}

// Like recordingRunner, but only the codex deep link (`open codex://…`) fails,
// so the deep-link → plain app launch degradation can be exercised.
function failDeepLinkRunner() {
  const calls = [];
  async function run(file, args) {
    calls.push({ file, args });
    if (file === 'open' && String(args[0]).startsWith('codex://')) {
      throw new Error('codex:// deep link rejected');
    }
    return '';
  }
  return { run, calls };
}

// --- command construction (unit) ---

test('resumeCommandFor builds native resume commands for CLI platforms', () => {
  assert.deepEqual(resumeCommandFor('codex', 'abc123', '/tmp/p'), {
    file: 'codex',
    args: ['resume', 'abc123', '--yolo'],
    cwd: '/tmp/p',
  });
  assert.deepEqual(resumeCommandFor('claude-code', 'abc123', null), {
    file: 'claude',
    args: ['--dangerously-skip-permissions', '--resume', 'abc123'],
    cwd: null,
  });
  assert.deepEqual(resumeCommandFor('omp', 'abc123', '/w'), {
    file: 'omp',
    args: ['--auto-approve', '--resume=abc123'],
    cwd: '/w',
  });
  assert.equal(resumeCommandFor('gemini', 'abc123', '/w'), null);
  for (const p of RESUME_PLATFORMS) assert.ok(resumeCommandFor(p, 'abc123', null));
});

test('shellCommandLine quotes cwd with spaces and single quotes', () => {
  const resume = { file: 'codex', args: ['resume', 'abc123'] };
  assert.equal(shellCommandLine(resume, '/tmp/my dir'), "cd '/tmp/my dir' && codex resume abc123");
  assert.equal(shellCommandLine(resume, "/tmp/it's"), "cd '/tmp/it'\\''s' && codex resume abc123");
  assert.equal(shellCommandLine(resume, null), 'codex resume abc123');
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('escapeAppleScript escapes backslashes and double quotes', () => {
  assert.equal(escapeAppleScript('a"b\\c'), 'a\\"b\\\\c');
});

// --- locate (unit, fake runner) ---

test('locateSession reveals an existing file in Finder (open -R)', async () => {
  const { run, calls } = recordingRunner();
  // Use the test file itself: it exists on disk, so the access check passes.
  const result = await locateSession(__filename, { isMac: true, run });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'locate');
  assert.deepEqual(calls, [{ file: 'open', args: ['-R', __filename] }]);
});

test('locateSession degrades to copy-path when the file is gone or on non-macOS', async () => {
  const missing = await locateSession('/nonexistent/session.jsonl', { isMac: true, run: recordingRunner().run });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.fallback, { type: 'copy-path', path: '/nonexistent/session.jsonl' });

  const { run, calls } = recordingRunner();
  const nonMac = await locateSession('/tmp/session.jsonl', { isMac: false, run });
  assert.equal(nonMac.ok, false);
  assert.match(nonMac.error, /macOS/);
  assert.equal(calls.length, 0);
});

test('locateSession reports when no file path exists at all', async () => {
  const result = await locateSession(null, { isMac: true });
  assert.equal(result.ok, false);
  assert.equal(result.fallback, null);
});

// --- open (unit, fake runner) ---

test('openSession resumes a CLI session in a new terminal window', { skip: !IS_MAC }, async () => {
  const { run, calls } = recordingRunner();
  const result = await openSession('claude-code', 'abc123', '/logs/abc123.jsonl', '/work dir', {
    isMac: true,
    run,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'open');
  assert.match(result.detail, /新窗口中恢复会话/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  const script = calls[0].args.join(' ');
  // iTerm2 must receive the command via `write text` (typed into the login
  // shell), never via `create window … command` (which execs it directly and
  // dies instantly); Terminal.app uses `do script`.
  assert.match(script, /create window with default profile(?:\s+command)?/);
  assert.match(script, /write text|do script/);
  assert.match(script, /claude --dangerously-skip-permissions --resume abc123/);
  assert.match(script, /cd '\/work dir'/);
});

test('openSession deep-links codex into the ChatGPT app (codex://threads/<sessionId>)', async () => {
  const { run, calls } = recordingRunner();
  const result = await openSession('codex', 'abc123', '/logs/abc123.jsonl', '/work dir', {
    isMac: true,
    run,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'open');
  assert.match(result.detail, /已在 ChatGPT 中打开会话/);
  // The Codex thread id equals the rollout session id, so the deep link is
  // tried first — a single `open codex://threads/<id>` call, no `-a`.
  assert.deepEqual(calls, [{ file: 'open', args: ['codex://threads/abc123'] }]);
});

test('openSession falls back to a plain app launch when the codex deep link fails', async () => {
  const { run, calls } = failDeepLinkRunner();
  const result = await openSession('codex', 'abc123', '/logs/abc123.jsonl', '/work dir', {
    isMac: true,
    run,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'open');
  assert.match(result.detail, /已打开 ChatGPT/);
  assert.deepEqual(calls, [
    { file: 'open', args: ['codex://threads/abc123'] },
    { file: 'open', args: ['-a', 'ChatGPT'] },
  ]);
});

test('openSession falls back to terminal resume when both the deep link and the app are unavailable (codex)', {
  skip: !IS_MAC,
}, async () => {
  const { run, calls } = failAppLaunchRunner();
  const result = await openSession('codex', 'abc123', '/logs/abc123.jsonl', '/work dir', {
    isMac: true,
    run,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'open');
  assert.match(result.detail, /未找到 ChatGPT 应用/);
  assert.match(result.detail, /codex resume abc123/);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { file: 'open', args: ['codex://threads/abc123'] });
  assert.deepEqual(calls[1], { file: 'open', args: ['-a', 'ChatGPT'] });
  assert.equal(calls[2].file, '/usr/bin/osascript');
  assert.match(calls[2].args.join(' '), /write text/);
  assert.match(calls[2].args.join(' '), /codex resume abc123/);
});

test('openSession launches the owning app for claude-desktop (Claude)', async () => {
  const { run, calls } = recordingRunner();
  const result = await openSession('claude-desktop', 'abc123', '/logs/x.jsonl', '/p', {
    isMac: true,
    run,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ file: 'open', args: ['-a', 'Claude'] }]);
});

test('openSession falls back to the default editor when the Claude app is missing', async () => {
  const { run, calls } = failAppLaunchRunner();
  const result = await openSession('claude-desktop', 'abc123', __filename, '/p', { isMac: true, run });
  assert.equal(result.ok, true);
  assert.match(result.detail, /默认应用打开/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { file: 'open', args: ['-a', 'Claude'] });
  assert.deepEqual(calls[1], { file: 'open', args: [__filename] });
});

test('openSession resumes a CLI session without cwd when none is known', async () => {
  const { run, calls } = recordingRunner();
  await openSession('omp', 'abc123', '/logs/x.jsonl', null, { isMac: true, run });
  assert.match(calls[0].args.join(' '), /omp --auto-approve --resume=abc123/);
  assert.ok(!calls[0].args.join(' ').includes('cd '));
});

test('openSession falls back to copy-command when terminal launch fails', async () => {
  const failing = async () => {
    throw new Error('osascript error (-25211)');
  };
  const result = await openSession('claude-code', 'abc123', '/logs/x.jsonl', '/p', {
    isMac: true,
    run: failing,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /辅助功能/);
  assert.equal(result.fallback.type, 'copy-command');
  assert.match(result.fallback.command, /claude --dangerously-skip-permissions --resume abc123/);
});

test('openSession degrades to copy-command on non-macOS for CLI platforms', async () => {
  const { run, calls } = recordingRunner();
  const result = await openSession('codex', 'abc123', '/logs/x.jsonl', '/p', { isMac: false, run });
  assert.equal(result.ok, false);
  assert.equal(result.fallback.type, 'copy-command');
  assert.equal(calls.length, 0);
});

test('openSession deep-links doubao into the Doubao 2 conversation (https://www.doubao.com/chat/<id>)', async () => {
  const { run, calls } = recordingRunner();
  const result = await openSession('doubao', 'abc123', '/logs/trajectory.jsonl', null, {
    isMac: true,
    run,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'open');
  assert.match(result.detail, /已在 Doubao 2 中打开会话/);
  // The doubao deep link is an https URL, so it must be opened with `-a` to
  // stay inside the Doubao work client instead of the system default browser.
  assert.deepEqual(calls, [{ file: 'open', args: ['-a', 'Doubao 2', 'https://www.doubao.com/chat/abc123'] }]);
});

test('openSession falls back to the app launch when the doubao deep link fails', async () => {
  const calls = [];
  async function run(file, args) {
    calls.push({ file, args });
    if (file === 'open' && args.some((a) => String(a).includes('https://www.doubao.com/chat/'))) {
      throw new Error('doubao deep link rejected');
    }
    return '';
  }
  const result = await openSession('doubao', 'abc123', '/logs/t.jsonl', null, { isMac: true, run });
  assert.equal(result.ok, true);
  // doubao targets Doubao 2 (com.bot.pc.doubao) by bundle id — `open -a Doubao`
  // is ambiguous because the old Doubao.app shares the same display name.
  assert.deepEqual(calls, [
    { file: 'open', args: ['-a', 'Doubao 2', 'https://www.doubao.com/chat/abc123'] },
    { file: 'open', args: ['-b', 'com.bot.pc.doubao'] },
  ]);
  assert.match(result.detail, /已打开 Doubao 2/);
});

test('openSession falls back to the display-name launch when both the doubao deep link and the bundle id fail', async () => {
  const calls = [];
  async function run(file, args) {
    calls.push({ file, args });
    if (file === 'open' && args.some((a) => String(a).includes('https://www.doubao.com/chat/'))) {
      throw new Error('doubao deep link rejected');
    }
    if (file === 'open' && args[0] === '-b') throw new Error('unknown bundle id');
    return '';
  }
  const result = await openSession('doubao', 'abc123', '/logs/t.jsonl', null, { isMac: true, run });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { file: 'open', args: ['-a', 'Doubao 2', 'https://www.doubao.com/chat/abc123'] },
    { file: 'open', args: ['-b', 'com.bot.pc.doubao'] },
    { file: 'open', args: ['-a', 'Doubao'] },
  ]);
});

test('openSession degrades to copy-path for doubao on non-macOS', async () => {
  const { run, calls } = recordingRunner();
  const result = await openSession('doubao', 'abc123', '/logs/t.jsonl', null, { isMac: false, run });
  assert.equal(result.ok, false);
  assert.deepEqual(result.fallback, { type: 'copy-path', path: '/logs/t.jsonl' });
  assert.equal(calls.length, 0);
});

test('openSession opens the log file with the default app for file-based platforms', async () => {
  const { run, calls } = recordingRunner();
  // __filename exists on disk, so the access check passes.
  const result = await openSession('gemini', 'abc123', __filename, '/p', {
    isMac: true,
    run,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ file: 'open', args: [__filename] }]);
});

test('openSession reports a missing log file for file-based platforms', async () => {
  const { run, calls } = recordingRunner();
  const result = await openSession('dsh', 'abc123', '/nonexistent/x.jsonl', '/p', { isMac: true, run });
  assert.equal(result.ok, false);
  assert.deepEqual(result.fallback, { type: 'copy-path', path: '/nonexistent/x.jsonl' });
  assert.equal(calls.length, 0);
});

// --- detectActiveWriter (unit, fake runner) ---

test('detectActiveWriter reports the process holding the log open', async () => {
  const calls = [];
  async function run(file, args) {
    calls.push({ file, args });
    if (file === 'lsof') return '12345\n';
    return '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  }
  const result = await openSessionModule.detectActiveWriter('/logs/abc123.jsonl', { isMac: true, run });
  assert.deepEqual(result, { pid: '12345', process: 'ChatGPT' });
  assert.deepEqual(calls, [
    { file: 'lsof', args: ['-t', '/logs/abc123.jsonl'] },
    { file: 'ps', args: ['-p', '12345', '-o', 'comm='] },
  ]);
});

test('detectActiveWriter returns null when no process holds the file', async () => {
  const { run } = recordingRunner();
  const result = await openSessionModule.detectActiveWriter('/logs/abc123.jsonl', { isMac: true, run });
  assert.equal(result, null);
});

test('detectActiveWriter is advisory: never throws, skips non-macOS and missing paths', async () => {
  const failing = async () => {
    throw new Error('lsof not available');
  };
  assert.equal(await openSessionModule.detectActiveWriter('/logs/x.jsonl', { isMac: false, run: failing }), null);
  assert.equal(await openSessionModule.detectActiveWriter(null, { isMac: true, run: failing }), null);
  assert.equal(await openSessionModule.detectActiveWriter('/logs/x.jsonl', { isMac: true, run: failing }), null);
});

// --- registry capability flags (unit) ---

test('platform registry exposes the open capability flag', () => {
  assert.equal(PLATFORMS.codex.capabilities.open, true);
  assert.equal(PLATFORMS.omp.capabilities.open, true);
  assert.equal(PLATFORMS.doubao.capabilities.open, true);
  assert.equal(PLATFORMS.hermes.capabilities.open, false);
});

// --- route validation (server boot, no real command execution) ---

test('open route rejects invalid platform / session id / action before executing', async () => {
  const srv = await startServer();
  try {
    // Unknown platform → falls through to 404.
    const unknown = await fetch(srv.base + '/api/nope/sessions/x/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'locate' }),
    });
    assert.equal(unknown.status, 404);

    // Invalid session id → 400.
    const badId = await fetch(srv.base + `/api/codex/sessions/${encodeURIComponent('a b!')}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'locate' }),
    });
    assert.equal(badId.status, 400);

    // Missing / invalid action → 400.
    const noBody = await sendJson(srv.base, 'POST', `/api/codex/sessions/${CODEX_ID}/open`, {}, 400);
    assert.match(noBody.error, /action/i);
    const badAction = await sendJson(
      srv.base,
      'POST',
      `/api/codex/sessions/${CODEX_ID}/open`,
      { action: 'explode' },
      400
    );
    assert.match(badAction.error, /action/i);
  } finally {
    await srv.stop();
  }
});

test('open route returns 404 for a valid id with no matching session', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(srv.base + '/api/codex/sessions/aaaaaaaa-0000-0000-0000-000000000000/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'locate' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.stop();
  }
});

test('openclaw open route requires a sanitized agent and session id', async () => {
  const srv = await startServer();
  try {
    const badAgent = await sendJson(
      srv.base,
      'POST',
      '/api/agents/%E4%B8%AD%20%E6%96%87/sessions/x/open',
      { action: 'locate' },
      400
    );
    assert.match(badAgent.error, /agent/i);
    const badSession = await sendJson(
      srv.base,
      'POST',
      '/api/agents/agent-a/sessions/%E4%B8%AD%20%E6%96%87/open',
      { action: 'locate' },
      400
    );
    assert.match(badSession.error, /session/i);
  } finally {
    await srv.stop();
  }
});

// --- route behaviour over fixtures (no real command execution) ---

test('open route resolves fixture sessions but validation stops before any exec', async () => {
  const srv = await startServer();
  try {
    // The route must answer 404 (not 500) for a well-formed id that has no
    // matching session — this path never reaches the command layer.
    const res = await fetch(srv.base + '/api/dsh/sessions/does-not-exist/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.stop();
  }
});

// --- route happy paths (fixture server + recording runner, no desktop effects) ---
// The server runs in its own process, so the fake runner is enabled through
// AGENTXRAY_OPEN_SESSION_RECORD_FILE (see lib/open-session.js runCommand):
// commands are recorded as JSONL instead of executed. This covers the route's
// happy path (real fixture resolution → locate/open dispatch) end to end.

const os = require('node:os');
const fsp = require('node:fs/promises');

async function recordedCalls() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'axr-open-record-'));
  return {
    file: path.join(dir, 'calls.jsonl'),
    async read() {
      const raw = await fsp.readFile(this.file, 'utf8').catch(() => '');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async cleanup() {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test('open route: locate reveals the resolved fixture log file', { skip: !IS_MAC }, async () => {
  const record = await recordedCalls();
  const srv = await startServer({ AGENTXRAY_OPEN_SESSION_RECORD_FILE: record.file });
  try {
    const res = await sendJson(srv.base, 'POST', `/api/codex/sessions/${CODEX_ID}/open`, {
      action: 'locate',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'locate');
    const calls = await record.read();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'open');
    assert.equal(calls[0].args[0], '-R');
    assert.ok(calls[0].args[1].endsWith(`${CODEX_ID}.jsonl`));
  } finally {
    await srv.stop();
    await record.cleanup();
  }
});

test('open route: app-first for codex, terminal resume for claude-code / omp', { skip: !IS_MAC }, async () => {
  const record = await recordedCalls();
  const srv = await startServer({ AGENTXRAY_OPEN_SESSION_RECORD_FILE: record.file });
  try {
    const codex = await sendJson(srv.base, 'POST', `/api/codex/sessions/${CODEX_ID}/open`, {
      action: 'open',
    });
    assert.equal(codex.ok, true);
    assert.match(codex.detail, /已在 ChatGPT 中打开会话/);
    assert.deepEqual((await record.read()).at(-1), { file: 'open', args: [`codex://threads/${CODEX_ID}`] });

    const claude = await sendJson(srv.base, 'POST', `/api/claude-code/sessions/${CLAUDE_ID}/open`, {
      action: 'open',
    });
    assert.equal(claude.ok, true);
    assert.match(
      (await record.read()).at(-1).args.join(' '),
      /claude --dangerously-skip-permissions --resume aaaa1111-2222-4333-8444-555566667777/
    );

    const omp = await sendJson(srv.base, 'POST', `/api/omp/sessions/${OMP_ID}/open`, { action: 'open' });
    assert.equal(omp.ok, true);
    assert.match(
      (await record.read()).at(-1).args.join(' '),
      /omp --auto-approve --resume=2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa/
    );
  } finally {
    await srv.stop();
    await record.cleanup();
  }
});

test('open route: file-based platform opens the log with the default app', { skip: !IS_MAC }, async () => {
  const record = await recordedCalls();
  const srv = await startServer({ AGENTXRAY_OPEN_SESSION_RECORD_FILE: record.file });
  try {
    const res = await sendJson(srv.base, 'POST', `/api/gemini/sessions/${GEMINI_ID}/open`, {
      action: 'open',
    });
    assert.equal(res.ok, true);
    const calls = await record.read();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'open');
    assert.match(calls[0].args[0], new RegExp(GEMINI_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await srv.stop();
    await record.cleanup();
  }
});
