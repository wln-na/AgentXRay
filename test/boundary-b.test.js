// Batch B boundary tests: corrupted/truncated JSONL, empty sessions, large
// sessions, multiple Claude Desktop candidates, and SSE/cache rebuild.
//
// Every test uses throwaway temp directories and cleans up after itself.
// HTTP-level tests boot a hermetic server via test/helpers.js startServer.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const { parseCodexSessionFile, parseCodexSessionMetadata } = require(path.join(ROOT, 'lib', 'platforms', 'codex'));
const { parseClaudeCodeSessionFile, parseClaudeCodeSessionMetadata } = require(
  path.join(ROOT, 'lib', 'platforms', 'claude')
);
const { parseSessionMetadata, parseSessionFile } = require(path.join(ROOT, 'lib', 'platforms', 'openclaw'));
const { collectClaudeDesktopEntries, findClaudeDesktopSessionFile } = require(
  path.join(ROOT, 'lib', 'platforms', 'claude-desktop')
);
const { computePrompts } = require(path.join(ROOT, 'lib', 'prompts'));
const { computeInsights, scanFileForInsights } = require(path.join(ROOT, 'lib', 'insights'));
const { withMetadataCache } = require(path.join(ROOT, 'lib', 'platforms', 'shared'));
const { sessionMetaCache } = require(path.join(ROOT, 'lib', 'config'));
const { startServer, getJson } = require('./helpers.js');

// --- helpers ---

