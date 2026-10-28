const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { DSH_DIR } = require('../config');
const { withMetadataCache, makeMessage, sortSessionsByTimestampDesc, topToolsOf } = require('./shared');

// --- DeepSeek Harness (dsh) platform adapter ---
// Sessions live at <root>/<projectKey>/<sessionId>/<canonical log name>, where
// the canonical name encodes the format generation:
//   v0   session.jsonl / session.jsonl.zstd
//   vN   session.vN.jsonl / session.vN.jsonl.zstd  (N >= 1, no leading zero)
// A session directory can carry several generations while a migration is in
// flight; we read only the highest one (zstd wins ties) so a session is never
// listed twice. Names with a leading-zero version, a non-numeric suffix, a
// migration temp file or a live lock are not canonical and are ignored.
//
// The log is a JSONL event stream: line 1 is a header record
// ({type:'session', version:0|4, id, createdAt, cwd, origin?, …}), every other
// line is a SessionEvent envelope ({type, seq, time, data, surfaceOp?}) or a
// packed chunk row (text-chunks / reasoning-chunks / tool-call-chunks).
//
// v0 and v4 share the envelope but differ in a few semantics:
//   - surfaceOp replace: v0 masks surface indexes [start, end); v4 masks event
//     seqs [startSeq, endSeq] (inclusive).
//   - tool/result: v4 puts the call id in message.toolCallId and the failure
//     flag in message.isError, with flat text blocks.
//   - user/message: v4 injects runtime context (source.kind machine values)
//     through the same event type; only a whitelist is a real conversation
//     bubble.
//   - session/title: v4 carries the DSH-generated title as its own event;
//     fallback titles defer to the first real prompt.
//
// zstd caveat: the compressed artifact is a CONCATENATION of independent
// Zstandard frames (one for the header, one per durable append batch), and
// Node's zstdDecompressSync only reads the FIRST frame. We scan frame
// boundaries (RFC 8878 structure, no block decoding) and decompress each
// frame separately. A truncated trailing frame (crash residue) is tolerated
// and dropped.

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

// Canonical log file name → format generation + compression.
const DSH_LOG_RE = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/;

// Fully supported generations (both have fixtures and normalization paths).
// v1-v3 require a migration in DeepSeek Harness; >4 requires a newer AgentXRay.
const SUPPORTED_VERSIONS = new Set([0, 4]);

// Refuse to decompress a single compressed log above this size; detail requests
// get 413 (DSH_LOG_TOO_LARGE) instead of risking an out-of-memory crash.
const DSH_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;

// user/message source.kind values that are real conversation bubbles. Everything
// else is machine-injected context (skill catalogs can exceed 12k chars) and is
// hidden by default. Unknown future kinds stay hidden (whitelist policy).
const DISPLAY_USER_KINDS = new Set(['user', 'agent-message', 'subagent-settled', 'compact-checkpoint']);

const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

const HAS_NODE_ZSTD = typeof zlib.zstdDecompressSync === 'function';

function msToIso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function dshError(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// Scan frame boundaries of a concatenated-zstd buffer without decompressing
// block contents. Returns { frames: [{start, end}], tornStart } where
// tornStart marks the offset of a trailing incomplete/corrupt frame (null if
// the buffer ends exactly on a frame boundary).
function scanZstdFrames(buf) {
  const frames = [];
  const len = buf.length;
  let off = 0;
  while (off < len) {
    const start = off;
    if (len - off < 4) return { frames, tornStart: start };
    const magic = buf.readUInt32LE(off);
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (len - off < 8) return { frames, tornStart: start };
      const size = buf.readUInt32LE(off + 4);
      if (off + 8 + size > len) return { frames, tornStart: start };
      off += 8 + size; // skippable frames carry no session data
      continue;
    }
    if (magic !== ZSTD_MAGIC) return { frames, tornStart: start };
    off += 4;
    if (off >= len) return { frames, tornStart: start };
    const descriptor = buf[off++];
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const checksumFlag = (descriptor >> 2) & 1;
    const didFlag = descriptor & 3;
    if (!singleSegment) off += 1; // Window_Descriptor
    off += [0, 1, 2, 4][didFlag]; // Dictionary_ID
    off += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]; // Frame_Content_Size
    if (off > len) return { frames, tornStart: start };
    for (;;) {
      if (off + 3 > len) return { frames, tornStart: start };
      const header = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
      off += 3;
      const lastBlock = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      if (blockType === 3) return { frames, tornStart: start }; // reserved: corrupt
      off += blockType === 1 ? 1 : blockSize; // RLE blocks store 1 byte
      if (off > len) return { frames, tornStart: start };
      if (lastBlock) break;
    }
    if (checksumFlag) {
      off += 4;
      if (off > len) return { frames, tornStart: start };
    }
    frames.push({ start, end: off });
  }
  return { frames, tornStart: null };
}

