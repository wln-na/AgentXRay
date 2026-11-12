// DeepSeek Harness v4 session support (P1).
//
// Two layers:
//   unit        — discovery (canonical file names, generation picking, one log
//                 per session dir, roots-only list with includeSubagents),
//                 version dispatch, v4 normalization (tool errors, closed seq
//                 compaction, injection filtering, titles, turn/end error text,
//                 context messages/window usage, subagent children) and the
//                 64 MB detail guard;
//   API/E2E     — the same fixtures written into an isolated HOME through
//                 startServer's prepareHome hook, exercised via /api/dsh/*,
//                 search, prompts, usage, backup and watch.
//
// Fixtures live in test/dsh-v4-fixtures.js and are never added to
// test/fixtures/home, so every other suite's counts stay untouched.

const { describe, it, before, after } = require('node:test');
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dsh = require(path.join(__dirname, '..', 'lib', 'platforms', 'dsh'));
const fixtures = require('./dsh-v4-fixtures.js');
const { startServer, getJson, sendJson } = require('./helpers.js');

const { TEXT, MAIN, MIXED, SUBAGENT, COMPACTION, FALLBACK, V5, V2, MISMATCH, FIXTURE_ORDER } = fixtures;

const V0_PLAIN = 'dsh-fixture-session-0001';
const V0_ZSTD = 'dsh-fixture-session-0002';

// The default (roots-only) projection drops the subagent row from FIXTURE_ORDER.
const ROOT_FIXTURE_ORDER = FIXTURE_ORDER.filter((id) => id !== SUBAGENT.id);

const REQUIRED_EXPORTS = [
  'parseDshLogName',
  'pickDshLogFile',
  'collectDshFiles',
  'isDisplayableDshUserMessage',
  'parseDshSessionFile',
  'listDshSessions',
  'listDshChildren',
  'getDshChildSession',
  'normalizeDshEvents',
];

// The adapter contract says `parseDshLogName` reports the format version; accept
// either a bare number or an object carrying it.
function versionOf(parsed) {
  if (parsed === null || parsed === undefined || parsed === false) return null;
  if (typeof parsed === 'number') return parsed;
  return parsed.version ?? parsed.formatVersion ?? null;
}

// `pickDshLogFile` may return the winning dirent, a name, or {file|name}.
function nameOf(picked) {
  if (!picked) return null;
  if (typeof picked === 'string') return picked;
  return picked.name ?? picked.file ?? null;
}

function line(record) {
  return JSON.stringify(record);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Minimal SSE client: collects {event, data} pairs until closed.
async function connectSse(url) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`);
  const events = [];
  let buffer = '';
  const decoder = new TextDecoder();
  (async () => {
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const row of raw.split('\n')) {
            if (row.startsWith('event: ')) event = row.slice(7);
            else if (row.startsWith('data: ')) data += row.slice(6);
          }
          if (data) events.push({ event, data: JSON.parse(data) });
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted by the client */
    }
  })();
  return {
    events,
    close: () => controller.abort(),
    async waitFor(name, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find((e) => e.event === name);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for SSE event ${name}`);
        await sleep(25);
      }
    },
  };
}

test('dsh adapter exports the v4 discovery and normalization contract', () => {
  const missing = REQUIRED_EXPORTS.filter((name) => typeof dsh[name] !== 'function');
  assert.deepEqual(missing, [], `missing adapter exports: ${missing.join(', ')}`);
});

// --- discovery + version dispatch (unit, temp dir) ---

