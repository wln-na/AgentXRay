// Pure (no-DOM) helpers shared by the React UI and (via the generated
// public/js/pure.js bundle — see scripts/build-legacy-pure.mjs) the frozen
// legacy UI and node tests. This file IS the single source of truth.

import type { MessageContentPart, SessionMessage } from '@/api/types';

/** Coerce unknown → number, treating non-numeric as 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

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
  /** Token usage breakdown for this span (chat spans only — tool spans don't
   *  carry their own API usage). Fields are optional because not every platform
   *  reports every bucket, and intermediate reasoning-only messages may have
   *  no usage at all (Claude Code aggregates usage on the final text reply). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Total tokens = input + output + cacheRead + cacheWrite + reasoning.
   *  Precomputed so the waterfall badge doesn't need to sum five fields. */
  totalTokens?: number;
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

// ─── Tool source classification (MCP / Skill / builtin) ──────────────────
// Post-hoc analysis needs to know where a tool came from: CLI built-in,
// an MCP server, a Claude Code Skill, or something else. Naming conventions
// differ across CLIs, so we match by prefix/pattern rather than a whitelist.

export type ToolSource = 'builtin' | 'mcp' | 'skill' | 'subagent' | 'other';

export interface ToolSourceInfo {
  source: ToolSource;
  /** MCP server name extracted from the tool name (e.g. "mcp__github__create_pr" → "github") */
  mcpServer?: string;
  /** Skill name extracted from the tool name */
  skillName?: string;
}

/** Classify a tool name by its source.
 *  - MCP tools: `mcp__<server>__<tool>`, `mcp-<server>-<tool>`, or `<server>_<tool>` with known MCP prefixes
 *  - Skill tools: Claude Code's `skill` / `Skill` / `use_skill`, or tools named `<skill-name>_<action>`
 *  - Subagent tools: `spawn`, `subagent`, `agent_*`, `Task` (Claude Code sub-agents)
 *  - Builtin: Bash, Read, Write, Grep, Edit, Glob, Todo, etc. (no special prefix)
 *  - Other: anything not matching the above */
export function classifyToolSource(name: string): ToolSourceInfo {
  const n = (name || '').toLowerCase();
  // MCP: explicit prefix patterns
  const mcpMatch = n.match(/^mcp[_\-]+([a-z0-9]+)[_\-]+/);
  if (mcpMatch) return { source: 'mcp', mcpServer: mcpMatch[1] };
  // MCP: some CLIs use `<server>__<tool>` without mcp prefix but with double underscore
  const serverMatch = n.match(/^([a-z0-9]+)__/);
  if (serverMatch && !['todo', 'task', 'web'].includes(serverMatch[1])) {
    return { source: 'mcp', mcpServer: serverMatch[1] };
  }
  // Skill: explicit skill tools
  if (n === 'skill' || n === 'use_skill' || n === 'load_skill' || n.startsWith('skill_'))
    return { source: 'skill', skillName: name };
  // Subagent: spawn / subagent / Task
  if (n.includes('spawn') || n.includes('subagent') || n.includes('agent_spawn') || n === 'task')
    return { source: 'subagent' };
  // Builtin: common CLI tool names (no prefix = builtin)
  const BUILTIN_TOOLS = new Set([
    'bash', 'read', 'write', 'edit', 'grep', 'glob', 'todo', 'view', 'cat',
    'ls', 'mkdir', 'rm', 'mv', 'cp', 'touch', 'cd', 'pwd', 'find', 'xargs',
    'notebook_view', 'notebook_edit', 'computer', 'browser', 'web_search',
    'web_fetch', 'local_shell_call', 'file_read', 'file_write', 'file_edit',
    'run_terminal', 'view_file', 'edit_file', 'execute_command', 'run_command',
    'search_files', 'search_code', 'list_directory', 'read_file', 'write_file',
  ]);
  if (BUILTIN_TOOLS.has(n)) return { source: 'builtin' };
  // Builtin: tools that look like builtin (single word, no separator)
  if (!n.includes('_') && !n.includes('-') && !n.includes('.') && n.length > 2)
    return { source: 'builtin' };
  return { source: 'other' };
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
      // Extract token usage from the message. Different platforms use
      // different field names (snake_case / camelCase), so we normalise.
      const u = m.usage || {};
      const inputTokens = num(u.input) || num(u.input_tokens);
      const outputTokens = num(u.output) || num(u.output_tokens);
      const cacheReadTokens = num(u.cacheRead) || num(u.cache_read);
      const cacheWriteTokens = num(u.cacheWrite) || num(u.cache_write);
      const reasoningTokens = num(u.reasoning) || num(u.reasoning_tokens);
      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
      const span: TraceSpan = {
        kind: 'chat',
        label: (m.model || 'model').split('/').pop() as string,
        start: prevTs,
        end: t,
        msgId: m.id,
        hasText: chatText.trim().length > 0,
      };
      if (totalTokens > 0) {
        span.inputTokens = inputTokens || undefined;
        span.outputTokens = outputTokens || undefined;
        span.cacheReadTokens = cacheReadTokens || undefined;
        span.cacheWriteTokens = cacheWriteTokens || undefined;
        span.reasoningTokens = reasoningTokens || undefined;
        span.totalTokens = totalTokens;
      }
      turn.spans.push(span);
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

// ─── Token helpers ─────────────────────────────────────────────────────────

/** Model pricing per 1M tokens (USD). Defaults to Claude Sonnet 4; user
 *  can override in settings. Kept in pure.ts so the waterfall badge and
 *  SpanSidebar can both estimate cost without importing the insights module. */
export const DEFAULT_MODEL_PRICING = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.30,
  cacheWrite: 3.75,
  reasoning: 15.0,
};

