const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const CACHE_DIR = process.env.AGENTXRAY_CACHE_DIR || path.join(os.homedir(), '.agentxray', 'cache');
const CACHE_PATH = process.env.DOUBAO_CACHE_PATH || path.join(CACHE_DIR, 'doubao.sqlite');
const IMPORT_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'doubao_indexeddb_import.py');
const REFRESH_INTERVAL_MS = 2000;

let refreshPromise = null;
let lastRefreshAttempt = 0;
let lastSourceSignature = '';

function indexedDbSourceFor(inputDir) {
  const expanded = path.resolve(String(inputDir || '').replace(/^~(?=$|\/)/, os.homedir()));
  if (expanded.endsWith('.indexeddb.leveldb')) return expanded;
  if (expanded.endsWith(path.join('.doubao', 'agent_mode', 'workspace', '.sessions'))) {
    return path.join(
      path.dirname(path.dirname(path.dirname(path.dirname(expanded)))),
      'IndexedDB',
      'chrome_doubao-chat_0.indexeddb.leveldb'
    );
  }
  if (path.basename(expanded) === '.sessions') {
    const marker = `${path.sep}.doubao${path.sep}agent_mode${path.sep}workspace${path.sep}.sessions`;
    const at = expanded.indexOf(marker);
    if (at >= 0) return path.join(expanded.slice(0, at), 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb');
  }
  return expanded;
}

function trajectoryRootFor(inputDir) {
  const expanded = path.resolve(String(inputDir || '').replace(/^~(?=$|\/)/, os.homedir()));
  if (expanded.endsWith('.indexeddb.leveldb')) {
    const marker = `${path.sep}IndexedDB${path.sep}`;
    const at = expanded.indexOf(marker);
    if (at >= 0) return path.join(expanded.slice(0, at), '.doubao', 'agent_mode', 'workspace', '.sessions');
  }
  return expanded;
}

async function sourceSignature(source) {
  const manifest = path.join(source, 'CURRENT');
  const parts = [];
  for (const file of [manifest, path.join(source, 'LOG')]) {
    try {
      const stat = await fsp.stat(file);
      parts.push(`${file}:${stat.size}:${stat.mtimeMs}`);
    } catch {}
  }
  try {
    const entries = await fsp.readdir(source, { withFileTypes: true });
    const recent = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:ldb|log)$/.test(entry.name)) continue;
      const stat = await fsp.stat(path.join(source, entry.name));
      recent.push(`${entry.name}:${stat.size}:${stat.mtimeMs}`);
    }
    recent.sort();
    parts.push(...recent.slice(-8));
  } catch {}
  return parts.join('|');
}

function parserCandidates() {
  const local = path.join(__dirname, '..', '..', '.venv-doubao-parser310', 'bin', 'dfindexeddb');
  const runtime = path.join(CACHE_DIR, 'dfindexeddb-runtime', 'bin', 'dfindexeddb');
  return [process.env.DFINDEXEDDB_BIN, local, runtime, 'dfindexeddb'].filter(Boolean);
}

function commandExists(command) {
  if (command.includes(path.sep)) return fs.existsSync(command);
  const paths = String(process.env.PATH || '').split(path.delimiter);
  return paths.some((dir) => fs.existsSync(path.join(dir, command)));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(stderr.trim() || `${command} exited with code ${code}`);
      error.code = code;
      reject(error);
    });
  });
}

async function ensureParser() {
  for (const candidate of parserCandidates()) {
    if (commandExists(candidate)) return candidate;
  }
  if (!commandExists('uv')) {
    throw new Error('Doubao IndexedDB parser missing. Install uv or dfindexeddb, then refresh.');
  }
  const runtimeDir = path.join(CACHE_DIR, 'dfindexeddb-runtime');
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await run('uv', ['venv', '--python', '3.10', runtimeDir]);
  await run('uv', ['pip', 'install', '--python', path.join(runtimeDir, 'bin', 'python'), 'dfindexeddb']);
  const executable = path.join(runtimeDir, 'bin', 'dfindexeddb');
  if (!fs.existsSync(executable)) throw new Error('dfindexeddb installation completed without an executable');
  return executable;
}

async function refreshCache(inputDir, force = false) {
  const source = indexedDbSourceFor(inputDir);
  if (source.endsWith('.sqlite') && fs.existsSync(source)) return source;
  const now = Date.now();
  if (!force && now - lastRefreshAttempt < REFRESH_INTERVAL_MS && fs.existsSync(CACHE_PATH)) return CACHE_PATH;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    lastRefreshAttempt = Date.now();
    if (!fs.existsSync(source)) return fs.existsSync(CACHE_PATH) ? CACHE_PATH : null;
    const signature = await sourceSignature(source);
    if (!force && signature && signature === lastSourceSignature && fs.existsSync(CACHE_PATH)) return CACHE_PATH;
    const parser = await ensureParser();
    await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await run(process.env.PYTHON || 'python3', [
      IMPORT_SCRIPT,
      '--source',
      source,
      '--output',
      CACHE_PATH,
      '--dfindexeddb',
      parser,
    ]);
    lastSourceSignature = signature;
    return CACHE_PATH;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function ensureCache(inputDir) {
  if (fs.existsSync(CACHE_PATH)) {
    void refreshCache(inputDir).catch((error) => {
      console.warn(`[doubao] IndexedDB refresh failed; keeping last valid cache: ${error.message}`);
    });
    return CACHE_PATH;
  }
  return refreshCache(inputDir, true);
}

function openCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  return new Database(CACHE_PATH, { readonly: true, fileMustExist: true });
}

