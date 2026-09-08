const fs = require('fs');
const { HERMES_DIR, sessionMetaCache, resolveDir, sanitizeAgentName, sanitizeSessionId } = require('../config');
const { PLATFORMS } = require('../platforms');
const { getHermesDbPath, openHermesDbForWatch, normalizeHermesMessage } = require('../platforms/hermes');
const { indexedDbSourceFor, cachePathFor } = require('../platforms/doubao-store');
const { readNewLines, parseWatchLines } = require('../watch');

// ========= Real-time SSE tail endpoint =========
// GET /api/watch?platform=openclaw&agent=NAME&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=codex&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=claude-code&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=hermes&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=omp&sessionId=ID[&dir=PATH]
// Streams Server-Sent Events:
//   event: connected     data: {"messageCount": N}
//   event: newMessages   data: {"messages": [...normalized], "session": {...}}
//   event: error         data: {"error": "..."}
//
// Offset-advance and line-normalization logic live in lib/watch.js; this
// module keeps only the SSE plumbing (headers, fs.watch, timers, cleanup).

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  return function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// Hermes: WAL file watch-based SSE against the SQLite db
function watchHermes(req, res, sessionId) {
  const send = sseInit(res);

  const hermesDir = resolveDir(req.query.dir, HERMES_DIR);
  const dbPath = getHermesDbPath(hermesDir);
  const walPath = dbPath + '-wal';

  // Keep one persistent read-only connection
  let db = null;
  let lastTimestamp = 0;
  try {
    if (fs.existsSync(dbPath)) {
      db = openHermesDbForWatch(dbPath);
      const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(sessionId);
      send('connected', { messageCount: row ? row.cnt : 0 });
      const lastMsg = db.prepare('SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ?').get(sessionId);
      lastTimestamp = lastMsg?.ts || 0;
    } else {
      send('connected', { messageCount: 0 });
    }
  } catch (e) {
    send('error', { error: e.message });
  }

  const newMsgStmt = db
    ? db.prepare('SELECT * FROM messages WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC')
    : null;

  function checkNewMessages() {
    if (!db || !newMsgStmt) return;
    try {
      const newRows = newMsgStmt.all(sessionId, lastTimestamp);
      if (newRows.length > 0) {
        lastTimestamp = newRows[newRows.length - 1].timestamp;
        const newMsgs = newRows.map(normalizeHermesMessage).filter(Boolean);
        if (newMsgs.length > 0) {
          send('newMessages', { messages: newMsgs });
        }
      }
    } catch (e) {
      send('error', { error: e.message });
    }
  }

  // Watch WAL file for changes (Hermes writes trigger WAL updates)
  let closed = false;
  let debounceTimer = null;
  let watcher = null;
  try {
    watcher = fs.watch(walPath, (eventType) => {
      if (eventType === 'change') {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkNewMessages, 50);
      }
    });
  } catch {
    // WAL file may not exist yet — watch dbPath as fallback
    try {
      watcher = fs.watch(dbPath, (eventType) => {
        if (eventType === 'change') {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(checkNewMessages, 50);
        }
      });
    } catch {}
  }

  const pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(pingTimer);
    if (watcher)
      try {
        watcher.close();
      } catch {}
    if (db) {
      try {
        db.close();
      } catch {}
      db = null;
    }
  });
}

// Resolve the primary data file(s) backing a snapshot session, used for
// mtime/size short-circuiting. Called once per connection (not per poll)
// because platform.find can be expensive (e.g. claude-desktop directory walk).
// Returns [] when the source is unknown — caller falls back to full reparse.
async function resolveSnapshotSourceFiles(platform, dir, sessionId) {
  const files = [];
  // platform.find returns the main JSONL/trajectory file for both
  // claude-desktop and doubao.
  try {
    if (typeof platform.find === 'function') {
      const found = await platform.find(dir, sessionId);
      if (found && !files.includes(found)) files.push(found);
    }
  } catch {
    // find may throw — fall through to SQLite-only or empty
  }
  // Doubao IndexedDB sessions are backed by a SQLite cache in addition to
  // (or instead of) the trajectory file.
  if (platform.id === 'doubao') {
    try {
      const source = indexedDbSourceFor(dir);
      const sqlitePath = source.endsWith('.sqlite') ? source : cachePathFor(source);
      if (fs.existsSync(sqlitePath) && !files.includes(sqlitePath)) {
        files.push(sqlitePath);
      }
    } catch {
      // non-critical — trajectory-only stat is still better than nothing
    }
  }
  return files;
}

