// Eval loop routes: annotations (with 👎 auto-collect into the regression
// set), LLM-as-judge against a mock OpenAI-compatible endpoint, and
// regression set CRUD. The claude CLI is disabled in every test via
// AGENTXRAY_CLAUDE_BIN so results don't depend on the host machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer, getJson, sendJson } = require('./helpers');

const NO_CLI = { AGENTXRAY_CLAUDE_BIN: '/nonexistent/claude-cli-disabled' };

// Minimal OpenAI-compatible /chat/completions mock (same shape as llm.test.js).
function startMockOpenAi(replyContent, extraMessageProps = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: replyContent, ...extraMessageProps } }] })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('annotation: upsert, auto-collect on 👎, keep curated cases on flip, clear', async () => {
  const { base, stop } = await startServer(NO_CLI);
  try {
    // 👍 lands in the store
    const up = await sendJson(base, 'PUT', '/api/evals/annotation', {
      platform: 'dsh',
      sessionId: 's1',
      thumb: 'up',
      note: '',
    });
    assert.equal(up.annotation.thumb, 'up');

    // 👎 with tags + note → auto-collected into the regression set
    await sendJson(base, 'PUT', '/api/evals/annotation', {
      platform: 'dsh',
      sessionId: 's1',
      thumb: 'down',
      note: '死循环了',
      tags: ['死循环', '绕路'],
    });
    let store = await getJson(base, '/api/evals');
    assert.equal(store.annotations['dsh/s1'].thumb, 'down');
    assert.equal(store.regression.length, 1);
    assert.equal(store.regression[0].source, 'thumb-down');
    assert.deepEqual(store.regression[0].tags, ['死循环', '绕路']);
    assert.equal(store.regression[0].note, '死循环了');

    // Same session again → upsert, no duplicate
    await sendJson(base, 'PUT', '/api/evals/annotation', {
      platform: 'dsh',
      sessionId: 's1',
      thumb: 'down',
      note: '',
      tags: ['幻觉'],
    });
    store = await getJson(base, '/api/evals');
    assert.equal(store.regression.length, 1);
    assert.deepEqual(store.regression[0].tags, ['幻觉']);

    // Flip to 👍: the curated case (has tags) survives
    await sendJson(base, 'PUT', '/api/evals/annotation', { platform: 'dsh', sessionId: 's1', thumb: 'up' });
    store = await getJson(base, '/api/evals');
    assert.equal(store.annotations['dsh/s1'].thumb, 'up');
    assert.equal(store.regression.length, 1);

    // Untouched 👎 → flip to 👍 → auto case removed
    await sendJson(base, 'PUT', '/api/evals/annotation', { platform: 'dsh', sessionId: 's2', thumb: 'down' });
    store = await getJson(base, '/api/evals');
    assert.equal(store.regression.length, 2);
    await sendJson(base, 'PUT', '/api/evals/annotation', { platform: 'dsh', sessionId: 's2', thumb: 'up' });
    store = await getJson(base, '/api/evals');
    assert.equal(store.regression.length, 1);

    // Clearing (thumb null + empty note) removes the annotation entirely
    await sendJson(base, 'PUT', '/api/evals/annotation', { platform: 'dsh', sessionId: 's2', thumb: null, note: '' });
    store = await getJson(base, '/api/evals');
    assert.equal(store.annotations['dsh/s2'], undefined);

    // Validation: missing session id, bad platform, empty body
    await sendJson(base, 'PUT', '/api/evals/annotation', { platform: 'dsh', thumb: 'up' }, 400);
    await sendJson(
      base,
      'PUT',
      '/api/evals/annotation',
      { platform: 'BAD PLATFORM', sessionId: 's1', thumb: 'up' },
      400
    );
    await sendJson(base, 'PUT', '/api/evals/annotation', { platform: 'dsh', sessionId: 's1' }, 400);
  } finally {
    await stop();
  }
});