describe('dsh v4 discovery and version dispatch', () => {
  let root;
  let list;
  let byId;
  let allList;
  let allById;
  let collected;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-v4-discovery-'));
    fixtures.writeAll(root);
    // Traversal trap: `<root>/session.jsonl` would be found by a naive
    // path.join(root, project, '..') lookup for sessionId '..'.
    await fsp.writeFile(
      path.join(root, 'session.jsonl'),
      `${line({ type: 'session', version: 0, id: 'dsh-escaped-trap', createdAt: 0, cwd: '/escape' })}\n`
    );
    list = await dsh.listDshSessions(root);
    byId = new Map(list.map((session) => [session.id, session]));
    allList = await dsh.listDshSessions(root, { includeSubagents: true });
    allById = new Map(allList.map((session) => [session.id, session]));
    collected = await dsh.collectDshFiles(root);
  });

  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('parseDshLogName accepts canonical v0/v4/v12 file names and rejects migration residue', () => {
    const canonical = [
      ['session.jsonl', 0],
      ['session.jsonl.zstd', 0],
      ['session.v4.jsonl', 4],
      ['session.v4.jsonl.zstd', 4],
      ['session.v12.jsonl.zstd', 12],
    ];
    for (const [name, version] of canonical) {
      const parsed = dsh.parseDshLogName(name);
      assert.ok(parsed, `${name} should be canonical`);
      assert.equal(versionOf(parsed), version, `${name} should report version ${version}`);
    }

    const rejected = [
      'session.v0.jsonl',
      'session.v04.jsonl',
      'session.V4.jsonl',
      'SESSION.v4.jsonl',
      'session.v-4.jsonl',
      'session.v4.jsonl.tmp',
      'session.v4.jsonl.zstd.tmp',
      'session.migration.abc.tmp',
      'session.lock',
      'notes.jsonl',
      '.DS_Store',
      '',
    ];
    for (const name of rejected) {
      assert.ok(!dsh.parseDshLogName(name), `${name} must not be canonical`);
    }
  });

  it('pickDshLogFile takes the highest canonical generation and ignores non-canonical files', async () => {
    const mixedDir = path.join(root, MIXED.project, MIXED.id);
    const entries = await fsp.readdir(mixedDir, { withFileTypes: true });
    assert.equal(nameOf(dsh.pickDshLogFile(entries)), MIXED.file);

    const handMade = [
      { name: 'session.jsonl', isFile: () => true },
      { name: 'session.v4.jsonl', isFile: () => true },
      { name: 'session.v9.jsonl', isFile: () => true },
      { name: 'session.lock', isFile: () => true },
      { name: 'notes.jsonl', isFile: () => true },
    ];
    assert.equal(nameOf(dsh.pickDshLogFile(handMade)), 'session.v9.jsonl');

    const junk = [
      { name: 'session.v0.jsonl', isFile: () => true },
      { name: 'session.v04.jsonl', isFile: () => true },
      { name: 'session.lock', isFile: () => true },
      { name: 'notes.jsonl', isFile: () => true },
    ];
    assert.equal(dsh.pickDshLogFile(junk), null);
  });

  it('lists v4 plain and multi-frame zstd sessions with v4 header metadata', () => {
    for (const meta of [MAIN, MIXED, COMPACTION, FALLBACK]) {
      assert.ok(byId.has(meta.id), `missing session ${meta.id}`);
    }

    const main = byId.get(MAIN.id);
    assert.equal(main.file, MAIN.file);
    assert.equal(main.cwd, MAIN.cwd);
    assert.equal(main.timestamp, new Date(MAIN.createdAt).toISOString());
    assert.equal(main.title, TEXT.providerTitle);
    assert.equal(main.firstUserMessage, TEXT.mainUserAlpha);
    assert.equal(main.userCount, 2); // injections are not user turns
    assert.equal(main.assistantCount, 2);
    assert.equal(main.toolCallCount, 2);
    assert.equal(main.toolResultCount, 2);
    assert.equal(main.parentSession, null);
    assert.equal(main.childCount, 1, 'the root session must advertise its direct child');
    assert.deepEqual(main.tokens, { input: 150, output: 30, cacheRead: 60, reasoning: 0 });
    assert.deepEqual(
      [...main.topTools].sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: 'read_file', count: 1 },
        { name: 'run_command', count: 1 },
      ]
    );
    // Metadata from frames beyond the first proves multi-frame decoding.
    assert.ok(main.messageCount >= 4);
  });

  it('hides subagent sessions from the default list and counts children on the root', async () => {
    assert.ok(!list.some((session) => session.id === SUBAGENT.id), 'default list must be roots-only');
    assert.equal(list.length, allList.length - 1, 'exactly one subagent fixture is hidden');
    assert.ok(allById.has(SUBAGENT.id), 'includeSubagents must surface the subagent row');

    for (const meta of [MAIN, MIXED, COMPACTION, FALLBACK, V5, V2, MISMATCH]) {
      assert.ok(byId.has(meta.id), `${meta.id} is a root and must stay in the default list`);
      assert.ok(allById.has(meta.id), `${meta.id} missing from the includeSubagents list`);
      assert.equal(byId.get(meta.id).childCount, allById.get(meta.id).childCount);
    }

    assert.equal(allById.get(MAIN.id).childCount, 1);
    assert.equal(allById.get(SUBAGENT.id).childCount, 0, 'a subagent row never has children');
    assert.equal(byId.get(COMPACTION.id).childCount, 0);
  });

  it('prefers the newest generation when v0 and v4 coexist in one session dir', () => {
    const matches = list.filter((session) => session.id === MIXED.id);
    assert.equal(matches.length, 1, 'one session dir must yield one row');
    assert.equal(matches[0].file, MIXED.file);
    assert.equal(matches[0].firstUserMessage, TEXT.mixedUser);
    assert.ok(!byId.has(MIXED.staleId), 'the stale v0 generation must not be listed separately');
    assert.ok(!list.some((session) => session.firstUserMessage === TEXT.mixedStaleUser));
  });

  it('keeps v1-v3 / v5 / filename-header mismatch visible with a readable error', () => {
    const v5 = byId.get(V5.id);
    assert.ok(v5, 'v5 session should stay visible');
    assert.equal(v5.unsupported, true);
    assert.match(v5.error, /5|upgrade|AgentXRay/i);

    const v2 = byId.get(V2.id);
    assert.ok(v2, 'v2 session should stay visible');
    assert.equal(v2.unsupported, true);
    assert.match(v2.error, /migrat|DeepSeek Harness/i);

    const mismatch = byId.get(MISMATCH.id);
    assert.ok(mismatch, 'mismatched filename/header session should stay visible');
    assert.match(mismatch.error, /mismatch|inconsistent|version/i);
  });

  it('writes v4 subagent metadata (status/origin/parentSession/delegationDepth)', () => {
    const subagent = allById.get(SUBAGENT.id);
    assert.equal(subagent.file, SUBAGENT.file);
    assert.equal(subagent.status, 'subagent');
    assert.equal(subagent.origin, 'subagent');
    assert.equal(subagent.parentSession, MAIN.id);
    assert.equal(subagent.delegationDepth, 1);
    assert.equal(subagent.childCount, 0);
    assert.ok(allById.get(MAIN.id).status !== 'subagent');
  });

  it('uses a fallback session/title only as a last resort', () => {
    const fallback = byId.get(FALLBACK.id);
    assert.equal(fallback.title, TEXT.fallbackUser);
    assert.notEqual(fallback.title, TEXT.fallbackOnlyTitle);
  });

  it('keeps list, find and collectDshFiles pointed at the same canonical file', async () => {
    const bySession = new Map(collected.map((entry) => [entry.sessionId, entry]));
    assert.equal(new Set(collected.map((entry) => entry.path)).size, collected.length, 'no path listed twice');

    for (const [id, session] of allById) {
      const entry = bySession.get(id);
      assert.ok(entry, `collectDshFiles missed ${id}`);
      const found = await dsh.findDshSessionFile(root, id);
      assert.equal(found, entry.path, `find(${id}) must match collectDshFiles`);
      assert.equal(path.basename(found), entry.file);
      assert.equal(session.file, entry.file, `list(${id}) must report the canonical file`);

      // Rows are visible in exactly one projection: roots in the default list,
      // subagents only when includeSubagents is set.
      const inDefault = byId.get(id);
      if (session.parentSession) {
        assert.equal(inDefault, undefined, `subagent ${id} must not appear in the default list`);
        assert.ok(allById.has(id), `subagent ${id} missing from the includeSubagents list`);
      } else {
        assert.ok(inDefault, `root ${id} missing from the default list`);
        assert.equal(inDefault.file, session.file);
        assert.equal(inDefault.childCount, session.childCount);
      }
    }

    assert.ok(!list.some((session) => session.parentSession), 'default list must not contain a subagent row');
  });

  it('ignores non-canonical files instead of listing a phantom session', async () => {
    const junkDir = path.join(root, '--fixtures-project-junk--', 'dsh-v4-junk-0010');
    await fsp.mkdir(junkDir, { recursive: true });
    const v0Header = line({ type: 'session', version: 0, id: 'dsh-v4-junk-0010', createdAt: 0, cwd: '/junk' });
    for (const name of ['session.v0.jsonl', 'session.v04.jsonl', 'session.V4.jsonl', 'session.lock', 'notes.jsonl']) {
      await fsp.writeFile(path.join(junkDir, name), `${v0Header}\n`);
    }
    await fsp.writeFile(path.join(junkDir, '.DS_Store'), 'junk');

    const listed = await dsh.listDshSessions(root);
    assert.ok(!listed.some((session) => session.id === 'dsh-v4-junk-0010'));
    assert.equal(await dsh.findDshSessionFile(root, 'dsh-v4-junk-0010'), null);
    const files = await dsh.collectDshFiles(root);
    assert.ok(!files.some((entry) => entry.path.includes('dsh-v4-junk-0010')));
  });

  it('does not let a traversal-shaped session id escape the project dir', async () => {
    const trap = path.join(root, 'session.jsonl');
    assert.equal(await dsh.findDshSessionFile(root, '..'), null);
    assert.equal(await dsh.findDshSessionFile(root, '../..'), null);
    assert.ok(fs.existsSync(trap), 'trap file is the thing find must not return');
  });
});