// Stat all source files synchronously (stat is microsecond-fast; at most 2
// files). Returns a Map<filePath, {mtimeMs, size}> or null if any stat
// fails (caller falls back to full reparse).
function statSourceFiles(filePaths) {
  const stats = new Map();
  for (const fp of filePaths) {
    try {
      const s = fs.statSync(fp);
      stats.set(fp, { mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      return null;
    }
  }
  return stats;
}

function sourceStatsEqual(current, last) {
  if (!current || !last || current.size !== last.size) return false;
  return current.mtimeMs === last.mtimeMs;
}

// Structured or stateful sources are safer to watch by periodically parsing the
// complete normalized session. This preserves IndexedDB snapshots without
// trying to tail an unsafe/stateful record. Codex is file-append JSONL and
// uses the byte-offset watchFile path below.
async function watchSnapshotSession(req, res, platform, sessionId, intervalMs = 2000) {
  const send = sseInit(res);
  const dir = resolveDir(req.query.dir, platform.defaultDir());
  let closed = false;
  let checking = false;
  let known = new Set();
  const keyOf = (message, index) =>
    `${message.id || ''}|${message.timestamp || ''}|${message.role || ''}|${JSON.stringify(message.content || [])}|${index}`;

  // Source files for mtime/size short-circuit. Resolved once after the
  // initial getSession; empty array means fallback to always-reparse.
  let sourceFiles = [];
  let lastSourceStat = null; // Map<filePath, {mtimeMs, size}>

  try {
    const detail = await platform.getSession(dir, sessionId);
    if (!detail) {
      send('error', { error: 'Session not found' });
      return res.end();
    }
    known = new Set(detail.messages.map(keyOf));
    send('connected', { messageCount: detail.messages.length });
    // Resolve source files and record initial stat after a successful parse.
    sourceFiles = await resolveSnapshotSourceFiles(platform, dir, sessionId);
    lastSourceStat = statSourceFiles(sourceFiles);
  } catch (error) {
    send('error', { error: error.message });
  }

  const poll = async () => {
    if (closed || checking) return;
    checking = true;
    try {
      // mtime/size short-circuit: if every source file is unchanged since
      // the last parse, skip the expensive full reparse. Any stat failure
      // (file deleted/moved) falls through to getSession.
      if (sourceFiles.length > 0 && lastSourceStat) {
        const currentStat = statSourceFiles(sourceFiles);
        if (currentStat) {
          let unchanged = true;
          for (const [fp, stat] of currentStat) {
            const last = lastSourceStat.get(fp);
            if (!last || !sourceStatsEqual(stat, last)) {
              unchanged = false;
              break;
            }
          }
          if (unchanged) return; // no changes — skip reparse
        }
      }

      const detail = await platform.getSession(dir, sessionId);
      if (!detail) return;
      const next = new Set();
      const fresh = [];
      detail.messages.forEach((message, index) => {
        const key = keyOf(message, index);
        next.add(key);
        if (!known.has(key)) fresh.push(message);
      });
      known = next;
      if (fresh.length) send('newMessages', { messages: fresh, session: detail.session });
      // Refresh stat after a successful reparse so subsequent unchanged polls
      // can short-circuit again.
      if (sourceFiles.length > 0) {
        lastSourceStat = statSourceFiles(sourceFiles);
      }
    } catch (error) {
      send('error', { error: error.message });
    } finally {
      checking = false;
    }
  };
  const pollTimer = setInterval(poll, intervalMs);
  const pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => {
    closed = true;
    clearInterval(pollTimer);
    clearInterval(pingTimer);
  });
}

// File-based platforms: byte-offset tail via fs.watch
async function watchFile(req, res, platform, filePath) {
  const send = sseInit(res);

  // Do initial full parse to know current message count + byte offset
  let byteOffset = 0;
  let initialMessageCount = 0;
  try {
    // readNewLines(…, 0) is platform-aware (dsh zstd frames vs plain JSONL)
    // and reports the offset actually consumed — a torn trailing zstd frame
    // stays pending for the first change event.
    const { lines, newOffset } = await readNewLines(filePath, 0);
    byteOffset = newOffset;
    // Count existing messages without sending them (client already has them)
    const { messages: existingMsgs } = parseWatchLines(platform, lines);
    initialMessageCount = existingMsgs.length;
  } catch (e) {
    send('error', { error: e.message });
    return res.end();
  }

  send('connected', { messageCount: initialMessageCount });

  // Watch for file changes
  let watcher;
  let debounceTimer = null;
  let closed = false;

  const onFileChange = async () => {
    if (closed) return;
    try {
      const { lines, newOffset } = await readNewLines(filePath, byteOffset);
      if (lines.length === 0) return;
      byteOffset = newOffset;
      const { messages, sessionMeta } = parseWatchLines(platform, lines);
      if (messages.length > 0) {
        const payload = { messages };
        if (sessionMeta) payload.session = sessionMeta;
        send('newMessages', payload);
      }
      // Invalidate metadata cache so next session list refresh picks up changes
      sessionMetaCache.delete(filePath);
    } catch (e) {
      send('error', { error: e.message });
    }
  };

  try {
    watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        // Debounce: batch rapid writes (e.g. multiple lines written close together)
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(onFileChange, 80);
      }
    });
  } catch (e) {
    send('error', { error: `Cannot watch file: ${e.message}` });
    return res.end();
  }

  // Keepalive ping every 15s to prevent proxy timeouts
  const pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  // Cleanup on client disconnect
  req.on('close', () => {
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(pingTimer);
    if (watcher) watcher.close();
  });
}

function mountWatchRoutes(app) {
  app.get('/api/watch', async (req, res) => {
    const platformId = req.query.platform || 'openclaw';
    const platform = PLATFORMS[platformId];
    if (!platform) return res.status(400).json({ error: 'Unknown platform' });
    const agentName = sanitizeAgentName(req.query.agent || '');
    const sessionId = sanitizeSessionId(req.query.sessionId || '');
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (platform.needsAgent && !agentName) return res.status(400).json({ error: `agent required for ${platformId}` });

    if (platformId === 'hermes') return watchHermes(req, res, sessionId);
    if (platformId === 'doubao' || platformId === 'claude-desktop') {
      const intervalMs = platformId === 'doubao' ? 2000 : 1000;
      return watchSnapshotSession(req, res, platform, sessionId, intervalMs);
    }

    let filePath = null;
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      filePath = await platform.find(dir, sessionId, { agent: agentName });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (!filePath) return res.status(404).json({ error: 'Session not found' });

    return watchFile(req, res, platform, filePath);
  });
}

module.exports = mountWatchRoutes;
module.exports.watchSnapshotSession = watchSnapshotSession;
module.exports.resolveSnapshotSourceFiles = resolveSnapshotSourceFiles;
