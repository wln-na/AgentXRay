// 资产库 view: cards + search + install toggles + CRUD form.
// 已移除：Fabric Patterns 导入（外部 GitHub 依赖）、版本历史对话框、
// 排序选择器、使用次数徽章（额外一次全量扫描）。

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getLibrary } from '@/api/client';
import type { LibraryPrompt } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store';
import { LibraryCard } from './LibraryCard';
import { LibraryFormDialog } from './LibraryFormDialog';

function matchesSearch(p: LibraryPrompt, q: string): boolean {
  if (!q) return true;
  if (p.name.toLowerCase().includes(q)) return true;
  if ((p.description || '').toLowerCase().includes(q)) return true;
  if ((p.tags || []).some((t) => t.toLowerCase().includes(q))) return true;
  return (p.content || '').toLowerCase().includes(q);
}

export function LibraryView() {
  const openLibraryForm = useAppStore((s) => s.openLibraryForm);
  const [search, setSearch] = useState('');

  const library = useQuery({ queryKey: ['library'], queryFn: getLibrary });

  if (library.isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading library…</div>;
  }
  if (library.isError) {
    return (
      <div className="p-4 text-sm text-destructive">Failed to load library: {(library.error as Error).message}</div>
    );
  }

  const all = library.data?.prompts || [];
  const q = search.trim().toLowerCase();
  const prompts = all
    .filter((p) => matchesSearch(p, q))
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="按名称 / 标签 / 描述 / 正文过滤"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Button variant="outline" size="sm" onClick={() => openLibraryForm(null, false)}>
          新建 Prompt
        </Button>
      </div>
      <div className="text-sm text-muted-foreground">
        <span className="mr-2 rounded-full bg-muted px-2 py-px text-xs">🌐 全平台</span>
        Prompt 资产库（~/.agentxray/library）— 点亮 Claude / Codex / OMP 开关即安装为该工具的 slash command，工具内{' '}
        <code className="rounded bg-muted px-1 text-xs">/名字</code> 调用 · {all.length} prompt
        {all.length === 1 ? '' : 's'}
        {q ? ` — showing ${prompts.length}` : ''}
      </div>
      {prompts.length ? (
        <div className="space-y-3">
          {prompts.map((p) => (
            <LibraryCard key={p.name} prompt={p} onEdit={() => openLibraryForm(p, true)} />
          ))}
        </div>
      ) : (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {all.length ? '没有匹配的 Prompt。' : '资产库为空。在 Prompts 视图点 ⭐ 收藏，或点击「新建 Prompt」。'}
        </div>
      )}
      <LibraryFormDialog />
    </div>
  );
}
