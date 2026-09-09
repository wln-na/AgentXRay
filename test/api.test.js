// Integration tests: each describe block gets a hermetic server whose HOME is
// a temp copy of test/fixtures/home. The read-only groups share one server;
// groups that mutate global stores (library installs, backup archive) start
// their own so runs stay order-independent and repeatable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer, getJson, sendJson } = require('./helpers.js');

const CODEX1 = '01900000-0000-7000-8000-000000000001';
const CODEX2 = '01900000-0000-7000-8000-000000000002';
const CODEX3 = '01900000-0000-7000-8000-000000000006';
const CODEX_CHILD = '01900000-0000-7000-8000-000000000003';
const CODEX_GRANDCHILD = '01900000-0000-7000-8000-000000000005';
const CODEX_ARCHIVED = '01900000-0000-7000-8000-000000000004';
const CLAUDE_A = 'aaaa1111-2222-4333-8444-555566667777';
const CLAUDE_B = 'bbbb1111-2222-4333-8444-555566667778';
const CLAUDE_C = 'cccc1111-2222-4333-8444-555566667779';
const CLAUDE_DESKTOP = 'local_dddd1111-2222-4333-8444-555566667777';
const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
const OMP2 = '019a0000-0000-7000-8000-00000000bbbb';

async function exists(p) {
  return fsp.access(p).then(
    () => true,
    () => false
  );
}

