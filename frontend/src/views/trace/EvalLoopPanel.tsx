// Eval loop panel inside the Trace health card: 👍/👎 annotation (+note+tags,
// 👎 auto-collects into the regression set server-side) and the ✨ LLM 评判
// button that runs LLM-as-judge over the visible turns. Hidden in demo mode
// (the demo API rejects mutations) and on child-agent transcripts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useMemo, useState } from 'react';

import { getEvalStore, judgeSession, putAnnotation } from '@/api/client';
import type { EvalHistoryEntry, Platform, SessionMessage } from '@/api/types';
import { cn } from '@/lib/utils';

import { buildJudgeTranscript } from './judge';

const PRESET_TAGS = ['误改文件', '死循环', '绕路', '幻觉', '错误恢复差'] as const;

const RAW_PRE_CLASS =
  'mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-background/60 p-1.5 text-[0.6rem] leading-relaxed text-muted-foreground';

/** One row of the judge-history list. */
function HistoryRow({ entry }: { entry: EvalHistoryEntry }) {
  const time = new Date(entry.judgedAt).toLocaleString();
  if (!entry.ok) {
    return (
      <li className="text-[0.65rem] text-muted-foreground">
        <details>
          <summary className="cursor-pointer select-none hover:text-foreground">
            ⚠️ 解析失败 · {entry.model} · {time}（点看模型原始输出）
          </summary>
          <pre className={RAW_PRE_CLASS}>{entry.raw}</pre>
        </details>
      </li>
    );
  }
  return (
    <li className="text-[0.65rem] text-muted-foreground">
      <span className="font-semibold text-foreground">{entry.overall} 分</span>
      {' · '}
      {entry.model} · {time}
      {entry.summary ? <div className="pl-2 text-muted-foreground/80">{entry.summary}</div> : null}
    </li>
  );
}

interface EvalLoopPanelProps {
  platform: Platform;
  sessionId: string;
  viewingChildAgent: boolean;
  /** Full message list — the judge transcript is built from these. */
  msgs: SessionMessage[];
}