// Multi-frame decompression: every complete frame decoded independently, then
// concatenated. A torn trailing frame is dropped.
function decompressDshLog(buffer) {
  if (!HAS_NODE_ZSTD) {
    throw new Error(
      'This dsh session log is zstd-compressed, but this Node.js build has no zstd support. ' +
        'Upgrade to Node.js >= 22.15 (node:zlib zstdDecompressSync) to view compressed dsh sessions.'
    );
  }
  const { frames } = scanZstdFrames(buffer);
  const parts = frames.map((f) => zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)));
  return Buffer.concat(parts).toString('utf8');
}

// Read a dsh session log (compressed or plain) as an array of non-empty lines.
async function readDshSessionLines(filePath) {
  if (filePath.endsWith('.zstd')) {
    const buffer = await fsp.readFile(filePath);
    return decompressDshLog(buffer)
      .split('\n')
      .filter((l) => l.trim());
  }
  const text = await fsp.readFile(filePath, 'utf8');
  return text.split('\n').filter((l) => l.trim());
}

// --- File discovery: name → generation, one canonical file per session dir ---

// Parse a canonical dsh log file name. Returns null for anything that is not
// exactly session[.vN].jsonl[.zstd] with N a positive integer (no leading zero).
function parseDshLogName(name) {
  if (typeof name !== 'string') return null;
  const match = DSH_LOG_RE.exec(name);
  if (!match) return null;
  return {
    version: match[1] === undefined ? 0 : Number(match[1]),
    compression: match[2] ? 'zstd' : 'none',
  };
}

function direntIsFile(entry) {
  if (!entry || typeof entry.name !== 'string') return false;
  if (typeof entry.isFile === 'function') return entry.isFile();
  return entry.isFile !== false;
}

// Pick the canonical log out of a session directory listing (fs.readdir with
// withFileTypes). Highest version wins; zstd wins a same-version tie; then the
// file name orders deterministically. Never returns more than one file.
function pickDshLogFile(entries) {
  const candidates = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!direntIsFile(entry)) continue;
    const parsed = parseDshLogName(entry.name);
    if (!parsed) continue;
    candidates.push({ name: entry.name, version: parsed.version, compression: parsed.compression });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.version !== b.version) return b.version - a.version;
    if (a.compression !== b.compression) return a.compression === 'zstd' ? -1 : 1;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
  return candidates[0];
}

// Enumerate <root>/<project>/<session>/ sessions, one canonical log each.
// Shape: [{ path, file, sessionId, formatVersion }].
async function collectDshFiles(dir) {
  const root = dir || DSH_DIR;
  const files = [];
  const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    const sessionDirs = await fsp.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(projectDir, session.name);
      const entries = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
      const picked = pickDshLogFile(entries);
      if (!picked) continue;
      files.push({
        path: path.join(sessionDir, picked.name),
        file: picked.name,
        sessionId: session.name,
        formatVersion: picked.version,
      });
    }
  }
  return files;
}

async function findDshSessionFile(baseDir, sessionId) {
  // The route sanitizes ids already; this guard keeps direct adapter callers
  // from escaping <root>/<project>/ with a crafted id.
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (sessionId === '.' || sessionId === '..' || /[/\\\0]/.test(sessionId)) return null;
  const dir = baseDir || DSH_DIR;
  const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const sessionDir = path.join(dir, project.name, sessionId);
    const entries = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
    const picked = pickDshLogFile(entries);
    if (picked) return path.join(sessionDir, picked.name);
  }
  return null;
}

// --- Version dispatch ---

function unsupportedVersionMessage(version) {
  if (version > 4) {
    return `Unsupported dsh session format version ${version}: 该会话是 v${version}，请升级 AgentXRay`;
  }
  return (
    `Unsupported dsh session format version ${version}: ` +
    `该会话是 v${version}，请在 DeepSeek Harness 中打开以迁移到 v4`
  );
}

function headerInvalidMessage(detail) {
  const suffix = detail ? ` (${detail})` : '';
  return `Dsh session header is missing or invalid: expected a first record with type:"session" and version 0|4${suffix}`;
}

