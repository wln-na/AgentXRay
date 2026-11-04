// 🎯 回归集 — curated bad cases (thumb-down auto-collect + manual add),
// rendered as a section of 全局分析. Each case can jump back to its session
// or be removed. Hidden entirely in demo mode (the eval API is unavailable).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEvalStore, removeRegressionCase } from '@/api/client';
import type { Platform, RegressionCase } from '@/api/types';
import { PLATFORM_LABELS } from '@/api/types';
import { useAppStore } from '@/store';
import { InsightSection } from './bits';

function CaseRow({
  item,
  judgementOverall,
  onRemove,
  removing,
}: {
  item: RegressionCase;
  judgementOverall: number | null;
  onRemove: () => void;
  removing: boolean;
}) {
  const setPlatform = useAppStore((s) => s.setPlatform);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const setView = useAppStore((s) => s.setView);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/70 px-2.5 py-1.5 text-xs">
      <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
        {PLATFORM_LABELS[item.platform as keyof typeof PLATFORM_LABELS] || item.platform}
      </span>
      <span className="font-mono text-muted-foreground" title={item.sessionId}>
        {item.sessionId.slice(0, 22)}
        {item.sessionId.length > 22 ? '…' : ''}
      </span>
      {item.source === 'thumb-down' && <span title="来自 👎 标注">👎</span>}
      {item.source === 'judge' && <span title="来自 LLM 评判低分">✨</span>}
      {(item.tags || []).map((t) => (
        <span
          key={t}
          className="rounded-full border border-[#f85149]/50 bg-[#f85149]/5 px-2 py-0.5 text-[11px] text-[#f85149]"
        >
          {t}
        </span>
      ))}
      {item.note && (
        <span className="min-w-0 max-w-xs truncate text-muted-foreground" title={item.note}>
          {item.note}
        </span>
      )}
      {judgementOverall !== null && (
        <span className="rounded-full bg-[#d2a8ff]/15 px-1.5 py-0.5 font-mono text-[11px] text-[#d2a8ff]">
          ✨ {judgementOverall}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            setPlatform(item.platform as Platform);
            setSelectedSessionId(item.sessionId);
            setView('sessions');
          }}
        >
          打开会话
        </button>
        <button
          type="button"
          disabled={removing}
          className="text-muted-foreground underline underline-offset-2 hover:text-[#f85149] disabled:opacity-50"
          onClick={onRemove}
        >
          移除
        </button>
      </span>
    </div>
  );
}

export function RegressionSection() {
  const evalStoreQ = useQuery({ queryKey: ['evals'], queryFn: getEvalStore });
  const queryClient = useQueryClient();
  const removeMut = useMutation({
    mutationFn: removeRegressionCase,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['evals'] }),
  });

  if (evalStoreQ.isError) return null;
  const cases = evalStoreQ.data?.regression ?? [];
  const judgements = evalStoreQ.data?.judgements ?? {};
  const byTag = new Map<string, number>();
  for (const c of cases) for (const t of c.tags || []) byTag.set(t, (byTag.get(t) || 0) + 1);

  return (
    <InsightSection title="回归集（坏案例收藏）">
      <p className="mb-2 text-xs text-muted-foreground">
        👎 标注或手动收藏的失败会话。改进 prompt / 换模型后回到这些会话上重新「LLM 评判」，对比分数验证改进。
      </p>
      {cases.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          还没有坏案例。在会话的 Trace 视图里点「👎 坏」，或收藏低分评判的会话。
        </div>
      ) : (
        <>
          {byTag.size > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {[...byTag.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([tag, n]) => (
                  <span key={tag} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                    {tag} ×{n}
                  </span>
                ))}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {cases.map((c) => (
              <CaseRow
                key={c.id}
                item={c}
                judgementOverall={judgements[`${c.platform}/${encodeURIComponent(c.sessionId)}`]?.overall ?? null}
                removing={removeMut.isPending}
                onRemove={() => removeMut.mutate(c.id)}
              />
            ))}
          </div>
        </>
      )}
    </InsightSection>
  );
}
