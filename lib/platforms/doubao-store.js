const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { topToolsOf, estimateToolDurationMs } = require('./shared');

const CACHE_DIR = process.env.AGENTXRAY_CACHE_DIR || path.join(os.homedir(), '.agentxray', 'cache');
const CACHE_PATH = process.env.DOUBAO_CACHE_PATH || path.join(CACHE_DIR, 'doubao.sqlite');
const IMPORT_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'doubao_indexeddb_import.py');
const EXPECTED_CACHE_SCHEMA = '3';
const REFRESH_INTERVAL_MS = 2000;

// Per-source cache path: when DOUBAO_CACHE_PATH is not explicitly set, derive a
// unique cache file from the resolved source absolute path so that different
// Doubao profiles / IndexedDB directories do not pollute each other.
function cachePathFor(source) {
  if (process.env.DOUBAO_CACHE_PATH) return process.env.DOUBAO_CACHE_PATH;
  const resolved = path.resolve(String(source || ''));
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return path.join(CACHE_DIR, `doubao-${hash}.sqlite`);
}

const refreshStates = new Map();

function getRefreshState(cachePath) {
  let state = refreshStates.get(cachePath);
  if (!state) {
    state = { promise: null, lastAttempt: 0, lastSignature: '' };
    refreshStates.set(cachePath, state);
  }
  return state;
}

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

