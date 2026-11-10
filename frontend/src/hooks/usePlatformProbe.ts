// Probe every platform's session count once per page load (legacy
// probePlatformSessionCounts): 0 or unreachable = known empty. Consumed by
// PlatformBar (collapse + first-launch auto-pick, #13) and SessionsView
// (all-empty guided state).

import { useQuery } from '@tanstack/react-query';
import { getAgents, getSessions } from '@/api/client';
import type { Platform } from '@/api/types';
import { PLATFORMS } from '@/api/types';
import { dirForPlatform, useAppStore } from '@/store';

export function usePlatformProbe() {
  const settings = useAppStore((s) => s.settings);
  return useQuery({
    queryKey: ['platform-probe', settings],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const entries = await Promise.all(
        PLATFORMS.map(async (p) => {
          try {
            // Only the COUNT is needed to draw the platform tabs (#13). Asking
            // for one row + reading page.total keeps boot cheap: this probe used
            // to download every session of every platform (~1 MB of JSON).
            if (p === 'openclaw') {
              const agents = await getAgents(settings.openclawDir || undefined);
              return [p, Array.isArray(agents) ? agents.length : 0] as const;
            }
            const page = await getSessions(p, {
              dir: dirForPlatform(settings, p) || undefined,
              limit: 1,
            });
            return [p, page?.page?.total ?? 0] as const;
          } catch {
            return [p, 0] as const; // unreachable = treat as empty
          }
        })
      );
      return Object.fromEntries(entries) as Record<Platform, number>;
    },
  });
}
