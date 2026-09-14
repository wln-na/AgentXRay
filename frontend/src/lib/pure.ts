// Pure (no-DOM) helpers shared by the React UI and (via the generated
// public/js/pure.js bundle — see scripts/build-legacy-pure.mjs) the frozen
// legacy UI and node tests. This file IS the single source of truth.

import type { MessageContentPart, SessionMessage } from '@/api/types';

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function parseTimestampMs(value: string | number | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function formatDurationCompact(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0s';
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 10) {
    return `${Math.round(totalSeconds * 10) / 10}s`;
  }
  const roundedSeconds = Math.round(totalSeconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes ? `${minutes}m` : ''}${!minutes && seconds ? `${seconds}s` : ''}`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds ? `${seconds}s` : ''}`;
  }
  return `${seconds}s`;
}

export function formatCost(dollars: number): string {
  return '$' + (dollars >= 0.01 ? dollars.toFixed(2) : dollars.toFixed(4));
}

// First-launch auto-pick (#13): the first platform, in display order, that
// actually has sessions. null = every platform empty (or probe not done yet).
export function pickAutoPlatform<P extends string>(
  counts: Partial<Record<P, number>> | null | undefined,
  order: readonly P[]
): P | null {
  if (!counts) return null;
  for (const p of order) {
    if ((counts[p] ?? 0) > 0) return p;
  }
  return null;
}

