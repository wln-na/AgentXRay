// pet-state reducer tests. The reducer is pure, so every branch in
// docs/pet-state-prd.md §4.2 gets a fixture here; `now` is injected so the
// time-cooling branches (done → waiting_input → idle) are deterministic.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { deriveState, DEFAULT_THRESHOLDS } = require('../lib/pet-state');

const NOW = Date.parse('2026-10-14T10:00:00.000Z');
// t helper: minutes/seconds before NOW, as ISO string
function t(secondsAgo) {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

// Minimal message factories — mirror makeMessage's 11 fields but only set the
// ones the reducer reads (role / timestamp / content / toolCallId / toolName /
// isError).
function userMsg(text, at) {
  return {
    id: 'u1',
    timestamp: at,
    role: 'user',
    content: [{ type: 'text', text }],
    usage: null,
    model: null,
    provider: null,
    toolCallId: null,
    toolName: null,
    details: null,
    isError: false,
  };
}
function assistantMsg(text, at) {
  return {
    id: 'a1',
    timestamp: at,
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    usage: null,
    model: null,
    provider: null,
    toolCallId: null,
    toolName: null,
    details: null,
    isError: false,
  };
}
function toolCallMsg(toolName, callId, at) {
  return {
    id: callId,
    timestamp: at,
    role: 'toolCall',
    content: [],
    usage: null,
    model: null,
    provider: null,
    toolCallId: callId,
    toolName,
    details: null,
    isError: false,
  };
}
function toolResultMsg(callId, { at, isError = false, text = 'ok' } = {}) {
  return {
    id: `${callId}-r`,
    timestamp: at,
    role: 'toolResult',
    content: [{ type: 'text', text }],
    usage: null,
    model: null,
    provider: null,
    toolCallId: callId,
    toolName: null,
    details: isError ? { status: 'error', exitCode: 1 } : { status: 'ok' },
    isError,
  };
}

describe('deriveState', () => {
  it('empty message list → idle, no throw', () => {
    const r = deriveState([], { now: NOW });
    assert.equal(r.state, 'idle');
    assert.equal(r.bubble, '空闲');
    assert.equal(r.lastEventAt, null);
    assert.deepEqual(r.pendingToolCalls, []);
  });

  it('ignores non-object entries without throwing', () => {
    const r = deriveState([null, 'junk', 42, userMsg('hi', t(1))], { now: NOW });
    assert.equal(r.state, 'thinking');
  });

  it('user message only → thinking', () => {
    const r = deriveState([userMsg('fix the bug', t(1))], { now: NOW });
    assert.equal(r.state, 'thinking');
    assert.equal(r.bubble, '思考中…');
  });

  it('user + fresh assistant text → done, bubble shows the reply', () => {
    const longReply = '我已经把 bug 修好了，改了三个文件的逻辑';
    const r = deriveState([userMsg('fix', t(10)), assistantMsg(longReply, t(2))], { now: NOW });
    assert.equal(r.state, 'done');
    assert.ok(r.bubble.includes('bug 修好了'));
  });

  it('user + assistant text older than waitingAfter → waiting_input', () => {
    // assistant finished 20s ago, nothing since → it's waiting on you
    const r = deriveState([userMsg('fix', t(30)), assistantMsg('done', t(20))], { now: NOW });
    assert.equal(r.state, 'waiting_input');
    assert.equal(r.bubble, '需要你的输入');
  });

  it('toolCall → working with the tool name in the bubble', () => {
    const r = deriveState([userMsg('run tests', t(5)), toolCallMsg('shell', 'call-1', t(4))], { now: NOW });
    assert.equal(r.state, 'working');
    assert.equal(r.bubble, '正在调用 shell');
    assert.equal(r.pendingToolCalls.length, 1);
    assert.equal(r.pendingToolCalls[0].toolName, 'shell');
  });

  it('toolCall + ok toolResult → thinking (turn handed back to model)', () => {
    const r = deriveState(
      [userMsg('run tests', t(5)), toolCallMsg('shell', 'call-1', t(4)), toolResultMsg('call-1', { at: t(3) })],
      { now: NOW }
    );
    assert.equal(r.state, 'thinking');
    assert.equal(r.pendingToolCalls.length, 0);
  });

  it('concurrent tool calls: second result missing → still working', () => {
    const r = deriveState(
      [
        userMsg('run', t(10)),
        toolCallMsg('read', 'c1', t(9)),
        toolCallMsg('write', 'c2', t(8)),
        toolResultMsg('c1', { at: t(7) }),
      ],
      { now: NOW }
    );
    assert.equal(r.state, 'working');
    assert.equal(r.pendingToolCalls.length, 1);
    assert.equal(r.pendingToolCalls[0].toolCallId, 'c2');
  });

  it('failed toolResult → error, until assistant prose clears the sticky', () => {
    const before = deriveState(
      [
        userMsg('run', t(10)),
        toolCallMsg('shell', 'c1', t(9)),
        toolResultMsg('c1', { at: t(8), isError: true, text: 'command not found' }),
      ],
      { now: NOW }
    );
    assert.equal(before.state, 'error');
    assert.ok(before.bubble.includes('command not found'));

    const after = deriveState(
      [
        userMsg('run', t(20)),
        toolCallMsg('shell', 'c1', t(19)),
        toolResultMsg('c1', { at: t(18), isError: true, text: 'boom' }),
        assistantMsg('我换了个命令重试', t(17)),
      ],
      { now: NOW }
    );
    assert.equal(after.state, 'waiting_input');
    assert.equal(after.errorSticky, false);
  });

  it('new user message clears a previous errorSticky', () => {
    const r = deriveState(
      [
        toolCallMsg('shell', 'c1', t(100)),
        toolResultMsg('c1', { at: t(99), isError: true }),
        userMsg('try again', t(2)),
      ],
      { now: NOW }
    );
    assert.equal(r.state, 'thinking');
    assert.equal(r.errorSticky, false);
  });

  it('no event for longer than idleAfter → idle even if instant state was done', () => {
    // Last assistant text 200s ago — way past waitingAfter, should cool to idle.
    const r = deriveState([userMsg('old task', t(300)), assistantMsg('done', t(200))], { now: NOW });
    assert.equal(r.state, 'idle');
    assert.equal(r.bubble, '空闲');
  });

  it('thresholds can be overridden (e.g. shorter waiting window)', () => {
    // assistant finished 20s ago; default waitingAfter=15 would make it
    // waiting_input, but with waitingAfter=30 it stays "done".
    const r = deriveState([userMsg('x', t(30)), assistantMsg('ok', t(20))], {
      now: NOW,
      thresholds: { waitingAfter: 30_000 },
    });
    assert.equal(r.state, 'done');
  });

  it('pure function: same input → same output twice', () => {
    const msgs = [userMsg('a', t(5)), toolCallMsg('shell', 'c1', t(4))];
    const r1 = deriveState(msgs, { now: NOW });
    const r2 = deriveState(msgs, { now: NOW });
    assert.deepEqual(r1, r2);
  });

  it('exposes default thresholds for callers that want to read them', () => {
    assert.ok(DEFAULT_THRESHOLDS.idleAfter > DEFAULT_THRESHOLDS.waitingAfter);
  });
});
