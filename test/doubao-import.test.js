const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const IMPORTER = path.join(ROOT, 'scripts', 'doubao_indexeddb_import.py');
const RECORDS = path.join(__dirname, 'fixtures', 'doubao-indexeddb-records.jsonl');

test('Doubao importer builds a privacy-minimized cache with project, session, messages and model', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentxray-doubao-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const output = path.join(tempDir, 'doubao.sqlite');
  const result = spawnSync(
    process.env.PYTHON || 'python3',
    [IMPORTER, '--source', tempDir, '--records', RECORDS, '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const db = new Database(output, { readonly: true });
  t.after(() => db.close());
  const project = db.prepare('SELECT id, name, root_path FROM projects').get();
  const session = db.prepare('SELECT id, project_id, title, model FROM sessions').get();
  const messages = db.prepare('SELECT role, model, content_json FROM messages ORDER BY timestamp').all();
  const metadata = Object.fromEntries(
    db
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((row) => [row.key, row.value])
  );

  assert.deepEqual(project, {
    id: 'fixture-project',
    name: 'Fixture Project',
    root_path: '/Users/example/Projects/fixture-project',
  });
  assert.deepEqual(session, {
    id: 'fixture-conversation',
    project_id: 'fixture-project',
    title: 'Fixture Session',
    model: 'Fixture Model',
  });
  assert.deepEqual(
    messages.map((message) => [message.role, message.model]),
    [
      ['user', 'Fixture Model'],
      ['assistant', 'Fixture Model'],
    ]
  );
  assert.match(messages[0].content_json, /fixture question/);
  const userContent = JSON.parse(messages[0].content_json);
  const userText = userContent.map((part) => part.text || '').join('\n');
  assert.match(userText, /<agents_md path="\/Users\/example\/Projects\/fixture-project\/AGENTS\.md">/);
  assert.match(userText, /Run tests before delivery\./);
  assert.match(userText, /<in-app-browser-context>/);
  assert.match(userText, /https:\/\/example\.test\/fixture/);
  assert.match(userText, /https:\/\/example\.test\/message/);
  assert.doesNotMatch(userText, /access_token|fixture-secret|#private/);
  assert.match(userText, /<current-state>/);
  assert.match(userText, /Project: Fixture Project/);
  assert.match(messages[1].content_json, /fixture_tool/);
  const assistantContent = JSON.parse(messages[1].content_json);
  const fileOperation = assistantContent.find((part) => part.id === 'fixture-file-tool');
  assert.deepEqual(fileOperation, {
    type: 'toolCall',
    id: 'fixture-file-tool',
    name: 'file_operation',
    arguments: null,
    status: null,
    summary: '已读取 fixture.txt',
    path: '/Users/example/Projects/fixture-project/fixture.txt',
    fileName: 'fixture.txt',
    fileType: 'text',
    content: 'Read fixture.txt:\nfixture file content',
  });
  const bashOperation = assistantContent.find((part) => part.id === 'fixture-bash-tool');
  assert.equal(bashOperation.name, 'Bash');
  assert.equal(bashOperation.summary, '已运行 npm test');
  assert.match(bashOperation.content, /tests passed/);
  assert.equal(metadata.schema_version, '3');
  assert.equal(metadata.session_count, '1');
  assert.equal(metadata.message_count, '2');
  assert.equal(metadata.model_count, '1');

  const adapterProbe = spawnSync(
    process.execPath,
    [
      '-e',
      `process.env.DOUBAO_CACHE_PATH=${JSON.stringify(output)};
       const store=require(${JSON.stringify(path.join(ROOT, 'lib', 'platforms', 'doubao-store.js'))});
       Promise.all([store.listCachedSessions(${JSON.stringify(output)}), store.getCachedSession(${JSON.stringify(output)}, 'fixture-conversation')])
         .then(([sessions, detail])=>process.stdout.write(JSON.stringify({session:sessions[0], detail:detail.session, messages:detail.messages})))
         .catch((error)=>{console.error(error);process.exit(1);});`,
    ],
    { encoding: 'utf8' }
  );
  assert.equal(adapterProbe.status, 0, adapterProbe.stderr || adapterProbe.stdout);
  const adapter = JSON.parse(adapterProbe.stdout);
  assert.equal(adapter.session.projectName, 'Fixture Project');
  assert.equal(adapter.session.projectPath, '/Users/example/Projects/fixture-project');
  assert.equal(adapter.session.cwd, '/Users/example/Projects/fixture-project');
  assert.equal(adapter.detail.projectPath, '/Users/example/Projects/fixture-project');
  const apiUserText = adapter.messages
    .find((message) => message.role === 'user')
    .content.map((part) => part.text || '')
    .join('\n');
  assert.match(apiUserText, /fixture question/);
  assert.match(apiUserText, /<agents_md/);
  assert.match(apiUserText, /<in-app-browser-context>/);
  assert.match(apiUserText, /https:\/\/example\.test\/message/);
  const apiFileOperation = adapter.messages
    .flatMap((message) => message.content || [])
    .find((part) => part.id === 'fixture-file-tool');
  assert.equal(apiFileOperation.summary, '已读取 fixture.txt');
  assert.equal(apiFileOperation.path, '/Users/example/Projects/fixture-project/fixture.txt');
  assert.match(apiFileOperation.content, /fixture file content/);
  assert.equal(apiFileOperation.estimatedDurationMs, 1000);
  assert.equal(apiFileOperation.durationSource, 'estimated');
  const apiBashOperation = adapter.messages
    .flatMap((message) => message.content || [])
    .find((part) => part.id === 'fixture-bash-tool');
  assert.equal(apiBashOperation.estimatedDurationMs, 3000);
  assert.equal(apiBashOperation.durationSource, 'estimated');

  const cacheBytes = fs.readFileSync(output, 'utf8');
  for (const forbidden of [
    'inner_user_ip',
    'local_device_id',
    'trace_id',
    'cookie',
    'authorization',
    'fixture-local-user',
    'fixture-secret',
  ]) {
    assert.equal(cacheBytes.includes(forbidden), false, `cache leaked ${forbidden}`);
  }
});

test('Doubao importer upgrades equal-sequence cached tool summaries with current details', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentxray-doubao-tool-upgrade-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const output = path.join(tempDir, 'doubao.sqlite');
  const initial = spawnSync(
    process.env.PYTHON || 'python3',
    [IMPORTER, '--source', tempDir, '--records', RECORDS, '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);

  const db = new Database(output);
  const assistant = db.prepare("SELECT id, content_json FROM messages WHERE role='assistant'").get();
  const legacyContent = JSON.parse(assistant.content_json).map((part) =>
    part.type === 'toolCall'
      ? { type: part.type, id: part.id, name: part.name, arguments: null, status: part.status, summary: part.summary }
      : part
  );
  legacyContent.push({
    type: 'toolCall',
    id: 'historical-tool-pruned-from-current-snapshot',
    name: 'file_operation',
    arguments: null,
    status: null,
    summary: '历史工具摘要',
  });
  db.prepare('UPDATE messages SET content_json=? WHERE id=?').run(JSON.stringify(legacyContent), assistant.id);
  db.close();

  const refresh = spawnSync(
    process.env.PYTHON || 'python3',
    [IMPORTER, '--source', tempDir, '--records', RECORDS, '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(refresh.status, 0, refresh.stderr || refresh.stdout);

  const refreshed = new Database(output, { readonly: true });
  t.after(() => refreshed.close());
  const content = JSON.parse(
    refreshed.prepare("SELECT content_json FROM messages WHERE role='assistant'").get().content_json
  );
  const fileOperation = content.find((part) => part.id === 'fixture-file-tool');
  assert.equal(fileOperation.path, '/Users/example/Projects/fixture-project/fixture.txt');
  assert.match(fileOperation.content, /fixture file content/);
  assert.equal(
    content.find((part) => part.id === 'historical-tool-pruned-from-current-snapshot').summary,
    '历史工具摘要'
  );
});

test('Doubao importer rebuilds an incomplete cache file', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentxray-doubao-empty-cache-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const output = path.join(tempDir, 'doubao.sqlite');
  fs.writeFileSync(output, '');

  const result = spawnSync(
    process.env.PYTHON || 'python3',
    [IMPORTER, '--source', tempDir, '--records', RECORDS, '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const db = new Database(output, { readonly: true });
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT name, root_path FROM projects').get(), {
    name: 'Fixture Project',
    root_path: '/Users/example/Projects/fixture-project',
  });
});

test('Doubao importer preserves cached history when Chromium blobs disappear', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentxray-doubao-degraded-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const output = path.join(tempDir, 'doubao.sqlite');
  const initial = spawnSync(
    process.env.PYTHON || 'python3',
    [IMPORTER, '--source', tempDir, '--records', RECORDS, '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(initial.status, 0, initial.stderr || initial.stdout);

  const degradedRecords = path.join(tempDir, 'directory-only.jsonl');
  const directoryRecord = fs.readFileSync(RECORDS, 'utf8').split('\n').find(Boolean);
  fs.writeFileSync(degradedRecords, `${directoryRecord}\n`, 'utf8');
  const refresh = spawnSync(
    process.env.PYTHON || 'python3',
    [IMPORTER, '--source', tempDir, '--records', degradedRecords, '--output', output],
    { encoding: 'utf8' }
  );
  assert.equal(refresh.status, 0, refresh.stderr || refresh.stdout);

  const db = new Database(output, { readonly: true });
  t.after(() => db.close());
  const project = db.prepare('SELECT root_path FROM projects').get();
  const session = db.prepare('SELECT created_at, updated_at, model, model_key FROM sessions').get();
  const messages = db.prepare('SELECT role, model, content_json FROM messages ORDER BY timestamp').all();
  assert.equal(project.root_path, '/Users/example/Projects/fixture-project');
  assert.equal(session.model, 'Fixture Model');
  assert.equal(session.model_key, 'fixture-model-key');
  assert.ok(session.created_at);
  assert.ok(session.updated_at);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content_json, /fixture question/);
  assert.match(messages[1].content_json, /fixture answer/);
});

test('cachePathFor derives distinct per-source cache paths and respects DOUBAO_CACHE_PATH', () => {
  const store = require('../lib/platforms/doubao-store');
  const original = process.env.DOUBAO_CACHE_PATH;
  delete process.env.DOUBAO_CACHE_PATH;
  try {
    const pathA = store.cachePathFor('/Users/alice/.doubao/agent_mode/workspace');
    const pathB = store.cachePathFor('/Users/bob/.doubao/agent_mode/workspace');
    assert.notEqual(pathA, pathB);
    assert.match(pathA, /doubao-[0-9a-f]{8}\.sqlite$/);
    assert.match(pathB, /doubao-[0-9a-f]{8}\.sqlite$/);
    // Deterministic: same source yields same path
    assert.equal(store.cachePathFor('/Users/alice/.doubao/agent_mode/workspace'), pathA);
    // Explicit env override takes precedence
    process.env.DOUBAO_CACHE_PATH = '/custom/global-cache.sqlite';
    assert.equal(store.cachePathFor('/any/source'), '/custom/global-cache.sqlite');
  } finally {
    if (original === undefined) delete process.env.DOUBAO_CACHE_PATH;
    else process.env.DOUBAO_CACHE_PATH = original;
  }
});

test('listCachedSessions counts tool calls, tool results, and top tools from IndexedDB cache', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentxray-doubao-toolstats-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dbPath = path.join(tempDir, 'test.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, display_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, section_id TEXT, created_at TEXT, updated_at TEXT, model TEXT, model_key TEXT, source_path TEXT NOT NULL, source_task_id TEXT, source_sequence INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, session_id TEXT, section_id TEXT, role TEXT NOT NULL, timestamp TEXT, model TEXT, model_key TEXT, content_json TEXT NOT NULL, sort_index INTEGER NOT NULL DEFAULT 0, source_sequence INTEGER NOT NULL DEFAULT 0);
  `);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run();
  db.prepare("INSERT INTO projects (id, name, root_path) VALUES ('p1', 'Test Project', '/tmp/test')").run();
  db.prepare(
    "INSERT INTO sessions (id, project_id, title, source_path, created_at) VALUES ('s1', 'p1', 'Tool Session', '/fake/source', '2024-01-01T00:00:00Z')"
  ).run();
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content_json, timestamp) VALUES ('m1', 's1', 'user', '[{\"type\":\"text\",\"text\":\"hello\"}]', '2024-01-01T00:00:01Z')"
  ).run();
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content_json, timestamp) VALUES ('m2', 's1', 'assistant', ?, '2024-01-01T00:00:02Z')"
  ).run(
    JSON.stringify([
      { type: 'text', text: 'running tools' },
      { type: 'toolCall', id: 'tc1', name: 'Bash', arguments: {} },
      { type: 'toolCall', id: 'tc2', name: 'Read', arguments: {} },
      { type: 'toolCall', id: 'tc3', name: 'Bash', arguments: {} },
    ])
  );
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content_json, timestamp) VALUES ('m3', 's1', 'tool', '[{\"type\":\"text\",\"text\":\"result 1\"}]', '2024-01-01T00:00:03Z')"
  ).run();
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content_json, timestamp) VALUES ('m4', 's1', 'tool', '[{\"type\":\"text\",\"text\":\"result 2\"}]', '2024-01-01T00:00:04Z')"
  ).run();
  db.close();

  const store = require('../lib/platforms/doubao-store');
  const sessions = await store.listCachedSessions(dbPath);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].toolCallCount, 3);
  assert.equal(sessions[0].toolResultCount, 2);
  assert.deepEqual(sessions[0].topTools, [
    { name: 'Bash', count: 2 },
    { name: 'Read', count: 1 },
  ]);
});

test('rowToMessage marks tool messages with error indicators as isError=true', () => {
  const store = require('../lib/platforms/doubao-store');

  // Structured: is_error field
  const msgIsError = store.rowToMessage({
    id: 't1',
    role: 'tool',
    content_json: JSON.stringify([{ type: 'text', text: 'failed', is_error: true }]),
  });
  assert.equal(msgIsError.isError, true);

  // Structured: status=error
  const msgStatusError = store.rowToMessage({
    id: 't2',
    role: 'tool',
    content_json: JSON.stringify([{ type: 'text', text: 'failed', status: 'error' }]),
  });
  assert.equal(msgStatusError.isError, true);

  // Text fallback: non-zero exit code
  const msgExitCode = store.rowToMessage({
    id: 't3',
    role: 'tool',
    content_json: JSON.stringify([{ type: 'text', text: 'Command exited with code 127' }]),
  });
  assert.equal(msgExitCode.isError, true);

  // Text fallback: Error: prefix
  const msgErrorPrefix = store.rowToMessage({
    id: 't4',
    role: 'tool',
    content_json: JSON.stringify([{ type: 'text', text: 'Error: something went wrong' }]),
  });
  assert.equal(msgErrorPrefix.isError, true);

  // Single-object content_json (not array) with isError
  const msgSingleObject = store.rowToMessage({
    id: 't5',
    role: 'tool',
    content_json: JSON.stringify({ type: 'text', text: 'failed', isError: true }),
  });
  assert.equal(msgSingleObject.isError, true);

  // Success tool message → false
  const msgSuccess = store.rowToMessage({
    id: 't6',
    role: 'tool',
    content_json: JSON.stringify([{ type: 'text', text: 'ok', status: 'success' }]),
  });
  assert.equal(msgSuccess.isError, false);

  // status=null must not trigger error (common in toolCall parts)
  const msgNullStatus = store.rowToMessage({
    id: 't7',
    role: 'tool',
    content_json: JSON.stringify([{ type: 'toolCall', name: 'Bash', status: null }]),
  });
  assert.equal(msgNullStatus.isError, false);

  // Zero exit code → not an error
  const msgExitZero = store.rowToMessage({
    id: 't8',
    role: 'tool',
    content_json: JSON.stringify([{ type: 'text', text: 'Command exited with code 0' }]),
  });
  assert.equal(msgExitZero.isError, false);

  // Non-tool message stays false even with error-looking content
  const msgAssistant = store.rowToMessage({
    id: 't9',
    role: 'assistant',
    content_json: JSON.stringify([{ type: 'text', text: 'Error: simulated', is_error: true }]),
  });
  assert.equal(msgAssistant.isError, false);
});
