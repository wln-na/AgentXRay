const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const { backupCopy, backupOpenclaw, backupClaudeDesktop, backupDoubao, runFullBackup } = require(
  path.join(ROOT, 'lib', 'backup')
);
const { computePrompts } = require(path.join(ROOT, 'lib', 'prompts'));
const { computeInsights } = require(path.join(ROOT, 'lib', 'insights'));

// --- helpers ---

function makeCounter() {
  return { copied: 0, skipped: 0, failed: 0, warnings: [], skippedFiles: [] };
}

async function makeTempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// Create a temp directory under HOME so resolveDir() accepts it as a dirOverride.
async function makeHomeTempDir(prefix) {
  const home = process.env.HOME || os.homedir();
  const dir = path.join(home, `.agentxray-test-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// Write a minimal openclaw session log with one user message.
function writeOpenClawSession(filePath, text = 'hello world') {
  const lines = [
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2025-01-01T00:00:00Z' }),
    JSON.stringify({
      type: 'message',
      timestamp: '2025-01-01T00:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

// --- Task 1 & 2: backup ---

test('backupCopy: copies file via temp+rename, no .tmp leftover', async () => {
  const dir = await makeTempDir('agentxray-backup-');
  const src = path.join(dir, 'src.jsonl');
  const dest = path.join(dir, 'sub', 'dest.jsonl');
  await fsp.writeFile(src, 'session data\n', 'utf8');
  const counter = makeCounter();

  await backupCopy(src, dest, counter);

  assert.equal(counter.copied, 1);
  assert.equal(counter.failed, 0);
  assert.equal(await fsp.readFile(dest, 'utf8'), 'session data\n');
  // temp file must not remain
  await assert.rejects(fsp.stat(`${dest}.tmp`), /ENOENT/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('backupCopy: skips when destination is current (same size + mtime)', async () => {
  const dir = await makeTempDir('agentxray-backup-');
  const src = path.join(dir, 'src.jsonl');
  const dest = path.join(dir, 'dest.jsonl');
  const content = 'abc\n';
  await fsp.writeFile(src, content, 'utf8');
  await fsp.writeFile(dest, content, 'utf8');
  // Make dest mtime clearly newer than src so the skip condition matches.
  const future = new Date(Date.now() + 10_000);
  await fsp.utimes(dest, future, future);
  const counter = makeCounter();

  await backupCopy(src, dest, counter);

  assert.equal(counter.skipped, 1);
  assert.equal(counter.copied, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('backupCopy: records failed+skippedFiles when copyFile fails, does not throw', async () => {
  const dir = await makeTempDir('agentxray-backup-');
  // Use a directory as the source: stat() succeeds but copyFile() rejects (EISDIR / EBUSY).
  const src = path.join(dir, 'src-dir');
  await fsp.mkdir(src);
  const dest = path.join(dir, 'dest.jsonl');
  const counter = makeCounter();

  await backupCopy(src, dest, counter);

  assert.equal(counter.copied, 0);
  assert.equal(counter.failed, 1);
  assert.deepEqual(counter.skippedFiles, [src]);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('backupCopy: records skippedFiles when source stat fails, does not throw', async () => {
  const dir = await makeTempDir('agentxray-backup-');
  const src = path.join(dir, 'nonexistent.jsonl');
  const dest = path.join(dir, 'dest.jsonl');
  const counter = makeCounter();

  await backupCopy(src, dest, counter);

  assert.equal(counter.copied, 0);
  assert.equal(counter.failed, 0);
  assert.deepEqual(counter.skippedFiles, [src]);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('backupOpenclaw preserves agent/session paths and only copies JSONL files', async () => {
  const dir = await makeTempDir('agentxray-openclaw-backup-');
  const root = path.join(dir, 'agents');
  const archive = path.join(dir, 'archive');
  const sessions = path.join(root, 'agent-a', 'sessions');
  await fsp.mkdir(path.join(sessions, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(sessions, 'main.jsonl'), 'main\n');
  await fsp.writeFile(path.join(sessions, 'nested', 'child.jsonl'), 'child\n');
  await fsp.writeFile(path.join(sessions, 'ignore.txt'), 'ignore\n');
  const counter = makeCounter();

  await backupOpenclaw(counter, root, archive);

  assert.equal(counter.copied, 2);
  assert.equal(
    await fsp.readFile(path.join(archive, 'openclaw', 'agent-a', 'sessions', 'main.jsonl'), 'utf8'),
    'main\n'
  );
  assert.equal(
    await fsp.readFile(path.join(archive, 'openclaw', 'agent-a', 'sessions', 'nested', 'child.jsonl'), 'utf8'),
    'child\n'
  );
  assert.equal(
    await fsp.access(path.join(archive, 'openclaw', 'agent-a', 'sessions', 'ignore.txt')).then(
      () => true,
      () => false
    ),
    false
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('backupClaudeDesktop copies linked JSONL and metadata but not unrelated logs', async () => {
  const dir = await makeHomeTempDir('desktop-backup');
  const root = path.join(dir, 'desktop');
  const archive = path.join(dir, 'archive');
  const base = path.join(root, 'account', 'profile');
  const linkedDir = path.join(base, 'short', '.claude', 'projects', 'session');
  await fsp.mkdir(linkedDir, { recursive: true });
  const metadataPath = path.join(base, 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json');
  const linkedPath = path.join(linkedDir, 'ffffffff-1111-4222-8333-444444444444.jsonl');
  const unrelatedPath = path.join(linkedDir, 'unrelated.jsonl');
  await fsp.writeFile(
    metadataPath,
    JSON.stringify({
      sessionId: 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      cliSessionId: 'ffffffff-1111-4222-8333-444444444444',
    })
  );
  await fsp.writeFile(linkedPath, '{}\n');
  await fsp.writeFile(unrelatedPath, '{}\n');
  const counter = makeCounter();

  await backupClaudeDesktop(counter, root, archive);

  assert.equal(counter.copied, 2);
  assert.equal(
    await fsp.access(path.join(archive, 'claude-desktop', path.relative(root, metadataPath))).then(
      () => true,
      () => false
    ),
    true
  );
  assert.equal(
    await fsp.access(path.join(archive, 'claude-desktop', path.relative(root, linkedPath))).then(
      () => true,
      () => false
    ),
    true
  );
  assert.equal(
    await fsp.access(path.join(archive, 'claude-desktop', path.relative(root, unrelatedPath))).then(
      () => true,
      () => false
    ),
    false
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('backupDoubao copies only trajectory.jsonl into session/agent archive paths', async () => {
  const dir = await makeTempDir('agentxray-doubao-backup-');
  const root = path.join(dir, 'sessions');
  const archive = path.join(dir, 'archive');
  const systemDir = path.join(root, 'session-a', 'agents', 'agent-a', 'system');
  const indexedDbDir = path.join(root, 'IndexedDB');
  await fsp.mkdir(systemDir, { recursive: true });
  await fsp.mkdir(indexedDbDir, { recursive: true });
  await fsp.writeFile(path.join(systemDir, 'trajectory.jsonl'), 'trajectory\n');
  await fsp.writeFile(path.join(systemDir, 'other.jsonl'), 'other\n');
  await fsp.writeFile(path.join(indexedDbDir, 'trajectory.jsonl'), 'cache\n');
  const counter = makeCounter();

  await backupDoubao(counter, root, archive);

  assert.equal(counter.copied, 1);
  assert.equal(
    await fsp.readFile(path.join(archive, 'doubao', 'session-a', 'agent-a', 'trajectory.jsonl'), 'utf8'),
    'trajectory\n'
  );
  assert.equal(
    await fsp.access(path.join(archive, 'doubao', 'IndexedDB')).then(
      () => true,
      () => false
    ),
    false
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('runFullBackup: returns warnings/skippedFiles/processedFiles/failed fields', async () => {
  const result = await runFullBackup();
  assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
  assert.ok(Array.isArray(result.skippedFiles), 'skippedFiles should be an array');
  assert.equal(typeof result.processedFiles, 'number');
  assert.equal(typeof result.failed, 'number');
  // Existing fields preserved
  assert.equal(typeof result.copied, 'number');
  assert.equal(typeof result.skipped, 'number');
  assert.equal(typeof result.total, 'number');
  assert.ok(result.byPlatform);
  assert.ok(result.archiveDir);
  // processedFiles equals copied+skipped
  assert.equal(result.processedFiles, result.copied + result.skipped);
});

test('runFullBackup: byPlatform entries include failed/warnings/skippedFiles', async () => {
  const result = await runFullBackup();
  for (const platform of Object.keys(result.byPlatform)) {
    const c = result.byPlatform[platform];
    assert.equal(typeof c.failed, 'number', `${platform}.failed should be a number`);
    assert.ok(Array.isArray(c.warnings), `${platform}.warnings should be an array`);
    assert.ok(Array.isArray(c.skippedFiles), `${platform}.skippedFiles should be an array`);
  }
});

// --- Task 4: prompts skippedFiles ---

test('computePrompts: returns warnings/skippedFiles/processedFiles for unreadable files', async () => {
  const homeDir = await makeHomeTempDir('prompts');
  const agentDir = path.join(homeDir, 'test-agent', 'sessions');
  await fsp.mkdir(agentDir, { recursive: true });

  // Good session file
  const goodFile = path.join(agentDir, 'good-session.jsonl');
  writeOpenClawSession(goodFile, 'please help me code');

  // Bad session file: remove all read permissions so createReadStream fails
  const badFile = path.join(agentDir, 'bad-session.jsonl');
  await fsp.writeFile(badFile, '{}', 'utf8');
  await fsp.chmod(badFile, 0o000);

  try {
    const result = await computePrompts('openclaw', 'test-agent', homeDir);
    assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
    assert.ok(Array.isArray(result.skippedFiles), 'skippedFiles should be an array');
    assert.equal(typeof result.processedFiles, 'number');
    assert.ok(result.skippedFiles.includes(badFile), 'bad file should be in skippedFiles');
    assert.equal(result.processedFiles, 1, 'only the good file was processed');
    // Existing fields preserved
    assert.equal(result.platform, 'openclaw');
    assert.equal(typeof result.totalSessions, 'number');
    assert.equal(typeof result.totalPrompts, 'number');
    assert.ok(Array.isArray(result.groups));
  } finally {
    // Restore permissions so cleanup works
    await fsp.chmod(badFile, 0o644).catch(() => {});
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('computePrompts: processedFiles counts zero-prompt sessions as processed', async () => {
  const homeDir = await makeHomeTempDir('prompts2');
  const agentDir = path.join(homeDir, 'test-agent', 'sessions');
  await fsp.mkdir(agentDir, { recursive: true });

  // Session with no user prompts (only assistant messages)
  const noPromptFile = path.join(agentDir, 'no-prompt.jsonl');
  fs.writeFileSync(
    noPromptFile,
    `${JSON.stringify({ type: 'session', id: 's2', timestamp: '2025-01-01T00:00:00Z' })}\n`,
    'utf8'
  );

  try {
    const result = await computePrompts('openclaw', 'test-agent', homeDir);
    assert.equal(result.processedFiles, 1);
    assert.equal(result.skippedFiles.length, 0);
    assert.equal(result.totalPrompts, 0);
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

// --- Task 5: insights skippedFiles ---

test('computeInsights: returns warnings/skippedFiles/processedFiles for unreadable files', async () => {
  const homeDir = await makeHomeTempDir('insights');
  const agentDir = path.join(homeDir, 'test-agent', 'sessions');
  await fsp.mkdir(agentDir, { recursive: true });

  // Good session with a tool call and tool result
  const goodFile = path.join(agentDir, 'good-session.jsonl');
  const goodLines = [
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2025-01-01T00:00:00Z' }),
    JSON.stringify({
      type: 'message',
      timestamp: '2025-01-01T00:01:00Z',
      message: { role: 'assistant', content: [{ type: 'toolCall', name: 'Bash' }] },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2025-01-01T00:02:00Z',
      message: { role: 'toolResult', toolName: 'Bash', isError: false, content: [] },
    }),
  ];
  fs.writeFileSync(goodFile, `${goodLines.join('\n')}\n`, 'utf8');

  // Bad session file: unreadable
  const badFile = path.join(agentDir, 'bad-session.jsonl');
  await fsp.writeFile(badFile, '{}', 'utf8');
  await fsp.chmod(badFile, 0o000);

  try {
    const result = await computeInsights('openclaw', 'test-agent', homeDir);
    assert.ok(result, 'computeInsights should return data when files exist');
    assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
    assert.ok(Array.isArray(result.skippedFiles), 'skippedFiles should be an array');
    assert.equal(typeof result.processedFiles, 'number');
    assert.ok(result.skippedFiles.includes(badFile), 'bad file should be in skippedFiles');
    assert.equal(result.processedFiles, 1, 'only the good file was processed');
    // Existing fields preserved
    assert.equal(typeof result.totalSessions, 'number');
    assert.equal(typeof result.totalMessages, 'number');
    assert.equal(typeof result.totalToolCalls, 'number');
    assert.ok(Array.isArray(result.toolStats));
    assert.ok(Array.isArray(result.errorClusters));
    assert.ok(Array.isArray(result.trend));
  } finally {
    await fsp.chmod(badFile, 0o644).catch(() => {});
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});

test('computeInsights: processedFiles counts successfully scanned files', async () => {
  const homeDir = await makeHomeTempDir('insights2');
  const agentDir = path.join(homeDir, 'test-agent', 'sessions');
  await fsp.mkdir(agentDir, { recursive: true });

  const file = path.join(agentDir, 'session.jsonl');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'session', id: 's1', timestamp: '2025-01-01T00:00:00Z' })}\n`,
    'utf8'
  );

  try {
    const result = await computeInsights('openclaw', 'test-agent', homeDir);
    assert.ok(result);
    assert.equal(result.processedFiles, 1);
    assert.equal(result.skippedFiles.length, 0);
  } finally {
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
});
