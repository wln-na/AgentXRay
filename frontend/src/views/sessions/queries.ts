// Shared TanStack Query option builders for the sessions view. CmdkDialog
// reuses these with queryClient.fetchQuery so jump-to-session shares the cache.

import { useQuery } from '@tanstack/react-query';
import type { DirSettings } from '@/api/client';
import { getSessionDetail, getSessions } from '@/api/client';
import type { Platform, SessionDetail, SessionSummary } from '@/api/types';
import { dirForPlatform, useAppStore } from '@/store';

export interface ListScope {
  platform: Platform;
  agent: string;
  includeArchived: boolean;
  settings: DirSettings;
}

export function sessionsListOptions(scope: ListScope) {
  const { platform, agent, includeArchived, settings } = scope;
  return {
    // Prefix ['sessions', platform] per contract; agent/includeArchived affect the result set.
    queryKey: ['sessions', platform, agent, includeArchived] as const,
    queryFn: (): Promise<SessionSummary[]> =>
      getSessions(platform, {
        agent: agent || undefined,
        includeArchived,
        dir: dirForPlatform(settings, platform) || undefined,
      }),
    enabled: platform !== 'openclaw' || !!agent,
  };
}

export function useSessionsList() {
  const platform = useAppStore((s) => s.platform);
  const agent = useAppStore((s) => s.selectedAgent);
  const includeArchived = useAppStore((s) => s.includeArchived);
  const settings = useAppStore((s) => s.settings);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  return useQuery({
    ...sessionsListOptions({ platform, agent, includeArchived, settings }),
    // Legacy restartRefreshLoop: poll the list every 5s while auto-refresh is on
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
      }),
    enabled: !!sessionId,
  };
}

/** Parent-session detail (summary always shows the parent, even while viewing a child). */
export function useSessionDetail() {
  const platform = useAppStore((s) => s.platform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const agent = useAppStore((s) => s.selectedAgent);
  const settings = useAppStore((s) => s.settings);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  return useQuery({
    ...sessionDetailOptions({ platform, sessionId, agent, settings }),
    // Poll alongside the SSE tail while auto-refresh is on: the transcript
    // self-heals (re-syncs full state, replaces the cache) even if the
    // EventSource drops, the tab is background-throttled, or a session file
    // is rewritten rather than appended. The SSE remains the low-latency
    // path; the poll is the reconciliation path (backend parse is ~30-150ms
    // even for multi-MB rollouts).
    refetchInterval: autoRefresh ? 5000 : false,
  });
}
