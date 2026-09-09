const fsp = require('fs/promises');
const path = require('path');
const { safeWalk } = require('./fs-utils');
const {
  DATA_DIR,
  CODEX_DIR,
  CODEX_ARCHIVED_DIR,
  CLAUDE_CODE_DIR,
  CLAUDE_DESKTOP_DIR,
  OMP_DIR,
  DSH_DIR,
  GEMINI_DIR,
  DOUBAO_DIR,
  ARCHIVE_DIR,
  readAgents,
} = require('./config');
const { collectClaudeDesktopEntries } = require('./platforms/claude-desktop');
const { PLATFORMS, platformSupports } = require('./platforms');

// --- Backup ---
// Incremental session backup: copies platform session logs into
// ARCHIVE_DIR/<platform>/<relative-path-from-platform-root>. A file is skipped
// when its archived copy already exists with the same size and an mtime no
// older than the source. Hermes is excluded because copying a live SQLite
// database at the file level can produce an inconsistent archive.

// Copy src → dest unless the archived copy is already current; count the outcome.
// Uses temp+rename so a crash mid-write never truncates the destination.
async function backupCopy(srcPath, destPath, counter) {
  let srcStat;
  try {
    srcStat = await fsp.stat(srcPath);
  } catch {
    if (Array.isArray(counter.skippedFiles) && counter.skippedFiles.length < 50) {
      counter.skippedFiles.push(srcPath);
    }
    return;
  }
  try {
    const destStat = await fsp.stat(destPath);
    if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
      counter.skipped++;
      return;
    }
  } catch {
    /* not archived yet */
  }
  try {
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.tmp`;
    await fsp.copyFile(srcPath, tmpPath);
    await fsp.rename(tmpPath, destPath);
    counter.copied++;
  } catch {
    counter.failed = (counter.failed || 0) + 1;
    if (Array.isArray(counter.skippedFiles) && counter.skippedFiles.length < 50) {
      counter.skippedFiles.push(srcPath);
    }
  }
}

// OpenClaw sessions live at <root>/<agent>/sessions/*.jsonl. readAgents
// scopes traversal to real agent directories; safeWalk includes nested session
// files without following symlinks.
async function backupOpenclaw(counter, root = DATA_DIR, archiveDir = ARCHIVE_DIR) {
  const destRoot = path.join(archiveDir, 'openclaw');
  let agents;
  try {
    agents = await readAgents(root);
  } catch (error) {
    if (Array.isArray(counter.warnings)) counter.warnings.push(`openclaw: cannot read ${root}: ${error.message}`);
    return;
  }
  for (const agent of agents) {
    const sessionsDir = path.join(root, agent, 'sessions');
    await safeWalk(sessionsDir, async (filePath) => {
      if (!filePath.endsWith('.jsonl')) return;
      const rel = path.relative(sessionsDir, filePath);
      await backupCopy(filePath, path.join(destRoot, agent, 'sessions', rel), counter);
    });
  }
}

// Codex sessions live under sessions/YYYY/MM/DD and archived_sessions/*.jsonl.
async function backupCodex(counter) {
  const roots = [
    { root: CODEX_DIR, bucket: 'sessions' },
    { root: CODEX_ARCHIVED_DIR, bucket: 'archived_sessions' },
  ];
  const destRoot = path.join(ARCHIVE_DIR, 'codex');
  for (const { root, bucket } of roots) {
    try {
      const entries = await fsp.readdir(root, { recursive: true });
      for (const rel of entries) {
        if (typeof rel === 'string' && rel.endsWith('.jsonl')) {
          await backupCopy(path.join(root, rel), path.join(destRoot, bucket, rel), counter);
        }
      }
    } catch (error) {
      if (Array.isArray(counter.warnings)) counter.warnings.push(`codex: cannot read ${root}: ${error.message}`);
    }
  }
}

// Claude Code sessions live at <root>/<project-slug>/*.jsonl; the prompt
// history sits beside the projects dir (~/.claude/history.jsonl)
async function backupClaudeCode(counter) {
  const root = CLAUDE_CODE_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'claude-code');
  try {
    const slugs = await fsp.readdir(root, { withFileTypes: true });
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const slugDir = path.join(root, s.name);
      const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          await backupCopy(path.join(slugDir, f.name), path.join(destRoot, s.name, f.name), counter);
        }
      }
    }
  } catch (error) {
    if (Array.isArray(counter.warnings)) counter.warnings.push(`claude-code: cannot read ${root}: ${error.message}`);
  }
  await backupCopy(path.join(path.dirname(root), 'history.jsonl'), path.join(destRoot, 'history.jsonl'), counter);
}

// Claude Desktop exposes metadata-linked JSONL entries. Preserve both the
// linked log and its metadata JSON under their paths relative to the platform
// root; duplicate linked files are copied once.
async function backupClaudeDesktop(counter, root = CLAUDE_DESKTOP_DIR, archiveDir = ARCHIVE_DIR) {
  const destRoot = path.join(archiveDir, 'claude-desktop');
  let entries;
  try {
    entries = await collectClaudeDesktopEntries(root);
  } catch (error) {
    if (Array.isArray(counter.warnings)) {
      counter.warnings.push(`claude-desktop: cannot read ${root}: ${error.message}`);
    }
    return;
  }
  const sourcePaths = new Set();
  for (const entry of entries) {
    sourcePaths.add(entry.filePath);
    if (entry.metadataPath) sourcePaths.add(entry.metadataPath);
  }
  for (const sourcePath of sourcePaths) {
    const rel = path.relative(root, sourcePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      if (Array.isArray(counter.warnings)) {
        counter.warnings.push(`claude-desktop: skipped source outside root: ${sourcePath}`);
      }
      continue;
    }
    await backupCopy(sourcePath, path.join(destRoot, rel), counter);
  }
}

// OMP sessions live at <root>/<slug>/*.jsonl; child agent transcripts may
// nest one level deeper. safeWalk finds every .jsonl at any depth.
async function backupOmp(counter) {
  const root = OMP_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'omp');
  try {
    await safeWalk(root, async (filePath) => {
      if (!filePath.endsWith('.jsonl')) return;
      const rel = path.relative(root, filePath);
      await backupCopy(filePath, path.join(destRoot, rel), counter);
    });
  } catch (error) {
    if (Array.isArray(counter.warnings)) counter.warnings.push(`omp: cannot read ${root}: ${error.message}`);
  }
}

// dsh sessions live at <root>/<projectKey>/<sessionId>/session.jsonl[.zstd]
async function backupDsh(counter) {
  const root = DSH_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'dsh');
  try {
    const entries = await fsp.readdir(root, { recursive: true });
    for (const rel of entries) {
      if (typeof rel === 'string' && (rel.endsWith('.jsonl') || rel.endsWith('.jsonl.zstd'))) {
        await backupCopy(path.join(root, rel), path.join(destRoot, rel), counter);
      }
    }
  } catch (error) {
    if (Array.isArray(counter.warnings)) counter.warnings.push(`dsh: cannot read ${root}: ${error.message}`);
  }
}

// gemini sessions live at <root>/<projectHash>/chats/session-*.jsonl
// (subagent transcripts nest one level deeper and are archived too)
async function backupGemini(counter) {
  const root = GEMINI_DIR;
  const destRoot = path.join(ARCHIVE_DIR, 'gemini');
  try {
    const entries = await fsp.readdir(root, { recursive: true });
    for (const rel of entries) {
      if (typeof rel === 'string' && rel.endsWith('.jsonl')) {
        await backupCopy(path.join(root, rel), path.join(destRoot, rel), counter);
      }
    }
  } catch (error) {
    if (Array.isArray(counter.warnings)) counter.warnings.push(`gemini: cannot read ${root}: ${error.message}`);
  }
}

// Doubao's durable source is each agent's trajectory.jsonl. IndexedDB caches
// are derived and deliberately excluded. Unlike the session registry scan,
// backup retains every agent trajectory in a session.
async function backupDoubao(counter, root = DOUBAO_DIR, archiveDir = ARCHIVE_DIR) {
  const destRoot = path.join(archiveDir, 'doubao');
  await safeWalk(root, async (filePath) => {
    if (path.basename(filePath) !== 'trajectory.jsonl') return;
    const rel = path.relative(root, filePath);
    const parts = rel.split(path.sep);
    if (parts.length !== 5 || parts[1] !== 'agents' || parts[3] !== 'system') return;
    const [sessionId, , agentId] = parts;
    await backupCopy(filePath, path.join(destRoot, sessionId, agentId, 'trajectory.jsonl'), counter);
  });
}

const BACKUP_HANDLERS = {
  openclaw: backupOpenclaw,
  codex: backupCodex,
  'claude-code': backupClaudeCode,
  'claude-desktop': backupClaudeDesktop,
  omp: backupOmp,
  dsh: backupDsh,
  gemini: backupGemini,
  doubao: backupDoubao,
};

function makeBackupCounter(overrides = {}) {
  return { copied: 0, skipped: 0, failed: 0, warnings: [], skippedFiles: [], ...overrides };
}

// Run every platform backup and return the summary object served by POST /api/backup
async function runFullBackup() {
  const byPlatform = Object.fromEntries(
    Object.keys(PLATFORMS).map((id) => {
      if (id === 'hermes') {
        return [id, makeBackupCounter({ warnings: ['hermes: SQLite database excluded from file-level backup'] })];
      }
      return [id, makeBackupCounter()];
    })
  );
  const backupPlatforms = Object.keys(PLATFORMS).filter((id) => platformSupports(id, 'backup'));
  await Promise.all(backupPlatforms.map((id) => BACKUP_HANDLERS[id](byPlatform[id])));
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const warnings = [];
  const skippedFiles = [];
  for (const c of Object.values(byPlatform)) {
    copied += c.copied;
    skipped += c.skipped;
    failed += c.failed || 0;
    for (const w of c.warnings || []) {
      if (warnings.length < 50) warnings.push(w);
    }
    for (const f of c.skippedFiles || []) {
      if (skippedFiles.length < 50) skippedFiles.push(f);
    }
  }
  return {
    copied,
    skipped,
    total: copied + skipped,
    byPlatform,
    archiveDir: ARCHIVE_DIR,
    warnings,
    skippedFiles,
    processedFiles: copied + skipped,
    failed,
  };
}

// Auto-backup: once shortly after startup, then daily. Failures are logged, never fatal.
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runAutoBackup() {
  try {
    const summary = await runFullBackup();
    console.log(`[backup] copied=${summary.copied} skipped=${summary.skipped} total=${summary.total}`);
  } catch (error) {
    console.log(`[backup] failed: ${error.message}`);
  }
}

module.exports = {
  runFullBackup,
  AUTO_BACKUP_INTERVAL_MS,
  runAutoBackup,
  backupCopy,
  backupOpenclaw,
  backupClaudeDesktop,
  backupDoubao,
};
