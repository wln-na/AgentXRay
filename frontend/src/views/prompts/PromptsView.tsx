// Prompts view — real-human prompt extraction grouped by directory.
// 工具栏只保留：搜索 / 聚类分析 / 已隐藏管理。单条收藏与隐藏放在行内。
// 已移除：批量选择、琐碎 prompt 过滤、导出 JSON、单条 LLM 改写、画像三张图表。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { getHiddenPrompts, getPromptAnalysis, getPrompts } from '@/api/client';
import type { PromptAnalysis, PromptCluster } from '@/api/types';
import { PLATFORM_LABELS } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { clusterPrefillContent } from '@/lib/pure';
import { dirForPlatform, useAppStore } from '@/store';
import { heuristicLibraryName, LibraryFormDialog } from '@/views/library/LibraryFormDialog';

import { PromptGroupSection } from './PromptGroupSection';
import { PromptsAnalysis } from './PromptsAnalysis';
import { PromptsHiddenDialog } from './PromptsHiddenDialog';
import { errorMessage, filterPromptGroups, hidePromptTextsChunked } from './promptsLib';

export function PromptsView() {
  const platform = useAppStore((s) => s.platform);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const settings = useAppStore((s) => s.settings);
  const setView = useAppStore((s) => s.setView);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const openLibraryForm = useAppStore((s) => s.openLibraryForm);
  const queryClient = useQueryClient();

  const agent = platform === 'openclaw' && selectedAgent ? selectedAgent : undefined;
  const dir = dirForPlatform(settings, platform) || undefined;

  // Search — debounced 250ms like legacy.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const [manageOpen, setManageOpen] = useState(false);
  // 「入库」-saved cluster patterns (session-local, legacy clusterSavedPatterns).
  const [savedPatterns, setSavedPatterns] = useState<Set<string>>(new Set());

  const promptsQuery = useQuery({
    queryKey: ['prompts', platform, agent ?? '', dir ?? ''],
    queryFn: () => getPrompts({ platform, agent, dir }),
  });
  const hiddenQuery = useQuery({ queryKey: ['prompts-hidden'], queryFn: getHiddenPrompts });
  const hidden = hiddenQuery.data?.hidden ?? [];

  // Persisted 画像 restore (cached=1 probe; 204 → null). staleTime/gcTime Infinity:
  // probe once per scope, then the entry doubles as the store for fresh runs.
  const analysisKey = ['prompt-analysis', platform, agent ?? '', dir ?? ''];
  const cachedAnalysisQuery = useQuery({
    queryKey: analysisKey,
    queryFn: () => getPromptAnalysis({ platform, agent, dir, cached: true }),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const analysis = cachedAnalysisQuery.data ?? null;

  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
  const analyzeMutation = useMutation({
    mutationFn: (refresh: boolean) => getPromptAnalysis({ platform, agent, dir, refresh }),
    onMutate: () => setAnalysisStartedAt(Date.now()),
    onSuccess: (data) => queryClient.setQueryData(analysisKey, data),
    onError: (error) => {
      const failed: PromptAnalysis = { platform, clusters: [], overall: [], llmError: errorMessage(error) };
      queryClient.setQueryData(analysisKey, failed);
    },
    onSettled: () => toast('画像分析完成'),
  });

  const hideMutation = useMutation({
    mutationFn: async ({ texts }: { texts: string[]; message: string }) => hidePromptTextsChunked(texts),
    onSuccess: (_data, { message }) => {
      toast(message);
      void queryClient.invalidateQueries({ queryKey: ['prompts'] });
      void queryClient.invalidateQueries({ queryKey: ['prompts-hidden'] });
    },
    onError: (error) => toast.error(`隐藏失败: ${errorMessage(error)}`),
  });

  const filtered = useMemo(
    () => (promptsQuery.data ? filterPromptGroups(promptsQuery.data, search) : null),
    [promptsQuery.data, search]
  );

  const q = search.trim().toLowerCase();

  if (promptsQuery.isPending) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading prompts…</div>;
  }
  if (promptsQuery.isError) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        Failed to load prompts: {errorMessage(promptsQuery.error)}
      </div>
    );
  }
  const data = promptsQuery.data;
  if (!data || data.groups.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">No prompts found.</div>;
  }

  const analyzeLabel = analyzeMutation.isPending
    ? '分析中…'
    : analysis && analysis.platform === platform
      ? '重新分析'
      : '🧮 聚类分析';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          className="h-8 w-72"
          placeholder="按 prompt 文本 / 目录 / 会话过滤"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={analyzeMutation.isPending}
          title="把相似 prompt 聚成模板簇，统计每类平均轮数/错误率，并由 Claude 给出改写建议（约 1-2 分钟）"
          onClick={() => analyzeMutation.mutate(!!(analysis && analysis.platform === platform))}
        >
          {analyzeLabel}
        </Button>
        {hidden.length > 0 && (
          <Button variant="link" size="sm" className="px-1" onClick={() => setManageOpen(true)}>
            已隐藏 {hidden.length} · 管理
          </Button>
        )}
      </div>

      <div className="text-xs text-muted-foreground">
        <span className="mr-1 rounded-full border border-border bg-secondary px-2 py-0.5">
          📍 当前平台：{PLATFORM_LABELS[platform] || platform}
        </span>
        从会话历史自动提取的真人 prompt（已过滤工具输出与系统注入），按目录分组 — 每条可 ⭐ 收藏入库 ·{' '}
        {data.totalPrompts} prompts / {data.totalSessions} sessions / {data.groups.length} directories
        {q && filtered ? ` — showing ${filtered.shownPrompts} prompts / ${filtered.shownSessions} sessions` : ''}
      </div>

      <PromptsAnalysis
        analysis={analysis}
        loading={analyzeMutation.isPending}
        startedAt={analysisStartedAt}
        platform={platform}
        savedPatterns={savedPatterns}
        onSaveCluster={(c: PromptCluster) => {
          const content = clusterPrefillContent(c);
          if (!content) return;
          openLibraryForm({
            content,
            source: 'history',
            onSaved: () => setSavedPatterns((prev) => new Set(prev).add(c.pattern)),
          });
        }}
      />

      {filtered && filtered.groups.length > 0 ? (
        filtered.groups.map((g) => (
          <PromptGroupSection
            key={g.directory}
            group={g}
            searchActive={!!q}
            onHideSession={(s) =>
              hideMutation.mutate({ texts: s.prompts.map((p) => p.text), message: `已隐藏 ${s.prompts.length} 条` })
            }
            onHidePrompt={(p) => hideMutation.mutate({ texts: [p.text], message: '已隐藏' })}
            hidePending={hideMutation.isPending}
            onStarPrompt={(p) =>
              openLibraryForm({ name: heuristicLibraryName(p.text), content: p.text, source: platform })
            }
            onOpenSession={(id) => {
              setSelectedSessionId(id);
              setView('sessions');
            }}
          />
        ))
      ) : (
        <div className="py-10 text-center text-sm text-muted-foreground">没有匹配的 prompt。</div>
      )}

      <PromptsHiddenDialog open={manageOpen} onOpenChange={setManageOpen} hidden={hidden} />
      <LibraryFormDialog />
    </div>
  );
}