function cacheSchemaIsCurrent(cachePath = CACHE_PATH) {
  if (!fs.existsSync(cachePath)) return false;
  try {
    const db = new Database(cachePath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
      return row?.value === EXPECTED_CACHE_SCHEMA;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function refreshCache(inputDir, force = false) {
  const source = indexedDbSourceFor(inputDir);
  // Sqlite passthrough: if the source itself is a sqlite file, use it directly.
  if (source.endsWith('.sqlite') && fs.existsSync(source)) return source;
  const cachePath = cachePathFor(source);
  const state = getRefreshState(cachePath);
  const schemaIsCurrent = cacheSchemaIsCurrent(cachePath);
  const now = Date.now();
  if (!force && schemaIsCurrent && now - state.lastAttempt < REFRESH_INTERVAL_MS) return cachePath;
  if (state.promise) return state.promise;
  state.promise = (async () => {
    state.lastAttempt = Date.now();
    if (!fs.existsSync(source)) return fs.existsSync(cachePath) ? cachePath : null;
    const signature = await sourceSignature(source);
    if (!force && schemaIsCurrent && signature && signature === state.lastSignature) return cachePath;
    const parser = await ensureParser();
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await run(process.env.PYTHON || 'python3', [
      IMPORT_SCRIPT,
      '--source',
      source,
      '--output',
      cachePath,
      '--dfindexeddb',
      parser,
    ]);
    state.lastSignature = signature;
    return cachePath;
  })().finally(() => {
    state.promise = null;
  });
  return state.promise;
}

async function ensureCache(inputDir) {
  const source = indexedDbSourceFor(inputDir);
  if (source.endsWith('.sqlite') && fs.existsSync(source)) return source;
  const cachePath = cachePathFor(source);
  if (fs.existsSync(cachePath)) {
    if (!cacheSchemaIsCurrent(cachePath)) return refreshCache(inputDir, true);
    void refreshCache(inputDir).catch((error) => {
      console.warn(`[doubao] IndexedDB refresh failed; keeping last valid cache: ${error.message}`);
    });
    return cachePath;
  }
  return refreshCache(inputDir, true);
}

function openCache(cachePath = CACHE_PATH) {
  if (!fs.existsSync(cachePath)) return null;
  return new Database(cachePath, { readonly: true, fileMustExist: true });
}

function parseContent(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addEstimatedToolDurations(content) {
  return content.map((part) => {
    if (part.type !== 'toolCall' && part.type !== 'tool_use') return part;
    return {
      ...part,
      estimatedDurationMs: estimateToolDurationMs(part.name),
      durationSource: 'estimated',
    };
  });
}

// Detect error indicators in a tool-result message's content_json.
// Handles both array-of-parts and single-object shapes.
function detectToolError(contentJson) {
  let parts;
  try {
    const parsed = JSON.parse(contentJson);
    if (Array.isArray(parsed)) {
      parts = parsed;
    } else if (parsed && typeof parsed === 'object') {
      parts = [parsed];
    } else {
      parts = [];
    }
  } catch {
    return false;
  }
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.is_error === true || part.isError === true) return true;
    if (typeof part.status === 'string' && part.status !== 'success') return true;
  }
  // Fallback: textual error markers when no structured field is present.
  const text = parts.map((p) => p.text || p.summary || '').join('\n');
  if (/Command exited with code [1-9]\d*/.test(text)) return true;
  if (/(^|\n)Error:/.test(text)) return true;
  return false;
}

function rowToMessage(row) {
  const content = addEstimatedToolDurations(parseContent(row.content_json));
  const isError = row.role === 'tool' ? detectToolError(row.content_json) : false;
  return {
    id: row.id,
    timestamp: row.timestamp,
    role: row.role,
    content,
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
    isError,
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
  const cachePath = await ensureCache(inputDir);
  const db = openCache(cachePath);
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
    // Aggregate tool-call / tool-result stats for all sessions in one pass.
    const toolStats = new Map();
    if (sessions.length > 0) {
      const placeholders = sessions.map(() => '?').join(',');
      const messageRows = db
        .prepare(`SELECT conversation_id, role, content_json FROM messages WHERE conversation_id IN (${placeholders})`)
        .all(...sessions.map((s) => s.id));
      for (const row of messageRows) {
        let stats = toolStats.get(row.conversation_id);
        if (!stats) {
          stats = { toolCallCount: 0, toolResultCount: 0, toolNames: {} };
          toolStats.set(row.conversation_id, stats);
        }
        if (row.role === 'tool') {
          stats.toolResultCount++;
        } else if (row.role === 'assistant') {
          const parts = parseContent(row.content_json);
          for (const part of parts) {
            if (part.type === 'toolCall' || part.type === 'tool_use') {
              stats.toolCallCount++;
              const name = part.name || 'unknown';
              stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
            }
          }
        }
      }
    }
    return sessions.map((row) => {
      const content = firstUser.get(row.id);
      const preview = content ? messagePlainText({ content: parseContent(content.content_json) }) : '';
      const stats = toolStats.get(row.id) || { toolCallCount: 0, toolResultCount: 0, toolNames: {} };
      return {
        id: row.id,
        timestamp: row.created_at || row.updated_at || '',
        lastActivity: row.updated_at || row.created_at || '',
        messageCount: row.message_count,
        userCount: row.user_count,
        assistantCount: row.assistant_count,
        toolCallCount: stats.toolCallCount,
        toolResultCount: stats.toolResultCount,
        topTools: topToolsOf(stats.toolNames),
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
  const cachePath = await ensureCache(inputDir);
  const db = openCache(cachePath);
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

// --- FTS5 search helpers ---

function ftsTableExists(db) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
  return Boolean(row);
}

// Build an FTS5 MATCH expression: each term double-quoted (escaping internal
// quotes by doubling), space-separated which implies AND.
function buildFtsQuery(terms) {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// FTS-backed search: single query per term for session-level AND, then one
// joined query for message-level matches. Avoids per-session getCachedSession.
function searchCachedSessionsFts(db, terms) {
  const projectPath = projectPathExpression(db);

  // For each term, collect conversation_ids whose messages contain it.
  const termMessageIds = new Map();
  for (const term of terms) {
    const ftsQuery = `"${term.replace(/"/g, '""')}"`;
    const rows = db
      .prepare('SELECT DISTINCT conversation_id FROM messages_fts WHERE messages_fts MATCH ?')
      .all(ftsQuery);
    termMessageIds.set(term, new Set(rows.map((r) => r.conversation_id)));
  }

  // Load all sessions with project info.
  const sessions = db
    .prepare(`
    SELECT s.*, p.name AS project_name, ${projectPath} AS project_path
    FROM sessions s LEFT JOIN projects p ON p.id=s.project_id
  `)
    .all();

  // Session-level AND: every term must appear in metadata OR in that session's messages.
  const candidateIds = [];
  for (const s of sessions) {
    const metadataHaystack = `${s.id}\n${s.title || ''}\n${s.project_name || ''}`.toLowerCase();
    const allTermsMatch = terms.every((term) => {
      if (metadataHaystack.includes(term)) return true;
      return termMessageIds.get(term)?.has(s.id) === true;
    });
    if (allTermsMatch) candidateIds.push(s.id);
  }

  if (candidateIds.length === 0) return [];

  // Message-level matches: all terms in a single message (FTS AND).
  const ftsQueryAll = buildFtsQuery(terms);
  const placeholders = candidateIds.map(() => '?').join(',');
  const messageRows = db
    .prepare(`
    SELECT m.conversation_id, m.role, m.timestamp, m.content_json
    FROM messages_fts f
    JOIN messages m ON m.id = f.message_id
    WHERE f.messages_fts MATCH ? AND m.conversation_id IN (${placeholders})
  `)
    .all(ftsQueryAll, ...candidateIds);

  const matchesBySession = new Map();
  for (const row of messageRows) {
    if (!matchesBySession.has(row.conversation_id)) {
      matchesBySession.set(row.conversation_id, []);
    }
    const text = messagePlainText({ content: parseContent(row.content_json) });
    matchesBySession.get(row.conversation_id).push({
      role: row.role,
      snippet: text.slice(0, 240),
      timestamp: row.timestamp || null,
    });
  }

  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  return candidateIds.map((sessionId) => {
    const s = sessionMap.get(sessionId);
    return {
      sessionId,
      file: s.source_path,
      platform: 'doubao',
      project: s.project_name || undefined,
      matches: (matchesBySession.get(sessionId) || []).slice(0, 5),
    };
  });
}

// Fallback memory search for caches without messages_fts (schema < 3).
async function searchCachedSessionsFallback(inputDir, terms) {
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

async function searchCachedSessions(inputDir, query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];

  const cachePath = await ensureCache(inputDir);
  const db = openCache(cachePath);
  if (!db) return [];

  try {
    if (ftsTableExists(db)) {
      return searchCachedSessionsFts(db, terms);
    }
  } catch (error) {
    console.warn(`[doubao] FTS search failed, falling back to memory search: ${error.message}`);
  } finally {
    db.close();
  }

  // Fallback: no FTS table or FTS query failed — use in-memory search.
  return searchCachedSessionsFallback(inputDir, terms);
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
  cachePathFor,
  indexedDbSourceFor,
  trajectoryRootFor,
  refreshCache,
  listCachedSessions,
  getCachedSession,
  searchCachedSessions,
  cacheMetadata,
  rowToMessage,
  detectToolError,
};