// Validate the parsed header against the name-derived generation. Returns
// { statusCode, code, message } for the caller to reuse (list → error card,
// detail → thrown 422), or null when the session is readable.
function dshHeaderProblem(header, fileNameVersion) {
  if (!header || typeof header !== 'object' || header.type !== 'session') {
    return { statusCode: 422, code: 'DSH_HEADER_INVALID', message: headerInvalidMessage() };
  }
  if (!Number.isInteger(header.version)) {
    return { statusCode: 422, code: 'DSH_HEADER_INVALID', message: headerInvalidMessage('no numeric version') };
  }
  // Header version first: an unsupported header can never be parsed, even when
  // the file name also disagrees (the name would only describe a different
  // unsupported generation).
  if (!SUPPORTED_VERSIONS.has(header.version)) {
    return {
      statusCode: 422,
      code: 'DSH_UNSUPPORTED_VERSION',
      message: unsupportedVersionMessage(header.version),
    };
  }
  if (Number.isInteger(fileNameVersion) && fileNameVersion !== header.version) {
    return {
      statusCode: 422,
      code: 'DSH_FORMAT_MISMATCH',
      message:
        `Dsh session format version mismatch: file name says version ${fileNameVersion}, ` +
        `header says version ${header.version}（文件名版本与 header 版本不一致）`,
    };
  }
  return null;
}

// --- Event normalization ---

// Real human prompt text from a user/message event's data, or null for
// non-user injections (hooks, spliced inbox items) and empty content.
function extractDshUserPromptText(data) {
  if (!data || (data.source?.kind && data.source.kind !== 'user')) return null;
  const content = Array.isArray(data.content) ? data.content : [];
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join(' ')
    .trim();
  if (!text) return null;
  if (text.startsWith('<')) return null;
  return text;
}

// Whitelist filter for user/message bubbles: a missing source.kind is a plain
// user bubble (v0), a known kind is displayable, anything else is injected
// context and stays out of the default conversation flow.
function isDisplayableDshUserMessage(data) {
  const kind = data?.source?.kind;
  if (!kind) return true;
  return DISPLAY_USER_KINDS.has(kind);
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenToolResultContent(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'tool-result') {
      for (const inner of Array.isArray(block.content) ? block.content : []) {
        if (inner.type === 'text') parts.push({ type: 'text', text: inner.text || '' });
      }
    }
  }
  return parts;
}

