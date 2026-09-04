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
  const apiFileOperation = adapter.messages
    .flatMap((message) => message.content || [])
    .find((part) => part.id === 'fixture-file-tool');
  assert.equal(apiFileOperation.summary, '已读取 fixture.txt');
  assert.equal(apiFileOperation.path, '/Users/example/Projects/fixture-project/fixture.txt');
  assert.match(apiFileOperation.content, /fixture file content/);

  const cacheBytes = fs.readFileSync(output, 'utf8');
  for (const forbidden of ['inner_user_ip', 'local_device_id', 'trace_id', 'cookie', 'authorization']) {
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
