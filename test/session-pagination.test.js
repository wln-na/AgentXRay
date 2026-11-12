const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { startServer, getJson } = require('./helpers.js');

const CLAUDE_SESSION = 'paged-claude-session';
const CLAUDE_LARGE_SESSION = 'paged-claude-large';
const CLAUDE_COLLISION_SESSION = 'paged-claude-collision';
const CLAUDE_EMPTY_SESSION = 'paged-claude-empty';
const OPENCLAW_AGENT = 'pagination-agent';
const OPENCLAW_SESSION = 'paged-openclaw-session';
const CODEX_CHILD = '01900000-0000-7000-8000-000000000003';
const CODEX_PARENT = '01900000-0000-7000-8000-000000000001';

function isoAt(base, index) {
  return new Date(Date.parse(base) + index * 1000).toISOString();
}

function claudeUserRecord(sessionId, uuid, parentUuid, text, timestamp) {
  return {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: '/fixtures/project-pagination',
    sessionId,
    version: '2.0.0',
    type: 'user',
    message: { role: 'user', content: text },
    uuid,
    timestamp,
  };
}

function claudeToolResultRecord(sessionId, parentUuid, text, timestamp) {
  return {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: '/fixtures/project-pagination',
    sessionId,
    version: '2.0.0',
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'same-tool-call',
          content: [{ type: 'text', text }],
        },
      ],
    },
    timestamp,
  };
}