// Maps one dsh session event to an array of normalized messages (an
// assistant/message fans out into reasoning / text entries, codex-style;
// tool calls are emitted from the dedicated tool/call events), or null for
// trace/boundary records. `toolNamesByCallId` pairs tool/result rows with the
// real tool name. Machine-injected user messages are dropped here (not in the
// caller) so the single-line watch tail filters them too; v0 human turns carry
// source.kind 'user' and are never affected.
function normalizeDshEvent(event, toolNamesByCallId) {
  const timestamp = msToIso(event.time);
  const data = event.data || {};

  if (event.type === 'user/message') {
    if (!isDisplayableDshUserMessage(data)) return null;
    const content = Array.isArray(data.content) ? data.content : [];
    return [
      makeMessage({
        id: data.id || null,
        timestamp,
        role: 'user',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
      }),
    ];
  }

  if (event.type === 'assistant/message') {
    const message = data.message || {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) return null; // known-empty stream: derives to no message
    const source = message.source || {};
    const messages = [];
    const reasoningText = content
      .filter((c) => c.type === 'reasoning')
      .map((c) => c.text || '')
      .join('\n\n')
      .trim();
    if (reasoningText) {
      messages.push(
        makeMessage({
          timestamp,
          role: 'reasoning',
          content: [{ type: 'text', text: reasoningText }],
        })
      );
    }
    const usage = data.usage
      ? {
          input: data.usage.inputTokens || 0,
          output: data.usage.outputTokens || 0,
          cacheRead: data.usage.cacheReadTokens || 0,
          reasoning: data.usage.reasoningTokens || 0,
        }
      : null;
    messages.push(
      makeMessage({
        id: message.id || null,
        timestamp,
        role: 'assistant',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
        usage,
        model: source.model || null,
        provider: source.provider || null,
      })
    );
    // tool-call blocks are intentionally skipped: the paired tool/call events
    // that follow carry the same callId/name/arguments and render as
    // standalone toolCall records (codex/omp style).
    return messages;
  }

  if (event.type === 'tool/call') {
    if (data.callId && data.name) toolNamesByCallId.set(data.callId, data.name);
    return [
      makeMessage({
        id: data.callId || null,
        timestamp,
        role: 'toolCall',
        toolCallId: data.callId || null,
        toolName: data.name || null,
        details: tryParseJson(data.arguments),
      }),
    ];
  }

  if (event.type === 'tool/result') {
    const message = data.message || {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const legacyBlock = blocks.find((b) => b.type === 'tool-result');
    // v4: message.toolCallId / message.source.callId; v0: the tool-result block.
    const callId = message.toolCallId || message.source?.callId || legacyBlock?.toolCallId || null;
    // v4 marks failures on message.isError (sometimes without data.error); v0
    // marks them on the nested tool-result block.
    const isError =
      message.isError === true || Boolean(data.error) || blocks.some((b) => b.type === 'tool-result' && b.isError);
    return [
      makeMessage({
        id: message.id || null,
        timestamp,
        role: 'toolResult',
        content: flattenToolResultContent(blocks),
        toolCallId: callId,
        toolName: (callId && toolNamesByCallId.get(callId)) || null,
        details: data.error ? { error: data.error.name || 'error', code: data.error.code ?? null } : null,
        isError,
      }),
    ];
  }

  if (event.type === 'turn/end') {
    const kind = data.reason?.kind;
    if (kind && kind !== 'completed') {
      return [
        makeMessage({
          timestamp,
          role: 'error',
          content: [{ type: 'text', text: `Turn ${data.turn ?? '?'} ended without completing: ${kind}` }],
          toolName: `turn ${kind}`,
          isError: true,
        }),
      ];
    }
    return null;
  }

  // Chunks, boundaries, packed rows and log-only events derive to no message.
  return null;
}

// Parse event lines (header excluded) into the normalized message list,
// honoring compaction. v4 replaces event seqs [startSeq, endSeq] (inclusive);
// v0 replaces surface indexes [start, end) (exclusive). Masked messages are
// dropped so compacted content never renders twice. `options.version` comes
// from the header; watch tails call this without it (both paths work).
function normalizeDshEvents(lines, options = {}) {
  const version = Number.isInteger(options.version) ? options.version : null;
  const toolNamesByCallId = new Map();
  const items = []; // { seq: number|undefined, surfaceIndex: number|null, messages, compacted? }
  let surfaceCount = 0;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'session' || CHUNK_ROW_TYPES.has(event.type)) continue;

    let surfaceIndex = null;
    if (SURFACE_EVENT_TYPES.has(event.type)) {
      const op = event.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace') {
        const hasSeqRange = Number.isInteger(op.startSeq) && Number.isInteger(op.endSeq);
        const hasSurfaceRange = Number.isInteger(op.start) && Number.isInteger(op.end);
        // v4+ always uses seq ranges; v0 (or an unknown caller) keeps surface
        // indexing. Only an explicit v0 header can prefer the legacy fields.
        const useSeqRange = hasSeqRange && (version === null || version >= 4 || !hasSurfaceRange);
        if (useSeqRange) {
          for (const item of items) {
            if (Number.isInteger(item.seq) && item.seq >= op.startSeq && item.seq <= op.endSeq) {
              item.compacted = true;
            }
          }
        } else if (hasSurfaceRange) {
          for (const item of items) {
            if (item.surfaceIndex !== null && item.surfaceIndex >= op.start && item.surfaceIndex < op.end) {
              item.compacted = true;
            }
          }
          // Legacy v0 replacements reuse the first masked surface slot; the
          // replacement occupies that position, mirroring the old adapter.
          surfaceIndex = op.start;
          surfaceCount = op.start + 1;
        }
      }
      if (surfaceIndex === null) surfaceIndex = surfaceCount++;
    }

    const messages = normalizeDshEvent(event, toolNamesByCallId);
    if (messages?.length) items.push({ seq: event.seq, surfaceIndex, messages });
  }

  const out = [];
  for (const item of items) {
    if (!item.compacted) out.push(...item.messages);
  }
  return out;
}

// --- Title resolution ---
// session/title may fire twice (fallback, then provider). A non-fallback last
// title wins; a fallback defers to the first real human prompt, then to itself.
function resolveDshTitle(lastTitle, lastTitleKind, firstUserMessage) {
  if (lastTitle && lastTitleKind !== 'fallback') return lastTitle;
  return firstUserMessage || lastTitle || null;
}