test('judge: scores via the configured endpoint, persists, records model + hash', async () => {
  const reply = JSON.stringify({
    overall: 82,
    dimensions: { completion: 90, efficiency: 70, toolQuality: 85, errorResilience: 88 },
    summary: '整体顺畅，略有绕路',
    issues: ['第 2 轮重复读取同一文件'],
  });
  const mock = await startMockOpenAi(reply);
  const { base, stop } = await startServer(NO_CLI);
  try {
    await sendJson(base, 'PUT', '/api/settings/llm', {
      baseUrl: `${mock.base}/v1`,
      model: 'mock-model',
      apiKey: 'sk-mock',
    });

    const out = await sendJson(base, 'POST', '/api/evals/judge', {
      platform: 'dsh',
      sessionId: 's1',
      transcript: '## 轮次 1\n用户: fix the login bug\n助手: done',
    });
    assert.equal(out.judgement.overall, 82);
    assert.equal(out.judgement.dimensions.toolQuality, 85);
    assert.equal(out.judgement.model, 'mock-model');
    assert.equal(out.judgement.backend, 'openai');
    assert.ok(out.judgement.contentHash.length > 0);
    assert.ok(out.judgement.judgedAt);
    // Audit trail: the exact transcript is stored with the judgement
    assert.ok(out.judgement.transcript.includes('fix the login bug'));
    assert.equal(out.judgement.reasoning, null);

    // Persisted in the store
    const store = await getJson(base, '/api/evals');
    assert.equal(store.judgements['dsh/s1'].overall, 82);
    assert.equal(store.judgements['dsh/s1'].issues.length, 1);

    // The mock saw the transcript and the judge prompt (four dimensions)
    assert.equal(mock.requests.length, 1);
    const sent = mock.requests[0].body.messages[0].content;
    assert.ok(sent.includes('fix the login bug'));
    assert.ok(sent.includes('errorResilience'));

    // Out-of-range scores are clamped
    const hot = await startMockOpenAi(
      JSON.stringify({ overall: 150, dimensions: { completion: -20 }, summary: '', issues: [] })
    );
    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: `${hot.base}/v1`, model: 'mock-model' });
    const clamped = await sendJson(base, 'POST', '/api/evals/judge', {
      platform: 'dsh',
      sessionId: 's1',
      transcript: 'again',
    });
    assert.equal(clamped.judgement.overall, 100);
    assert.equal(clamped.judgement.dimensions.completion, 0);
    // Missing dimensions fall back to the overall score
    assert.equal(clamped.judgement.dimensions.efficiency, 100);
    await hot.close();
  } finally {
    await stop();
    await mock.close();
  }
});

test('judge: unparseable output returns raw text, records a failure entry, keeps prior score', async () => {
  const mock = await startMockOpenAi('我觉得这个会话表现不错，无需打分。');
  const { base, stop } = await startServer(NO_CLI);
  try {
    // A prior good judgement on the same session — a later parse failure must
    // not wipe it out.
    const good = await startMockOpenAi(
      JSON.stringify({ overall: 60, dimensions: { completion: 60 }, summary: '前一次', issues: [] })
    );
    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: `${good.base}/v1`, model: 'mock-model' });
    await sendJson(base, 'POST', '/api/evals/judge', { platform: 'dsh', sessionId: 's3', transcript: 'ok' });
    await good.close();

    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: `${mock.base}/v1`, model: 'mock-model' });
    const out = await sendJson(base, 'POST', '/api/evals/judge', {
      platform: 'dsh',
      sessionId: 's3',
      transcript: 'hello',
    });
    assert.equal(out.judgement, null);
    assert.ok(out.raw.includes('不错'));

    const store = await getJson(base, '/api/evals');
    // `judgements` keeps the last successful score…
    assert.equal(store.judgements['dsh/s3'].overall, 60);
    // …and the failed attempt lands in the history with the raw output.
    const history = store.history['dsh/s3'];
    assert.equal(history.length, 2);
    assert.equal(history[0].ok, false);
    assert.ok(history[0].raw.includes('不错'));
    assert.equal(history[0].model, 'mock-model');
    assert.equal(history[0].backend, 'openai');
    assert.ok(history[0].contentHash.length > 0);
    assert.ok(history[0].judgedAt);
    assert.equal(history[1].ok, true);
    assert.equal(history[1].overall, 60);
  } finally {
    await stop();
    await mock.close();
  }
});

