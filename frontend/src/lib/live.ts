// Shared "live session" definition: a session whose log was written within
// this window is considered "live" — the agent is (or just was) actively
// working on it elsewhere (the "open in another app" situation).
export const LIVE_WINDOW_MS = 3 * 60 * 1000;

export function isLive(lastActivity: unknown): boolean {
  if (typeof lastActivity !== 'string' || !lastActivity) return false;
  const t = new Date(lastActivity).getTime();
  return !Number.isNaN(t) && Date.now() - t < LIVE_WINDOW_MS;
}