function collectDshTitleInfo(records) {
  let lastTitle = null;
  let lastTitleKind = null;
  let firstUserMessage = null;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'session/title') {
      const title = typeof rec.data?.title === 'string' ? rec.data.title : null;
      if (title) {
        lastTitle = title;
        lastTitleKind = rec.data?.source?.kind || null;
      }
    } else if (rec.type === 'user/message' && !firstUserMessage) {
      const text = extractDshUserPromptText(rec.data);
      if (text) firstUserMessage = text.slice(0, 120);
    }
  }
  return { lastTitle, lastTitleKind, firstUserMessage };
}

// --- Session metadata (list path) ---

const HEADER_ONLY_COUNTS = Object.freeze({
  messageCount: 0,
  userCount: 0,
  assistantCount: 0,
  toolCallCount: 0,
  toolResultCount: 0,
});

const HEADER_ONLY_TOKENS = Object.freeze({ input: 0, output: 0, cacheRead: 0, reasoning: 0 });

// Readable error card for a session we found but cannot read. Keeps the
// session visible (never silently dropped) with whatever the header/dir knows.
function dshErrorSessionCard({ header, fileName, sessionDirName, formatVersion, error, unsupported }) {
  const isSubagent = header?.origin === 'subagent';
  return {
    id: header?.id || sessionDirName || null,
    timestamp: msToIso(header?.createdAt) || null,
    lastActivity: msToIso(header?.createdAt) || null,
    ...HEADER_ONLY_COUNTS,
    topTools: [],
    firstUserMessage: null,
    title: null,
    cwd: header?.cwd || null,
    origin: header?.origin || null,
    parentSession: header?.parentSession || null,
    delegationDepth: header?.delegationDepth ?? null,
    isSeeded: header?.isSeeded ?? null,
    agentPreset: header?.agentPreset || null,
    formatVersion: formatVersion ?? null,
    tokens: { ...HEADER_ONLY_TOKENS },
    file: fileName,
    error,
    ...(unsupported ? { unsupported: true } : {}),
    ...(isSubagent ? { status: 'subagent' } : {}),
  };
}

const parseDshSessionMetadata = withMetadataCache(_parseDshSessionMetadataRaw);

async function _parseDshSessionMetadataRaw(filePath, fileName, sessionDirName) {
  const name = fileName || path.basename(filePath);
  const dirName = sessionDirName || path.basename(path.dirname(filePath));
  const fileNameVersion = parseDshLogName(name)?.version ?? null;
  const base = { fileName: name, sessionDirName: dirName, formatVersion: fileNameVersion };

  // Size gate: never expand a compressed log past the limit just to list it.
  if (name.endsWith('.zstd')) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat && stat.size > DSH_MAX_COMPRESSED_BYTES) {
      return dshErrorSessionCard({
        ...base,
        error:
          `Dsh session log is too large to index: ${stat.size} bytes exceeds the 64 MB compressed limit ` +
          `(${DSH_MAX_COMPRESSED_BYTES} bytes)`,
      });
    }
  }

  let lines = [];
  try {
    lines = await readDshSessionLines(filePath);
  } catch (error) {
    return dshErrorSessionCard({ ...base, error: error.message });
  }

  let header = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimeMs = null;
  let firstUserMessage = null;
  let lastTitle = null;
  let lastTitleKind = null;
  const toolNames = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;

    if (rec.type === 'session' && !header) {
      header = rec;
      const problem = dshHeaderProblem(header, fileNameVersion);
      if (problem) {
        return dshErrorSessionCard({
          ...base,
          header,
          formatVersion: Number.isInteger(header.version) ? header.version : fileNameVersion,
          error: problem.message,
          unsupported: problem.code === 'DSH_UNSUPPORTED_VERSION',
        });
      }
      continue;
    }

    if (typeof rec.time === 'number' && (lastTimeMs === null || rec.time > lastTimeMs)) lastTimeMs = rec.time;

    const data = rec.data || {};
    if (rec.type === 'user/message') {
      if (!isDisplayableDshUserMessage(data)) continue;
      messageCount++;
      userCount++;
      if (!firstUserMessage) {
        const text = extractDshUserPromptText(data);
        if (text) firstUserMessage = text.slice(0, 120);
      }
    } else if (rec.type === 'assistant/message') {
      messageCount++;
      assistantCount++;
      if (data.usage) {
        tokens.input += data.usage.inputTokens || 0;
        tokens.output += data.usage.outputTokens || 0;
        tokens.cacheRead += data.usage.cacheReadTokens || 0;
        tokens.reasoning += data.usage.reasoningTokens || 0;
      }
    } else if (rec.type === 'tool/call') {
      toolCallCount++;
      const toolName = data.name || 'unknown';
      toolNames[toolName] = (toolNames[toolName] || 0) + 1;
    } else if (rec.type === 'tool/result') {
      toolResultCount++;
    } else if (rec.type === 'session/title') {
      const title = typeof data.title === 'string' ? data.title : null;
      if (title) {
        lastTitle = title;
        lastTitleKind = data.source?.kind || null;
      }
    }
  }

  if (!header) {
    return dshErrorSessionCard({ ...base, error: headerInvalidMessage('no session header found') });
  }

  return {
    id: header.id || dirName,
    timestamp: msToIso(header.createdAt) || null,
    lastActivity: msToIso(lastTimeMs),
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools: topToolsOf(toolNames),
    firstUserMessage: firstUserMessage || null,
    title: resolveDshTitle(lastTitle, lastTitleKind, firstUserMessage),
    cwd: header.cwd || null,
    origin: header.origin || null,
    parentSession: header.parentSession || null,
    delegationDepth: header.delegationDepth ?? null,
    isSeeded: header.isSeeded ?? null,
    agentPreset: header.agentPreset || null,
    formatVersion: header.version,
    tokens,
    file: name,
    ...(header.origin === 'subagent' ? { status: 'subagent' } : {}),
  };
}