test('judge history: every attempt kept newest-first, capped, audit bulk omitted', async () => {
  // Mock whose reply can be swapped between judge calls.
  let reply = '';
  const requests = [];
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
    });
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockBase = `http://127.0.0.1:${mockServer.address().port}`;
  const { base, stop } = await startServer(NO_CLI);
  try {
    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: `${mockBase}/v1`, model: 'mock-model' });

    reply = JSON.stringify({ overall: 82, dimensions: { completion: 90 }, summary: '第一次', issues: [] });
    await sendJson(base, 'POST', '/api/evals/judge', { platform: 'dsh', sessionId: 's-hist', transcript: '第一轮' });
    reply = JSON.stringify({ overall: 55, dimensions: { completion: 40 }, summary: '第二次', issues: ['绕路'] });
    await sendJson(base, 'POST', '/api/evals/judge', { platform: 'dsh', sessionId: 's-hist', transcript: '第二轮' });

    let store = await getJson(base, '/api/evals');
    // `judgements` keeps the latest; history keeps every attempt, newest first
    assert.equal(store.judgements['dsh/s-hist'].overall, 55);
    assert.equal(store.history['dsh/s-hist'].length, 2);
    assert.equal(store.history['dsh/s-hist'][0].overall, 55);
    assert.equal(store.history['dsh/s-hist'][0].ok, true);
    assert.equal(store.history['dsh/s-hist'][1].overall, 82);
    // Audit bulk (transcript/reasoning) stays only on the latest judgement
    assert.equal(store.history['dsh/s-hist'][0].transcript, undefined);
    assert.ok(store.judgements['dsh/s-hist'].transcript.includes('第二轮'));

    // Cap: 12 attempts → only the newest 10 are kept
    reply = JSON.stringify({ overall: 50, dimensions: {}, summary: '重复', issues: [] });
    for (let i = 0; i < 12; i++) {
      await sendJson(base, 'POST', '/api/evals/judge', {
        platform: 'dsh',
        sessionId: 's-hist',
        transcript: `第 ${i} 次重复评判`,
      });
    }
    store = await getJson(base, '/api/evals');
    assert.equal(store.history['dsh/s-hist'].length, 10);
    assert.equal(store.judgements['dsh/s-hist'].overall, 50);
  } finally {
    await stop();
    mockServer.close();
  }
});

test('judge: no backend configured → 503 with guidance; empty transcript → 400', async () => {
  const { base, stop } = await startServer(NO_CLI);
  try {
    const res = await fetch(`${base}/api/evals/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'dsh', sessionId: 's1', transcript: 'x' }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'NO_LLM_BACKEND');
    assert.ok(body.error.includes('设置'));

    await sendJson(base, 'POST', '/api/evals/judge', { platform: 'dsh', sessionId: 's1', transcript: '   ' }, 400);
  } finally {
    await stop();
  }
});

test('regression set: manual add, upsert, list, remove', async () => {
  const { base, stop } = await startServer(NO_CLI);
  try {
    const added = await sendJson(base, 'POST', '/api/evals/regression', {
      platform: 'codex',
      sessionId: 'sess-9',
      tags: ['误改文件'],
      note: '改错了文件',
      source: 'manual',
    });
    assert.equal(added.case.platform, 'codex');
    assert.equal(added.case.source, 'manual');
    assert.ok(added.case.id.startsWith('reg-'));

    // Same session again → upsert (no duplicate), tags replaced
    const again = await sendJson(base, 'POST', '/api/evals/regression', {
      platform: 'codex',
      sessionId: 'sess-9',
      tags: ['误改文件', '幻觉'],
    });
    assert.equal(again.case.id, added.case.id);
    let store = await getJson(base, '/api/evals');
    assert.equal(store.regression.length, 1);
    assert.equal(store.regression[0].tags.length, 2);

    const list = await getJson(base, '/api/evals/regression');
    assert.equal(list.cases.length, 1);

    const del = await sendJson(base, 'DELETE', `/api/evals/regression/${added.case.id}`);
    assert.equal(del.removed, true);
    const delAgain = await sendJson(base, 'DELETE', `/api/evals/regression/${added.case.id}`);
    assert.equal(delAgain.removed, false);
    store = await getJson(base, '/api/evals');
    assert.equal(store.regression.length, 0);
  } finally {
    await stop();
  }
});

test('judge: captures the model reasoning when the endpoint exposes it', async () => {
  const reply = JSON.stringify({
    overall: 70,
    dimensions: { completion: 80, efficiency: 60, toolQuality: 70, errorResilience: 70 },
    summary: '尚可',
    issues: [],
  });
  const mock = await startMockOpenAi(reply, { reasoning: '先看用户目标，再检查工具证据链…' });
  const { base, stop } = await startServer(NO_CLI);
  try {
    await sendJson(base, 'PUT', '/api/settings/llm', { baseUrl: `${mock.base}/v1`, model: 'mock-model' });
    const out = await sendJson(base, 'POST', '/api/evals/judge', {
      platform: 'dsh',
      sessionId: 's-reason',
      transcript: '## 轮次 1\n[用户] do things\n[工具] Bash git status\n[工具结果·成功] On branch main',
    });
    assert.equal(out.judgement.overall, 70);
    assert.ok(out.judgement.reasoning.includes('证据链'));
  } finally {
    await stop();
    await mock.close();
  }
});
