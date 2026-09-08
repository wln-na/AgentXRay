const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_DESKTOP_DIR } = require('../config');
const { parseClaudeCodeSessionFile, parseClaudeCodeSessionMetadata, normalizeClaudeCodeRecord } = require('./claude');
const { sortSessionsByTimestampDesc } = require('./shared');

const SKIP_DIRS = new Set(['title-gen', 'IndexedDB', 'Local Storage', 'Cache', 'Code Cache', 'GPUCache', 'vm_bundles']);

async function walkFiles(root, visitor) {
  const out = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(filePath);
      } else if (entry.isFile() && visitor(filePath, entry.name)) {
        out.push(filePath);
      }
    }
  }
  await walk(root);
  return out;
}

function isoFromEpoch(value) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

async function readDesktopMetadata(filePath) {
  try {
    const value = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || !value.sessionId || !value.cliSessionId) return null;
    return { ...value, metadataPath: filePath };
  } catch {
    return null;
  }
}

function candidateScore(filePath, metadata) {
  const desktopId = String(metadata.sessionId || '').replace(/^local_/, '');
  const shortId = desktopId.slice(0, 8);
  const parts = filePath.split(path.sep);
  let score = 0;
  if (parts.includes(shortId)) score += 20;
  if (parts.includes(metadata.sessionId)) score += 20;
  if (filePath.includes(`${path.sep}.claude${path.sep}projects${path.sep}session${path.sep}`)) score += 5;
  return score;
}

async function findAuditPath(logPath, root) {
  let dir = path.dirname(logPath);
  const resolvedRoot = path.resolve(root);
  while (dir.startsWith(resolvedRoot)) {
    const candidate = path.join(dir, 'audit.jsonl');
    try {
      if ((await fsp.stat(candidate)).isFile()) return candidate;
    } catch {
      // Keep walking toward the local session root.
    }
    if (dir === resolvedRoot) break;
    dir = path.dirname(dir);
  }
  return null;
}

async function collectClaudeDesktopEntries(baseDir) {
  const dir = baseDir || CLAUDE_DESKTOP_DIR;
  const [metadataFiles, logFiles] = await Promise.all([
    walkFiles(dir, (_filePath, name) => /^local_[0-9a-f-]+\.json$/i.test(name)),
    walkFiles(
      dir,
      (filePath, name) =>
        name.endsWith('.jsonl') && name !== 'audit.jsonl' && !filePath.includes(`${path.sep}title-gen${path.sep}`)
    ),
  ]);

  const logsBySessionId = new Map();
  for (const filePath of logFiles) {
    const sessionId = path.basename(filePath, '.jsonl');
    const list = logsBySessionId.get(sessionId) || [];
    list.push(filePath);
    logsBySessionId.set(sessionId, list);
  }

  const entries = [];
  for (const metadataFile of metadataFiles) {
    const metadata = await readDesktopMetadata(metadataFile);
    if (!metadata) continue;
    const candidates = logsBySessionId.get(metadata.cliSessionId) || [];
    if (!candidates.length) continue;
    candidates.sort((a, b) => candidateScore(b, metadata) - candidateScore(a, metadata) || a.localeCompare(b));
    const filePath = candidates[0];
    entries.push({
      id: metadata.sessionId,
      cliSessionId: metadata.cliSessionId,
      filePath,
      file: path.basename(filePath),
      metadata,
      metadataPath: metadataFile,
      auditPath: await findAuditPath(filePath, dir),
    });
  }
  return entries;
}

function projectPathOf(metadata) {
  const selected = Array.isArray(metadata.userSelectedFolders)
    ? metadata.userSelectedFolders.find((item) => typeof item === 'string' && item.trim())
    : null;
  return selected || null;
}

function desktopTitle(metadata, logMetadata) {
  const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
  if (title && title !== 'New session') return title;
  const initial = typeof metadata.initialMessage === 'string' ? metadata.initialMessage.trim() : '';
  return initial || logMetadata.firstUserMessage || title || null;
}

async function buildDesktopSummary(entry) {
  const logMetadata = await parseClaudeCodeSessionMetadata(entry.filePath, entry.file);
  const projectPath = projectPathOf(entry.metadata);
  const createdAt = isoFromEpoch(entry.metadata.createdAt);
  const lastActivityAt = isoFromEpoch(entry.metadata.lastActivityAt);
  return {
    ...logMetadata,
    id: entry.id,
    cliSessionId: entry.cliSessionId,
    title: desktopTitle(entry.metadata, logMetadata),
    timestamp: logMetadata.timestamp || createdAt,
    lastActivity: logMetadata.lastActivity || lastActivityAt || createdAt,
    cwd: projectPath,
    projectPath,
    model: logMetadata.model || entry.metadata.model || null,
    source: 'claude-desktop-local-agent',
    dataSource: 'local-agent-mode-sessions',
    sourcePath: entry.filePath,
    filePath: entry.filePath,
    metadataPath: entry.metadataPath,
    auditPath: entry.auditPath,
    selectedModel: entry.metadata.model || null,
    archived: Boolean(entry.metadata.isArchived),
  };
}

async function listClaudeDesktopSessions(baseDir) {
  const entries = await collectClaudeDesktopEntries(baseDir);
  const sessions = await Promise.all(entries.map(buildDesktopSummary));
  return sortSessionsByTimestampDesc(sessions);
}

async function findClaudeDesktopEntry(baseDir, sessionId) {
  const entries = await collectClaudeDesktopEntries(baseDir);
  return entries.find((entry) => entry.id === sessionId || entry.cliSessionId === sessionId) || null;
}

async function findClaudeDesktopSessionFile(baseDir, sessionId) {
  return (await findClaudeDesktopEntry(baseDir, sessionId))?.filePath || null;
}

async function getClaudeDesktopSession(baseDir, sessionId) {
  const entry = await findClaudeDesktopEntry(baseDir, sessionId);
  if (!entry) return null;
  const [detail, summary] = await Promise.all([parseClaudeCodeSessionFile(entry.filePath), buildDesktopSummary(entry)]);
  const models = [];
  for (const message of detail.messages || []) {
    if (message.model && message.model !== '<synthetic>' && !models.includes(message.model)) models.push(message.model);
  }
  const contextUsage = detail.contextUsage
    ? {
        ...detail.contextUsage,
        note: 'Claude Desktop 本地 Agent/Cowork 日志记录了本次输入与缓存 Token，但未必记录上下文窗口上限及分类 Token。',
      }
    : null;
  return {
    ...detail,
    contextUsage,
    session: {
      ...(detail.session || {}),
      ...summary,
      id: entry.id,
      cliSessionId: entry.cliSessionId,
      model: models.at(-1) || summary.model || null,
      models,
      tokenUsage: detail.tokenUsage || null,
      contextUsage,
    },
  };
}

async function parseClaudeDesktopSessionFile(filePath) {
  return parseClaudeCodeSessionFile(filePath);
}

module.exports = {
  collectClaudeDesktopEntries,
  listClaudeDesktopSessions,
  findClaudeDesktopEntry,
  findClaudeDesktopSessionFile,
  getClaudeDesktopSession,
  parseClaudeDesktopSessionFile,
  normalizeClaudeDesktopRecord: normalizeClaudeCodeRecord,
};
