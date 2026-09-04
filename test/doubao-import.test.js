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
  const project = db.prepare('SELECT id, name FROM projects').get();
  const session = db.prepare('SELECT id, project_id, title, model FROM sessions').get();
  const messages = db.prepare('SELECT role, model, content_json FROM messages ORDER BY timestamp').all();
  const metadata = Object.fromEntries(
    db
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((row) => [row.key, row.value])
  );

  assert.deepEqual(project, { id: 'fixture-project', name: 'Fixture Project' });
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
  assert.equal(metadata.project_count, '1');
  assert.equal(metadata.session_count, '1');
  assert.equal(metadata.message_count, '2');
  assert.equal(metadata.model_count, '1');

  const cacheBytes = fs.readFileSync(output, 'utf8');
  for (const forbidden of ['inner_user_ip', 'local_device_id', 'trace_id', 'cookie', 'authorization']) {
    assert.equal(cacheBytes.includes(forbidden), false, `cache leaked ${forbidden}`);
  }
});