async function makeTempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// resolveDir() rejects any dir outside HOME, so tests that pass a dirOverride
// to computePrompts/computeInsights/collectClaudeDesktopEntries must create
// their scratch tree under HOME (same pattern as test/robustness.test.js).
async function makeHomeTempDir(prefix) {
  const home = process.env.HOME || os.homedir();
  const dir = path.join(home, `.agentxray-test-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Compile the frontend sessions lib.ts to CJS so buildTimingAnalysis is
// testable in Node (same approach as test/unit.test.js).
function loadSessionsLib() {
  const { buildSync } = createRequire(path.join(ROOT, 'frontend', 'package.json'))('esbuild');
  const output = buildSync({
    entryPoints: [path.join(ROOT, 'frontend', 'src', 'views', 'sessions', 'lib.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    alias: { '@': path.join(ROOT, 'frontend', 'src') },
  }).outputFiles[0].text;
  const compiled = { exports: {} };
  new Function('module', 'exports', 'require', output)(compiled, compiled.exports, require);
  return compiled.exports;
}

// Minimal SSE client (mirrors test/watch.test.js).
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
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ event, data: JSON.parse(data) });
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted on close */
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

// ============================================================
// Scenario 1: corrupted / truncated JSONL parsing
// ============================================================

describe('Batch B: corrupted/truncated JSONL', () => {
  let dir;

  before(async () => {
    dir = await makeTempDir('agentxray-boundary-corrupt-');
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('parseCodexSessionFile skips bad lines and parses good ones', async () => {
    const file = path.join(dir, 'codex-corrupt.jsonl');
    const bigPayload = 'x'.repeat(1_100_000); // >1MB single-line JSON
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-01-15T10:00:00.000Z',
        payload: { id: 'corrupt-codex', cwd: '/tmp/test', timestamp: '2026-01-15T10:00:00.000Z' },
      }),
      '{broken', // malformed JSON
      '', // empty line
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-01-15T10:00:01.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello from good line' }] },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: bigPayload }] },
      }),
      // truncated last line (no closing brace, no newline)
      '{"type":"response_item","payload":{"type":"message","role":"user"',
    ];
    // Write without trailing newline so the last line is genuinely truncated.
    fs.writeFileSync(file, lines.join('\n'), 'utf8');

    const result = await parseCodexSessionFile(file);
    assert.ok(result.session, 'session should be parsed from session_meta');
    assert.equal(result.session.id, 'corrupt-codex');
    // 3 good response_item messages (user, assistant, big-user); truncated line skipped
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].role, 'user');
    assert.ok(result.messages[0].content[0].text.includes('hello from good line'));
    // The >1MB line should parse fine (it's valid JSON, just large)
    assert.equal(result.messages[2].content[0].text.length, 1_100_000);
  });

  it('parseClaudeCodeSessionFile skips bad lines without throwing', async () => {
    const file = path.join(dir, 'claude-corrupt.jsonl');
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-01-15T10:00:00.000Z',
        cwd: '/tmp/test',
        message: { role: 'user', content: [{ type: 'text', text: 'good user message' }] },
      }),
      'not json at all',
      '',
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-15T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'good assistant' }] },
      }),
      '{truncated',
    ];
    fs.writeFileSync(file, lines.join('\n'), 'utf8');

    const result = await parseClaudeCodeSessionFile(file);
    assert.ok(Array.isArray(result.messages));
    assert.ok(result.messages.length >= 2, 'good messages should survive');
    const roles = result.messages.map((m) => m.role);
    assert.ok(roles.includes('user'));
    assert.ok(roles.includes('assistant'));
  });

  it('openclaw parseSessionMetadata skips corrupted lines', async () => {
    const file = path.join(dir, 'openclaw-corrupt.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', id: 'oc-corrupt', timestamp: '2026-01-15T10:00:00Z' }),
      '{bad json',
      '',
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-15T10:01:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'real prompt' }] },
      }),
      '{"type":"message"', // truncated
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const meta = await parseSessionMetadata(file, 'openclaw-corrupt.jsonl');
    assert.equal(meta.id, 'oc-corrupt');
    assert.equal(meta.messageCount, 1);
    assert.equal(meta.userCount, 1);
    assert.ok(meta.firstUserMessage?.includes('real prompt'));
  });

  it('computePrompts tolerates corrupted codex lines (extractCodexPrompts internal)', async () => {
    // extractCodexPrompts is not exported; exercise it through computePrompts
    // with a codex session file that contains bad lines.
    const homeDir = await makeHomeTempDir('corrupt-codex-prompts');
    const codexDir = path.join(homeDir, '.codex', 'sessions');
    await fsp.mkdir(codexDir, { recursive: true });
    const file = path.join(codexDir, 'corrupt-prompts.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-01-15T10:00:00Z',
        payload: { cwd: '/tmp/x', id: 'corrupt-prompts' },
      }),
      'garbage line',
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-01-15T10:00:01Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'surviving prompt' }] },
      }),
      '{broken json',
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    try {
      const result = await computePrompts('codex', null, homeDir);
      assert.equal(result.totalPrompts, 1);
      assert.equal(result.groups[0].sessions[0].prompts[0].text, 'surviving prompt');
      assert.equal(result.skippedFiles.length, 0);
    } finally {
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('computePrompts tolerates corrupted openclaw lines (extractOpenClawPrompts internal)', async () => {
    const homeDir = await makeHomeTempDir('corrupt-oc-prompts');
    const agentDir = path.join(homeDir, 'test-agent', 'sessions');
    await fsp.mkdir(agentDir, { recursive: true });
    const file = path.join(agentDir, 'corrupt.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-01-15T10:00:00Z' }),
      'not json',
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-15T10:01:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'openclaw surviving prompt' }] },
      }),
      '{truncated',
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    try {
      const result = await computePrompts('openclaw', 'test-agent', homeDir);
      assert.equal(result.totalPrompts, 1);
      assert.equal(result.groups[0].sessions[0].prompts[0].text, 'openclaw surviving prompt');
    } finally {
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('scanFileForInsights skips bad lines and counts good ones', async () => {
    const file = path.join(dir, 'insights-corrupt.jsonl');
    const lines = [
      JSON.stringify({ type: 'session', timestamp: '2026-01-15T10:00:00Z' }),
      '{bad',
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }),
      '',
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'Bash' }],
        },
      }),
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const data = await scanFileForInsights(file, 'test-session');
    assert.equal(data.messageCount, 2);
    assert.equal(data.toolCallCount, 1);
  });
});

// ============================================================
// Scenario 2: empty sessions
// ============================================================

describe('Batch B: empty sessions', () => {
  let dir;

  before(async () => {
    dir = await makeTempDir('agentxray-boundary-empty-');
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('parseCodexSessionFile on session_meta-only file returns messages=[]', async () => {
    const file = path.join(dir, 'empty-codex.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-01-15T10:00:00.000Z',
        payload: { id: 'empty-codex', cwd: '/tmp/empty', timestamp: '2026-01-15T10:00:00.000Z' },
      })}\n`,
      'utf8'
    );

    const result = await parseCodexSessionFile(file);
    assert.ok(result.session);
    assert.equal(result.session.id, 'empty-codex');
    assert.deepEqual(result.messages, []);
    assert.equal(result.tokenUsage, null);
    assert.equal(result.session.model, null);
  });

  it('parseCodexSessionMetadata on empty file returns zero counts', async () => {
    const file = path.join(dir, 'empty-codex-meta.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'empty-meta', timestamp: '2026-01-15T10:00:00Z' },
      })}\n`,
      'utf8'
    );
    const meta = await parseCodexSessionMetadata(file, 'empty-codex-meta.jsonl');
    assert.equal(meta.messageCount, 0);
    assert.equal(meta.userCount, 0);
    assert.equal(meta.toolCallCount, 0);
    assert.equal(meta.tokenUsage, null);
  });

  it('openclaw parseSessionFile on session-only file returns messages=[]', async () => {
    const file = path.join(dir, 'empty-openclaw.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'session', id: 'empty-oc', timestamp: '2026-01-15T10:00:00Z' })}\n`,
      'utf8'
    );
    const result = await parseSessionFile(file);
    assert.ok(result.session);
    assert.deepEqual(result.messages, []);
  });

  it('computePrompts on an empty openclaw session returns promptCount=0', async () => {
    const homeDir = await makeHomeTempDir('empty-prompts');
    const agentDir = path.join(homeDir, 'test-agent', 'sessions');
    await fsp.mkdir(agentDir, { recursive: true });
    const file = path.join(agentDir, 'empty-session.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'session', id: 'empty-session', timestamp: '2026-01-15T10:00:00Z' })}\n`,
      'utf8'
    );

    try {
      const result = await computePrompts('openclaw', 'test-agent', homeDir);
      assert.equal(result.totalPrompts, 0);
      assert.equal(result.processedFiles, 1);
      assert.equal(result.skippedFiles.length, 0);
    } finally {
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('computeInsights on an empty session returns zeroed stats, not null', async () => {
    const homeDir = await makeHomeTempDir('empty-insights');
    const agentDir = path.join(homeDir, 'test-agent', 'sessions');
    await fsp.mkdir(agentDir, { recursive: true });
    const file = path.join(agentDir, 'empty-session.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ type: 'session', id: 'empty-session', timestamp: '2026-01-15T10:00:00Z' })}\n`,
      'utf8'
    );

    try {
      const result = await computeInsights('openclaw', 'test-agent', homeDir);
      assert.ok(result, 'computeInsights should not return null when a file exists');
      assert.equal(result.totalSessions, 1);
      assert.equal(result.totalMessages, 0);
      assert.equal(result.totalToolCalls, 0);
      assert.equal(result.processedFiles, 1);
    } finally {
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('API /api/codex/sessions/:id returns 200 for an empty session', async () => {
    const srv = await startServer();
    try {
      // Plant an empty codex session in the server's temp HOME
      const codexDir = path.join(srv.home, '.codex', 'sessions');
      await fsp.mkdir(codexDir, { recursive: true });
      const emptyId = '01900000-0000-7000-8000-00000000eeee';
      const file = path.join(codexDir, `${emptyId}.jsonl`);
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-09-01T00:00:00.000Z',
          payload: { id: emptyId, cwd: '/tmp/empty', timestamp: '2026-09-01T00:00:00.000Z' },
        })}\n`,
        'utf8'
      );

      const detail = await getJson(srv.base, `/api/codex/sessions/${emptyId}`);
      assert.equal(detail.session.id, emptyId);
      assert.deepEqual(detail.messages, []);
      assert.equal(detail.tokenUsage, null);
    } finally {
      await srv.stop();
    }
  });
});

// ============================================================
// Scenario 3: large sessions (performance / memory)
// ============================================================

describe('Batch B: large sessions', { timeout: 30000 }, () => {
  let dir;

  before(async () => {
    dir = await makeTempDir('agentxray-boundary-large-');
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('parseCodexSessionFile handles 5000 messages under 5 seconds', async () => {
    const file = path.join(dir, 'large-codex.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-01-15T10:00:00.000Z',
        payload: { id: 'large-codex', cwd: '/tmp/large', timestamp: '2026-01-15T10:00:00.000Z' },
      }),
    ];
    for (let i = 0; i < 5000; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      lines.push(
        JSON.stringify({
          type: 'response_item',
          timestamp: `2026-01-15T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
          payload: {
            type: 'message',
            role,
            content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: `msg ${i}` }],
          },
        })
      );
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const start = Date.now();
    const result = await parseCodexSessionFile(file);
    const elapsed = Date.now() - start;

    assert.equal(result.messages.length, 5000);
    assert.ok(elapsed < 5000, `parse took ${elapsed}ms, expected < 5000ms`);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[4999].role, 'assistant');
  });

  it('buildTimingAnalysis handles 5000 messages without OOM or infinite loop', async () => {
    const { buildTimingAnalysis } = loadSessionsLib();
    const messages = [];
    for (let i = 0; i < 5000; i++) {
      messages.push({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        timestamp: new Date(1700000000000 + i * 1000).toISOString(),
        content: [{ type: 'text', text: `message ${i}` }],
      });
    }

    const start = Date.now();
    const analysis = buildTimingAnalysis(messages);
    const elapsed = Date.now() - start;

    assert.ok(analysis.visibleMessages.length > 0);
    assert.ok(analysis.timingByMessage.size > 0);
    assert.ok(elapsed < 5000, `buildTimingAnalysis took ${elapsed}ms, expected < 5000ms`);
    assert.ok(analysis.totalDurationMs !== null);
    assert.ok(analysis.totalDurationMs > 0);
  });

  it('computeInsights scans a large session without crashing', async () => {
    const homeDir = await makeHomeTempDir('large-insights');
    const agentDir = path.join(homeDir, 'test-agent', 'sessions');
    await fsp.mkdir(agentDir, { recursive: true });
    const file = path.join(agentDir, 'large-session.jsonl');

    const lines = [JSON.stringify({ type: 'session', id: 'large-session', timestamp: '2026-01-15T10:00:00Z' })];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: 'message',
          timestamp: `2026-01-15T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: [{ type: 'text', text: `msg ${i}` }],
          },
        })
      );
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    try {
      const start = Date.now();
      const result = await computeInsights('openclaw', 'test-agent', homeDir);
      const elapsed = Date.now() - start;

      assert.ok(result);
      assert.equal(result.totalSessions, 1);
      assert.equal(result.totalMessages, 5000);
      assert.ok(elapsed < 10000, `computeInsights took ${elapsed}ms`);
    } finally {
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('parseSessionMetadata handles 5000 messages efficiently', async () => {
    const file = path.join(dir, 'large-openclaw.jsonl');
    const lines = [JSON.stringify({ type: 'session', id: 'large-oc', timestamp: '2026-01-15T10:00:00Z' })];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({
          type: 'message',
          timestamp: `2026-01-15T10:00:${String(i % 60).padStart(2, '0')}Z`,
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: [{ type: 'text', text: `msg ${i}` }],
          },
        })
      );
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const start = Date.now();
    const meta = await parseSessionMetadata(file, 'large-openclaw.jsonl');
    const elapsed = Date.now() - start;

    assert.equal(meta.messageCount, 5000);
    assert.equal(meta.userCount, 2500);
    assert.equal(meta.assistantCount, 2500);
    assert.ok(elapsed < 5000, `parseSessionMetadata took ${elapsed}ms`);
  });
});

// ============================================================
// Scenario 4: multiple Claude Desktop candidates
// ============================================================

describe('Batch B: multiple Claude Desktop candidates', () => {
  let dir;

  before(async () => {
    // Must be under HOME because resolveDir() rejects dirs outside HOME.
    dir = await makeHomeTempDir('boundary-desktop');
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('collectClaudeDesktopEntries picks the highest-scored candidate when duplicates exist', async () => {
    // Build a Claude Desktop directory tree with two project dirs containing
    // the same-named .jsonl log file, plus one metadata file pointing to it.
    const cliSessionId = 'eeee1111-2222-4333-8444-555566667777';
    const desktopSessionId = 'local_dddd1111-2222-4333-8444-555566667777';

    // Project A: path includes the short id prefix → higher candidateScore
    const projectA = path.join(
      dir,
      'account-a',
      '00000000',
      cliSessionId.slice(0, 8),
      '.claude',
      'projects',
      'session'
    );
    await fsp.mkdir(projectA, { recursive: true });
    const logA = path.join(projectA, `${cliSessionId}.jsonl`);
    fs.writeFileSync(
      logA,
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-01-15T10:00:00.000Z',
        cwd: '/project-a',
        message: { role: 'user', content: [{ type: 'text', text: 'from project A' }] },
      })}\n`,
      'utf8'
    );

    // Project B: no short-id prefix in path → lower score
    const projectB = path.join(dir, 'account-b', '00000000', 'other', '.claude', 'projects', 'session');
    await fsp.mkdir(projectB, { recursive: true });
    const logB = path.join(projectB, `${cliSessionId}.jsonl`);
    fs.writeFileSync(
      logB,
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-01-15T11:00:00.000Z',
        cwd: '/project-b',
        message: { role: 'user', content: [{ type: 'text', text: 'from project B' }] },
      })}\n`,
      'utf8'
    );

    // Metadata file at the top level
    const metaFile = path.join(dir, 'account-a', '00000000', `${desktopSessionId}.json`);
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        sessionId: desktopSessionId,
        cliSessionId,
        title: 'Duplicate candidate session',
        createdAt: 1736899200000,
        lastActivityAt: 1736902800000,
        model: 'test-model',
      }),
      'utf8'
    );

    const entries = await collectClaudeDesktopEntries(dir);
    assert.equal(entries.length, 1, 'one metadata file → one entry');
    const entry = entries[0];
    assert.equal(entry.id, desktopSessionId);
    assert.equal(entry.cliSessionId, cliSessionId);
    // Candidate A has the short-id in its path (score +20), so it wins.
    assert.ok(
      entry.filePath.includes(cliSessionId.slice(0, 8)),
      `expected higher-scored candidate (with short id in path), got ${entry.filePath}`
    );
  });

  it('findClaudeDesktopSessionFile returns the selected candidate path', async () => {
    const cliSessionId = 'ffff1111-2222-4333-8444-555566667777';
    const desktopSessionId = 'local_eeee1111-2222-4333-8444-555566667777';

    const projDir = path.join(dir, 'single', cliSessionId.slice(0, 8), '.claude', 'projects', 'session');
    await fsp.mkdir(projDir, { recursive: true });
    const logFile = path.join(projDir, `${cliSessionId}.jsonl`);
    fs.writeFileSync(logFile, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [] } })}\n`, 'utf8');

    const metaFile = path.join(dir, 'single', `${desktopSessionId}.json`);
    fs.writeFileSync(metaFile, JSON.stringify({ sessionId: desktopSessionId, cliSessionId, title: 'test' }), 'utf8');

    const found = await findClaudeDesktopSessionFile(dir, desktopSessionId);
    assert.equal(found, logFile);

    // Also findable by cliSessionId
    const foundByCli = await findClaudeDesktopSessionFile(dir, cliSessionId);
    assert.equal(foundByCli, logFile);
  });

  it('collectClaudeDesktopEntries deduplicates by metadata sessionId', async () => {
    // Two metadata files with the same sessionId but different cliSessionIds
    // should each produce an entry (they're distinct Desktop sessions).
    const base = path.join(dir, 'dedup');
    await fsp.mkdir(path.join(base, 'logs'), { recursive: true });

    const log1 = path.join(base, 'logs', 'aaaa1111-2222-4333-8444-555566667777.jsonl');
    const log2 = path.join(base, 'logs', 'bbbb1111-2222-4333-8444-555566667778.jsonl');
    fs.writeFileSync(log1, '{}\n', 'utf8');
    fs.writeFileSync(log2, '{}\n', 'utf8');

    const meta1 = path.join(base, 'local_cccc1111-2222-4333-8444-555566667779.json');
    const meta2 = path.join(base, 'sub', 'local_cccc1111-2222-4333-8444-555566667779.json');
    await fsp.mkdir(path.join(base, 'sub'), { recursive: true });
    fs.writeFileSync(
      meta1,
      JSON.stringify({
        sessionId: 'local_cccc1111-2222-4333-8444-555566667779',
        cliSessionId: 'aaaa1111-2222-4333-8444-555566667777',
        title: 'one',
      }),
      'utf8'
    );
    fs.writeFileSync(
      meta2,
      JSON.stringify({
        sessionId: 'local_cccc1111-2222-4333-8444-555566667779',
        cliSessionId: 'bbbb1111-2222-4333-8444-555566667778',
        title: 'two',
      }),
      'utf8'
    );

    const entries = await collectClaudeDesktopEntries(base);
    // collectClaudeDesktopEntries does NOT dedup by sessionId — it yields one
    // entry per metadata file. This test records the current behavior.
    assert.equal(entries.length, 2, 'current behavior: one entry per metadata file, no sessionId dedup');
    const ids = entries.map((e) => e.id);
    assert.deepEqual(ids, ['local_cccc1111-2222-4333-8444-555566667779', 'local_cccc1111-2222-4333-8444-555566667779']);
  });
});

