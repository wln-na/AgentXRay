const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { createCache } = require('./cache');
const { indexedCodexCandidates } = require('./search-index');
const { CLAUDE_CODE_DIR, HERMES_DIR, resolveDir } = require('./config');
const { PLATFORMS, platformSupports, collectSessionFiles } = require('./platforms');
const { readDshSessionLines } = require('./platforms/dsh');
const { foldGeminiRecords } = require('./platforms/gemini');
const { searchHermesSessions } = require('./platforms/hermes');

// ========= Full-text session search =========
// Multi-keyword AND search: whitespace-separated keywords must all appear
// somewhere in a session's text records; snippets come from the first keyword.
// Matching semantics are shared across every platform via SessionMatcher; only
// text extraction differs (raw JSONL stream, dsh event data, gemini fold).

const MAX_MATCHES_PER_SESSION = 3;
const SEARCH_CONCURRENCY = 6;
const searchFileCache = createCache({ max: 2000, ttl: 10 * 60 * 1000 });

async function mapConcurrentOrdered(items, concurrency, mapper) {
  if (!items.length) return [];
  const output = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

async function fileFingerprint(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function cloneSearchHit(hit) {
  if (!hit) return hit;
  return { ...hit, matches: (hit.matches || []).map((match) => ({ ...match })) };
}

async function searchFileCached(sf, keywords, searchOne) {
  const fingerprint = await fileFingerprint(sf.path);
  if (!fingerprint) return searchOne(sf, keywords);
  const cacheKey = `${sf.platform || ''}|${sf.path}|${fingerprint}|${keywords.join('\u0000')}`;
  const cached = searchFileCache.get(cacheKey);
  if (cached !== undefined) return cloneSearchHit(cached);
  const hit = await searchOne(sf, keywords);
  searchFileCache.set(cacheKey, cloneSearchHit(hit));
  return hit;
}

function runRipgrep(command, files, keyword) {
  return new Promise((resolve) => {
    const args = ['-l', '-i', '-F', '-e', keyword, '--', ...files.map((file) => file.path)];
    let stdout = '';
    let settled = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      if (code === 0) finish(new Set(stdout.split(/\r?\n/).filter(Boolean).map((entry) => path.resolve(entry))));
      else if (code === 1) finish(new Set());
      else finish(null);
    });
  });
}

async function ripgrepCandidatePaths(files, keywords, options = {}) {
  if (!files.length || !keywords.length) return null;
  const minFiles = options.minFiles ?? 8;
  if (files.length < minFiles) return null;
  const command = options.command || process.env.AGENTXRAY_RG_PATH || 'rg';
  const chunkSize = options.chunkSize || 200;
  const candidates = new Set();
  for (let start = 0; start < files.length; start += chunkSize) {
    const batch = await runRipgrep(command, files.slice(start, start + chunkSize), keywords[0]);
    if (batch === null) return null;
    for (const filePath of batch) candidates.add(filePath);
  }
  return candidates;
}

async function prefilterJsonlFiles(files, keywords, options = {}) {
  if (options.enabled === false) return files;
  const candidates = await ripgrepCandidatePaths(files, keywords, options);
  if (candidates === null) return files;
  return files.filter((file) => candidates.has(path.resolve(file.path)));
}

// A ±(40/60)-char window around the first keyword's first occurrence.
function extractSnippet(text, keyword) {
  const idx = text.toLowerCase().indexOf(keyword);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + keyword.length + 60);
  return (start > 0 ? '\u2026' : '') + text.slice(start, end) + (end < text.length ? '\u2026' : '');
}

// Accumulates keyword sightings + snippets for one session.
// A session satisfies the query when every keyword appeared somewhere in it
// and at least one snippet (first keyword) was captured.
function hasMutationEvidence(text, keyword) {
  const lower = text.toLowerCase();
  const index = lower.indexOf(keyword);
  if (index < 0) return false;
  const nearby = lower.slice(Math.max(0, index - 320), Math.min(lower.length, index + keyword.length + 320));
  return /\b(?:mkdir|install(?:ed|ing)?|create(?:d|ing)?|write|add(?:ed|ing)?|copy|symlink|ln\s+-s)\b/i.test(nearby);
}

function searchEvidenceScore(text, source, keyword) {
  const sourceScore = {
    command: 40,
    tool_arguments: 35,
    tool_result: 30,
    message: 20,
    reasoning: 15,
    working_directory: 5,
  }[source] || 10;
  return sourceScore + (hasMutationEvidence(text, keyword) ? 20 : 0);
}