/** Estimate USD cost from token counts using the given pricing table. */
export function estimateSpanCost(
  span: Pick<TraceSpan, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'>,
  pricing = DEFAULT_MODEL_PRICING,
): number {
  return (
    (num(span.inputTokens) * pricing.input +
      num(span.outputTokens) * pricing.output +
      num(span.cacheReadTokens) * pricing.cacheRead +
      num(span.cacheWriteTokens) * pricing.cacheWrite +
      num(span.reasoningTokens) * pricing.reasoning) /
    1_000_000
  );
}

/** Format a token count compactly: 1234 → "1.2K", 1500000 → "1.5M". */
export function formatTokensCompact(n: number | undefined | null): string {
  const v = num(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

/** Human-readable labels for each token bucket, in display order. */
export const TOKEN_BUCKET_LABELS: { key: keyof Pick<TraceSpan, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'>; label: string; hint: string }[] = [
  { key: 'inputTokens', label: '输入', hint: 'Input tokens — prompt + context sent to the model' },
  { key: 'outputTokens', label: '输出', hint: 'Output tokens — generated text + tool calls' },
  { key: 'cacheReadTokens', label: '缓存读取', hint: 'Cache read tokens — prompt cache hits (cheaper)' },
  { key: 'cacheWriteTokens', label: '缓存写入', hint: 'Cache write tokens — prompt cache writes' },
  { key: 'reasoningTokens', label: '推理', hint: 'Reasoning tokens — model thinking time (o1 / Sonnet reasoning)' },
];

// ─── Agent Health: metrics + scoring ───────────────────────────────────────
// Coding-agent "health" = did it finish cleanly, without wasting tools or
// tokens, without errors or loops. These are pure functions over TraceTurn[]
// so they live in pure.ts and are unit-testable without a DOM or LLM.

/** Raw health metrics computed from a session's trace turns. */
export interface AgentHealthMetrics {
  // Completion
  hasFinalReply: boolean;
  finalReplyLength: number;
  turnCount: number;
  // Tool usage
  totalToolCalls: number;
  uniqueToolCount: number;
  toolRedundancyRate: number; // 0..1, fraction of calls that repeat a prior tool
  maxConsecutiveSameTool: number;
  errorCount: number;
  errorRate: number; // 0..1
  // Efficiency
  totalDurationMs: number;
  totalTokens: number;
  tokensPerToolCall: number;
  avgTurnDurationMs: number;
  // Sub-agents
  subAgentCount: number;
}

/** A single anomaly flag raised by the health scorer. */
export interface HealthFlag {
  type: 'error' | 'warning' | 'info';
  message: string;
  /** Index into the spans array (0-based), when the flag is span-specific. */
  spanIndex?: number;
}

/** A contiguous segment of the trace with a health score, for the timeline. */
export interface HealthSegment {
  start: number;
  end: number;
  score: number; // 0..100
  label: string;
}

/** Scored health result: overall score, per-dimension breakdown, flags, segments. */
export interface AgentHealthScore {
  overall: number; // 0..100
  dimensions: {
    completion: number; // did it finish with a real reply?
    efficiency: number; // tokens / duration per useful output
    toolQuality: number; // no redundant calls, no loops
    errorResilience: number; // few errors, errors get fixed
  };
  flags: HealthFlag[];
  segments: HealthSegment[];
}

/** Compute raw health metrics from trace turns. Pure, no LLM needed. */
export function computeHealthMetrics(turns: TraceTurn[]): AgentHealthMetrics {
  let totalToolCalls = 0;
  let errorCount = 0;
  let subAgentCount = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;
  let hasFinalReply = false;
  let finalReplyLength = 0;
  const toolNames: string[] = [];
  let maxConsecutiveSameTool = 0;
  let currentConsecutive = 0;
  let lastToolName: string | null = null;

  for (const turn of turns) {
    totalDurationMs += turn.end - turn.start;
    for (let i = 0; i < turn.spans.length; i++) {
      const s = turn.spans[i];
      if (s.kind === 'tool' || s.kind === 'tool-error') {
        totalToolCalls++;
        toolNames.push(s.label);
        if (s.kind === 'tool-error') errorCount++;
        if (s.label === lastToolName) {
          currentConsecutive++;
        } else {
          currentConsecutive = 1;
          lastToolName = s.label;
        }
        maxConsecutiveSameTool = Math.max(maxConsecutiveSameTool, currentConsecutive);
      } else if (s.kind === 'agent') {
        subAgentCount++;
      } else if (s.kind === 'chat') {
        if (s.totalTokens) totalTokens += s.totalTokens;
        if (s.isFinalReply && s.hasText) {
          hasFinalReply = true;
        }
      }
    }
  }

  // Estimate final reply length from the last chat span with text
  for (let ti = turns.length - 1; ti >= 0; ti--) {
    const lastChat = [...turns[ti].spans].reverse().find((s) => s.kind === 'chat' && s.hasText);
    if (lastChat) {
      finalReplyLength = 1; // placeholder; actual text length needs message access
      break;
    }
  }

  const uniqueToolCount = new Set(toolNames).size;
  const toolRedundancyRate = totalToolCalls > 0 ? 1 - uniqueToolCount / totalToolCalls : 0;
  const errorRate = totalToolCalls > 0 ? errorCount / totalToolCalls : 0;
  const tokensPerToolCall = totalToolCalls > 0 ? totalTokens / totalToolCalls : 0;
  const avgTurnDurationMs = turns.length > 0 ? totalDurationMs / turns.length : 0;

  return {
    hasFinalReply,
    finalReplyLength,
    turnCount: turns.length,
    totalToolCalls,
    uniqueToolCount,
    toolRedundancyRate,
    maxConsecutiveSameTool,
    errorCount,
    errorRate,
    totalDurationMs,
    totalTokens,
    tokensPerToolCall,
    avgTurnDurationMs,
    subAgentCount,
  };
}

/** Score health from metrics using a deterministic rule-based model.
 *  Returns 0..100 overall + per-dimension scores + anomaly flags.
 *  This is the "LLM-free baseline"; an LLM-as-judge can override the score
 *  by writing to the same shape. */
export function scoreHealth(metrics: AgentHealthMetrics): AgentHealthScore {
  const flags: HealthFlag[] = [];

  // Dimension 1: Completion (0..40)
  let completion = 0;
  if (metrics.hasFinalReply) completion += 25;
  if (metrics.turnCount > 0) completion += 5;
  if (metrics.totalToolCalls > 0) completion += 5;
  if (metrics.subAgentCount > 0) completion += 5;
  if (!metrics.hasFinalReply) flags.push({ type: 'warning', message: '会话无最终回复，任务可能未完成' });

  // Dimension 2: Efficiency (0..20)
  let efficiency = 20;
  if (metrics.tokensPerToolCall > 50000) {
    efficiency -= 10;
    flags.push({ type: 'warning', message: `每次工具调用平均 ${formatTokensCompact(metrics.tokensPerToolCall)} tokens，效率偏低` });
  }
  if (metrics.avgTurnDurationMs > 120000) {
    efficiency -= 5;
    flags.push({ type: 'info', message: `平均每轮耗时 ${(metrics.avgTurnDurationMs / 1000).toFixed(0)}s，较长` });
  }

  // Dimension 3: Tool quality (0..20)
  let toolQuality = 20;
  if (metrics.toolRedundancyRate > 0.5) {
    toolQuality -= 8;
    flags.push({ type: 'warning', message: `工具重复率 ${(metrics.toolRedundancyRate * 100).toFixed(0)}%，可能存在循环调用` });
  }
  if (metrics.maxConsecutiveSameTool >= 5) {
    toolQuality -= 7;
    flags.push({ type: 'error', message: `连续 ${metrics.maxConsecutiveSameTool} 次调用同一工具，疑似死循环` });
  } else if (metrics.maxConsecutiveSameTool >= 3) {
    toolQuality -= 3;
    flags.push({ type: 'info', message: `连续 ${metrics.maxConsecutiveSameTool} 次调用同一工具` });
  }

  // Dimension 4: Error resilience (0..20)
  let errorResilience = 20;
  if (metrics.errorRate > 0.3) {
    errorResilience -= 12;
    flags.push({ type: 'error', message: `工具错误率 ${(metrics.errorRate * 100).toFixed(0)}%，过高` });
  } else if (metrics.errorRate > 0.1) {
    errorResilience -= 5;
    flags.push({ type: 'warning', message: `工具错误率 ${(metrics.errorRate * 100).toFixed(0)}%` });
  }
  if (metrics.errorCount >= 5) {
    errorResilience -= 3;
  }

  const overall = Math.min(100, Math.max(0, completion + efficiency + toolQuality + errorResilience));

  return {
    overall,
    dimensions: {
      completion: Math.round((completion / 40) * 100),
      efficiency: Math.round((efficiency / 20) * 100),
      toolQuality: Math.round((toolQuality / 20) * 100),
      errorResilience: Math.round((errorResilience / 20) * 100),
    },
    flags,
    segments: [], // filled by buildHealthSegments
  };
}

/** Build per-turn health segments for the timeline visualization.
 *  Each turn gets a score based on its local error density and tool loops. */
export function buildHealthSegments(turns: TraceTurn[]): HealthSegment[] {
  return turns.map((turn, idx) => {
    let score = 100;
    const toolSpans = turn.spans.filter((s) => s.kind === 'tool' || s.kind === 'tool-error');
    const errors = toolSpans.filter((s) => s.kind === 'tool-error').length;
    const uniqueTools = new Set(toolSpans.map((s) => s.label)).size;

    if (toolSpans.length > 0) {
      const errorRate = errors / toolSpans.length;
      if (errorRate > 0.5) score -= 40;
      else if (errorRate > 0.2) score -= 20;
      else if (errorRate > 0) score -= 10;

      const redundancy = 1 - uniqueTools / toolSpans.length;
      if (redundancy > 0.6) score -= 20;
      else if (redundancy > 0.3) score -= 10;
    }

    const hasFinalReply = turn.spans.some((s) => s.kind === 'chat' && s.isFinalReply);
    const label = hasFinalReply ? `第 ${idx + 1} 轮 · 最终回复` : `第 ${idx + 1} 轮`;

    return {
      start: turn.start,
      end: turn.end,
      score: Math.max(0, score),
      label,
    };
  });
}

/** Full health pipeline: metrics → score → segments. One call for the UI. */
export function analyzeHealth(turns: TraceTurn[]): AgentHealthScore {
  const metrics = computeHealthMetrics(turns);
  const score = scoreHealth(metrics);
  score.segments = buildHealthSegments(turns);
  return score;
}

/** Map a 0..100 health score to a color hex for the timeline. */
export function healthColor(score: number): string {
  if (score >= 80) return '#22c55e'; // green
  if (score >= 60) return '#eab308'; // yellow
  if (score >= 40) return '#f97316'; // orange
  return '#ef4444'; // red
}

/** Human-readable label for a health score range. */
export function healthLabel(score: number): string {
  if (score >= 80) return '健康';
  if (score >= 60) return '良好';
  if (score >= 40) return '一般';
  if (score >= 20) return '较差';
  return '异常';
}