export function EvalLoopPanel({ platform, sessionId, viewingChildAgent, msgs }: EvalLoopPanelProps) {
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTags, setEditorTags] = useState<string[]>([]);
  const [editorNote, setEditorNote] = useState('');

  const evalStoreQ = useQuery({ queryKey: ['evals'], queryFn: getEvalStore });
  const key = useMemo(() => `${platform}/${encodeURIComponent(sessionId)}`, [platform, sessionId]);
  const annotation = evalStoreQ.data?.annotations?.[key] ?? null;
  const judgement = evalStoreQ.data?.judgements?.[key] ?? null;
  const history = useMemo(() => evalStoreQ.data?.history?.[key] ?? [], [evalStoreQ.data, key]);
  const latestAttempt = history[0];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['evals'] });
  const annMut = useMutation({
    mutationFn: (vars: {
      platform: Platform;
      sessionId: string;
      thumb: 'up' | 'down' | null;
      note?: string;
      tags?: string[];
    }) => putAnnotation(vars.platform, vars.sessionId, vars),
    onSuccess: invalidate,
  });
  const judgeMut = useMutation({
    mutationFn: () => judgeSession(platform, sessionId, buildJudgeTranscript(msgs)),
    onSuccess: invalidate,
  });

  // Raw output of the latest failed judge attempt. Prefer the mutation's own
  // result (covers a server that returned raw without history); fall back to
  // the persisted failure entry so the notice survives tab switches & reloads.
  const failedRaw =
    judgeMut.data && judgeMut.data.judgement === null && judgeMut.data.raw
      ? judgeMut.data.raw
      : latestAttempt && !latestAttempt.ok
        ? latestAttempt.raw
        : null;

  // Demo mode (store query errors) and child transcripts: no eval surface.
  if (!sessionId || viewingChildAgent || evalStoreQ.isError) return null;

  const thumbBtn = (thumb: 'up' | 'down') => {
    const active = annotation?.thumb === thumb;
    const Icon = thumb === 'up' ? ThumbsUp : ThumbsDown;
    return (
      <button
        type="button"
        disabled={annMut.isPending}
        title={thumb === 'up' ? '标为好案例' : '标为坏案例（自动加入回归集）'}
        onClick={() => {
          if (thumb === 'down') {
            if (active) {
              // Toggle off: clear thumb, keep nothing curated in the editor
              annMut.mutate({ platform: platform, sessionId, thumb: null, note: '' });
              setEditorOpen(false);
            } else {
              setEditorTags(annotation?.note ? [] : (annotation && []) || []);
              setEditorTags([]);
              setEditorNote(annotation?.note ?? '');
              setEditorOpen(true);
              annMut.mutate({ platform: platform, sessionId, thumb: 'down' });
            }
          } else {
            annMut.mutate({
              platform: platform,
              sessionId,
              thumb: active ? null : 'up',
              note: annotation?.note ?? '',
            });
          }
        }}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs transition-colors',
          active
            ? thumb === 'up'
              ? 'border-[#3fb950] bg-[#3fb950]/10 text-[#3fb950]'
              : 'border-[#f85149] bg-[#f85149]/10 text-[#f85149]'
            : 'border-border text-muted-foreground hover:text-foreground'
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {thumb === 'up' ? '好' : '坏'}
      </button>
    );
  };

  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">评测闭环：</span>
        {thumbBtn('up')}
        {thumbBtn('down')}
        <button
          type="button"
          disabled={judgeMut.isPending}
          title="把完整会话记录（用户提问、助手回复、工具命令与输出）发给配置的模型打质量分"
          onClick={() => judgeMut.mutate()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d2a8ff]/60 px-2 text-xs text-[#d2a8ff] transition-colors hover:bg-[#d2a8ff]/10 disabled:opacity-60"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {judgeMut.isPending ? '评判中…（本地模型约 1-3 分钟）' : 'LLM 评判'}
        </button>
        {annotation?.thumb === 'down' && !editorOpen && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => {
              setEditorNote(annotation.note ?? '');
              setEditorOpen(true);
            }}
          >
            编辑坏案例标签/备注
          </button>
        )}
      </div>

      {failedRaw && !judgeMut.isPending && (
        <div className="mt-2 rounded-md border border-[#f85149]/40 bg-[#f85149]/5 p-2">
          <div className="text-xs font-medium text-[#f85149]">⚠️ 评判输出解析失败</div>
          <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
            模型没有返回规定的 JSON 评分结构，本次不计分（已留档到评判历史，可直接重试）。
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer select-none text-[0.65rem] text-muted-foreground hover:text-foreground">
              模型原始输出
            </summary>
            <pre className={RAW_PRE_CLASS}>{failedRaw}</pre>
          </details>
        </div>
      )}

      {editorOpen && (
        <div className="mt-2 rounded-md border border-[#f85149]/40 bg-[#f85149]/5 p-2">
          <div className="mb-1.5 text-xs font-medium text-[#f85149]">
            👎 坏案例 · 自动加入回归集（分析 → 全局分析 可管理）
          </div>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {PRESET_TAGS.map((t) => {
              const on = editorTags.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setEditorTags((prev) => (on ? prev.filter((x) => x !== t) : [...prev, t]))}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px]',
                    on ? 'border-[#f85149] bg-[#f85149]/10 text-[#f85149]' : 'border-border text-muted-foreground'
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
          <input
            className="mb-1.5 w-full rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
            placeholder="备注：发生了什么（可选）"
            value={editorNote}
            onChange={(e) => setEditorNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={annMut.isPending}
              onClick={() => {
                annMut.mutate(
                  { platform: platform, sessionId, thumb: 'down', note: editorNote, tags: editorTags },
                  { onSuccess: () => setEditorOpen(false) }
                );
              }}
              className="rounded-md border border-[#f85149]/60 px-2 py-1 text-xs text-[#f85149] hover:bg-[#f85149]/10"
            >
              保存标注 + 回归集
            </button>
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => setEditorOpen(false)}
            >
              收起
            </button>
          </div>
        </div>
      )}

      {judgement && !judgeMut.isPending && (
        <div className="mt-2 rounded-md border border-[#d2a8ff]/40 bg-[#d2a8ff]/5 p-2">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
              style={{ backgroundColor: '#8957e5' }}
              title={`LLM 评判 ${judgement.overall}/100`}
            >
              {judgement.overall}
            </span>
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">
                ✨ LLM 评判 · {judgement.model}
                <span className="ml-1 font-normal text-muted-foreground">
                  {new Date(judgement.judgedAt).toLocaleString()}
                </span>
              </div>
              <div className="flex gap-2 text-[0.65rem] text-muted-foreground">
                <span>完成 {judgement.dimensions.completion}</span>
                <span>效率 {judgement.dimensions.efficiency}</span>
                <span>工具质量 {judgement.dimensions.toolQuality}</span>
                <span>错误恢复 {judgement.dimensions.errorResilience}</span>
              </div>
            </div>
          </div>
          {judgement.summary && <p className="mt-1 text-xs text-foreground/90">{judgement.summary}</p>}
          {judgement.issues.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {judgement.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
          {/* Audit trail: exactly what the judge received + the model's
              thinking, so a score can be verified instead of trusted. */}
          {(judgement.transcript || judgement.reasoning) && (
            <details className="mt-1.5">
              <summary className="cursor-pointer select-none text-[0.65rem] text-muted-foreground hover:text-foreground">
                评判详情（发送给模型的会话记录 / 模型思考过程）
              </summary>
              {judgement.transcript && (
                <div className="mt-1">
                  <div className="text-[0.65rem] font-medium text-muted-foreground">
                    发送的会话记录（{judgement.transcript.length} 字，模型只看到这些）
                  </div>
                  <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-background/60 p-1.5 text-[0.6rem] leading-relaxed text-muted-foreground">
                    {judgement.transcript}
                  </pre>
                </div>
              )}
              {judgement.reasoning && (
                <div className="mt-1">
                  <div className="text-[0.65rem] font-medium text-muted-foreground">模型思考过程</div>
                  <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-background/60 p-1.5 text-[0.6rem] leading-relaxed text-muted-foreground">
                    {judgement.reasoning}
                  </pre>
                </div>
              )}
            </details>
          )}
        </div>
      )}
      {history.length > 0 && !judgeMut.isPending && (
        <details className="mt-1.5">
          <summary className="cursor-pointer select-none text-[0.65rem] text-muted-foreground hover:text-foreground">
            评判历史（{history.length} 次，最新在前，保留最近 10 次）
          </summary>
          <ul className="mt-1 space-y-1.5">
            {history.map((entry, i) => (
              <HistoryRow key={`${entry.judgedAt}-${i}`} entry={entry} />
            ))}
          </ul>
        </details>
      )}
      {judgeMut.isError && (
        <div className="mt-1 text-xs text-[#f85149]">LLM 评判失败：{(judgeMut.error as Error).message}</div>
      )}
    </div>
  );
}