describe('AgentXRay API', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('GET /api/version returns a boot id', async () => {
    const body = await getJson(srv.base, '/api/version');
    assert.equal(typeof body.bootId, 'string');
    assert.ok(body.bootId.length > 0);
  });

  describe('sessions: codex', () => {
    it('lists sessions newest-first with metadata', async () => {
      const sessions = await getJson(srv.base, '/api/codex/sessions');
      assert.equal(sessions.length, 4);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [CODEX3, CODEX2, CODEX1, CODEX_ARCHIVED]
      );
      const s1 = sessions.find((s) => s.id === CODEX1);
      assert.equal(s1.timestamp, '2026-01-15T10:00:00.000Z');
      assert.equal(s1.cwd, '/fixtures/project-alpha');
      assert.equal(s1.userCount, 2);
      assert.equal(s1.assistantCount, 2);
      assert.equal(s1.toolCallCount, 1);
      assert.equal(s1.toolResultCount, 1);
      assert.ok(s1.firstUserMessage.startsWith('fixture: search-needle-alpha'));
      assert.deepEqual(s1.topTools, [{ name: 'shell', count: 1 }]);
      assert.equal(s1.childCount, 2);
      assert.equal(s1.lastActivity, '2026-01-15T10:00:14.000Z');
      assert.deepEqual(s1.tokenUsage, {
        input: 250,
        output: 45,
        cacheRead: 110,
        cacheWrite: 9,
        reasoning: 13,
        totalTokens: 427,
        contextWindow: 200000,
      });
      const archived = sessions.find((s) => s.id === CODEX_ARCHIVED);
      assert.equal(archived.archived, true);
      assert.ok(archived.filePath.includes('.codex/archived_sessions/'));
    });

    it('exposes Codex subagents without listing them as main sessions', async () => {
      const children = await getJson(srv.base, `/api/codex/sessions/${CODEX1}/children`);
      assert.equal(children.length, 2);
      const child = children.find((item) => item.name === CODEX_CHILD);
      assert.equal(child.agentType, 'explorer');
      assert.equal(child.description, 'Scout');
      assert.equal(child.messageCount, 2);
      const grandchild = children.find((item) => item.name === CODEX_GRANDCHILD);
      assert.equal(grandchild.parentThreadId, CODEX_CHILD);
      assert.equal(grandchild.agentType, 'reviewer');

      const detail = await getJson(srv.base, `/api/codex/sessions/${CODEX1}/children/${CODEX_CHILD}`);
      assert.equal(detail.session.id, CODEX_CHILD);
      assert.equal(detail.session.parentThreadId, CODEX1);
      assert.equal(detail.session.rootThreadId, CODEX1);
      assert.deepEqual(
        detail.messages.map((m) => m.role),
        ['user', 'assistant']
      );

      const grandchildDetail = await getJson(srv.base, `/api/codex/sessions/${CODEX1}/children/${CODEX_GRANDCHILD}`);
      assert.equal(grandchildDetail.session.id, CODEX_GRANDCHILD);
      assert.equal(grandchildDetail.session.parentThreadId, CODEX_CHILD);
      assert.equal(grandchildDetail.session.rootThreadId, CODEX1);
    });

    it('serves a session detail with normalized roles and the latest cumulative token snapshot', async () => {
      const { session, messages, tokenUsage } = await getJson(srv.base, `/api/codex/sessions/${CODEX1}`);
      assert.equal(session.id, CODEX1);
      assert.equal(session.cwd, '/fixtures/project-alpha');
      const roles = messages.map((m) => m.role);
      for (const role of ['user', 'assistant', 'toolCall', 'toolResult']) {
        assert.ok(roles.includes(role), `missing role ${role}`);
      }
      const assistants = messages.filter((m) => m.role === 'assistant');
      assert.deepEqual(
        assistants.map((m) => m.model),
        ['fixture-model-a', 'fixture-model-b']
      );
      assert.equal(session.model, 'fixture-model-b');
      assert.deepEqual(session.models, ['fixture-model-a', 'fixture-model-b']);
      assert.equal(session.provider, 'fixture-provider');
      const expectedTokenUsage = {
        input: 250,
        output: 45,
        cacheRead: 110,
        cacheWrite: 9,
        reasoning: 13,
        totalTokens: 427,
        contextWindow: 200000,
      };
      assert.deepEqual(session.tokenUsage, expectedTokenUsage);
      assert.deepEqual(tokenUsage, expectedTokenUsage);
      assert.ok(messages.every((message) => message.usage === null));
      const call = messages.find((m) => m.role === 'toolCall');
      assert.equal(call.toolName, 'shell');
      assert.equal(call.toolCallId, 'call-fx-1');
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'call-fx-1');
      assert.equal(result.isError, false);
      assert.deepEqual(result.details, { status: 'ok', exitCode: 0, durationMs: 400 });
    });

    it('reconstructs the recoverable Codex request and respects compaction boundaries', async () => {
      const detail = await getJson(srv.base, `/api/codex/sessions/${CODEX3}`);
      const targetIndex = detail.messages.findIndex(
        (message) => message.role === 'user' && JSON.stringify(message.content).includes('hello from project-beta')
      );
      const context = await getJson(srv.base, `/api/codex/sessions/${CODEX3}/context?messageIndex=${targetIndex}`);
      assert.equal(context.messages.included, true);
      assert.equal(context.messages.target.role, 'user');
      assert.equal(context.messages.compaction.applied, true);
      assert.equal(context.messages.compaction.source, 'compacted.payload.replacement_history');
      assert.deepEqual(
        context.messages.items.map((message) => message.role),
        ['user', 'assistant']
      );
      assert.ok(JSON.stringify(context.messages.items).includes('compressed earlier request'));
      assert.ok(!JSON.stringify(context.messages.items).includes('environment_context'));
      assert.ok(context.systemPrompt.content.includes('Always use TypeScript'));
      assert.ok(context.metadata.missingItems.includes('工具定义 (tool definitions)'));
    });

    it('rejects context reconstruction for platforms without the capability', async () => {
      const response = await getJson(srv.base, '/api/omp/sessions/not-used/context?messageIndex=0', 400);
      assert.match(response.error, /not yet supported for platform: omp/);
      assert.match(response.error, /Supported: codex, claude-code, claude-desktop/);
    });

    it('aggregates only the latest Codex token snapshot per file', async () => {
      const insights = await getJson(srv.base, '/api/insights?platform=codex');
      assert.deepEqual(insights.tokenUsage, {
        input: 250,
        output: 45,
        cacheRead: 110,
        cacheWrite: 9,
        reasoning: 13,
      });
    });
  });

  describe('sessions: claude-code', () => {
    it('lists sessions without leaking subagent transcripts', async () => {
      const sessions = await getJson(srv.base, '/api/claude-code/sessions');
      assert.equal(sessions.length, 3);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [CLAUDE_C, CLAUDE_B, CLAUDE_A]
      );
      const a = sessions.find((s) => s.id === CLAUDE_A);
      assert.equal(a.toolCallCount, 1);
      assert.equal(a.toolResultCount, 1);
      assert.equal(a.cwd, '/fixtures/project-beta');
      assert.equal(a.model, 'claude-fixture-1');
      assert.ok(a.firstUserMessage.startsWith('fixture: claude-prompt-one'));
    });

    it('serves a session detail with tool_use/tool_result normalized', async () => {
      const detail = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}`);
      const { session, messages, tokenUsage, contextUsage } = detail;
      assert.equal(session.id, CLAUDE_A);
      const roles = messages.map((m) => m.role);
      for (const role of ['user', 'assistant', 'toolResult']) {
        assert.ok(roles.includes(role), `missing role ${role}`);
      }
      const firstUser = messages.find((m) => m.id === 'ua-1');
      assert.ok(firstUser.content.some((c) => c.text?.includes('<skill-context>')));
      assert.ok(firstUser.content.some((c) => c.text?.includes('fixture-skill-a')));
      assert.ok(!firstUser.content.some((c) => c.text?.includes('must-not-attach')));
      const assistant = messages.find((m) => m.role === 'assistant');
      const toolCall = assistant.content.find((c) => c.type === 'toolCall');
      assert.equal(toolCall.name, 'Task');
      assert.equal(toolCall.id, 'toolu-fx-1');
      assert.equal(assistant.usage.input, 10);
      assert.equal(assistant.usage.output, 20);
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'toolu-fx-1');
      assert.equal(result.content[0].text, 'hello');
      assert.deepEqual(tokenUsage, {
        input: 12,
        output: 26,
        cacheRead: 200,
        cacheWrite: 300,
        totalTokens: 538,
      });
      assert.equal(contextUsage.used, 512);
      assert.equal(contextUsage.limit, 1000);
      assert.equal(contextUsage.percent, 51.2);
      assert.equal(contextUsage.breakdownStatus, 'unavailable');
      assert.equal(session.contextUsage.used, 512);
    });

    it('deduplicates streamed Claude usage snapshots in insights', async () => {
      const insights = await getJson(srv.base, '/api/insights?platform=claude-code');
      assert.equal(insights.tokenUsage.input, 277);
      assert.equal(insights.tokenUsage.output, 114);
      assert.equal(insights.tokenUsage.cacheRead, 230);
      assert.equal(insights.tokenUsage.cacheWrite, 340);
    });

    it('exposes subagents via the children endpoints', async () => {
      const children = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children`);
      assert.equal(children.length, 1);
      const child = children[0];
      assert.equal(child.name, 'agent-fx001');
      assert.equal(child.agentType, 'general-purpose');
      assert.equal(child.description, 'Scout the fixture');
      assert.equal(child.messageCount, 2);

      const detail = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children/agent-fx001`);
      assert.deepEqual(
        detail.messages.map((m) => m.role),
        ['user', 'assistant']
      );
      assert.equal(detail.messages[1].content[0].text, 'hello');
    });

    it('a Task-free session has no children', async () => {
      const children = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_B}/children`);
      assert.deepEqual(children, []);
    });
  });

  describe('sessions: claude-desktop', () => {
    it('lists only metadata-linked Desktop Agent/Cowork sessions', async () => {
      const sessions = await getJson(srv.base, '/api/claude-desktop/sessions');
      assert.equal(sessions.length, 1);
      const session = sessions[0];
      assert.equal(session.id, CLAUDE_DESKTOP);
      assert.equal(session.cliSessionId, 'eeee1111-2222-4333-8444-555566667777');
      assert.equal(session.title, 'Desktop fixture session');
      assert.equal(session.cwd, '/fixtures/desktop-project');
      assert.equal(session.model, 'desktop-log-model');
      assert.equal(session.toolCallCount, 1);
      assert.equal(session.toolResultCount, 1);
      assert.ok(!JSON.stringify(sessions).includes('must-not-list-title-generator'));
    });

    it('serves Desktop detail with native model, token usage and source paths', async () => {
      const detail = await getJson(srv.base, `/api/claude-desktop/sessions/${CLAUDE_DESKTOP}`);
      assert.equal(detail.session.id, CLAUDE_DESKTOP);
      assert.equal(detail.session.model, 'desktop-log-model');
      assert.deepEqual(detail.session.models, ['desktop-log-model']);
      assert.equal(detail.session.dataSource, 'local-agent-mode-sessions');
      assert.ok(detail.session.sourcePath.endsWith('eeee1111-2222-4333-8444-555566667777.jsonl'));
      assert.ok(detail.session.metadataPath.endsWith('local_dddd1111-2222-4333-8444-555566667777.json'));
      assert.deepEqual(detail.tokenUsage, {
        input: 18,
        output: 12,
        cacheRead: 30,
        cacheWrite: 7,
        totalTokens: 67,
      });
      assert.equal(detail.contextUsage.used, 55);
      assert.equal(detail.contextUsage.limit, 500);
      assert.equal(detail.contextUsage.percent, 11);
      assert.ok(detail.messages.some((message) => message.content?.some((part) => part.type === 'toolCall')));
      assert.ok(
        detail.messages.some((message) => message.role === 'toolResult' && message.toolCallId === 'toolu-desktop-1')
      );
    });

    it('supports full-text search and context reconstruction for Desktop sessions', async () => {
      const search = await getJson(srv.base, '/api/search?platform=claude-desktop&q=desktop-search-needle');
      assert.equal(search.length, 1);
      assert.equal(search[0].sessionId, CLAUDE_DESKTOP);

      const detail = await getJson(srv.base, `/api/claude-desktop/sessions/${CLAUDE_DESKTOP}`);
      const targetIndex = detail.messages.findIndex((message) => message.role === 'user');
      const context = await getJson(
        srv.base,
        `/api/claude-desktop/sessions/${CLAUDE_DESKTOP}/context?messageIndex=${targetIndex}`
      );
      assert.equal(context.platform, 'claude-desktop');
      assert.equal(context.messages.included, true);
      assert.equal(context.messages.target.role, 'user');
    });
  });

  describe('sessions: openclaw', () => {
    it('attaches trajectory prompt context by transcript leaf without listing trajectory as a session', async () => {
      const agents = await getJson(srv.base, '/api/agents');
      assert.ok(agents.includes('fixture-agent'));
      const sessions = await getJson(srv.base, '/api/agents/fixture-agent/sessions');
      assert.deepEqual(
        sessions.map((session) => session.id),
        ['openclaw-context-fixture']
      );

      const { messages } = await getJson(srv.base, '/api/agents/fixture-agent/sessions/openclaw-context-fixture');
      const firstUser = messages.find((message) => message.id === 'openclaw-user-1');
      assert.ok(firstUser.content.some((part) => part.text?.includes('Conversation info (untrusted metadata)')));
      assert.equal(
        firstUser.content.filter((part) => part.text?.includes('fixture: openclaw actual question')).length,
        1
      );
      const secondUser = messages.find((message) => message.id === 'openclaw-user-2');
      assert.equal(secondUser.content.length, 1);
      assert.ok(!JSON.stringify(messages).includes('must not attach'));
    });
  });

  describe('sessions: omp', () => {
    it('lists sessions with title, cost-bearing usage and tool counts', async () => {
      const sessions = await getJson(srv.base, '/api/omp/sessions');
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [OMP2, OMP1]
      );
      const s1 = sessions[1];
      assert.equal(s1.title, 'Fixture OMP Session');
      assert.equal(s1.toolCallCount, 1);
      assert.equal(s1.toolResultCount, 1);
      assert.ok(s1.firstUserMessage.startsWith('fixture: omp-prompt-alpha'));
    });

    it('serves a detail with the toolCall→toolResult error pair and usage.cost', async () => {
      const { session, messages } = await getJson(srv.base, `/api/omp/sessions/${OMP1}`);
      assert.equal(session.id, OMP1);
      assert.equal(session.model, 'fixture/model-x');
      const call = messages.find((m) => m.role === 'toolCall');
      assert.equal(call.toolName, 'bash');
      assert.equal(call.toolCallId, 'tc-fx-1');
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'tc-fx-1');
      assert.equal(result.isError, true);
      const assistant = messages.find((m) => m.role === 'assistant');
      assert.equal(assistant.usage.cost.total, 0.003);
      assert.equal(assistant.usage.input, 100);
    });

    it('exposes spawned children next to the session file', async () => {
      const children = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children`);
      assert.equal(children.length, 1);
      assert.equal(children[0].name, 'Scout');
      assert.equal(children[0].file, 'Scout.jsonl');
      assert.equal(children[0].messageCount, 2);

      const detail = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children/Scout`);
      assert.equal(detail.messages.filter((m) => m.role === 'user').length, 1);
      assert.ok(detail.messages.some((m) => m.role === 'assistant'));
    });

    it('a child-free session reports no children', async () => {
      const children = await getJson(srv.base, `/api/omp/sessions/${OMP2}/children`);
      assert.deepEqual(children, []);
    });
  });

  describe('search', () => {
    it('finds a keyword in one platform', async () => {
      const results = await getJson(srv.base, '/api/search?q=search-needle-alpha&platform=codex');
      assert.equal(results.length, 1);
      assert.equal(results[0].sessionId, CODEX1);
      assert.equal(results[0].platform, 'codex');
      assert.ok(results[0].matches.length >= 1);
      assert.equal(results[0].matches[0].role, 'user');
      assert.ok(results[0].matches[0].snippet.includes('search-needle-alpha'));
    });

    it('maps Codex child-thread matches to the parent session', async () => {
      const results = await getJson(srv.base, '/api/search?q=child%20branch&platform=codex');
      assert.equal(results.length, 1);
      assert.equal(results[0].sessionId, CODEX1);
      assert.equal(results[0].childSessionId, CODEX_CHILD);
      assert.match(results[0].matches[0].snippet, /child branch/i);
    });

    it('multi-keyword search is an AND across the session', async () => {
      const hit = await getJson(srv.base, '/api/search?q=search-needle-alpha+zebra-token&platform=codex');
      assert.equal(hit.length, 1);
      assert.equal(hit[0].sessionId, CODEX1);
      const miss = await getJson(srv.base, '/api/search?q=search-needle-alpha+no-such-token-anywhere&platform=codex');
      assert.deepEqual(miss, []);
    });

    it('platform=all merges hits across platforms', async () => {
      const results = await getJson(srv.base, '/api/search?q=fixture&platform=all&limit=100');
      const platforms = new Set(results.map((r) => r.platform));
      for (const p of ['codex', 'claude-code', 'omp', 'dsh', 'gemini']) {
        assert.ok(platforms.has(p), `missing platform ${p}`);
      }
    });

    it('falls back to claude prompt history for retired sessions', async () => {
      const results = await getJson(srv.base, '/api/search?q=history-needle-gamma&platform=claude-code');
      assert.equal(results.length, 1);
      const hit = results[0];
      assert.equal(hit.history, true);
      assert.equal(hit.sessionId, null);
      assert.equal(hit.file, 'history.jsonl');
      assert.equal(hit.project, '/fixtures/project-beta');
      assert.ok(hit.matches[0].snippet.includes('history-needle-gamma'));
    });

    it('rejects path traversal via the agent query parameter', async () => {
      // Plant a session file OUTSIDE the openclaw data dir, reachable only by
      // escaping it: <home>/.openclaw/agents/../../escape/sessions/evil.jsonl.
      const evilDir = path.join(srv.home, 'escape', 'sessions');
      await fsp.mkdir(evilDir, { recursive: true });
      await fsp.writeFile(
        path.join(evilDir, 'evil.jsonl'),
        `${JSON.stringify({
          type: 'message',
          timestamp: '2026-01-20T08:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'escape-needle-secret' }] },
        })}\n`
      );

      // Search must not follow ../ out of the agents dir
      const results = await getJson(
        srv.base,
        '/api/search?q=escape-needle-secret&platform=openclaw&agent=..%2F..%2Fescape'
      );
      assert.deepEqual(results, []);

      // Insights must not aggregate the escaped file either
      const insights = await getJson(srv.base, '/api/insights?platform=openclaw&agent=..%2F..%2Fescape', 400);
      assert.equal(insights.error, 'Invalid agent name');
    });
  });

  describe('prompts + hidden prompts', () => {
    it('hiding one text collapses every identical occurrence, and unhiding restores it', async () => {
      const beforeData = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(beforeData.totalPrompts, 5);
      assert.equal(beforeData.totalSessions, 4);
      assert.equal(beforeData.groups[0].directory, '/fixtures/project-alpha');

      // The duplicate text lives in both codex sessions: one hide removes both
      const hideRes = await sendJson(srv.base, 'POST', '/api/prompts/hidden', {
        text: 'fixture: duplicate-prompt-omega',
      });
      assert.equal(hideRes.added, 1);
      assert.match(hideRes.hash, /^[0-9a-f]{16}$/);

      const hiddenList = await getJson(srv.base, '/api/prompts/hidden');
      assert.ok(hiddenList.hidden.some((h) => h.hash === hideRes.hash && h.preview.includes('duplicate-prompt-omega')));

      const afterHide = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(afterHide.totalPrompts, beforeData.totalPrompts - 2);
      assert.equal(afterHide.totalSessions, 3); // duplicate-only main session drops; archived + new beta remain

      // Store lives under the temp HOME, never the real ~/.agentxray
      assert.ok(await exists(path.join(srv.home, '.agentxray', 'hidden-prompts.json')));

      await sendJson(srv.base, 'DELETE', `/api/prompts/hidden/${hideRes.hash}`, undefined);
      const restored = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(restored.totalPrompts, beforeData.totalPrompts);
    });
  });

  describe('tools audit', () => {
    it('aggregates tool rows across platforms and flags unused MCP servers', async () => {
      const audit = await getJson(srv.base, '/api/tools/audit?platform=all');
      const byName = new Map(audit.tools.map((t) => [t.name, t]));

      const shell = byName.get('shell');
      assert.deepEqual(shell.platforms, ['codex']);
      assert.equal(shell.calls, 1);
      assert.equal(shell.errors, 0);
      assert.equal(shell.avgMs, 400);

      const task = byName.get('Task');
      assert.deepEqual(task.platforms, ['claude-code']);
      assert.equal(task.calls, 1);

      const bash = byName.get('bash');
      assert.deepEqual(bash.platforms, ['omp']);
      assert.equal(bash.errors, 1);
      assert.equal(bash.errorRate, 1);
      assert.equal(bash.avgMs, 2000);

      // From the fixture ~/.claude.json mcpServers entry that no tool ever used
      assert.deepEqual(audit.configuredUnused, [{ name: 'fixture-unused-server', source: 'claude-mcp' }]);
    });
  });

  describe('otlp export', () => {
    it('serializes an omp session as one trace with parented spans', async () => {
      const payload = await getJson(srv.base, `/api/otlp/omp/${OMP1}`);
      const resource = payload.resourceSpans[0];
      const attrs = Object.fromEntries(resource.resource.attributes.map((a) => [a.key, a.value.stringValue]));
      assert.equal(attrs['service.name'], 'agentxray');
      assert.equal(attrs['gen_ai.conversation.id'], OMP1);

      const spans = resource.scopeSpans[0].spans;
      assert.ok(spans.every((s) => s.kind === 1));
      assert.ok(spans.every((s) => s.traceId === spans[0].traceId));

      const roots = spans.filter((s) => s.name === 'invoke_agent');
      assert.equal(roots.length, 1);
      assert.equal(roots[0].parentSpanId, undefined);

      const chats = spans.filter((s) => s.name.startsWith('chat '));
      assert.equal(chats.length, 2);
      for (const c of chats) assert.equal(c.parentSpanId, roots[0].spanId);
      const chatAttrs = Object.fromEntries(
        chats[0].attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue])
      );
      assert.equal(chatAttrs['gen_ai.request.model'], 'fixture/model-x');
      assert.equal(chatAttrs['gen_ai.usage.input_tokens'], '100');

      const tools = spans.filter((s) => s.name.startsWith('execute_tool '));
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'execute_tool bash');
      assert.equal(tools[0].parentSpanId, roots[0].spanId);
      assert.deepEqual(tools[0].status, { code: 2 }); // the fixture tool pair errored
      assert.ok(BigInt(tools[0].endTimeUnixNano) > BigInt(tools[0].startTimeUnixNano));
    });
  });
});

