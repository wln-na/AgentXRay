// Shared TanStack Query option builders for the sessions view. CmdkDialog
// reuses these with queryClient.fetchQuery so jump-to-session shares the cache.

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DirSettings } from '@/api/client';
import { getSessionDetail, getSessions } from '@/api/client';
import type { Platform, SessionDetail, SessionMessage, SessionSummary, SessionsPage } from '@/api/types';
import { getTextContent } from '@/lib/pure';
import { dirForPlatform, useAppStore, useSessionViewSelectors } from '@/store';

export interface ListScope {
  platform: Platform;
  agent: string;
  includeArchived: boolean;
  settings: DirSettings;
  /** Page size; the sidebar loads the first page lazily and appends older pages. */
  limit?: number;
  before?: string | null;
}

export function sessionsListOptions(scope: ListScope) {
  const { platform, agent, includeArchived, settings, limit, before } = scope;
  return {
    // Prefix ['sessions', platform] per contract; agent/includeArchived affect the result set.
    queryKey: ['sessions', platform, agent, includeArchived] as const,
    // One cursor page (see SessionsPage). The sidebar keeps the accumulated list
    // in local state and appends `before` pages to it.
    queryFn: (): Promise<SessionsPage> =>
      getSessions(platform, {
        agent: agent || undefined,
        includeArchived,
        dir: dirForPlatform(settings, platform) || undefined,
        limit,
        before,
      }),
    enabled: platform !== 'openclaw' || !!agent,
  };
}

export function useSessionsList() {
  const { platform, agent } = useSessionViewSelectors();
  const includeArchived = useAppStore((s) => s.includeArchived);
  const settings = useAppStore((s) => s.settings);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  return useQuery({
    ...sessionsListOptions({ platform, agent, includeArchived, settings }),
    // Legacy restartRefreshLoop: poll the list every 5s while auto-refresh is on
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/** The first page's summaries only. Convenience for callers that just need the
 *  array (headers, "find selected session"), not the cursor metadata. */
export function useSessionSummaries(): { data: SessionSummary[]; isLoading: boolean } {
  const query = useSessionsList();
  return { data: query.data?.sessions ?? EMPTY_SUMMARIES, isLoading: query.isLoading };
}

const EMPTY_SUMMARIES: SessionSummary[] = [];

/**
 * Sidebar session list with cursor pagination: the first (newest) page plus
 * "load older" pages appended via `page.nextBefore`.
 *
 * Uses its own key (trailing `'infinite'`) because a single key cannot be shared
 * between `useQuery` and `useInfiniteQuery`: the cached shapes differ
 * (`SessionsPage` vs `{ pages, pageParams }`) and the two observers would
 * overwrite each other. The key still shares the
 * `['sessions', platform, agent, includeArchived]` prefix, so a prefix
 * invalidation reaches both caches.
 */
export function useSessionsInfinite() {
  const { platform, agent } = useSessionViewSelectors();
  const includeArchived = useAppStore((s) => s.includeArchived);
  const settings = useAppStore((s) => s.settings);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  return useInfiniteQuery({
    queryKey: ['sessions', platform, agent, includeArchived, 'infinite'] as const,
    queryFn: ({ pageParam }) =>
      getSessions(platform, {
        agent: agent || undefined,
        includeArchived,
        dir: dirForPlatform(settings, platform) || undefined,
        // `null` cursor = the newest page; every later page passes the previous
        // page's `page.nextBefore`.
        before: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    // The server returns `nextBefore: null` when there is no older page.
    getNextPageParam: (lastPage) => lastPage.page.nextBefore ?? undefined,
    enabled: platform !== 'openclaw' || !!agent,
    // Legacy restartRefreshLoop: poll the list every 5s while auto-refresh is on.
    // NOTE: an infinite query refetches every loaded page on each poll, so this
    // costs one list request per loaded page per tick once older pages exist.
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

export function sessionDetailOptions(scope: {
  platform: Platform;
  sessionId: string;
  agent: string;
  settings: DirSettings;
}) {
  const { platform, sessionId, agent, settings } = scope;
  return {
    queryKey: ['session', platform, sessionId] as const,
    queryFn: (): Promise<SessionDetail> =>
      getSessionDetail(platform, sessionId, {
        agent: agent || undefined,
        dir: dirForPlatform(settings, platform) || undefined,
        limit: 60,
      }),
    enabled: !!sessionId,
  };
}

/**
 * Identity used to de-duplicate a message that appears in both the cached detail
 * and a freshly fetched page.
 *
 * Records WITHOUT an `id` are common (codex emits many). The old key was
 * `timestamp|role|toolCallId`, which collides across genuinely different records —
 * merging a full transcript with a 60-message page silently dropped hundreds of
 * them (measured: 2 675 codex messages collapsed to 1 741). Fold in the fields
 * that actually distinguish two id-less records.
 */
function messageMergeKey(message: SessionMessage): string {
  if (message.id) return `id:${message.id}`;
  const text = getTextContent(message.content) || '';
  return [
    'noid',
    message.timestamp || '',
    message.role || '',
    message.toolCallId || '',
    message.toolName || '',
    text.length,
    text.slice(0, 64),
  ].join('|');
}

export function mergeSessionDetailPages(current: SessionDetail | undefined, next: SessionDetail): SessionDetail {
  if (!current?.messagePage || !next.messagePage) return next;
  const seen = new Set<string>();
  const messages = [...current.messages, ...next.messages].filter((message) => {
    const key = messageMergeKey(message);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...next,
    messages,
    messagePage: {
      ...next.messagePage,
      start: Math.min(current.messagePage.start, next.messagePage.start),
      end: Math.max(current.messagePage.end, next.messagePage.end),
      loadedCount: messages.length,
      hasMoreBefore: current.messagePage.hasMoreBefore || next.messagePage.hasMoreBefore,
      nextBefore:
        next.messagePage.start < current.messagePage.start
          ? next.messagePage.nextBefore
          : current.messagePage.nextBefore,
    },
  };
}

/** Parent-session detail (summary always shows the parent, even while viewing a child). */
export function useSessionDetail() {
  const { platform, sessionId, agent, settings } = useSessionViewSelectors();
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const queryClient = useQueryClient();
  const queryKey = ['session', platform, sessionId] as const;
  return useQuery({
    ...sessionDetailOptions({ platform, sessionId, agent, settings }),
    queryKey,
    queryFn: async () => {
      const next = await getSessionDetail(platform, sessionId, {
        agent: agent || undefined,
        dir: dirForPlatform(settings, platform) || undefined,
        limit: 60,
      });
      return mergeSessionDetailPages(queryClient.getQueryData<SessionDetail>(queryKey), next);
    },
    // Poll alongside the SSE tail while auto-refresh is on: the transcript
    // self-heals (re-syncs full state, replaces the cache) even if the
    // EventSource drops, the tab is background-throttled, or a session file
    // is rewritten rather than appended. The SSE remains the low-latency
    // path; the poll is the reconciliation path (backend parse is ~30-150ms
    // even for multi-MB rollouts).
    refetchInterval: autoRefresh ? 5000 : false,
  });
}