// --- subagent children (unit, temp dir) ---

describe('dsh v4 subagent children', () => {
  let root;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-v4-children-'));
    fixtures.writeAll(root);
  });

  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('lists the direct children of a root session with a readable title', async () => {
    const children = await dsh.listDshChildren(root, MAIN.id);
    assert.equal(children.length, 1);

    const [child] = children;
    assert.equal(child.name, SUBAGENT.id);
    assert.equal(child.file, SUBAGENT.file);
    assert.equal(child.title, TEXT.subagentUser);
    assert.equal(child.description, child.title);
    assert.equal(child.agentType, null);
    assert.ok(child.timestamp, 'child rows carry the header timestamp');
    assert.ok(child.messageCount >= 2);
    assert.equal(child.toolCallCount, 0);

    // A subagent has no children of its own, and an unknown parent has none.
    assert.deepEqual(await dsh.listDshChildren(root, SUBAGENT.id), []);
    assert.deepEqual(await dsh.listDshChildren(root, 'dsh-v4-no-such-parent'), []);
  });

  it('loads one child only through its real parent', async () => {
    const payload = await dsh.getDshChildSession(root, MAIN.id, SUBAGENT.id);
    assert.ok(payload, 'expected the subagent detail payload');
    assert.equal(payload.session.id, SUBAGENT.id);
    assert.equal(payload.session.parentSession, MAIN.id);
    assert.equal(payload.session.origin, 'subagent');
    assert.ok(Array.isArray(payload.messages) && payload.messages.length > 0);

    // Wrong parent, unknown parent and unknown child all resolve to null: a
    // guessed id must never surface an unrelated session.
    assert.equal(await dsh.getDshChildSession(root, SUBAGENT.id, MAIN.id), null);
    assert.equal(await dsh.getDshChildSession(root, 'dsh-v4-no-such-parent', SUBAGENT.id), null);
    assert.equal(await dsh.getDshChildSession(root, MAIN.id, 'dsh-v4-no-such-child'), null);
  });
});

// --- v4 normalization ---