describe('library', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('supports CRUD, install into platform command dirs, and usage stats', async () => {
    const empty = await getJson(srv.base, '/api/library');
    assert.deepEqual(empty.prompts, []);

    const created = await sendJson(
      srv.base,
      'POST',
      '/api/library',
      {
        name: 'fixture-prompt',
        description: 'Fixture prompt for tests',
        tags: ['fixture', 'test'],
        content: 'Run the fixture checks and report.',
      },
      201
    );
    assert.equal(created.prompt.name, 'fixture-prompt');
    assert.deepEqual(created.prompt.tags, ['fixture', 'test']);
    assert.deepEqual(created.prompt.installed, { claude: false, codex: false, omp: false });

    // Duplicate create is rejected
    await sendJson(
      srv.base,
      'POST',
      '/api/library',
      {
        name: 'fixture-prompt',
        content: 'x',
      },
      409
    );

    const listed = await getJson(srv.base, '/api/library');
    assert.equal(listed.prompts.length, 1);

    const updated = await sendJson(srv.base, 'PUT', '/api/library/fixture-prompt', {
      description: 'Updated fixture description',
    });
    assert.equal(updated.prompt.description, 'Updated fixture description');
    assert.equal(updated.prompt.content.trim(), 'Run the fixture checks and report.');

    // Install lands real files inside the temp HOME copy — never the real ~
    const installed = await sendJson(srv.base, 'POST', '/api/library/fixture-prompt/install', {
      targets: ['claude', 'codex'],
    });
    assert.deepEqual(installed.installed, { claude: true, codex: true, omp: false });
    const claudeCmd = path.join(srv.home, '.claude', 'commands', 'fixture-prompt.md');
    const codexCmd = path.join(srv.home, '.codex', 'prompts', 'fixture-prompt.md');
    assert.ok(await exists(claudeCmd));
    assert.ok(await exists(codexCmd));
    const installedBody = await fsp.readFile(claudeCmd, 'utf8');
    assert.ok(installedBody.includes('Run the fixture checks and report.'));

    // Usage: one slash invocation in the omp fixture session + one in claude history
    const usage = await getJson(srv.base, '/api/library/usage');
    const u = usage.usage['fixture-prompt'];
    assert.equal(u.uses, 2);
    assert.equal(u.avgMessages, 1);
    assert.equal(u.errorRate, 0);
    assert.equal(u.lastUsed, '2026-01-21T09:00:02.000Z');

    // Delete removes the entry and its installed copies
    const deleted = await sendJson(srv.base, 'DELETE', '/api/library/fixture-prompt', undefined);
    assert.equal(deleted.ok, true);
    assert.equal(await exists(claudeCmd), false);
    assert.equal(await exists(codexCmd), false);
    const finalList = await getJson(srv.base, '/api/library');
    assert.deepEqual(finalList.prompts, []);
  });
});

