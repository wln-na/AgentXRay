// Prompts-view helpers — search filtering and the hide/unhide plumbing.
// 已移除批量选择相关算法（selection keys）、琐碎过滤与客户端 JSON 导出。

import { hidePrompts } from '@/api/client';
import type { PromptSession } from '@/api/types';

/** app.js promptsMatchesSearch — id/slug/title/prompt-text substring match. */
export function promptsMatchesSearch(session: PromptSession, q: string): boolean {
  if (!q) return true;
  if (session.id.toLowerCase().includes(q)) return true;
  if ((session.slug || '').toLowerCase().includes(q)) return true;
  if ((session.title || '').toLowerCase().includes(q)) return true;
  return session.prompts.some((p) => p.text.toLowerCase().includes(q));
}

export interface FilteredPrompts {
  groups: import('@/api/types').PromptGroup[];
  shownSessions: number;
  shownPrompts: number;
}

/** Search filter over directory groups. */
export function filterPromptGroups(data: import('@/api/types').PromptsData, search: string): FilteredPrompts {
  const q = search.trim().toLowerCase();
  const groups = data.groups
    .map((g) => ({
      ...g,
      sessions: g.sessions.filter((s) => promptsMatchesSearch(s, q) || g.directory.toLowerCase().includes(q)),
    }))
    .filter((g) => g.sessions.length > 0);

  const shownSessions = groups.reduce((n, g) => n + g.sessions.length, 0);
  const shownPrompts = groups.reduce((n, g) => n + g.sessions.reduce((m, s) => m + s.promptCount, 0), 0);
  return { groups, shownSessions, shownPrompts };
}

/** Batch-hide helper: dedupes texts and chunks POSTs at 500 per request (backend limit). */
export async function hidePromptTextsChunked(texts: string[]): Promise<void> {
  const unique = [...new Set(texts)];
  for (let i = 0; i < unique.length; i += 500) {
    await hidePrompts({ texts: unique.slice(i, i + 500) });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