describe('dsh v4 event normalization', () => {
  it('reads message.isError + message.toolCallId from flat v4 tool results', () => {
    const lines = [
      line({
        type: 'tool/call',
        seq: 1,
        time: 1768471200000,
        data: { callId: 'call-x', name: 'bash', arguments: '{"command":"cat nope"}' },
      }),
      line({
        type: 'tool/result',
        seq: 2,
        time: 1768471201000,
        data: {
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'call-x' },
            toolCallId: 'call-x',
            isError: true,
            content: [{ type: 'text', text: 'permission denied' }],
          },
        },
      }),
    ];
    const messages = dsh.normalizeDshEvents(lines, { version: 4 });
    const result = messages.find((message) => message.role === 'toolResult');
    assert.ok(result, 'expected a toolResult message');
    assert.equal(result.toolCallId, 'call-x');
    assert.equal(result.toolName, 'bash');
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'permission denied');
  });

  it('flags machine injections and keeps readable user-side events', () => {
    const kinds = [
      ['runtime-context', false],
      ['time-context', false],
      ['skill-catalog', false],
      ['agent-instructions', false],
      ['working-directory', false],
      ['model-selection', false],
      ['user-approval', false],
      ['tool-jobs', false],
      ['future-injection', false],
      ['agent-message', true],
      ['subagent-settled', true],
      ['compact-checkpoint', true],
      ['user', true],
    ];
    const lines = kinds.map(([kind], i) =>
      line({
        type: 'user/message',
        seq: i + 1,
        time: 1768471200000 + i * 1000,
        data: {
          content: [{ type: 'text', text: `${kind}-text` }],
          source: { kind },
          role: 'user',
          id: `user-${kind}`,
        },
      })
    );

    const expected = kinds.filter(([, keep]) => keep).map(([kind]) => `${kind}-text`);
    const v4Texts = dsh.normalizeDshEvents(lines, { version: 4 }).map((message) => message.content[0].text);
    assert.deepEqual(v4Texts, expected);

    // The whitelist also applies without a header version: the watch tail
    // normalizes single appended lines and has no version at hand, so it relies
    // on this path to keep injected context out of the live stream.
    const unversioned = dsh.normalizeDshEvents(lines).map((message) => message.content[0].text);
    assert.deepEqual(unversioned, expected);
  });

  it('isDisplayableDshUserMessage applies the whitelist', () => {
    const displayable = ['user', 'agent-message', 'subagent-settled', 'compact-checkpoint'];
    const filtered = [
      'runtime-context',
      'time-context',
      'skill-catalog',
      'agent-instructions',
      'working-directory',
      'model-selection',
      'user-approval',
      'tool-jobs',
      'future-injection',
    ];
    for (const kind of displayable) {
      assert.equal(
        dsh.isDisplayableDshUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind } }),
        true,
        `${kind} should be displayable`
      );
    }
    for (const kind of filtered) {
      assert.equal(
        dsh.isDisplayableDshUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind } }),
        false,
        `${kind} should be filtered`
      );
    }
    // Legacy records without a source.kind are human messages (v0 shape).
    assert.equal(dsh.isDisplayableDshUserMessage({ content: [{ type: 'text', text: 'legacy' }] }), true);
  });

  it('masks a closed startSeq/endSeq range and keeps the compaction summary once', () => {
    const lines = fixtures.compactionRecords().slice(1).map(line);
    const texts = dsh
      .normalizeDshEvents(lines, { version: 4 })
      .map((message) => message.content[0]?.text)
      .filter(Boolean);
    assert.deepEqual(texts, [TEXT.compactionSummary, TEXT.compactionAfter]);
    assert.equal(texts.filter((text) => text === TEXT.compactionSummary).length, 1);
  });

  it('still honors v0 surface-index compaction when no version is passed', () => {
    const user = (seq, surfaceOp, text) =>
      line({
        type: 'user/message',
        seq,
        time: 1768471200000 + seq,
        data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `u${seq}` },
        surfaceOp,
      });
    const lines = [
      user(1, 'append', 'first'),
      user(2, 'append', 'second'),
      user(3, { op: 'replace', start: 0, end: 2 }, 'compaction summary'),
      user(4, 'append', 'third'),
    ];
    const texts = dsh.normalizeDshEvents(lines).map((message) => message.content[0].text);
    assert.deepEqual(texts, ['compaction summary', 'third']);
  });

  it('reuses the legacy replace position across repeated compactions', () => {
    const user = (seq, surfaceOp, text) =>
      line({
        type: 'user/message',
        seq,
        time: 1768471200000 + seq,
        data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `u${seq}` },
        surfaceOp,
      });
    const lines = [
      user(1, 'append', 'first'),
      user(2, 'append', 'second'),
      user(3, { op: 'replace', start: 0, end: 2 }, 'summary one'),
      user(4, 'append', 'third'),
      user(5, { op: 'replace', start: 0, end: 2 }, 'summary two'),
    ];
    const texts = dsh.normalizeDshEvents(lines).map((message) => message.content[0].text);
    assert.deepEqual(texts, ['summary two']);
  });
});

// --- v4 detail parsing (unit, temp dir) ---