function createSessionMatcher(keywords) {
  const matches = [];
  const seen = new Set();
  const preferMutationEvidence = keywords.length === 2 && keywords[1].includes('/');
  return {
    matches,
    // Ordinary text queries retain the old three-snippet early stop. Full-path
    // provenance queries continue until a create/install/write signal appears.
    get done() {
      if (seen.size !== keywords.length) return false;
      if (preferMutationEvidence) return matches.some((match) => match.evidenceType === 'mutation');
      return matches.length >= MAX_MATCHES_PER_SESSION;
    },
    // Include this session in the results
    get satisfied() {
      return matches.length > 0 && seen.size === keywords.length;
    },
    consider(text, role, timestamp, metadata = {}) {
      if (!text) return;
      const textLower = text.toLowerCase();
      for (const kw of keywords) {
        if (textLower.includes(kw)) seen.add(kw);
      }
      if (!textLower.includes(keywords[0])) return;
      const actionEvidence = ['command', 'tool_arguments', 'tool_result'].includes(metadata.source) && hasMutationEvidence(text, keywords[0]);
      const candidate = {
        role,
        snippet: extractSnippet(text, keywords[0]),
        timestamp,
        ...metadata,
        matchedTerm: keywords[0],
        score: searchEvidenceScore(text, metadata.source, keywords[0]),
        ...(actionEvidence ? { evidenceType: 'mutation' } : {}),
      };
      const duplicate = matches.find(
        (match) => match.source === candidate.source && match.snippet === candidate.snippet
      );
      if (duplicate) return;
      matches.push(candidate);
      matches.sort((a, b) => b.score - a.score || String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
      if (matches.length > MAX_MATCHES_PER_SESSION) matches.length = MAX_MATCHES_PER_SESSION;
    },
  };
}

// A full path may be split across structured records: tool arguments carry the
// workdir while tool output names the created child directory. Search it as
// "basename AND parent path", with the basename first so snippets show the
// action/result rather than only the working directory.
function buildSearchKeywords(q) {
  const normalized = q.trim().toLowerCase();
  if (!normalized) return [];
  if ((normalized.startsWith('/') || normalized.startsWith('~/')) && normalized.includes('/')) {
    const clean = normalized.replace(/\/+$/, '');
    const base = path.basename(clean).replace(/^\.+/, '') || path.basename(clean);
    const parent = path.dirname(clean);
    return [...new Set([base, parent].filter(Boolean))];
  }
  return normalized.split(/\s+/).filter(Boolean);
}

function stringifySearchValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function contentSearchDocuments(content, context = {}) {
  const docs = [];
  const parts = Array.isArray(content)
    ? content
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : [];
  const text = parts
    .filter((part) => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || part.type === 'reasoning'))
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n');
  if (text) docs.push({ text, source: context.source || 'message', role: context.role || '', messageId: context.messageId || null });
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'tool_use' || part.type === 'toolCall' || part.type === 'function_call') {
      const args = stringifySearchValue(part.input ?? part.arguments);
      if (args) {
        docs.push({
          text: args,
          source: 'tool_arguments',
          role: 'toolCall',
          messageId: part.id || context.messageId || null,
          toolName: part.name || context.toolName || null,
        });
      }
    } else if (part.type === 'tool_result' || part.type === 'function_call_output') {
      const output = stringifySearchValue(part.content ?? part.output ?? part.text);
      if (output) {
        docs.push({
          text: output,
          source: 'tool_result',
          role: 'toolResult',
          messageId: part.tool_use_id || context.messageId || null,
          toolName: context.toolName || null,
        });
      }
    }
  }
  return docs;
}

