// Typed fetchers for every AgentXRay backend endpoint.
// Mirrors public/js/app.js fetch behavior: non-2xx → throw Error(body.error || statusText).

import { DEMO } from '@/demo/flag';
import { demoJson } from '@/demo/router';
import type {
  BackupResult,
  BackupStatus,
  ChildAgentSummary,
  ContextBatch,
  ContextSnapshot,
  DailyUsage,
  EvalAnnotation,
  EvalJudgement,
  EvalStoreData,
  HiddenPromptsData,
  HidePromptsResult,
  Insights,
  InstallTarget,
  LibraryData,
  OpenSessionResult,
  OtlpExport,
  Platform,
  PromptAnalysis,
  PromptsData,
  RegressionCase,
  SearchResult,
  SessionDetail,
  SessionFull,
  SessionMessage,
  SessionMessagePage,
  SessionsPage,
  SessionTaskAnalysis,
  SpawnLink,
  SpawnTreeResult,
  SuggestNameResult,
  ToolsAudit,
  VersionInfo,
} from './types';

/** Per-platform log-directory overrides (settings dialog). Empty string = default. */
export interface DirSettings {
  openclawDir: string;
  codexDir: string;
  claudeCodeDir: string;
  claudeDesktopDir: string;
  hermesDir: string;
  ompDir: string;
  dshDir: string;
  geminiDir: string;
  cursorDir: string;
  doubaoDir: string;
  workbuddyDir: string;
  traeDir: string;
}

type ParamValue = string | number | boolean | undefined | null;

function withParams(path: string, params: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  if (DEMO) return demoJson<T>(url, init);
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

function requestJson<T>(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------- Sessions ----------

export function getAgents(dir?: string): Promise<string[]> {
  return fetchJson(withParams('/api/agents', { dir }));
}

// One URL shape for every platform: `agent` is a query parameter, not a path
// segment. OpenClaw used to get its own `/api/agents/:name/sessions/...` family,
// which forced every fetcher here to branch and leaked `agent` into the whole
// state layer. `/api/:platform/sessions/:id/export` already worked this way, so
// the rest of the API now matches it.
function sessionBase(platform: Platform): string {
  return `/api/${encodeURIComponent(platform)}/sessions`;
}

/**
 * List sessions, one cursor page at a time.
 *
 * Lists page like messages (`limit` + `before`) so the sidebar never downloads
 * every session of a platform just to draw the first screen, and so the boot
 * probe can ask for `limit=1` and read `page.total`.
 */
export function getSessions(
  platform: Platform,
  opts: { agent?: string; includeArchived?: boolean; dir?: string; limit?: number; before?: string | null } = {}
): Promise<SessionsPage> {
  return fetchJson(
    withParams(sessionBase(platform), {
      agent: opts.agent,
      include_archived: opts.includeArchived,
      dir: opts.dir,
      // Keep the list response in its paged shape. The API still supports its
      // legacy bare-array response when no pagination parameter is supplied.
      limit: opts.limit ?? 100,
      before: opts.before,
    })
  );
}

export function getSessionDetail(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string; dir?: string; limit?: number; before?: string | null } = {}
): Promise<SessionDetail> {
  return fetchJson(
    withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}`, {
      agent: opts.agent,
      dir: opts.dir,
      limit: opts.limit,
      before: opts.before,
    })
  );
}

/**
 * The COMPLETE transcript, from its own endpoint. Deliberately separate from
 * `getSessionDetail`: asking for "everything" is an explicit, different request
 * with a different payload shape, so it can never be confused with (or poison
 * the cache of) the paged window.
 */
export function getSessionFull(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string; dir?: string } = {}
): Promise<SessionFull> {
  return fetchJson(
    withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}/full`, {
      agent: opts.agent,
      dir: opts.dir,
    })
  );
}

export function getSessionMessages(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string; dir?: string; limit?: number; before?: string | null } = {}
): Promise<{ messages: SessionMessage[]; messagePage: SessionMessagePage }> {
  return fetchJson(
    withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}/messages`, {
      agent: opts.agent,
      dir: opts.dir,
      limit: opts.limit,
      before: opts.before,
    })
  );
}

export function getSessionTaskAnalysis(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string; dir?: string; refresh?: boolean } = {}
): Promise<SessionTaskAnalysis> {
  return fetchJson(
    withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}/tasks`, {
      agent: opts.agent,
      dir: opts.dir,
      refresh: opts.refresh,
    })
  );
}