async function writeJsonl(filePath, records) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function openclawSessionRecords(sessionId, startTime, count) {
  const records = [
    {
      type: 'session',
      id: sessionId,
      timestamp: startTime,
      cwd: '/fixtures/project-pagination',
      version: '1.0.0',
    },
  ];
  for (let index = 0; index < count; index += 1) {
    records.push({
      type: 'message',
      id: `${sessionId}-message-${index}`,
      timestamp: isoAt(startTime, index),
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${sessionId}-text-${index}` }],
      },
    });
  }
  return records;
}

async function installPaginationFixtures(home) {
  const projectDir = path.join(home, '.claude', 'projects', '-fixtures-project-pagination');
  const mainRoot = Date.UTC(2026, 9, 3, 0, 0, 0);
  const mainRecords = [];
  for (let index = 0; index < 61; index += 1) {
    mainRecords.push(
      claudeUserRecord(
        CLAUDE_SESSION,
        `paged-${index}`,
        index === 0 ? null : `paged-${index - 1}`,
        `paged-message-${String(index).padStart(2, '0')}`,
        isoAt(new Date(mainRoot).toISOString(), index)
      )
    );
  }
  await writeJsonl(path.join(projectDir, `${CLAUDE_SESSION}.jsonl`), mainRecords);

  const largeRoot = new Date(Date.UTC(2026, 8, 3, 0, 0, 0)).toISOString();
  const largeRecords = [];
  for (let index = 0; index < 205; index += 1) {
    largeRecords.push(
      claudeUserRecord(
        CLAUDE_LARGE_SESSION,
        `large-${index}`,
        index === 0 ? null : `large-${index - 1}`,
        `large-message-${String(index).padStart(3, '0')}`,
        isoAt(largeRoot, index)
      )
    );
  }
  await writeJsonl(path.join(projectDir, `${CLAUDE_LARGE_SESSION}.jsonl`), largeRecords);

  const collisionTime = '2026-08-03T00:00:01.000Z';
  await writeJsonl(path.join(projectDir, `${CLAUDE_COLLISION_SESSION}.jsonl`), [
    claudeUserRecord(
      CLAUDE_COLLISION_SESSION,
      'collision-anchor',
      null,
      'collision-anchor',
      '2026-08-03T00:00:00.000Z'
    ),
    claudeToolResultRecord(CLAUDE_COLLISION_SESSION, 'collision-anchor', 'collision-a', collisionTime),
    claudeToolResultRecord(CLAUDE_COLLISION_SESSION, 'collision-anchor', 'collision-b', collisionTime),
  ]);

  await writeJsonl(path.join(projectDir, `${CLAUDE_EMPTY_SESSION}.jsonl`), [
    {
      type: 'system',
      subtype: 'turn_duration',
      sessionId: CLAUDE_EMPTY_SESSION,
      cwd: '/fixtures/project-pagination',
      timestamp: '2026-08-04T00:00:00.000Z',
    },
  ]);

  const agentDir = path.join(home, '.openclaw', 'agents', OPENCLAW_AGENT, 'sessions');
  await writeJsonl(
    path.join(agentDir, `${OPENCLAW_SESSION}.jsonl`),
    openclawSessionRecords(OPENCLAW_SESSION, '2026-08-10T00:00:00.000Z', 61)
  );
  await writeJsonl(
    path.join(agentDir, 'paged-openclaw-middle.jsonl'),
    openclawSessionRecords('paged-openclaw-middle', '2026-08-09T00:00:00.000Z', 1)
  );
  await writeJsonl(
    path.join(agentDir, 'paged-openclaw-oldest.jsonl'),
    openclawSessionRecords('paged-openclaw-oldest', '2026-08-08T00:00:00.000Z', 1)
  );
}

function messageTexts(messages) {
  return messages.map((message) => message.content?.[0]?.text ?? '');
}

async function collectMessagePages(base, sessionId, limit) {
  const pages = [];
  let before = null;
  do {
    const beforeParam = before === null ? '' : `&before=${encodeURIComponent(before)}`;
    const body = await getJson(base, `/api/claude-code/sessions/${sessionId}/messages?limit=${limit}${beforeParam}`);
    pages.push(body);
    before = body.messagePage.nextBefore;
  } while (before !== null);
  return pages;
}

describe('session pagination HTTP contract', () => {
  let srv;

  before(async () => {
    srv = await startServer(undefined, { prepareHome: installPaginationFixtures });
  });

  after(async () => {
    await srv.stop();
  });

  it('keeps the unpaginated detail contract and computes stats from the full session', async () => {
    const full = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}`);
    assert.equal(full.messages.length, 61);
    assert.equal(full.messagePage, undefined);
    assert.equal(full.stats.userCount, 61);

    const latest = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}?limit=60`);
    assert.equal(latest.messages.length, 60);
    assert.equal(latest.messages[0].content[0].text, 'paged-message-01');
    assert.equal(latest.messages.at(-1).content[0].text, 'paged-message-60');
    assert.deepEqual(latest.messagePage, {
      total: 61,
      limit: 60,
      start: 1,
      end: 61,
      hasMoreBefore: true,
      nextBefore: '1',
    });
    assert.equal(latest.stats.userCount, 61, 'stats must cover the full session, not the page');

    const oldest = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}?limit=60&before=1`);
    assert.deepEqual(messageTexts(oldest.messages), ['paged-message-00']);
    assert.deepEqual(oldest.messagePage, {
      total: 61,
      limit: 60,
      start: 0,
      end: 1,
      hasMoreBefore: false,
      nextBefore: null,
    });
  });

  it('defaults the messages endpoint to the newest 60 and returns the final message next', async () => {
    const latest = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}/messages`);
    assert.equal(latest.messages.length, 60);
    assert.deepEqual(messageTexts(latest.messages).slice(0, 2), ['paged-message-01', 'paged-message-02']);
    assert.equal(latest.messages.at(-1).content[0].text, 'paged-message-60');
    assert.equal(latest.messagePage.nextBefore, '1');

    const oldest = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}/messages?before=1&limit=60`);
    assert.deepEqual(messageTexts(oldest.messages), ['paged-message-00']);
    assert.equal(oldest.messagePage.hasMoreBefore, false);
  });

  it('traverses every message exactly once and preserves chronological order', async () => {
    const pages = await collectMessagePages(srv.base, CLAUDE_SESSION, 20);
    assert.equal(pages.length, 4);
    assert.deepEqual(
      pages.map((page) => page.messagePage),
      [
        { total: 61, limit: 20, start: 41, end: 61, hasMoreBefore: true, nextBefore: '41' },
        { total: 61, limit: 20, start: 21, end: 41, hasMoreBefore: true, nextBefore: '21' },
        { total: 61, limit: 20, start: 1, end: 21, hasMoreBefore: true, nextBefore: '1' },
        { total: 61, limit: 20, start: 0, end: 1, hasMoreBefore: false, nextBefore: null },
      ]
    );

    const allMessages = pages.reverse().flatMap((page) => messageTexts(page.messages));
    assert.equal(allMessages.length, 61);
    assert.equal(new Set(allMessages).size, 61);
    assert.deepEqual(
      allMessages,
      Array.from({ length: 61 }, (_, index) => `paged-message-${String(index).padStart(2, '0')}`)
    );
  });

  it('handles empty pages and empty sessions', async () => {
    const emptyPage = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}/messages?before=0&limit=20`);
    assert.deepEqual(emptyPage.messages, []);
    assert.deepEqual(emptyPage.messagePage, {
      total: 61,
      limit: 20,
      start: 0,
      end: 0,
      hasMoreBefore: false,
      nextBefore: null,
    });

    const emptySession = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_EMPTY_SESSION}/messages`);
    assert.deepEqual(emptySession.messages, []);
    assert.deepEqual(emptySession.messagePage, {
      total: 0,
      limit: 60,
      start: 0,
      end: 0,
      hasMoreBefore: false,
      nextBefore: null,
    });
  });

  it('preserves distinct no-ID messages with identical timestamp, role, and toolCallId', async () => {
    const first = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_COLLISION_SESSION}/messages?limit=2`);
    assert.deepEqual(messageTexts(first.messages), ['collision-a', 'collision-b']);
    for (const message of first.messages) {
      assert.equal(message.id, null);
      assert.equal(message.role, 'toolResult');
      assert.equal(message.toolCallId, 'same-tool-call');
      assert.equal(message.timestamp, '2026-08-03T00:00:01.000Z');
    }
    assert.equal(first.messagePage.nextBefore, '1');

    const older = await getJson(
      srv.base,
      `/api/claude-code/sessions/${CLAUDE_COLLISION_SESSION}/messages?limit=2&before=1`
    );
    assert.deepEqual(messageTexts(older.messages), ['collision-anchor']);
    assert.equal(older.messagePage.total, 3);

    const full = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_COLLISION_SESSION}`);
    assert.deepEqual(messageTexts(full.messages), ['collision-anchor', 'collision-a', 'collision-b']);
  });

  it('caps explicit limits at 200 and preserves zero as the historical no-limit sentinel', async () => {
    const capped = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_LARGE_SESSION}/messages?limit=500`);
    assert.equal(capped.messages.length, 200);
    assert.deepEqual(capped.messagePage, {
      total: 205,
      limit: 200,
      start: 5,
      end: 205,
      hasMoreBefore: true,
      nextBefore: '5',
    });

    const unlimited = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}/messages?limit=0`);
    assert.equal(unlimited.messages.length, 61);
    assert.deepEqual(unlimited.messagePage, {
      total: 61,
      limit: 61,
      start: 0,
      end: 61,
      hasMoreBefore: false,
      nextBefore: null,
    });
  });

  it('rejects malformed and repeated pagination parameters with 400', async () => {
    const invalidQueries = [
      'limit=abc',
      'limit=-1',
      'limit=1.5',
      'before=abc',
      'before=-1',
      'limit=1&limit=2',
      'before=1&before=2',
    ];
    for (const query of invalidQueries) {
      const body = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}/messages?${query}`, 400);
      assert.match(body.error, /^(limit|before) must be a non-negative integer$/);
    }
  });

  it('keeps legacy list arrays and paginates the same list only when asked', async () => {
    const full = await getJson(srv.base, '/api/codex/sessions');
    assert.ok(Array.isArray(full));
    assert.equal(full.length, 4);

    const latest = await getJson(srv.base, '/api/codex/sessions?limit=2');
    assert.equal(latest.sessions.length, 2);
    assert.deepEqual(latest.page, {
      total: 4,
      limit: 2,
      start: 2,
      end: 4,
      hasMoreBefore: true,
      nextBefore: '2',
    });

    const older = await getJson(srv.base, '/api/codex/sessions?limit=2&before=2');
    assert.equal(older.sessions.length, 2);
    assert.equal(older.page.hasMoreBefore, false);
    assert.equal(older.page.nextBefore, null);

    const invalid = await getJson(srv.base, '/api/codex/sessions?limit=abc', 400);
    assert.match(invalid.error, /^limit must be a non-negative integer$/);
  });

  it('applies the same contract to OpenClaw detail, messages, and list routes', async () => {
    const fullDetail = await getJson(srv.base, `/api/agents/${OPENCLAW_AGENT}/sessions/${OPENCLAW_SESSION}`);
    assert.equal(fullDetail.messages.length, 61);
    assert.equal(fullDetail.messagePage, undefined);

    const detail = await getJson(srv.base, `/api/agents/${OPENCLAW_AGENT}/sessions/${OPENCLAW_SESSION}?limit=2`);
    assert.deepEqual(messageTexts(detail.messages), [`${OPENCLAW_SESSION}-text-59`, `${OPENCLAW_SESSION}-text-60`]);
    assert.equal(detail.messagePage.total, 61);
    assert.equal(detail.stats.userCount, 61);

    const messages = await getJson(srv.base, `/api/agents/${OPENCLAW_AGENT}/sessions/${OPENCLAW_SESSION}/messages`);
    assert.equal(messages.messages.length, 60);
    assert.equal(messages.messagePage.nextBefore, '1');

    const fullList = await getJson(srv.base, `/api/agents/${OPENCLAW_AGENT}/sessions`);
    assert.ok(Array.isArray(fullList));
    assert.equal(fullList.length, 3);

    const pagedList = await getJson(srv.base, `/api/agents/${OPENCLAW_AGENT}/sessions?limit=2`);
    assert.equal(pagedList.sessions.length, 2);
    assert.equal(pagedList.page.total, 3);
    assert.equal(pagedList.page.nextBefore, '1');

    await getJson(srv.base, `/api/agents/${OPENCLAW_AGENT}/sessions/${OPENCLAW_SESSION}?limit=bad`, 400);
    await getJson(srv.base, `/api/agents/${OPENCLAW_AGENT}/sessions/${OPENCLAW_SESSION}/messages?before=bad`, 400);
  });

  it('keeps child-session full responses and paginates them consistently', async () => {
    const full = await getJson(srv.base, `/api/codex/sessions/${CODEX_PARENT}/children/${CODEX_CHILD}`);
    assert.equal(full.messages.length, 2);
    assert.equal(full.messagePage, undefined);

    const latest = await getJson(srv.base, `/api/codex/sessions/${CODEX_PARENT}/children/${CODEX_CHILD}?limit=1`);
    assert.equal(latest.messages.length, 1);
    assert.equal(latest.messages[0].role, 'assistant');
    assert.equal(latest.messagePage.total, 2);
    assert.equal(latest.messagePage.nextBefore, '1');
    assert.equal(latest.stats.userCount, 1);
    assert.equal(latest.stats.assistantCount, 1);

    const older = await getJson(
      srv.base,
      `/api/codex/sessions/${CODEX_PARENT}/children/${CODEX_CHILD}?limit=1&before=1`
    );
    assert.equal(older.messages.length, 1);
    assert.equal(older.messages[0].role, 'user');
    assert.equal(older.messagePage.hasMoreBefore, false);

    await getJson(srv.base, `/api/codex/sessions/${CODEX_PARENT}/children/${CODEX_CHILD}?limit=bad`, 400);
  });

  it('keeps context reconstruction, stats, and export on the complete transcript', async () => {
    await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}?limit=1`);
    const context = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_SESSION}/context?messageIndex=60`);
    assert.equal(context.messages.summary.total, 60);
    assert.equal(context.messages.summary.user, 60);
    assert.equal(context.messages.target.content[0].text, 'paged-message-60');

    const response = await fetch(`${srv.base}/api/claude-code/sessions/${CLAUDE_SESSION}/export?format=md`);
    assert.equal(response.status, 200);
    const exportBody = await response.text();
    assert.match(exportBody, /paged-message-00/);
    assert.match(exportBody, /paged-message-60/);
  });
});
