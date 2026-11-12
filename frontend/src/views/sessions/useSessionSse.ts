// Real-time tail: EventSource on /api/watch appending into the shared
// ['session', platform, id] query cache (legacy startSse/closeSse).

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { watchUrl } from '@/api/client';
import type { SessionDetail, SessionMessage, SessionMeta } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { getTextContent } from '@/lib/pure';
import { dirForPlatform, useAppStore, useSessionViewSelectors } from '@/store';

export type SseStatus = 'off' | 'connecting' | 'live' | 'error';

// Tool events often arrive in bursts. Wait until the burst settles before
// asking the server to re-cluster the session's semantic tasks.
const TASK_ANALYSIS_DEBOUNCE_MS = 2500;

/**
 * Watches the selected parent session while auto-refresh is on (suppressed when
 * a child transcript is being viewed). New messages are appended to the query
 * cache; `onNewMessages(count)` lets the caller expand pagination / auto-scroll.
 */
export function useSessionSse(onNewMessages: (count: number) => void): SseStatus {
  const { platform, sessionId, agent, settings } = useSessionViewSelectors();
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SseStatus>('off');
  const onNewRef = useRef(onNewMessages);
  const taskAnalysisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onNewRef.current = onNewMessages;

  const dir = dirForPlatform(settings, platform);
  // Demo mode has no backend to stream from — the toggle stays visibly off.
  const enabled = !DEMO && autoRefresh && !!sessionId && !viewingChildAgent;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    const es = new EventSource(watchUrl({ platform, sessionId, agent: agent || undefined, dir: dir || undefined }));
    es.addEventListener('connected', () => setStatus('live'));
    es.addEventListener('newMessages', (e) => {
      const payload = JSON.parse((e as MessageEvent).data || '{}') as {
        messages?: SessionMessage[];
        contextMessages?: SessionMessage[];
        session?: Partial<SessionMeta>;
      };
      const newMsgs = Array.isArray(payload.messages) ? payload.messages : [];
      const newContext = Array.isArray(payload.contextMessages) ? payload.contextMessages : [];
      if (newMsgs.length === 0 && newContext.length === 0) return;
      // Idempotent append: dedupe against messages already in the cache so a
      // concurrent detail poll (full refetch) can never be double-counted.
      // Context records have no id on some platforms (codex turn_context), so
      // their key falls back to kind + text — identical re-injections collapse.
      // No cache yet → skip; the next detail fetch reconciles from the file.
      const keyOf = (m: SessionMessage) => m.id || `${m.timestamp || ''}|${m.role || ''}|${m.toolCallId || ''}`;
      const contextKeyOf = (m: SessionMessage) =>
        m.id || `${m.details?.sourceKind || m.role || ''}|${getTextContent(m.content)}`;
      const current = queryClient.getQueryData<SessionDetail>(['session', platform, sessionId]);
      if (!current) return;
      const existing = new Set(current.messages.map(keyOf));
      const fresh = newMsgs.filter((m) => !existing.has(keyOf(m)));
      const existingContext = new Set((current.contextMessages || []).map(contextKeyOf));
      const freshContext = newContext.filter((m) => !existingContext.has(contextKeyOf(m)));
      if (fresh.length === 0 && freshContext.length === 0) return;
      queryClient.setQueryData<SessionDetail>(['session', platform, sessionId], {
        session: { ...current.session, ...(payload.session || {}) },
        messages: fresh.length ? [...current.messages, ...fresh] : current.messages,
        ...(current.messagePage && fresh.length
          ? {
              messagePage: {
                ...current.messagePage,
                total: current.messagePage.total + fresh.length,
                end: current.messagePage.end + fresh.length,
                loadedCount: (current.messagePage.loadedCount ?? current.messages.length) + fresh.length,
              },
            }
          : current.messagePage
            ? { messagePage: current.messagePage }
            : {}),
        // Keep the detail shape intact when the session had no context channel.
        ...(current.contextMessages || freshContext.length
          ? { contextMessages: [...(current.contextMessages || []), ...freshContext] }
          : {}),
      });
      onNewRef.current(fresh.length);
      // Refresh sidebar counters (legacy loadSessions(true) on newMessages)
      queryClient.invalidateQueries({ queryKey: ['sessions', platform] });

      // Keep the existing task result visible while the new transcript is
      // classified in the background. The backend fingerprint prevents an
      // unnecessary LLM call when the normalized execution units are unchanged.
      if (taskAnalysisTimerRef.current) clearTimeout(taskAnalysisTimerRef.current);
      taskAnalysisTimerRef.current = setTimeout(() => {
        taskAnalysisTimerRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ['session-tasks', platform, sessionId] });
      }, TASK_ANALYSIS_DEBOUNCE_MS);
    });
    // EventSource auto-reconnects on error — just reflect the state (🔴 Live)
    es.addEventListener('error', () => setStatus('error'));
    return () => {
      es.close();
      if (taskAnalysisTimerRef.current) {
        clearTimeout(taskAnalysisTimerRef.current);
        taskAnalysisTimerRef.current = null;
      }
      setStatus('off');
    };
  }, [enabled, platform, sessionId, agent, dir, queryClient]);

  return status;
}