describe('backup', () => {
  let srv;
  before(async () => {
    srv = await startServer();
    // Clear any archive created by the 10s auto-backup timer so the test
    // starts from a clean slate regardless of test ordering.
    await fsp.rm(path.join(srv.home, '.agentxray', 'archive'), { recursive: true, force: true });
    const doubaoSystemDir = path.join(
      srv.home,
      '.doubao',
      'agent_mode',
      'workspace',
      '.sessions',
      'doubao-session-fixture',
      'agents',
      'doubao-agent-fixture',
      'system'
    );
    await fsp.mkdir(doubaoSystemDir, { recursive: true });
    await fsp.writeFile(path.join(doubaoSystemDir, 'trajectory.jsonl'), '{}\n');
  });
  after(async () => {
    await srv.stop();
  });

  it('copies every session log once, then skips everything on the second run', async () => {
    const first = await sendJson(srv.base, 'POST', '/api/backup', undefined);
    // codex 6 + claude-code 4 + omp 3 + dsh 2 + gemini 3 + openclaw 2 + claude-desktop 2 + doubao 1.
    assert.equal(first.copied, 23);
    assert.equal(first.skipped, 0);
    assert.equal(first.total, 23);
    assert.deepEqual(first.byPlatform.openclaw, {
      copied: 2,
      skipped: 0,
      failed: 0,
      warnings: [],
      skippedFiles: [],
    });
    assert.deepEqual(first.byPlatform.codex, { copied: 6, skipped: 0, failed: 0, warnings: [], skippedFiles: [] });
    assert.deepEqual(first.byPlatform['claude-code'], {
      copied: 4,
      skipped: 0,
      failed: 0,
      warnings: [],
      skippedFiles: [],
    });
    assert.deepEqual(first.byPlatform['claude-desktop'], {
      copied: 2,
      skipped: 0,
      failed: 0,
      warnings: [],
      skippedFiles: [],
    });
    assert.deepEqual(first.byPlatform.hermes, {
      copied: 0,
      skipped: 0,
      failed: 0,
      warnings: ['hermes: SQLite database excluded from file-level backup'],
      skippedFiles: [],
    });
    assert.deepEqual(first.byPlatform.doubao, {
      copied: 1,
      skipped: 0,
      failed: 0,
      warnings: [],
      skippedFiles: [],
    });
    assert.deepEqual(first.byPlatform.omp, { copied: 3, skipped: 0, failed: 0, warnings: [], skippedFiles: [] });
    assert.deepEqual(first.byPlatform.dsh, { copied: 2, skipped: 0, failed: 0, warnings: [], skippedFiles: [] });
    assert.deepEqual(first.byPlatform.gemini, { copied: 3, skipped: 0, failed: 0, warnings: [], skippedFiles: [] });
    // Archive stays inside the temp HOME
    assert.equal(first.archiveDir, path.join(srv.home, '.agentxray', 'archive'));
    assert.ok(await exists(path.join(first.archiveDir, 'claude-code', 'history.jsonl')));
    assert.ok(
      await exists(
        path.join(first.archiveDir, 'openclaw', 'fixture-agent', 'sessions', 'openclaw-context-fixture.jsonl')
      )
    );
    assert.ok(
      await exists(
        path.join(
          first.archiveDir,
          'claude-desktop',
          'account-fixture',
          '00000000',
          'local_dddd1111-2222-4333-8444-555566667777.json'
        )
      )
    );
    assert.ok(
      await exists(
        path.join(
          first.archiveDir,
          'claude-desktop',
          'account-fixture',
          '00000000',
          'abcd1234',
          '.claude',
          'projects',
          'session',
          'eeee1111-2222-4333-8444-555566667777.jsonl'
        )
      )
    );

    assert.ok(
      await exists(
        path.join(first.archiveDir, 'doubao', 'doubao-session-fixture', 'doubao-agent-fixture', 'trajectory.jsonl')
      )
    );

    const second = await sendJson(srv.base, 'POST', '/api/backup', undefined);
    assert.equal(second.copied, 0);
    assert.equal(second.skipped, 23);
    assert.equal(second.total, 23);

    const status = await getJson(srv.base, '/api/backup/status');
    assert.equal(status.archiveDir, first.archiveDir);
    assert.equal(status.files, 23);
    assert.ok(status.bytes > 0);
    assert.ok(typeof status.lastBackup === 'string');
  });
});
