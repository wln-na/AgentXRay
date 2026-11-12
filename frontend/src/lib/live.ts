// Shared recent-activity hint. This timestamp window does not confirm that an
// agent process is still running; it only indicates a recent session update.
export const LIVE_WINDOW_MS = 3 * 60 * 1000;

export function isLive(lastActivity: unknown): boolean {
  if (typeof lastActivity !== 'string' || !lastActivity) return false;
  const t = new Date(lastActivity).getTime();
  return !Number.isNaN(t) && Date.now() - t < LIVE_WINDOW_MS;
}