describe('dsh v4 session detail', () => {
  let root;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-v4-detail-'));
    fixtures.writeAll(root);
  });

  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('returns the v4 header, roles, usage, tool pairing and filtered injections', async () => {
    const { session, messages } = await dsh.parseDshSessionFile(path.join(root, MAIN.project, MAIN.id, MAIN.file));
    assert.equal(session.id, MAIN.id);
    assert.equal(session.version, 4);
    assert.equal(session.cwd, MAIN.cwd);
    assert.equal(session.timestamp, new Date(MAIN.createdAt).toISOString());
    assert.equal(session.model, 'deepseek-v4');

    const roles = messages.map((message) => message.role);
    for (const role of ['user', 'reasoning', 'assistant', 'toolCall', 'toolResult', 'error']) {
      assert.ok(roles.includes(role), `missing role ${role}`);
    }

    const assistants = messages.filter((message) => message.role === 'assistant');
    assert.equal(assistants.length, 2);
    assert.deepEqual(assistants[0].usage, { input: 100, output: 20, cacheRead: 40, reasoning: 0 });
    assert.deepEqual(assistants[1].usage, { input: 50, output: 10, cacheRead: 20, reasoning: 0 });
    assert.equal(assistants[0].model, 'deepseek-v4');
    assert.equal(assistants[0].provider, 'deepseek');

    const failed = messages.find((message) => message.role === 'toolResult' && message.isError);
    assert.ok(failed, 'expected the failed tool result');
    assert.equal(failed.toolCallId, fixtures.TOOL_1.callId);
    assert.equal(failed.toolName, fixtures.TOOL_1.name);
    assert.equal(failed.content[0].text, TEXT.mainToolError);

    const ok = messages.find((message) => message.role === 'toolResult' && !message.isError);
    assert.ok(ok, 'expected the successful tool result');
    assert.equal(ok.toolCallId, fixtures.TOOL_2.callId);
    assert.equal(ok.toolName, fixtures.TOOL_2.name);
    assert.equal(ok.content[0].text, TEXT.mainToolOk);

    const call = messages.find((message) => message.role === 'toolCall');
    assert.equal(call.toolCallId, fixtures.TOOL_1.callId);
    assert.deepEqual(call.details, { command: 'echo v4' });

    const allText = messages
      .map((message) => (message.content || []).map((block) => block.text || '').join('\n'))
      .join('\n');
    assert.ok(!allText.includes('v4-runtime-context-needle'), 'runtime-context injection leaked into messages');
    assert.ok(!allText.includes('v4-skill-catalog-needle'), 'skill-catalog injection leaked into messages');

    const marker = messages.find((message) => message.role === 'error');
    assert.equal(marker.isError, true);
    assert.match(marker.content[0].text, /error/i);
  });

  it('surfaces turn/end errors with the reason detail in the error row', async () => {
    const { messages } = await dsh.parseDshSessionFile(path.join(root, MAIN.project, MAIN.id, MAIN.file));
    const errorRow = messages.find((message) => message.role === 'error');
    assert.ok(errorRow, 'expected the failing turn/end to produce an error row');
    assert.equal(errorRow.isError, true);
    const text = errorRow.content[0].text;
    assert.ok(text.includes(TEXT.mainTurnError), `error row must quote the cause: ${text}`);
    assert.ok(text.includes('ended without completing'), `error row must explain the turn state: ${text}`);
  });

  it('keeps injected context out of messages and reports it as contextMessages', async () => {
    const { messages, contextMessages } = await dsh.parseDshSessionFile(
      path.join(root, MAIN.project, MAIN.id, MAIN.file)
    );
    assert.equal(contextMessages.length, 2);
    assert.deepEqual(
      contextMessages.map((message) => message.details.sourceKind),
      ['runtime-context', 'skill-catalog']
    );
    for (const message of contextMessages) assert.equal(message.role, 'context');

    const contextText = contextMessages.map((message) => message.content[0].text).join('\n');
    assert.ok(contextText.includes('v4-runtime-context-needle'));
    assert.ok(contextText.includes('v4-skill-catalog-needle'));

    const rendered = messages
      .map((message) => (message.content || []).map((block) => block.text || '').join('\n'))
      .join('\n');
    assert.ok(!rendered.includes('v4-runtime-context-needle'), 'runtime-context injection leaked into messages');
    assert.ok(!rendered.includes('v4-skill-catalog-needle'), 'skill-catalog injection leaked into messages');
    assert.equal(
      messages.filter((message) => message.role === 'context').length,
      0,
      'context messages must stay out of the conversation'
    );
  });

  it('derives contextUsage from request/context plus the last assistant usage', async () => {
    const { contextUsage } = await dsh.parseDshSessionFile(path.join(root, MAIN.project, MAIN.id, MAIN.file));
    assert.ok(contextUsage, 'contextUsage must be present when the log carries usage');
    assert.equal(contextUsage.used, 70); // last assistant: input 50 + cacheRead 20
    assert.equal(contextUsage.limit, 100000);
    assert.equal(contextUsage.input, 50);
    assert.equal(contextUsage.cacheRead, 20);
    assert.equal(contextUsage.source, 'native');
    assert.ok(
      Math.abs(contextUsage.percent - 0.07) < 1e-9,
      `expected ~0.07 percent (70/100000), got ${contextUsage.percent}`
    );
  });

  it('masks compacted v4 messages so only the summary and later turns render', async () => {
    const { messages } = await dsh.parseDshSessionFile(
      path.join(root, COMPACTION.project, COMPACTION.id, COMPACTION.file)
    );
    const texts = messages.map((message) => message.content[0]?.text).filter(Boolean);
    assert.ok(!texts.includes(TEXT.compactionOldUser), 'compacted user message rendered');
    assert.ok(!texts.includes(TEXT.compactionOldAssistant), 'compacted assistant message rendered');
    assert.equal(texts.filter((text) => text === TEXT.compactionSummary).length, 1);
    assert.ok(texts.includes(TEXT.compactionAfter));
  });

  it('exposes subagent header metadata on the detail payload', async () => {
    const { session } = await dsh.parseDshSessionFile(path.join(root, SUBAGENT.project, SUBAGENT.id, SUBAGENT.file));
    assert.equal(session.id, SUBAGENT.id);
    assert.equal(session.version, 4);
    assert.equal(session.origin, 'subagent');
    assert.equal(session.parentSession, MAIN.id);
    assert.equal(session.delegationDepth, 1);
  });

  it('refuses a compressed log over 64 MB with a 413 before decompressing it', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-v4-big-'));
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    // Sparse file: 65 MB of logical size, no 65 MB write and no full parse.
    const handle = await fsp.open(file, 'w');
    try {
      await handle.truncate(65 * 1024 * 1024);
    } finally {
      await handle.close();
    }
    try {
      await assert.rejects(
        () => dsh.parseDshSessionFile(file),
        (error) => {
          const guarded = error.statusCode === 413 || /64 ?MB|too large|exceed|413/i.test(error.message);
          assert.ok(guarded, `expected the 64 MB guard, got: ${error.message}`);
          return true;
        }
      );
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

// --- API / downstream integration over an isolated HOME ---

describe('dsh v4 API integration', () => {
  let srv;

  before(async () => {
    srv = await startServer(undefined, { prepareHome: fixtures.installHomeFixtures });
  });
  after(async () => {
    await srv.stop();
  });

  it('lists v0 and v4 sessions newest-first with one row per session dir', async () => {
    const sessions = await getJson(srv.base, '/api/dsh/sessions');
    const byId = new Map(sessions.map((session) => [session.id, session]));

    // v0 keeps working.
    assert.equal(byId.get(V0_PLAIN)?.file, 'session.jsonl');
    assert.equal(byId.get(V0_ZSTD)?.file, 'session.jsonl.zstd');

    for (const meta of [MAIN, MIXED, COMPACTION, FALLBACK, V5, V2, MISMATCH]) {
      assert.ok(byId.has(meta.id), `missing v4 session ${meta.id}`);
    }
    assert.ok(!byId.has(SUBAGENT.id), 'the default list must not include subagent sessions');

    const main = byId.get(MAIN.id);
    assert.equal(main.file, MAIN.file);
    assert.equal(main.cwd, MAIN.cwd);
    assert.equal(main.title, TEXT.providerTitle);
    assert.equal(main.firstUserMessage, TEXT.mainUserAlpha);
    assert.equal(main.userCount, 2);
    assert.equal(main.assistantCount, 2);
    assert.equal(main.toolCallCount, 2);
    assert.equal(main.toolResultCount, 2);
    assert.equal(main.childCount, 1);
    assert.deepEqual(main.tokens, { input: 150, output: 30, cacheRead: 60, reasoning: 0 });

    assert.deepEqual(
      sessions.filter((session) => FIXTURE_ORDER.includes(session.id)).map((session) => session.id),
      ROOT_FIXTURE_ORDER
    );
    assert.equal(sessions.filter((session) => session.id === MIXED.id).length, 1);
    assert.ok(!sessions.some((session) => session.id === MIXED.staleId));

    const dated = sessions.filter((session) => session.timestamp);
    for (let i = 1; i < dated.length; i++) {
      assert.ok(Date.parse(dated[i - 1].timestamp) >= Date.parse(dated[i].timestamp), 'list is not newest-first');
    }
  });

  it('adds subagent rows only for include_subagents=1', async () => {
    const sessions = await getJson(srv.base, '/api/dsh/sessions?include_subagents=1');
    const byId = new Map(sessions.map((session) => [session.id, session]));

    assert.deepEqual(
      sessions.filter((session) => FIXTURE_ORDER.includes(session.id)).map((session) => session.id),
      FIXTURE_ORDER
    );

    assert.equal(byId.get(MAIN.id).childCount, 1);

    const subagent = byId.get(SUBAGENT.id);
    assert.ok(subagent, 'include_subagents must add the subagent row');
    assert.equal(subagent.status, 'subagent');
    assert.equal(subagent.parentSession, MAIN.id);
    assert.equal(subagent.childCount, 0);
    assert.equal(subagent.file, SUBAGENT.file);
    assert.equal(subagent.title, TEXT.subagentUser);
  });

  it('serves subagent children and their detail, with 404 for a session that is not a child', async () => {
    const children = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}/children`);
    assert.equal(children.length, 1);
    assert.equal(children[0].name, SUBAGENT.id);
    assert.ok(children[0].title.includes('subagent-needle'), `unreadable child title: ${children[0].title}`);

    const detail = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}/children/${SUBAGENT.id}`);
    assert.equal(detail.session.id, SUBAGENT.id);
    assert.equal(detail.session.parentSession, MAIN.id);
    assert.ok(Array.isArray(detail.messages) && detail.messages.length > 0);
    assert.ok(detail.stats && typeof detail.stats === 'object');

    // Unknown child and a reversed parent/child pair both 404 rather than
    // resolving an unrelated session.
    const missing = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}/children/dsh-v4-no-such-child`, 404);
    assert.match(missing.error, /not found/i);
    await getJson(srv.base, `/api/dsh/sessions/${SUBAGENT.id}/children/${MAIN.id}`, 404);
  });

  it('serves a v4 detail with the expected roles and session stats', async () => {
    const { session, messages, stats } = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}`);
    assert.equal(session.id, MAIN.id);
    assert.equal(session.version, 4);
    assert.equal(session.model, 'deepseek-v4');
    assert.ok(stats && typeof stats === 'object', 'detail should carry precomputed stats');

    const roles = messages.map((message) => message.role);
    for (const role of ['user', 'reasoning', 'assistant', 'toolCall', 'toolResult', 'error']) {
      assert.ok(roles.includes(role), `missing role ${role}`);
    }

    const failed = messages.find((message) => message.role === 'toolResult' && message.isError);
    assert.equal(failed.toolCallId, fixtures.TOOL_1.callId);
    assert.equal(failed.toolName, fixtures.TOOL_1.name);

    const allText = messages
      .map((message) => (message.content || []).map((block) => block.text || '').join('\n'))
      .join('\n');
    assert.ok(!allText.includes('v4-runtime-context-needle'));
    assert.ok(!allText.includes('v4-skill-catalog-needle'));
    assert.ok(allText.includes(TEXT.mainUserBeta));

    const errorRow = messages.find((message) => message.role === 'error');
    assert.ok(errorRow, 'expected the failing turn/end to produce an error row');
    assert.ok(errorRow.content[0].text.includes(TEXT.mainTurnError));
    assert.ok(errorRow.content[0].text.includes('ended without completing'));
  });

  it('serves injected context and context-window usage separately from the conversation', async () => {
    const { messages, contextMessages, contextUsage } = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}`);

    assert.equal(contextMessages.length, 2);
    assert.deepEqual(
      contextMessages.map((message) => message.details.sourceKind),
      ['runtime-context', 'skill-catalog']
    );
    const injected = contextMessages.map((message) => message.content[0].text).join('\n');
    assert.ok(injected.includes('v4-runtime-context-needle'));
    assert.ok(injected.includes('v4-skill-catalog-needle'));

    const rendered = messages
      .map((message) => (message.content || []).map((block) => block.text || '').join('\n'))
      .join('\n');
    assert.ok(!rendered.includes('v4-runtime-context-needle'));
    assert.ok(!rendered.includes('v4-skill-catalog-needle'));

    assert.equal(contextUsage.used, 70);
    assert.equal(contextUsage.limit, 100000);
    assert.equal(contextUsage.input, 50);
    assert.equal(contextUsage.cacheRead, 20);
    assert.ok(Math.abs(contextUsage.percent - 0.07) < 1e-9, `unexpected percent: ${contextUsage.percent}`);
  });

  it('serves a compacted v4 detail with the summary rendered exactly once', async () => {
    const { messages } = await getJson(srv.base, `/api/dsh/sessions/${COMPACTION.id}`);
    const texts = messages.map((message) => message.content[0]?.text).filter(Boolean);
    assert.ok(!texts.includes(TEXT.compactionOldUser));
    assert.ok(!texts.includes(TEXT.compactionOldAssistant));
    assert.equal(texts.filter((text) => text === TEXT.compactionSummary).length, 1);
    assert.ok(texts.includes(TEXT.compactionAfter));
  });

  it('rejects v1-v3, v5 and filename/header mismatch details with 422', async () => {
    const v5 = await getJson(srv.base, `/api/dsh/sessions/${V5.id}`, 422);
    assert.ok(typeof v5.error === 'string' && v5.error.length > 0, 'v5 needs a readable error');
    assert.match(v5.error, /5|upgrade|AgentXRay/i);

    const v2 = await getJson(srv.base, `/api/dsh/sessions/${V2.id}`, 422);
    assert.match(v2.error, /migrat|DeepSeek Harness/i);

    const mismatch = await getJson(srv.base, `/api/dsh/sessions/${MISMATCH.id}`, 422);
    assert.match(mismatch.error, /mismatch|inconsistent|version/i);
  });

  it('rejects traversal-shaped session ids without a 500', async () => {
    for (const id of ['%2E%2E', '..%2F..%2Fetc%2Fpasswd', '%2E%2E%2Fdsh-v4-mixed-0003']) {
      const res = await fetch(`${srv.base}/api/dsh/sessions/${id}`);
      assert.ok([400, 404].includes(res.status), `${id} -> ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('dsh-v4-mixed'), `${id} must not resolve another session`);
    }
  });

  it('finds v4 content through full-text search exactly once', async () => {
    const hits = await getJson(srv.base, '/api/search?q=v4-needle-beta&platform=dsh');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sessionId, MAIN.id);
    assert.equal(hits[0].platform, 'dsh');
    assert.ok(hits[0].matches[0].snippet.includes('v4-needle-beta'));
  });

  it('groups subagent search hits under the root and keeps the child id', async () => {
    const hits = await getJson(srv.base, '/api/search?q=v4-subagent-needle&platform=dsh');
    const hit = hits.find((item) => item.childSessionId === SUBAGENT.id);
    assert.ok(hit, 'expected a subagent hit');
    assert.equal(hit.sessionId, MAIN.id);
  });

  it('extracts only human v4 prompts, never injected context', async () => {
    const data = await getJson(srv.base, '/api/prompts?platform=dsh');
    // base v0 (2) + main (2) + subagent (1) + mixed (1) + fallback (1) + compaction (2)
    assert.equal(data.totalSessions, 7);
    assert.equal(data.totalPrompts, 9);
    const texts = data.groups.flatMap((group) =>
      group.sessions.flatMap((session) => session.prompts.map((p) => p.text))
    );
    assert.ok(texts.some((text) => text.includes('v4-needle-alpha')));
    assert.ok(texts.some((text) => text.includes('v4-needle-beta')));
    assert.ok(!texts.some((text) => text.includes('v4-skill-catalog-needle')));
    assert.ok(!texts.some((text) => text.includes('v4-runtime-context-needle')));
  });

  it('sums v4 input/output/cacheRead without double-counting totalTokens', async () => {
    const usage = await getJson(srv.base, '/api/usage/daily?days=14&platform=dsh');
    const totals = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
    for (const day of usage.series) {
      const bucket = day.byPlatform?.dsh;
      if (!bucket) continue;
      for (const key of Object.keys(totals)) totals[key] += bucket[key] || 0;
    }
    assert.deepEqual(totals, { input: 150, output: 30, cacheRead: 60, reasoning: 0 });
  });

  it('counts v4 message.isError in insights and the tools audit', async () => {
    const insights = await getJson(srv.base, '/api/insights?platform=dsh');
    const insightTool = insights.toolStats.find((tool) => tool.name === 'run_command');
    assert.ok(insightTool, 'expected run_command in insights');
    assert.equal(insightTool.errors, 1);

    const audit = await getJson(srv.base, '/api/tools/audit?platform=dsh');
    const audited = audit.tools.find((tool) => tool.name === 'run_command');
    assert.ok(audited, 'expected run_command in the tools audit');
    assert.equal(audited.errors, 1);
  });

  it('exposes activityEvents for jobs, approvals, and retries', async () => {
    const detail = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}`);
    const events = detail.activityEvents;
    assert.ok(Array.isArray(events), 'activityEvents must be an array');
    assert.ok(events.length > 0, 'expected activity events');

    const jobs = events.filter((event) => event.type === 'job');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 'bash-fixture-001');
    assert.equal(jobs[0].status, 'completed');
    assert.equal(jobs[0].label, 'fixture: run test command');

    const approvals = events.filter((event) => event.type === 'approval');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].action, 'decided');
    assert.equal(approvals[0].decision, 'allowed-once');
    assert.equal(approvals[0].toolName, 'bash');

    const retries = events.filter((event) => event.type === 'retry');
    assert.equal(retries.length, 1);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].maxRetries, 5);
    assert.equal(retries[0].failure.code, 'RATE_LIMIT');
  });

  it('exposes tool result diffs in the detail payload', async () => {
    const detail = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}`);
    const toolResult = detail.messages.find((m) => m.role === 'toolResult' && m.toolCallId === fixtures.TOOL_2.callId);
    assert.ok(toolResult, 'expected the successful tool result');
    assert.ok(Array.isArray(toolResult.details?.diffs), 'expected diffs array');
    assert.equal(toolResult.details.diffs.length, 1);
    assert.equal(toolResult.details.diffs[0].path, '/fixtures/project-v4/config.txt');
    assert.equal(toolResult.details.path, '/fixtures/project-v4/config.txt');
    assert.equal(toolResult.details.operation, 'update');
  });

  it('builds a dsh context snapshot with system prompt and tools', async () => {
    const detail = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}`);
    // Pick a target user message past the first turn.
    const targetIndex = detail.messages.findIndex((m, i) => m.role === 'user' && i > 0);
    assert.ok(targetIndex > 0, 'expected a second user message');
    const context = await getJson(srv.base, `/api/dsh/sessions/${MAIN.id}/context?messageIndex=${targetIndex}`);
    assert.ok(context.systemPrompt, 'expected systemPrompt');
    assert.ok(context.systemPrompt.components, 'expected components');
    const systemComponent = context.systemPrompt.components.find((c) => c.type === 'system-prompt');
    assert.ok(systemComponent, 'expected system-prompt component');
    assert.ok(systemComponent.present, 'system message should be present in fixture');
    assert.ok(context.tools.available || context.tools.count >= 0, 'tools block present');
  });

  it('archives session.v4.jsonl.zstd and skips it on a second backup', async () => {
    const first = await sendJson(srv.base, 'POST', '/api/backup', undefined);
    assert.ok(first.byPlatform.dsh.copied > 0);
    const archived = path.join(first.archiveDir, 'dsh', MAIN.project, MAIN.id, MAIN.file);
    assert.ok(fs.existsSync(archived), `backup missing ${archived}`);

    const second = await sendJson(srv.base, 'POST', '/api/backup', undefined);
    assert.equal(second.byPlatform.dsh.copied, 0);
    assert.ok(second.byPlatform.dsh.skipped > 0);
  });

  it('streams a v4 zstd frame appended to a watched log, holding back a torn frame', async () => {
    const file = path.join(srv.home, '.dsh', 'sessions', MAIN.project, MAIN.id, MAIN.file);
    const sse = await connectSse(`${srv.base}/api/watch?platform=dsh&sessionId=${MAIN.id}`);
    try {
      const connected = await sse.waitFor('connected');
      assert.ok(connected.data.messageCount > 0);

      const record = fixtures.event(
        'user/message',
        99,
        Date.now(),
        {
          content: [{ type: 'text', text: 'fixture: v4-watch-frame' }],
          source: { kind: 'user' },
          role: 'user',
          id: 'watch-v4-1',
        },
        'append'
      );
      const bytes = fixtures.frame(`${line(record)}\n`);

      // Torn frame: first half lands, nothing may be emitted yet.
      await fsp.appendFile(file, bytes.subarray(0, bytes.length - 4));
      await sleep(400);
      assert.equal(sse.events.filter((event) => event.event === 'newMessages').length, 0);

      await fsp.appendFile(file, bytes.subarray(bytes.length - 4));
      const event = await sse.waitFor('newMessages');
      assert.deepEqual(
        event.data.messages.map((message) => message.content[0].text),
        ['fixture: v4-watch-frame']
      );
    } finally {
      sse.close();
    }
  });
});