async function listDshSessions(baseDir) {
  const files = await collectDshFiles(baseDir || DSH_DIR);
  const sessions = files.map((entry) =>
    parseDshSessionMetadata(entry.path, entry.file, entry.sessionId).catch(() => null)
  );
  const resolved = (await Promise.all(sessions)).filter(Boolean);
  return sortSessionsByTimestampDesc(resolved);
}

// --- Session detail ---

async function parseDshSessionFile(filePath) {
  // Detail gate: a compressed log above the limit is rejected with 413 before
  // any decompression happens.
  const stat = await fsp.stat(filePath);
  if (filePath.endsWith('.zstd') && stat.size > DSH_MAX_COMPRESSED_BYTES) {
    throw dshError(
      'DSH_LOG_TOO_LARGE',
      413,
      `Dsh session log is too large to open: ${stat.size} bytes exceeds the 64 MB compressed limit ` +
        `(${DSH_MAX_COMPRESSED_BYTES} bytes). Export it or open it in DeepSeek Harness instead.`
    );
  }

  const lines = await readDshSessionLines(filePath);
  const records = [];
  let header = null;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    records.push(rec);
    if (!header && rec?.type === 'session') {
      header = rec;
      headerIndex = i;
    }
  }

  const fileNameVersion = parseDshLogName(path.basename(filePath))?.version ?? null;
  const problem = dshHeaderProblem(header, fileNameVersion);
  if (problem) throw dshError(problem.code, problem.statusCode, problem.message);

  const messages = normalizeDshEvents(lines.slice(headerIndex + 1), { version: header.version });
  const { lastTitle, lastTitleKind, firstUserMessage } = collectDshTitleInfo(records);

  const session = {
    id: header.id || null,
    cwd: header.cwd || null,
    timestamp: msToIso(header.createdAt),
    version: header.version,
    formatVersion: header.version,
    origin: header.origin || null,
    parentSession: header.parentSession || null,
    delegationDepth: header.delegationDepth ?? null,
    isSeeded: header.isSeeded ?? null,
    agentPreset: header.agentPreset || null,
    title: resolveDshTitle(lastTitle, lastTitleKind, firstUserMessage),
    model: null,
    ...(header.origin === 'subagent' ? { status: 'subagent' } : {}),
  };
  const modeled = messages.find((m) => m.role === 'assistant' && m.model);
  if (modeled) session.model = modeled.model;
  return { session, messages };
}

module.exports = {
  HAS_NODE_ZSTD,
  DSH_MAX_COMPRESSED_BYTES,
  SUPPORTED_VERSIONS,
  DISPLAY_USER_KINDS,
  scanZstdFrames,
  decompressDshLog,
  readDshSessionLines,
  parseDshLogName,
  pickDshLogFile,
  collectDshFiles,
  findDshSessionFile,
  extractDshUserPromptText,
  isDisplayableDshUserMessage,
  parseDshSessionMetadata,
  listDshSessions,
  normalizeDshEvents,
  parseDshSessionFile,
};