/** Spawned sub-agents of a session (omp / claude-code / codex / dsh). */
export function getSessionChildren(
  platform: 'omp' | 'claude-code' | 'codex' | 'dsh',
  sessionId: string,
  dir?: string
): Promise<ChildAgentSummary[]> {
  return fetchJson(withParams(`/api/${platform}/sessions/${encodeURIComponent(sessionId)}/children`, { dir }));
}

export function getSessionChild(
  platform: 'omp' | 'claude-code' | 'codex' | 'dsh',
  sessionId: string,
  childName: string,
  dir?: string,
  opts: { limit?: number; before?: string | null } = {}
): Promise<SessionDetail> {
  return fetchJson(
    withParams(`/api/${platform}/sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(childName)}`, {
      dir,
      limit: opts.limit,
      before: opts.before,
    })
  );
}

/**
 * One-click locate (Finder reveal) or open (resume in terminal / launch app /
 * open log with the default editor) of a collected session. openclaw is
 * addressed per agent: /api/agents/:agent/sessions/:id/open.
 * The server returns { ok, action, detail } or { ok:false, error, fallback }
 * where fallback offers a copyable path/command on non-macOS or failure.
 */
export function openSession(
  platform: Platform,
  sessionId: string,
  action: 'locate' | 'open',
  opts: { agent?: string; dir?: string } = {}
): Promise<OpenSessionResult> {
  return requestJson(
    withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}/open`, { dir: opts.dir, agent: opts.agent }),
    'POST',
    { action }
  );
}

// ---------- Spawn map / tree ----------

export function getSpawnMap(dir?: string): Promise<SpawnLink[]> {
  return fetchJson(withParams('/api/spawn-map', { dir }));
}

export function getSpawnTree(sessionId: string, dir?: string): Promise<SpawnTreeResult> {
  return fetchJson(withParams(`/api/spawn-tree/${encodeURIComponent(sessionId)}`, { dir }));
}

// ---------- Insights ----------

export function getInsights(opts: { platform: Platform; agent?: string; dir?: string }): Promise<Insights> {
  // Note: legacy app.js passes dirParam() ("?dir=…") as the dir value here — a bug.
  // We pass the raw directory.
  return fetchJson(withParams('/api/insights', { platform: opts.platform, agent: opts.agent, dir: opts.dir }));
}

// ---------- Daily usage ----------

export function getDailyUsage(
  opts: { days?: number; platform?: string; dirs?: Partial<DirSettings> } = {}
): Promise<DailyUsage> {
  return fetchJson<DailyUsage>(
    withParams('/api/usage/daily', { days: opts.days, platform: opts.platform, ...(opts.dirs || {}) })
  );
}

// ---------- Prompts ----------

export function getPrompts(opts: { platform: Platform; agent?: string; dir?: string }): Promise<PromptsData> {
  return fetchJson(withParams('/api/prompts', { platform: opts.platform, agent: opts.agent, dir: opts.dir }));
}

/**
 * Template clustering + attribution + LLM suggestions.
 * `cached: true` probes the persisted analysis only — resolves null on 204/anything but 200.
 * `refresh: true` forces recompute; `skipLlm: true` clusters without Claude suggestions.
 */
export async function getPromptAnalysis(opts: {
  platform: Platform;
  agent?: string;
  dir?: string;
  cached?: boolean;
  refresh?: boolean;
  skipLlm?: boolean;
}): Promise<PromptAnalysis | null> {
  const url = withParams('/api/prompts/analyze', {
    platform: opts.platform,
    agent: opts.agent,
    dir: opts.dir,
    cached: opts.cached,
    refresh: opts.refresh,
    skipLlm: opts.skipLlm,
  });
  if (opts.cached) {
    if (DEMO) return null; // nothing persisted in demo mode
    const resp = await fetch(url);
    if (resp.status !== 200) return null;
    return (await resp.json()) as PromptAnalysis;
  }
  return fetchJson(url);
}

export function getHiddenPrompts(): Promise<HiddenPromptsData> {
  return fetchJson('/api/prompts/hidden');
}

/** Hide one prompt ({text}) or a batch ({texts}, ≤500 per call). */
export function hidePrompts(body: { text: string } | { texts: string[] }): Promise<HidePromptsResult> {
  return requestJson('/api/prompts/hidden', 'POST', body);
}

export function unhidePrompt(hash: string): Promise<{ hidden: number }> {
  return requestJson(`/api/prompts/hidden/${encodeURIComponent(hash)}`, 'DELETE');
}

// ---------- Tools audit ----------

/** Cross-platform tool health check. Resolves null on 204 (cached probe, nothing persisted yet). */
export async function getToolsAudit(opts: {
  dirs?: Partial<DirSettings>;
  refresh?: boolean;
}): Promise<ToolsAudit | null> {
  const url = withParams('/api/tools/audit', {
    platform: 'all',
    dirOpenclaw: opts.dirs?.openclawDir,
    dirCodex: opts.dirs?.codexDir,
    dirClaude: opts.dirs?.claudeCodeDir,
    dirClaudeDesktop: opts.dirs?.claudeDesktopDir,
    dirOmp: opts.dirs?.ompDir,
    dirDsh: opts.dirs?.dshDir,
    dirGemini: opts.dirs?.geminiDir,
    [opts.refresh ? 'refresh' : 'cached']: true,
  });
  if (DEMO) return null; // no persisted audit in demo mode
  const resp = await fetch(url);
  if (resp.status === 204) return null;
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || resp.statusText);
  }
  return (await resp.json()) as ToolsAudit;
}

// ---------- Search ----------

/** Full-text search across every platform (multi-keyword AND), with per-platform dir overrides. */
export function searchSessions(q: string, dirs?: Partial<DirSettings>, platform?: string): Promise<SearchResult[]> {
  return fetchJson(
    withParams('/api/search', {
      q,
      platform: platform || 'all',
      dirOpenclaw: dirs?.openclawDir,
      dirCodex: dirs?.codexDir,
      dirClaude: dirs?.claudeCodeDir,
      dirHermes: dirs?.hermesDir,
      dirOmp: dirs?.ompDir,
      dirDsh: dirs?.dshDir,
      dirGemini: dirs?.geminiDir,
      dirDoubao: dirs?.doubaoDir,
    })
  );
}

// ---------- Library ----------

export function getLibrary(): Promise<LibraryData> {
  return fetchJson('/api/library');
}

export function createLibraryPrompt(body: {
  name: string;
  content: string;
  description?: string;
  tags?: string[];
  source?: string;
}): Promise<Record<string, unknown>> {
  return requestJson('/api/library', 'POST', body);
}

export function updateLibraryPrompt(
  name: string,
  body: { newName?: string; content?: string; description?: string; tags?: string[] }
): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}`, 'PUT', body);
}

