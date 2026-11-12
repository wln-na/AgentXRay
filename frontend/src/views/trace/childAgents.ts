// Child-agent (omp / claude-code spawned subagent) data hooks, shared by
// TraceView, ChildAgentsSection and the sessions detail (via useActiveSessionDetail).
// Behavior ported from public/js/app.js (childrenEndpoint/childAgentLabel/getSessionChildren).

import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSessionChild, getSessionChildren, getSessionDetail } from '@/api/client';
import type { ChildAgentSummary, Platform, SessionDetail } from '@/api/types';
import { PLATFORM_CAPABILITIES } from '@/api/types';
import { dirForPlatform, useAppStore, useSessionViewSelectors } from '@/store';
import { mergeSessionDetailPages } from '@/views/sessions/queries';

export type ChildPlatform = 'omp' | 'claude-code' | 'codex' | 'dsh';

/** Platforms whose sessions use the generic children API. OpenClaw spawn maps use separate endpoints. */
export function hasChildAgents(platform: Platform): platform is ChildPlatform {
  return PLATFORM_CAPABILITIES[platform].spawn && platform !== 'openclaw';
}

/**
 * Chip/span label: claude-code children carry meta (description/agentType); omp
 * children only a name; dsh children expose a generated title plus a description
 * (never show the raw uuid/name when either exists).
 */
export function childAgentLabel(c: ChildAgentSummary, platform: Platform): string {
  if (platform === 'dsh') {
    const label = (c.description || c.title || c.name).replace(/\s+/g, ' ').trim();
    return label.length > 56 ? `${label.slice(0, 56)}…` : label;
  }
  return (platform === 'claude-code' || platform === 'codex' ? c.description || c.agentType : '') || c.name;
}

/** Subagent list of the selected session. Legacy swallows fetch errors → empty list. */
export function useChildrenQuery(): UseQueryResult<ChildAgentSummary[]> {
  const { platform, sessionId, settings } = useSessionViewSelectors();
  const dir = dirForPlatform(settings, platform) || undefined;
  return useQuery({
    queryKey: ['session-children', platform, sessionId],
    enabled: hasChildAgents(platform) && !!sessionId,
    queryFn: () => getSessionChildren(platform as ChildPlatform, sessionId, dir).catch(() => [] as ChildAgentSummary[]),
  });
}

/** The selected (parent) session detail — same key ViewSessions uses, cache is shared. */
export function useSessionDetailQuery(): UseQueryResult<SessionDetail> {
  const { platform, sessionId, agent, settings } = useSessionViewSelectors();
  const dir = dirForPlatform(settings, platform) || undefined;
  const queryClient = useQueryClient();
  const queryKey = ['session', platform, sessionId] as const;
  return useQuery({
    queryKey,
    enabled: !!sessionId && (platform !== 'openclaw' || !!agent),
    queryFn: async () => {
      const next = await getSessionDetail(platform, sessionId, {
        agent: agent || undefined,
        dir,
        limit: 60,
      });
      return mergeSessionDetailPages(queryClient.getQueryData<SessionDetail>(queryKey), next);
    },
  });
}

/** Transcript of the child agent being viewed (viewingChildAgent). */
export function useChildSessionQuery(): UseQueryResult<SessionDetail> {
  const { platform, sessionId, settings } = useSessionViewSelectors();
  const child = useAppStore((s) => s.viewingChildAgent);
  const dir = dirForPlatform(settings, platform) || undefined;
  const queryClient = useQueryClient();
  const queryKey = ['session-child', platform, sessionId, child] as const;
  return useQuery({
    queryKey,
    enabled: hasChildAgents(platform) && !!sessionId && !!child,
    queryFn: async () => {
      const next = await getSessionChild(platform as ChildPlatform, sessionId, child as string, dir, { limit: 60 });
      return mergeSessionDetailPages(queryClient.getQueryData<SessionDetail>(queryKey), next);
    },
  });
}

/**
 * SessionDetail powering the messages/trace area: the child transcript while a
 * child agent is being viewed, otherwise the parent session (legacy swapped
 * state.sessionData in viewChildAgent).
 */
export function useActiveSessionDetail(): UseQueryResult<SessionDetail> {
  const child = useAppStore((s) => s.viewingChildAgent);
  const parentQuery = useSessionDetailQuery();
  const childQuery = useChildSessionQuery();
  return child ? childQuery : parentQuery;
}