// Turn one raw JSONL record into focused searchable documents. This deliberately
// avoids indexing the entire JSON blob (system prompts, token counters, metadata
// noise) while covering the evidence users need for provenance questions:
// messages/reasoning, tool arguments, command/cwd, and tool stdout/stderr.
function extractSearchDocuments(rec) {
  const docs = [];
  const payload = rec?.payload || {};
  const timestamp = rec?.timestamp || null;
  const payloadType = payload.type || '';
  const messageId = payload.call_id || payload.id || rec?.id || rec?.uuid || null;

  if ((rec?.type === 'session_meta' && payload.cwd) || (rec?.type === 'session' && rec.cwd)) {
    docs.push({ text: String(payload.cwd || rec.cwd), source: 'working_directory', role: 'session', messageId: null, timestamp });
  }

  if (payloadType === 'message') {
    docs.push(
      ...contentSearchDocuments(payload.content, {
        source: payload.role === 'reasoning' ? 'reasoning' : 'message',
        role: payload.role || 'message',
        messageId,
      }).map((doc) => ({ ...doc, timestamp }))
    );
  } else if (payloadType === 'user_message' && typeof payload.message === 'string') {
    docs.push({ text: payload.message, source: 'message', role: 'user', messageId, timestamp });
  } else if (payloadType === 'reasoning') {
    const text = stringifySearchValue(payload.text || payload.summary || payload.content);
    if (text) docs.push({ text, source: 'reasoning', role: 'reasoning', messageId, timestamp });
  } else if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const args = stringifySearchValue(payload.arguments ?? payload.input);
    if (args) docs.push({ text: args, source: 'tool_arguments', role: 'toolCall', messageId, toolName: payload.name || null, timestamp });
  } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    const output = stringifySearchValue(payload.output);
    if (output) docs.push({ text: output, source: 'tool_result', role: 'toolResult', messageId, timestamp });
  }

  const item = payloadType === 'item_completed' && payload.item && typeof payload.item === 'object' ? payload.item : null;
  if (item?.type === 'CommandExecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : stringifySearchValue(item.command);
    if (command) docs.push({ text: command, source: 'command', role: 'toolCall', messageId: item.id || messageId, toolName: 'exec', action: command, timestamp });
    if (item.cwd) docs.push({ text: String(item.cwd).replace(/^file:\/\//, ''), source: 'working_directory', role: 'toolCall', messageId: item.id || messageId, toolName: 'exec', action: command || null, timestamp });
    for (const output of [item.stdout, item.stderr, item.aggregated_output]) {
      if (output) docs.push({ text: String(output), source: 'tool_result', role: 'toolResult', messageId: item.id || messageId, toolName: 'exec', action: command || null, timestamp });
    }
  } else if (item?.type === 'Reasoning') {
    const text = stringifySearchValue(item.text || item.summary || item.content);
    if (text) docs.push({ text, source: 'reasoning', role: 'reasoning', messageId: item.id || messageId, timestamp });
  }

  // Claude/OpenClaw/OMP/Doubao-style records put the normalized message at
  // rec.message or top level instead of response_item.payload.
  const msg = rec?.message || (rec?.role || rec?.content ? rec : null);
  if (msg && payloadType !== 'message') {
    docs.push(
      ...contentSearchDocuments(msg.content, {
        source: msg.role === 'reasoning' ? 'reasoning' : 'message',
        role: msg.role || rec.type || 'message',
        messageId: msg.id || rec.uuid || rec.id || null,
        toolName: msg.toolName || null,
      }).map((doc) => ({ ...doc, timestamp }))
    );
    if (msg.details) {
      const details = stringifySearchValue(msg.details);
      if (details) docs.push({ text: details, source: 'tool_arguments', role: msg.role || 'toolCall', messageId: msg.id || rec.uuid || null, toolName: msg.toolName || null, timestamp });
    }
  }

  return docs;
}

// Quick line-level pre-filter: skip lines that can't contain any keyword.
function lineMayMatch(line, keywords) {
  const lower = line.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// Generic JSONL platforms (openclaw, codex, claude-code, omp): stream the raw
// file; message text lives under rec.message?.content or rec.payload?.content.
async function searchJsonlFile(sf, keywords) {
  const matcher = createSessionMatcher(keywords);
  const stream = fs.createReadStream(sf.path, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = sf.sessionId || sf.file.split('.jsonl')[0];

  try {
    for await (const line of rl) {
      if (matcher.done) break;
      if (!lineMayMatch(line, keywords)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract session id. Registry-provided rootSessionId is authoritative
      // for adapters whose product-level id differs from the embedded CLI id.
      if (!sf.rootSessionId) {
        if (rec.type === 'session' && rec.id) sessionId = rec.id;
        if (rec.sessionId) sessionId = rec.sessionId;
      }

      for (const doc of extractSearchDocuments(rec)) {
        matcher.consider(doc.text, doc.role, doc.timestamp ?? rec.timestamp ?? null, {
          source: doc.source,
          messageId: doc.messageId || null,
          ...(doc.toolName ? { toolName: doc.toolName } : {}),
          ...(doc.action ? { action: doc.action } : {}),
        });
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!matcher.satisfied) return null;
  return {
    sessionId: sf.rootSessionId || sessionId,
    childSessionId: sf.parentThreadId ? sessionId : undefined,
    file: sf.file,
    platform: sf.platform,
    ...(sf.agent ? { agent: sf.agent } : {}),
    ...(sf.dataSource ? { dataSource: sf.dataSource } : {}),
    ...(sf.cwd ? { cwd: sf.cwd } : {}),
    ...(sf.originator ? { originator: sf.originator } : {}),
    ...(sf.agentRole ? { agentRole: sf.agentRole } : {}),
    ...(sf.agentNickname ? { agentNickname: sf.agentNickname } : {}),
    matches: matcher.matches,
  };
}

// dsh logs may be zstd-compressed and nest text under event.data — read them
// via the adapter's line reader instead of the raw stream.
async function searchDshFile(sf, keywords) {
  let lines;
  try {
    lines = await readDshSessionLines(sf.path);
  } catch {
    return null;
  }
  const matcher = createSessionMatcher(keywords);
  let sessionId = sf.sessionId;
  for (const line of lines) {
    if (matcher.done) break;
    if (!lineMayMatch(line, keywords)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session' && rec.id) sessionId = rec.id;
    const data = rec.data || {};
    const timestamp = typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null;
    if (rec.type === 'session' && (rec.cwd || data.cwd)) {
      matcher.consider(String(rec.cwd || data.cwd), 'session', timestamp, { source: 'working_directory', messageId: null });
    }
    if (rec.type === 'tool/call') {
      const args = stringifySearchValue(data.arguments);
      matcher.consider(args, 'toolCall', timestamp, {
        source: 'tool_arguments',
        messageId: data.callId || null,
        toolName: data.name || null,
      });
      continue;
    }
    if (rec.type === 'tool/result') {
      const result = stringifySearchValue(data.message?.content || data.content || data.result);
      matcher.consider(result, 'toolResult', timestamp, {
        source: 'tool_result',
        messageId: data.callId || data.message?.source?.callId || null,
      });
      continue;
    }
    const msg = rec.type === 'user/message' ? data : data.message || {};
    const role = msg.role || rec.type || '';
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const doc of contentSearchDocuments(content, {
      source: role === 'assistant' ? 'message' : role,
      role,
      messageId: msg.id || null,
    })) {
      matcher.consider(doc.text, doc.role, timestamp, {
        source: doc.source,
        messageId: doc.messageId || null,
        ...(doc.toolName ? { toolName: doc.toolName } : {}),
      });
    }
  }
  if (!matcher.satisfied) return null;
  return { sessionId, file: sf.file, platform: 'dsh', matches: matcher.matches };
}

// Gemini records keep text at the top level (content: string | Part[]) and
// fold history via $rewindTo/$set — reuse the adapter's fold, then match.
async function searchGeminiFile(sf, keywords) {
  let folded;
  try {
    const text = await fsp.readFile(sf.path, 'utf8');
    folded = foldGeminiRecords(text.split('\n').filter((l) => l.trim()));
  } catch {
    return null;
  }
  const matcher = createSessionMatcher(keywords);
  const sessionId = folded.metadata.sessionId || sf.file.replace(/\.jsonl$/, '');
  if (Array.isArray(folded.metadata.directories)) {
    for (const directory of folded.metadata.directories) {
      matcher.consider(String(directory), 'session', folded.metadata.startTime || null, {
        source: 'working_directory',
        messageId: null,
      });
    }
  }
  for (const rec of folded.messages) {
    if (matcher.done) break;
    const timestamp = rec.timestamp || null;
    const messageText = typeof rec.content === 'string'
      ? rec.content
      : Array.isArray(rec.content)
        ? rec.content.filter((part) => part && typeof part.text === 'string').map((part) => part.text).join('\n')
        : '';
    matcher.consider(messageText, rec.type === 'gemini' ? 'assistant' : rec.type || '', timestamp, {
      source: 'message',
      messageId: rec.id || null,
    });
    if (Array.isArray(rec.thoughts)) {
      const thoughts = rec.thoughts.map((thought) => [thought.subject, thought.description].filter(Boolean).join(': ')).join('\n');
      matcher.consider(thoughts, 'reasoning', timestamp, { source: 'reasoning', messageId: rec.id ? `${rec.id}-reasoning` : null });
    }
    for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
      matcher.consider(stringifySearchValue(call.args), 'toolCall', call.timestamp || timestamp, {
        source: 'tool_arguments',
        messageId: call.id || null,
        toolName: call.name || null,
      });
      matcher.consider(stringifySearchValue(call.result), 'toolResult', call.timestamp || timestamp, {
        source: 'tool_result',
        messageId: call.id || null,
        toolName: call.name || null,
      });
    }
  }
  if (!matcher.satisfied) return null;
  return { sessionId, file: sf.file, platform: 'gemini', matches: matcher.matches };
}

// Claude Code prompt history (~/.claude/history.jsonl): surfaces prompts whose
// sessions were removed by Claude's cleanupPeriodDays retention. Grouped by
// project; prompts whose snippet already appears in a live hit are skipped.
async function searchClaudeHistory(claudeDir, keywords, liveSnippets) {
  const historyPath = path.join(path.dirname(claudeDir), 'history.jsonl');
  const byProject = new Map(); // project → matches[]
  const results = [];
  try {
    const stream = fs.createReadStream(historyPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const lower = line.toLowerCase();
        if (!keywords.every((kw) => lower.includes(kw))) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const text = typeof rec.display === 'string' ? rec.display : '';
        const textLower = text.toLowerCase();
        if (!keywords.every((kw) => textLower.includes(kw))) continue;
        const snippet = extractSnippet(text, keywords[0]);
        const project = rec.project || '?';
        if (liveSnippets.has(snippet)) continue; // prompt belongs to a still-live session
        if (!byProject.has(project)) byProject.set(project, []);
        const matches = byProject.get(project);
        if (matches.length < 5) matches.push({ role: 'user', snippet, timestamp: rec.timestamp || null });
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    for (const [project, matches] of byProject) {
      results.push({
        sessionId: null,
        file: 'history.jsonl',
        platform: 'claude-code',
        project,
        history: true,
        matches,
      });
    }
  } catch {
    /* no history file */
  }
  return results;
}

const PLATFORM_DIR_PARAMS = {
  openclaw: 'dirOpenclaw',
  codex: 'dirCodex',
  'claude-code': 'dirClaude',
  'claude-desktop': 'dirClaudeDesktop',
  omp: 'dirOmp',
  dsh: 'dirDsh',
  gemini: 'dirGemini',
  doubao: 'dirDoubao',
};

// File-backed searchable platforms use dir override params in all-platform mode.
// Hermes and Doubao keep their dedicated search paths below.
const DIR_PARAMS = Object.fromEntries(
  Object.entries(PLATFORM_DIR_PARAMS).filter(([id]) => platformSupports(id, 'search'))
);

// Resolve and clamp the `limit` query parameter. Rejects NaN, zero,
// negatives and non-numeric strings (including partial numbers like
// "12abc") by falling back to the default of 50; caps at 100.
function resolveSearchLimit(raw) {
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}

// Search orchestrator. `query` is the raw req.query object: q, platform,
// limit and the dir overrides (dir in single-platform mode, dirXxx in `all`).
// `agent` is the sanitized openclaw agent filter.
async function searchSessions(query, agent) {
  const q = (query.q || '').trim().toLowerCase();
  if (!q) return [];
  const platform = query.platform || 'openclaw';
  const maxResults = resolveSearchLimit(query.limit);
  const keywords = buildSearchKeywords(q);
  const pathQuery = keywords.length === 2 && keywords[1].includes('/');

  const all = platform === 'all';
  const dirParamFor = (key) => (all ? query[key] : query.dir) || '';

  if (platform === 'hermes' && !all) {
    const dir = resolveDir(query.dir, HERMES_DIR);
    return searchHermesSessions(dir, q, maxResults);
  }

  // Collect candidate files per platform via the registry, in a stable order:
  // openclaw, codex, claude-code, omp, dsh, gemini. The claude-code subagents
  // dir is excluded (children surface under their parent) and gemini ids
  // resolve from the folded metadata during matching.
  const wanted = Object.keys(DIR_PARAMS).filter((id) => platform === id || all);
  const collected = await Promise.all(
    wanted.map(async (id) => {
      const agentFor = id === 'openclaw' && !all ? agent : '';
      const files = await collectSessionFiles(id, agentFor, dirParamFor(DIR_PARAMS[id]), {
        subagents: id === 'codex',
        resolveIds: false,
      }).catch(() => []);
      return files.map((f) => ({ ...f, platform: id }));
    })
  );
  const byPlatform = new Map(wanted.map((id, i) => [id, collected[i]]));

  const results = [];
  if (wanted.includes('doubao') && PLATFORMS.doubao.search) {
    const doubaoDir = resolveDir(dirParamFor('dirDoubao'), PLATFORMS.doubao.defaultDir());
    const cachedHits = await PLATFORMS.doubao.search(doubaoDir, q).catch(() => []);
    results.push(...cachedHits.slice(0, maxResults));
  }
  const codexFiles = byPlatform.get('codex') || [];
  const indexedCodexFiles =
    codexFiles.length >= 8
      ? await indexedCodexCandidates(codexFiles, keywords, extractSearchDocuments, {
          sourceDir: resolveDir(dirParamFor('dirCodex'), PLATFORMS.codex.defaultDir()),
        })
      : null;
  const codexCandidates = indexedCodexFiles === null ? codexFiles : indexedCodexFiles;
  const jsonlFiles = await prefilterJsonlFiles(
    [
      ...(byPlatform.get('openclaw') || []),
      ...codexCandidates,
      ...(byPlatform.get('claude-code') || []),
      ...(byPlatform.get('claude-desktop') || []),
      ...(byPlatform.get('omp') || []),
      ...(byPlatform.get('doubao') || []),
    ],
    keywords
  );
  const searchers = [
    [jsonlFiles, searchJsonlFile],
    [byPlatform.get('dsh') || [], searchDshFile],
    [byPlatform.get('gemini') || [], searchGeminiFile],
  ];
  for (const [files, searchOne] of searchers) {
    for (let start = 0; start < files.length; start += SEARCH_CONCURRENCY) {
      if (!pathQuery && results.length >= maxResults) break;
      const batch = files.slice(start, start + SEARCH_CONCURRENCY);
      const hits = await mapConcurrentOrdered(batch, SEARCH_CONCURRENCY, (sf) =>
        searchFileCached(sf, keywords, searchOne)
      );
      for (const hit of hits) {
        if (!hit) continue;
        const existing = results.find((item) => item.platform === hit.platform && item.sessionId === hit.sessionId);
        if (existing) {
          const seen = new Set(
            existing.matches.map((match) => `${match.role}|${match.snippet}|${match.timestamp || ''}`)
          );
          for (const match of hit.matches) {
            const key = `${match.role}|${match.snippet}|${match.timestamp || ''}`;
            if (!seen.has(key) && existing.matches.length < 5) existing.matches.push(match);
          }
        } else if (pathQuery || results.length < maxResults) {
          results.push(hit);
        }
      }
    }
  }

  // Claude Code retention fallback: prompt history
  if (platform === 'claude-code' || all) {
    const dir = resolveDir(dirParamFor('dirClaude'), CLAUDE_CODE_DIR);
    const liveSnippets = new Set(results.flatMap((r) => r.matches.map((m) => m.snippet)));
    const historyHits = await searchClaudeHistory(dir, keywords, liveSnippets);
    for (const hit of historyHits) {
      if (!pathQuery && results.length >= maxResults) break;
      results.push(hit);
    }
  }

  // Hermes stores sessions in SQLite; merge its hits in all-platform mode
  if (all) {
    try {
      const remaining = Math.max(0, maxResults - results.length);
      if (remaining > 0) {
        results.push(...searchHermesSessions(resolveDir(dirParamFor('dirHermes'), HERMES_DIR), q, remaining));
      }
    } catch {
      /* no hermes db */
    }
  }

  if (pathQuery) {
    results.sort((a, b) => {
      const scoreOf = (result) => Math.max(0, ...(result.matches || []).map((match) => match.score || 0));
      const scoreDiff = scoreOf(b) - scoreOf(a);
      if (scoreDiff) return scoreDiff;
      const timeOf = (result) => (result.matches || []).map((match) => match.timestamp || '').filter(Boolean).sort()[0] || '';
      return timeOf(a).localeCompare(timeOf(b));
    });
  }
  return results.slice(0, maxResults);
}

module.exports = {
  extractSnippet,
  createSessionMatcher,
  buildSearchKeywords,
  extractSearchDocuments,
  mapConcurrentOrdered,
  searchFileCached,
  ripgrepCandidatePaths,
  prefilterJsonlFiles,
  clearSearchFileCache: () => searchFileCache.clear(),
  resolveSearchLimit,
  searchSessions,
};