export function deleteLibraryPrompt(name: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}`, 'DELETE');
}

export function installLibraryPrompt(name: string, targets: InstallTarget[]): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}/install`, 'POST', { targets });
}

export function uninstallLibraryPrompt(name: string, targets: InstallTarget[]): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}/uninstall`, 'POST', { targets });
}

/** Claude-CLI name suggestion; `{ name: null }` when the CLI is unavailable. */
export function suggestLibraryName(text: string): Promise<SuggestNameResult> {
  return requestJson('/api/library/suggest-name', 'POST', { text });
}

// ---------- Backup / misc ----------

export function runBackup(): Promise<BackupResult> {
  return requestJson('/api/backup', 'POST');
}

export function getBackupStatus(): Promise<BackupStatus> {
  return fetchJson('/api/backup/status');
}

export function getOtlp(platform: Platform, sessionId: string, dir?: string): Promise<OtlpExport> {
  return fetchJson(withParams(`/api/otlp/${encodeURIComponent(platform)}/${encodeURIComponent(sessionId)}`, { dir }));
}

export function getVersion(): Promise<VersionInfo> {
  return fetchJson('/api/version');
}

// ---------- LLM backend settings (#14) ----------

/** GET/PUT /api/settings/llm — local LLM profiles and per-feature routing. */
export interface LlmProfileSummary {
  type: 'openai-compatible' | 'claude-cli';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export type LlmPurpose = 'sessionTasks' | 'promptRewrite' | 'promptAnalysis' | 'libraryName';

export interface LlmSettings {
  version: number;
  activeProfile: string;
  profiles: Record<string, LlmProfileSummary>;
  routes: Partial<Record<LlmPurpose, string>>;
  routeBackends: Partial<Record<LlmPurpose, 'openai' | 'claude-cli' | null>>;
  // Compatibility fields for older clients.
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  backend: 'openai' | 'claude-cli' | null;
}

export function getLlmSettings(): Promise<LlmSettings> {
  return fetchJson('/api/settings/llm');
}

export interface LlmProfileInput {
  type: 'openai-compatible' | 'claude-cli';
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
}

export function saveLlmSettings(body: {
  activeProfile: string;
  profiles: Record<string, LlmProfileInput>;
  routes: Partial<Record<LlmPurpose, string | null>>;
}): Promise<LlmSettings> {
  return requestJson('/api/settings/llm', 'PUT', body);
}

/** URL for the server-side session export (Markdown / standalone HTML download). */
export function exportUrl(
  platform: Platform,
  sessionId: string,
  format: 'md' | 'html',
  opts: { agent?: string; dir?: string } = {}
): string {
  return withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}/export`, {
    format,
    agent: opts.agent,
    dir: opts.dir,
  });
}