// First line that carries information — skips structural-only lines
// ({ } [ ] ``` etc.) so JSON-body errors don't render as a lone symbol
export function firstInformativeLine(text: string | null | undefined): string {
  const joined = String(text || '');
  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[{}[\]()`"',;:.\-=|\\/*+\s]+$/.test(line)) continue;
    return line.slice(0, 200);
  }
  return joined.trim().replace(/\s+/g, ' ').slice(0, 200);
}

export function getTextContent(content: MessageContentPart[] | null | undefined): string {
  return (content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text || '')
    .join('\n\n');
}

export interface ClusterLike {
  samples?: (string | null | undefined)[];
  examples?: (string | null | undefined)[];
  pattern?: string;
}

// 入库 prefill: longest common prefix of a cluster's example prompts when it is a
// meaningful template (≥30 chars), with the variable tail replaced by $ARGUMENTS;
// otherwise the first example verbatim.
export function clusterPrefillContent(c: ClusterLike): string {
  const examples = (c.samples || c.examples || []).map((s) => String(s || '')).filter(Boolean);
  if (!examples.length) return c.pattern || '';
  let prefix = examples[0];
  for (const ex of examples.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < ex.length && prefix[i] === ex[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (examples.length > 1 && prefix.trim().length >= 30 && prefix.length < examples[0].length) {
    return prefix.replace(/\s+$/, '') + ' $ARGUMENTS';
  }
  return examples[0];
}

export interface AgentSpan {
  name: string;
  label?: string | null;
  start: number | null | undefined;
  end?: number | null;
}

export interface TraceSpan {
  kind: 'chat' | 'tool' | 'tool-error' | 'agent';
  label: string;
  start: number;
  end: number;
  durationSource?: 'measured' | 'estimated' | 'unknown';
  msgId?: string;
  toolCallId?: string;
  agentName?: string;
  /** Concrete subject extracted from tool args (file path, command line, query…).
   *  Borrowed from botmux's CoT title: `读取文件 · /path/to/file.ts` instead
   *  of a bare `Read`. Empty when the args carry no recognisable subject. */
  subject?: string;
  /** For chat spans: whether the assistant message contains actual text content
   *  (a visible reply). `false` means the span is pure reasoning / tool-call
   *  prep with no user-visible text — rendered lighter in the waterfall. */
  hasText?: boolean;
  /** For chat spans: true when this is the turn's final text reply (the last
   *  chat span that carries text). Highlighted in the waterfall. */
  isFinalReply?: boolean;
}

export interface TraceTurn {
  start: number;
  end: number;
  text: string;
  spans: TraceSpan[];
}

// ─── Tool metadata helpers (borrowed from botmux's CoT renderer) ─────────
// botmux maps raw CLI tool names (Bash / Read / Grep / …) to human-readable
// Chinese category labels and extracts a one-line subject (file path, command
// line, query) from the args. The same idea here makes the Trace waterfall
// scannable: `📖 读取文件 · src/foo.ts` instead of `🔧 Read`.

export interface ToolMeta {
  icon: string;
  label: string;
}

/** Map a raw tool name to its Chinese category label + icon. Matches by
 *  lowercase substring so it works across Claude's Bash/Read/Grep, Codex's
 *  local_shell_call / file_read, Gemini's run_terminal / view_file, MCP
 *  tools, and Doubao/Cursor-style names without a per-CLI table. */
export function toolMeta(name: string): ToolMeta {
  const n = (name || '').toLowerCase();
  // Shell / command execution (Claude Bash, Codex local_shell_call,
  // Gemini run_terminal, MCP execute_command, Doubao run_shell)
  if (
    n.includes('bash') || n.includes('shell') || n.includes('command') ||
    n.includes('exec') || n.includes('terminal') || n.includes('run_command') ||
    n.includes('execute') || n.includes('subprocess')
  )
    return { icon: '⌨️', label: '执行命令' };
  // File write / edit / create (Claude Write/Edit, Codex file_write,
  // Gemini edit_file, MCP write_file)
  if (
    n.includes('write') || n.includes('edit') || n.includes('patch') ||
    n.includes('create') || n.includes('save') || n.includes('apply') ||
    n.includes('modify') || n.includes('replace')
  )
    return { icon: '✏️', label: '编辑文件' };
  // File read / view (Claude Read, Codex file_read, Gemini view_file,
  // MCP read_file, notebook_view)
  if (
    n.includes('read') || n.includes('notebook') || n.includes('view') ||
    n.includes('cat') || n.includes('open') || n.includes('inspect') ||
    n.includes('load')
  )
    return { icon: '📖', label: '读取文件' };
  // Search / grep / find (Claude Grep/Glob, MCP search, code_search)
  if (
    n.includes('grep') || n.includes('glob') || n.includes('search') ||
    n.includes('fetch') || n.includes('find') || n.includes('lookup') ||
    n.includes('query') || n.includes('scan')
  )
    return { icon: '🔍', label: '搜索' };
  // Task / todo / plan management
  if (
    n.includes('task') || n.includes('todo') || n.includes('plan') ||
    n.includes('list') || n.includes('checklist') || n.includes('reminder')
  )
    return { icon: '📋', label: '任务管理' };
  // Browser / desktop / GUI automation (Claude Computer, browser_use,
  // MCP browser, screenshot, click)
  if (
    n.includes('browser') || n.includes('computer') || n.includes('click') ||
    n.includes('screenshot') || n.includes('gui') || n.includes('desktop') ||
    n.includes('navigate') || n.includes('scroll') || n.includes('type')
  )
    return { icon: '🖥️', label: '浏览器/桌面' };
  // Web / HTTP / network requests (web_fetch, http_request, curl)
  if (
    n.includes('web') || n.includes('http') || n.includes('request') ||
    n.includes('curl') || n.includes('api') || n.includes('url') ||
    n.includes('download') || n.includes('scrape')
  )
    return { icon: '🌐', label: '网络请求' };
  // Version control (git_commit, git_diff, git_log)
  if (n.includes('git') || n.includes('commit') || n.includes('diff') || n.includes('merge'))
    return { icon: '🌿', label: '版本控制' };
  // Database / SQL (sql_query, database_query, run_sql)
  if (n.includes('sql') || n.includes('database') || n.includes('db_') || n.includes('query_db'))
    return { icon: '🗄️', label: '数据库' };
  // File system ops (ls, mkdir, rm, mv, cp, file_system)
  if (
    n.includes('mkdir') || n.includes('remove') || n.includes('delete_file') ||
    n.includes('move') || n.includes('rename') || n.includes('copy') ||
    n.includes('file_system') || n.includes('fs_')
  )
    return { icon: '📁', label: '文件操作' };
  // Test / run / build (run_tests, build, npm_test)
  if (n.includes('test') || n.includes('build') || n.includes('compile') || n.includes('lint'))
    return { icon: '🧪', label: '测试/构建' };
  // Knowledge / docs / context retrieval
  if (n.includes('knowledge') || n.includes('doc') || n.includes('context') || n.includes('memory'))
    return { icon: '📚', label: '知识检索' };
  return { icon: '🔧', label: name || '调用工具' };
}

/** Fields ordered by how well each identifies the call to a human reader.
 *  `command` covers Claude's Bash and Codex's local_shell_call; `file_path`
 *  covers Read/Write/Edit; `pattern`/`query` cover search tools. Extended
 *  to cover Gemini (code, file_path), MCP (input, path), Doubao (content),
 *  and generic tool arg names. */
const TOOL_SUBJECT_FIELDS = [
  // Shell / command
  'command', 'cmd', 'code', 'script', 'shell', 'bash',
  // File paths
  'file_path', 'path', 'file', 'filename', 'file_name', 'source', 'target', 'destination',
  // Search / query
  'pattern', 'query', 'search', 'keyword', 'keywords', 'regex',
  // URL / web
  'url', 'uri', 'endpoint', 'link',
  // Generic
  'skill', 'subject', 'description', 'prompt', 'name', 'title', 'input', 'content', 'text',
  // Database
  'sql', 'database', 'db', 'table',
  // Git
  'branch', 'commit', 'message',
] as const;

const TOOL_SUBJECT_MAX_CHARS = 80;

/** Extract a one-line subject from tool args (JSON object or raw string).
 *  Returns '' when no recognisable field is present (caller keeps the bare
 *  category label). Multi-line scripts collapse to one line; truncated at 80
 *  chars with an ellipsis — the Trace bar is a single line, not a payload
 *  viewer (full args live in the SpanSidebar). */
export function extractToolSubject(args: unknown): string {
  if (args == null) return '';
  let raw = '';
  if (typeof args === 'string') {
    raw = args;
  } else if (typeof args === 'object') {
    const o = args as Record<string, unknown>;
    const pick = TOOL_SUBJECT_FIELDS
      .map((k) => o[k])
      .find((v) => (typeof v === 'string' && v.trim().length > 0) || Array.isArray(v));
    if (pick === undefined) return '';
    // local_shell_call renders `command` as ["bash","-lc","…"] — last element
    // is the script; joining argv would bury it in boilerplate.
    raw = Array.isArray(pick)
      ? String(pick[pick.length - 1] ?? '').trim()
      : String(pick).trim();
  }
  if (!raw) return '';
  // Truncated JSON: try to recover the first priority field via regex before
  // giving up (the transcript layer may hard-cut long Write/Edit payloads).
  if (raw.startsWith('{') && raw.length > 200) {
    for (const key of TOOL_SUBJECT_FIELDS) {
      const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (m) {
        try {
          const v = JSON.parse(`"${m[1]}"`);
          if (typeof v === 'string' && v.trim()) raw = v.trim();
          break;
        } catch {
          /* bad escape — try next key */
        }
      }
    }
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > TOOL_SUBJECT_MAX_CHARS
    ? `${collapsed.slice(0, TOOL_SUBJECT_MAX_CHARS)}…`
    : collapsed;
}

// ─── Tool result syntax highlighting (borrowed from botmux's CoT renderer) ─
// botmux maps tool output to a syntax-highlight language based on the tool
// name and the file extension in its subject. Same idea here: the SpanSidebar
// renders tool results as Markdown code blocks, and passing the right language
// lets the highlighter colour shell output / JSON / TypeScript / etc.

const EXT_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', sql: 'sql', md: 'markdown',
};

/** Resolve a syntax-highlight language for a tool's output.
 *  - shell/command tools → bash (their output is shell-shaped regardless of
 *    what file the command touched)
 *  - search/fetch tools → undefined (they return match lists / rendered pages,
 *    not the file the subject names)
 *  - file read/write tools → language from the subject's file extension
 *  Returns undefined when no language can be determined (caller renders plain). */
export function resultLanguage(toolName: string | undefined, subject: string | undefined): string | undefined {
  if (!toolName) return undefined;
  const n = toolName.toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('command') || /(^|[^a-z])exec([^a-z]|$)/.test(n))
    return 'bash';
  if (n.includes('fetch') || n.includes('search') || n.includes('grep') || n.includes('glob'))
    return undefined;
  const ext = subject?.match(/\.([A-Za-z0-9]+)\s*$/)?.[1]?.toLowerCase();
  return ext ? EXT_LANGUAGES[ext] : undefined;
}

// Build spans from normalized messages: chat spans from message-timestamp deltas,
// tool spans from toolCall→toolResult pairing (both standalone records and content parts).
export function buildTraceTurns(msgs: SessionMessage[], agentSpans: AgentSpan[] = []): TraceTurn[] {
  const ts = (m: SessionMessage) => parseTimestampMs(m.timestamp);
  const calls = new Map<
    string,
    { name: string; ts: number | null; msgId: string; estimatedDurationMs: number | null; args: unknown }
  >(); // callId → { name, ts, msgId, estimatedDurationMs, args }
  const results = new Map<string, { ts: number | null; isError: boolean }>(); // callId → { ts, isError }
  for (const m of msgs) {
    const t = ts(m);
    if (m.role === 'toolCall' && m.toolCallId)
      calls.set(m.toolCallId, {
        name: m.toolName || '?',
        ts: t,
        msgId: m.id,
        estimatedDurationMs:
          typeof m.details?.estimatedDurationMs === 'number' && m.details.estimatedDurationMs > 0
            ? m.details.estimatedDurationMs
            : null,
        args: m.details ?? null,
      });
    if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, { ts: t, isError: !!m.isError });
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.id)
        calls.set(c.id, {
          name: c.name || '?',
          ts: t,
          msgId: m.id,
          estimatedDurationMs:
            typeof c.estimatedDurationMs === 'number' && c.estimatedDurationMs > 0 ? c.estimatedDurationMs : null,
          args: (c as MessageContentPart).arguments ?? (c as MessageContentPart).input ?? null,
        });
      if (c.type === 'tool_result' && c.tool_use_id) results.set(c.tool_use_id, { ts: t, isError: !!c.is_error });
    }
  }

  const turns: TraceTurn[] = [];
  let turn: TraceTurn | null = null;
  let prevTs: number | null = null;
  for (const m of msgs) {
    const t = ts(m);
    if (!t) continue;
    if (m.role === 'user') {
      const text = getTextContent(m.content || [])
        .replace(/\s+/g, ' ')
        .trim();
      turn = { start: t, end: t, text: text.slice(0, 140) || '(user)', spans: [] };
      turns.push(turn);
      prevTs = t;
      continue;
    }
    if (!turn) {
      turn = { start: t, end: t, text: '(session start)', spans: [] };
      turns.push(turn);
      prevTs = t;
    }
    if (m.role === 'assistant' && prevTs && t > prevTs) {
      const chatText = getTextContent(m.content || []);
      turn.spans.push({
        kind: 'chat',
        label: (m.model || 'model').split('/').pop() as string,
        start: prevTs,
        end: t,
        msgId: m.id,
        hasText: chatText.trim().length > 0,
      });
    }
    // Reasoning shares the API call with its assistant message — don't advance the clock
    if (m.role !== 'reasoning') prevTs = t;
    turn.end = Math.max(turn.end, t);
  }

  // Turns MUST be sorted by start time before attaching tool/agent spans:
  // the owner lookup below uses `if (tn.start <= c.ts) owner = tn; else break`,
  // which relies on ascending order. Message arrays are not guaranteed sorted.
  turns.sort((a, b) => a.start - b.start);

  // Attach tool spans to the turn they started in
  for (const [cid, c] of calls) {
    if (!c.ts) continue;
    const r = results.get(cid);
    const measured = Boolean(r?.ts && r.ts > c.ts);
    const estimated = !measured && c.estimatedDurationMs != null;
    const end = measured ? (r?.ts as number) : c.ts + (c.estimatedDurationMs || 50);
    let owner: TraceTurn | null = null;
    for (const tn of turns) {
      if (tn.start <= c.ts) owner = tn;
      else break;
    }
    if (!owner) continue;
    owner.spans.push({
      kind: r && r.isError ? 'tool-error' : 'tool',
      label: c.name,
      start: c.ts,
      end,
      durationSource: measured ? 'measured' : estimated ? 'estimated' : 'unknown',
      msgId: c.msgId,
      toolCallId: cid,
      subject: extractToolSubject(c.args),
    });
    owner.end = Math.max(owner.end, end);
  }

  // Attach spawned-subagent spans (omp / claude-code) to the turn they started in
  for (const a of agentSpans) {
    if (!a.start) continue;
    const end = a.end && a.end > a.start ? a.end : a.start + 50;
    let owner: TraceTurn | null = null;
    for (const tn of turns) {
      if (tn.start <= a.start) owner = tn;
      else break;
    }
    if (!owner) continue;
    owner.spans.push({ kind: 'agent', label: a.label || a.name, start: a.start, end, agentName: a.name });
    owner.end = Math.max(owner.end, end);
  }

  // Stable span ordering: by start time, then kind priority (chat before
  // agent before tool before tool-error — model reasoning precedes the tools
  // it invokes), then label. Plain `a.start - b.start` is unstable when
  // multiple spans share the same timestamp (assistant message + its tool_use
  // blocks are written with one timestamp), which made the list order jump
  // between renders.
  const SPAN_KIND_ORDER: Record<TraceSpan['kind'], number> = {
    chat: 0,
    agent: 1,
    tool: 2,
    'tool-error': 3,
  };
  for (const tn of turns) {
    tn.spans.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      const ko = SPAN_KIND_ORDER[a.kind] - SPAN_KIND_ORDER[b.kind];
      if (ko !== 0) return ko;
      return a.label.localeCompare(b.label);
    });
    // Mark the turn's final reply: the last chat span that carries visible
    // text. This is the answer the user actually sees after all tool calls.
    // Borrowed from botmux's trailingAssistantText() — it isolates the
    // post-tool-call reply so the waterfall can highlight it.
    let lastTextChat: TraceSpan | null = null;
    for (const s of tn.spans) {
      if (s.kind === 'chat' && s.hasText) lastTextChat = s;
    }
    if (lastTextChat) lastTextChat.isFinalReply = true;
  }
  return turns.filter((tn) => tn.spans.length > 0);
}