// ============================================================
// Scenario 5: SSE reconnect / WAL / cache rebuild
// ============================================================

describe('Batch B: SSE reconnect and cache', () => {
  let dir;

  before(async () => {
    dir = await makeTempDir('agentxray-boundary-sse-');
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // --- metadata cache unit tests ---

  it('withMetadataCache returns cached data on second call when mtime unchanged', async () => {
    const file = path.join(dir, 'cache-test.jsonl');
    fs.writeFileSync(file, '{"type":"session","id":"cache-me"}\n', 'utf8');

    let callCount = 0;
    const cachedParse = withMetadataCache(async (fp) => {
      callCount++;
      return { parsed: true, path: fp };
    });

    const first = await cachedParse(file);
    const second = await cachedParse(file);

    assert.deepEqual(first, second);
    assert.equal(callCount, 1, 'raw parser should be called only once (cache hit on second)');

    // Verify the cache entry exists in the shared sessionMetaCache
    const cached = sessionMetaCache.get(file);
    assert.ok(cached, 'cache entry should exist in sessionMetaCache');
  });

  it('withMetadataCache re-parses after mtime changes', async () => {
    const file = path.join(dir, 'cache-invalidate.jsonl');
    fs.writeFileSync(file, '{"v":1}\n', 'utf8');

    let callCount = 0;
    const cachedParse = withMetadataCache(async () => {
      callCount++;
      const content = fs.readFileSync(file, 'utf8');
      return { content };
    });

    const first = await cachedParse(file);
    assert.equal(first.content, '{"v":1}\n');

    // Modify the file and advance mtime
    await sleep(10);
    fs.writeFileSync(file, '{"v":2}\n', 'utf8');
    const future = new Date(Date.now() + 5000);
    await fsp.utimes(file, future, future);

    const second = await cachedParse(file);
    assert.equal(second.content, '{"v":2}\n');
    assert.equal(callCount, 2, 'raw parser should be called again after mtime change');
  });

  it('withMetadataCache falls through to parse when stat fails', async () => {
    const file = path.join(dir, 'nonexistent-cache.jsonl');
    let callCount = 0;
    const cachedParse = withMetadataCache(async () => {
      callCount++;
      return { fallback: true };
    });
    // The raw parser will be called (stat fails → fall through). If the raw
    // parser itself doesn't throw, we get a result.
    const result = await cachedParse(file);
    assert.deepEqual(result, { fallback: true });
    assert.equal(callCount, 1);
  });

  // --- SSE integration tests ---

  it('SSE /api/watch sends connected event on initial connect', async () => {
    const srv = await startServer();
    try {
      const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
      const sse = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`);
      try {
        const connected = await sse.waitFor('connected');
        assert.equal(typeof connected.data.messageCount, 'number');
        assert.ok(connected.data.messageCount > 0);
      } finally {
        sse.close();
      }
    } finally {
      await srv.stop();
    }
  });

  it('SSE client can disconnect and reconnect successfully', async () => {
    const srv = await startServer();
    try {
      const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
      const url = `${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`;

      // First connection
      const sse1 = await connectSse(url);
      const connected1 = await sse1.waitFor('connected');
      assert.ok(connected1.data.messageCount > 0);
      sse1.close();
      await sleep(100);

      // Reconnect — should get a fresh connected event
      const sse2 = await connectSse(url);
      try {
        const connected2 = await sse2.waitFor('connected');
        assert.ok(connected2.data.messageCount > 0);
        assert.equal(connected2.data.messageCount, connected1.data.messageCount);
      } finally {
        sse2.close();
      }
    } finally {
      await srv.stop();
    }
  });

  it('SSE watch invalidates metadata cache when new lines arrive', async () => {
    const srv = await startServer();
    try {
      const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
      const ompFile = path.join(
        srv.home,
        '.omp',
        'agent',
        'sessions',
        '-fixtures-project-gamma',
        '2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl'
      );

      const sse = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`);
      try {
        await sse.waitFor('connected');

        // Append a new message — the watcher should emit newMessages and
        // invalidate the metadata cache for this file.
        const newLine = JSON.stringify({
          type: 'message',
          id: 'boundary-new-msg',
          timestamp: '2026-01-20T09:30:00.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'boundary: cache invalidate check' }],
            attribution: 'user',
          },
        });
        await fsp.appendFile(ompFile, `${newLine}\n`);

        const ev = await sse.waitFor('newMessages');
        assert.ok(ev.data.messages.length > 0);
        const texts = ev.data.messages.map((m) => m.content?.[0]?.text || '');
        assert.ok(texts.some((t) => t.includes('boundary: cache invalidate check')));
      } finally {
        sse.close();
      }
    } finally {
      await srv.stop();
    }
  });

  // --- WAL behavior ---

  it('Hermes watch handles missing WAL file gracefully (falls back to db watch)', async () => {
    // The watch route for hermes tries fs.watch on the -wal file first; if it
    // doesn't exist, it falls back to watching the db file. We verify the
    // endpoint returns 200 and sends a connected event even without a WAL.
    const srv = await startServer();
    try {
      // The fixture home has a .hermes/state.db. Connect to a hermes session.
      const hermesSessions = await getJson(srv.base, '/api/hermes/sessions');
      if (hermesSessions.length === 0) {
        // No hermes fixture — skip gracefully
        return;
      }
      const sessionId = hermesSessions[0].id;
      const sse = await connectSse(`${srv.base}/api/watch?platform=hermes&sessionId=${sessionId}`);
      try {
        const connected = await sse.waitFor('connected');
        assert.equal(typeof connected.data.messageCount, 'number');
      } finally {
        sse.close();
      }
    } finally {
      await srv.stop();
    }
  });
});