/** URL for the real-time tail EventSource (GET /api/watch, SSE — consumed via new EventSource()). */
export function watchUrl(opts: { platform: Platform; sessionId: string; agent?: string; dir?: string }): string {
  return withParams('/api/watch', {
    platform: opts.platform,
    sessionId: opts.sessionId,
    agent: opts.agent,
    dir: opts.dir,
  });
}

// ---------- Pet (global status companion, PRD §5.2) ----------

// ---------- Context reconstruction ----------

/**
 * GET /api/:platform/sessions/:sessionId/context
 * Reconstruct the full system prompt + history a model likely saw before a
 * given user turn. Pass either messageIndex or messageId to anchor.
 */
export function getSessionContext(
  platform: Platform,
  sessionId: string,
  target: { messageIndex?: number; messageId?: string; dir?: string; agent?: string }
): Promise<ContextSnapshot> {
  return fetchJson(
    withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}/context`, {
      messageIndex: target.messageIndex,
      messageId: target.messageId,
      dir: target.dir,
      agent: target.agent,
    })
  );
}

/**
 * Reconstruct several turns' context in ONE round trip. The server resolves every
 * anchor from a single session read, and reports per-anchor failures in `errors`
 * instead of failing the whole batch.
 */
export function getSessionContextBatch(
  platform: Platform,
  sessionId: string,
  messageIds: string[],
  opts: { dir?: string; agent?: string } = {}
): Promise<ContextBatch> {
  return fetchJson(
    withParams(`${sessionBase(platform)}/${encodeURIComponent(sessionId)}/context`, {
      messageIds: messageIds.join(','),
      dir: opts.dir,
      agent: opts.agent,
    })
  );
}

// ---------- Eval loop (annotations / LLM-as-judge / regression set) ----------

/** GET /api/evals — annotations, judgements and the regression set in one shot. */
export function getEvalStore(): Promise<EvalStoreData> {
  return fetchJson('/api/evals');
}

/**
 * PUT /api/evals/annotation — upsert the manual annotation for one session.
 * A 👎 auto-collects the session into the regression set (tags/note carried
 * over); flipping back to 👍 removes an untouched auto-collected case.
 */
export function putAnnotation(
  platform: Platform,
  sessionId: string,
  body: { thumb: 'up' | 'down' | null; note?: string; tags?: string[] }
): Promise<{ annotation: EvalAnnotation | null }> {
  return requestJson('/api/evals/annotation', 'PUT', { platform, sessionId, ...body });
}

/**
 * POST /api/evals/judge — run LLM-as-judge over a session transcript.
 * Returns the persisted judgement (also recorded in the session's judge
 * history), or `{ judgement: null, raw }` when the model's output could not
 * be parsed into the score shape (the failed attempt is recorded in history
 * with the raw output; `judgements` keeps the last successful score).
 */
export function judgeSession(
  platform: Platform,
  sessionId: string,
  transcript: string
): Promise<{ judgement: EvalJudgement | null; raw?: string }> {
  return requestJson('/api/evals/judge', 'POST', { platform, sessionId, transcript });
}

/** POST /api/evals/regression — upsert one curated bad case (per session). */
export function addRegressionCase(
  platform: Platform,
  sessionId: string,
  body: { tags?: string[]; note?: string; source?: string } = {}
): Promise<{ case: RegressionCase }> {
  return requestJson('/api/evals/regression', 'POST', { platform, sessionId, ...body });
}

/** DELETE /api/evals/regression/:id — remove one case. */
export function removeRegressionCase(id: string): Promise<{ removed: boolean }> {
  return requestJson(`/api/evals/regression/${encodeURIComponent(id)}`, 'DELETE');
}
