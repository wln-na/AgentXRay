// pet-aggregator tests. Aggregation logic is registry-driven, so we inject a
// fake `platforms` map (no real fs) and assert ranking / window filtering /
// top-1 selection. Time is pinned via deriveState's `now` injection.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { rankState, pickTopState, collectActiveSessions, aggregatePetState, DEFAULT_WINDOW_MS } =
  require('../lib/pet-aggregator');

const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const t = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

// Minimal normalized messages (mirrors what deriveState reads).
const userMsg = (at) => ({ role: 'user', timestamp: at, content: [{ type: 'text', text: 'go' }] });
const assistantMsg = (text, at) => ({ role: 'assistant', timestamp: at, content: [{ type: 'text', text }] });
const toolCallMsg = (name, id, at) => ({
  role: 'toolCall',
  timestamp: at,
  toolCallId: id,
  toolName: name,
  content: [],
});
const toolErrMsg = (id, at) => ({
  role: 'toolResult',
  timestamp: at,
  toolCallId: id,
  isError: true,
  content: [{ type: 'text', text: 'boom' }],
});

// Build a fake platform registry from a list of platform defs.
// def = { id, summaries:[{id,lastActivity,agent}], getSession:(sid)=>({messages}) }
function fakePlatforms(defs) {
  const reg = {};
  for (const d of defs) {
    reg[d.id] = {
      id: d.id,
      label: d.id,
      defaultDir: () => '/tmp/fake',
      needsAgent: false,
      list: async () => d.summaries,
      // Forward (dir, sid) faithfully so per-session getSession defs that
      // branch on `sid` actually receive the right id (the real aggregator
      // calls getSession(dir, sessionId, { agent })).
      getSession: (dir, sid) => d.getSession(dir, sid),
    };
  }
  return reg;
}

describe('rankState / pickTopState', () => {
  it('ranks per PRD §4.1: waiting_input > error > working > thinking > done > idle', () => {
    assert.equal(rankState('idle'), 0);
    assert.equal(rankState('done'), 1);
    assert.equal(rankState('thinking'), 2);
    assert.equal(rankState('working'), 3);
    assert.equal(rankState('error'), 4);
    assert.equal(rankState('waiting_input'), 5);
    assert.equal(rankState('unknown'), 0);
  });

  it('pickTopState returns the highest-ranked candidate', () => {
    const top = pickTopState([
      { state: 'idle', lastActivity: NOW },
      { state: 'working', lastActivity: NOW - 1000 },
      { state: 'thinking', lastActivity: NOW },
    ]);
    assert.equal(top.state, 'working');
  });

  it('tie on rank → most recently active wins', () => {
    const top = pickTopState([
      { state: 'working', lastActivity: NOW - 5000 },
      { state: 'working', lastActivity: NOW - 1000 },
    ]);
    assert.equal(top.lastActivity, NOW - 1000);
  });

  it('empty candidates → null', () => {
    assert.equal(pickTopState([]), null);
  });
});

describe('collectActiveSessions', () => {
  it('drops sessions whose lastActivity is outside the window', async () => {
    const platforms = fakePlatforms([
      {
        id: 'codex',
        summaries: [
          { id: 'fresh', lastActivity: t(10), agent: null },
          { id: 'stale', lastActivity: t(600), agent: null }, // 10 min ago > 3 min window
        ],
        getSession: async () => ({ messages: [] }),
      },
    ]);
    const active = await collectActiveSessions({ now: NOW, windowMs: DEFAULT_WINDOW_MS, platforms });
    assert.deepEqual(active.map((a) => a.sessionId).sort(), ['fresh']);
  });

  it('skips summaries with no parseable lastActivity', async () => {
    const platforms = fakePlatforms([
      {
        id: 'codex',
        summaries: [{ id: 'bad', lastActivity: 'not-a-date' }],
        getSession: async () => ({ messages: [] }),
      },
    ]);
    const active = await collectActiveSessions({ now: NOW, platforms });
    assert.equal(active.length, 0);
  });
});

describe('aggregatePetState', () => {
  it('returns idle with null platform when nothing is active', async () => {
    const platforms = fakePlatforms([{ id: 'codex', summaries: [], getSession: async () => ({ messages: [] }) }]);
    const r = await aggregatePetState({ now: NOW, windowMs: DEFAULT_WINDOW_MS, platforms });
    assert.equal(r.state, 'idle');
    assert.equal(r.platform, null);
    assert.equal(r.sessionId, null);
    assert.equal(r.bubble, '空闲');
  });

  it('picks waiting_input over working (higher priority), carries sessionId/platform', async () => {
    const platforms = fakePlatforms([
      {
        id: 'codex',
        summaries: [
          { id: 's-work', lastActivity: t(1), agent: null },
          { id: 's-wait', lastActivity: t(1), agent: null },
        ],
        getSession: async (_dir, sid) =>
          sid === 's-work'
            ? { messages: [userMsg(t(5)), toolCallMsg('shell', 'c1', t(4))] }
            : { messages: [userMsg(t(30)), assistantMsg('任务已完成', t(20))] },
      },
    ]);
    const r = await aggregatePetState({ now: NOW, windowMs: DEFAULT_WINDOW_MS, platforms });
    assert.equal(r.state, 'waiting_input');
    assert.equal(r.sessionId, 's-wait');
    assert.equal(r.platform, 'codex');
    assert.equal(r.bubble, '需要你的输入');
  });

  it('error outranks working; an assistant reply that clears error wins', async () => {
    const platforms = fakePlatforms([
      {
        id: 'codex',
        summaries: [
          { id: 's-err', lastActivity: t(1), agent: null },
          { id: 's-wait', lastActivity: t(1), agent: null },
        ],
        getSession: async (_dir, sid) =>
          sid === 's-err'
            ? { messages: [userMsg(t(10)), toolCallMsg('shell', 'c1', t(9)), toolErrMsg('c1', t(8))] }
            : { messages: [userMsg(t(30)), assistantMsg('done', t(20))] },
      },
    ]);
    const r = await aggregatePetState({ now: NOW, windowMs: DEFAULT_WINDOW_MS, platforms });
    // waiting_input (5) beats error (4)
    assert.equal(r.state, 'waiting_input');
    assert.equal(r.sessionId, 's-wait');
  });

  it('a session outside the window never contributes', async () => {
    const platforms = fakePlatforms([
      {
        id: 'codex',
        // stale summary only → would be working, but excluded by window
        summaries: [{ id: 's-work', lastActivity: t(600), agent: null }],
        getSession: async () => ({ messages: [userMsg(t(5)), toolCallMsg('shell', 'c1', t(4))] }),
      },
    ]);
    const r = await aggregatePetState({ now: NOW, windowMs: DEFAULT_WINDOW_MS, platforms });
    assert.equal(r.state, 'idle');
    assert.equal(r.platform, null);
  });
});