function parseContent(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToMessage(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    role: row.role,
    content: parseContent(row.content_json),
    usage: null,
    model: row.model || null,
    provider: row.model ? 'doubao' : null,
    toolCallId: null,
    toolName: null,
    details: {
      sectionId: row.section_id || null,
      sourceSessionId: row.session_id || null,
      dataSource: 'indexeddb',
    },
    isError: false,
  };
}

function messagePlainText(message) {
  return (message.content || [])
    .map((item) => item.text || item.summary || '')
    .filter(Boolean)
    .join('\n');
}

function projectPathExpression(db) {
  const columns = db.prepare('PRAGMA table_info(projects)').all();
  return columns.some((column) => column.name === 'root_path') ? 'p.root_path' : 'NULL';
}

async function listCachedSessions(inputDir) {
  await ensureCache(inputDir);
  const db = openCache();
  if (!db) return [];
  try {
    const projectPath = projectPathExpression(db);
    const sessions = db
      .prepare(`
      SELECT s.*, p.name AS project_name, ${projectPath} AS project_path,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=s.id) AS message_count,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=s.id AND m.role='user') AS user_count,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=s.id AND m.role='assistant') AS assistant_count
      FROM sessions s LEFT JOIN projects p ON p.id=s.project_id
      ORDER BY COALESCE(s.updated_at, s.created_at, '') DESC, s.id DESC
    `)
      .all();
    const firstUser = db.prepare(`
      SELECT content_json FROM messages WHERE conversation_id=? AND role='user'
      ORDER BY COALESCE(timestamp,''), sort_index, source_sequence LIMIT 1
    `);
    return sessions.map((row) => {
      const content = firstUser.get(row.id);
      const preview = content ? messagePlainText({ content: parseContent(content.content_json) }) : '';
      return {
        id: row.id,
        timestamp: row.created_at || row.updated_at || '',
        lastActivity: row.updated_at || row.created_at || '',
        messageCount: row.message_count,
        userCount: row.user_count,
        assistantCount: row.assistant_count,
        toolCallCount: 0,
        toolResultCount: 0,
        topTools: [],
        firstUserMessage: preview,
        file: row.source_path,
        title: row.title || null,
        cwd: row.project_path || null,
        model: row.model || null,
        source: 'indexeddb',
        projectId: row.project_id || null,
        projectName: row.project_name || null,
        projectPath: row.project_path || null,
        sectionId: row.section_id || null,
        dataSource: 'indexeddb',
      };
    });
  } finally {
    db.close();
  }
}

async function getCachedSession(inputDir, sessionId) {
  await ensureCache(inputDir);
  const db = openCache();
  if (!db) return null;
  try {
    const projectPath = projectPathExpression(db);
    const session = db
      .prepare(`
      SELECT s.*, p.name AS project_name, ${projectPath} AS project_path FROM sessions s
      LEFT JOIN projects p ON p.id=s.project_id WHERE s.id=?
    `)
      .get(sessionId);
    if (!session) return null;
    const rows = db
      .prepare(`
      SELECT * FROM messages WHERE conversation_id=?
      ORDER BY COALESCE(timestamp,''), sort_index, source_sequence, id
    `)
      .all(sessionId);
    const models = [...new Set(rows.map((row) => row.model).filter(Boolean))];
    return {
      session: {
        id: session.id,
        cwd: session.project_path || null,
        timestamp: session.created_at || session.updated_at || null,
        model: models.length === 1 ? models[0] : session.model || models.at(-1) || null,
        models,
        source: 'indexeddb',
        projectId: session.project_id || null,
        projectName: session.project_name || null,
        projectPath: session.project_path || null,
        sectionId: session.section_id || null,
        dataSource: 'indexeddb',
        sourcePath: session.source_path,
      },
      messages: rows.map(rowToMessage),
    };
  } finally {
    db.close();
  }
}

async function searchCachedSessions(inputDir, query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];
  const sessions = await listCachedSessions(inputDir);
  const results = [];
  for (const session of sessions) {
    const detail = await getCachedSession(inputDir, session.id);
    if (!detail) continue;
    const matches = [];
    let haystack = `${session.id}\n${session.title || ''}\n${session.projectName || ''}`.toLowerCase();
    for (const message of detail.messages) {
      const text = messagePlainText(message);
      haystack += `\n${text.toLowerCase()}`;
      if (terms.every((term) => text.toLowerCase().includes(term))) {
        matches.push({ role: message.role, snippet: text.slice(0, 240), timestamp: message.timestamp || null });
      }
    }
    if (terms.every((term) => haystack.includes(term))) {
      results.push({
        sessionId: session.id,
        file: session.file,
        platform: 'doubao',
        project: session.projectName || undefined,
        matches: matches.slice(0, 5),
      });
    }
  }
  return results;
}

function cacheMetadata() {
  const db = openCache();
  if (!db) return null;
  try {
    return Object.fromEntries(
      db
        .prepare('SELECT key,value FROM meta')
        .all()
        .map((row) => [row.key, row.value])
    );
  } finally {
    db.close();
  }
}

module.exports = {
  CACHE_PATH,
  indexedDbSourceFor,
  trajectoryRootFor,
  refreshCache,
  listCachedSessions,
  getCachedSession,
  searchCachedSessions,
  cacheMetadata,
};
