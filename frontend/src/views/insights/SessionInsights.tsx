// 本会话分析 — insights computed client-side from the selected session's
// messages. Legacy: public/js/app.js renderSessionInsights() (render half;
// the stats loop lives in ./sessionStats.ts). Error / retry items jump to the
// failing message via the shared requestScrollToMessage store action.

import { useQuery } from '@tanstack/react-query';
import { getSessionDetail } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDurationCompact } from '@/lib/pure';
import { dirForPlatform, useAppStore } from '@/store';
import { ContextUsageCard } from '@/views/sessions/ContextUsageCard';
import { InsightSection, ScopeChip, StatCard, UsageBar, fmtTokens, formatNumber } from './bits';
import { computeSessionInsights, computeReflectionReport, PROMPT_CATEGORY_LABELS, WASTE_CATEGORY_LABELS } from './sessionStats';
import type { WasteCategory } from './sessionStats';

// Tool sequence chip palette — legacy toolColorPalette order preserved.
const TOOL_PALETTE = [
  { bg: 'rgba(88,166,255,0.15)', color: '#58a6ff' }, // blue
  { bg: 'rgba(63,185,80,0.15)', color: '#3fb950' }, // green
  { bg: 'rgba(210,153,34,0.15)', color: '#d29922' }, // yellow
  { bg: 'rgba(188,143,243,0.15)', color: '#bc8ff3' }, // purple
  { bg: 'rgba(219,109,40,0.15)', color: '#db6d28' }, // orange
  { bg: 'rgba(121,192,255,0.15)', color: '#79c0ff' }, // light blue
  { bg: 'rgba(255,123,114,0.15)', color: '#ff7b72' }, // salmon
  { bg: 'rgba(165,214,255,0.15)', color: '#a5d6ff' }, // sky
];

export function SessionInsights() {
  const platform = useAppStore((s) => s.platform);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const settings = useAppStore((s) => s.settings);
  const requestScrollToMessage = useAppStore((s) => s.requestScrollToMessage);

  // Shared cache with the sessions view — same key + queryFn opts (contract).
  const query = useQuery({
    queryKey: ['session', platform, selectedSessionId],
    enabled: !!selectedSessionId,
    queryFn: () =>
      getSessionDetail(platform, selectedSessionId, {
        agent: selectedAgent || undefined,
        dir: dirForPlatform(settings, platform) || undefined,
      }),
  });

  if (query.isPending) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading session…</div>;
  }
  if (query.isError) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Failed to load session: {query.error.message}
      </div>
    );
  }

  const msgs = query.data.messages;
  const session = query.data.session || {};
  const st = computeSessionInsights(msgs);
  const reflection = computeReflectionReport(msgs);
  const tokenUsage = query.data.tokenUsage || session.tokenUsage;
  const contextUsage = query.data.contextUsage || session.contextUsage;
  const tokenInput = tokenUsage?.input ?? st.totalInputTokens;
  const tokenOutput = tokenUsage?.output ?? st.totalOutputTokens;
  const tokenCacheRead = tokenUsage?.cacheRead ?? st.totalCacheRead;
  const tokenCacheWrite = tokenUsage?.cacheWrite ?? 0;
  const tokenReasoning = tokenUsage?.reasoning ?? 0;
  const tokenTotal = tokenUsage?.totalTokens ?? tokenInput + tokenOutput;

  const errorRate = st.toolResultCount > 0 ? ((st.errorCount / st.toolResultCount) * 100).toFixed(1) : '0.0';
  const maxCalls = st.toolStats.length > 0 ? st.toolStats[0].calls : 1;
  const sid = session.id || selectedSessionId || '?';

  // Jump to the message backing a stat item (error / retry).
  const jumpToIndex = (idx: number) => {
    const msg = msgs[idx];
    if (msg && msg.id) requestScrollToMessage(msg.id);
  };

  // toolName → palette index, in first-appearance order (legacy toolColorMap).
  const toolColorMap: Record<string, number> = {};
  let colorIdx = 0;
  for (const tc of st.toolCalls) {
    if (!(tc.name in toolColorMap)) {
      toolColorMap[tc.name] = colorIdx % TOOL_PALETTE.length;
      colorIdx++;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        本会话分析 <ScopeChip>📍 仅当前会话</ScopeChip>
      </h2>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{sid.slice(0, 20)}</Badge>
        {session.cwd && <Badge variant="secondary">{session.cwd}</Badge>}
        <Badge variant="secondary">
          👤 {st.userCount} &nbsp; 🤖 {st.assistantCount}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-3">
        <StatCard value={st.toolCallCount} label="Tool Calls" />
        <StatCard value={`${errorRate}%`} label="Error Rate" tone={st.errorCount > 0 ? 'error' : undefined} />
        <StatCard value={st.retries.length} label="Retries" />
        <StatCard value={fmtTokens(tokenTotal)} label="Tokens" tone="token" />
        {/* Post-hoc efficiency metrics */}
        <StatCard
          value={st.avgTurnDurationMs > 0 ? formatDurationCompact(st.avgTurnDurationMs) : '—'}
          label="平均轮次耗时"
        />
        <StatCard value={st.avgTurnToolCalls > 0 ? String(st.avgTurnToolCalls) : '—'} label="平均工具调用/轮" />
        <StatCard
          value={st.avgTurnTokens > 0 ? fmtTokens(st.avgTurnTokens) : '—'}
          label="平均 Tokens/轮"
          tone="token"
        />
      </div>

      <ContextUsageCard
        usage={contextUsage}
        unavailableNote={
          session.dataSource === 'indexeddb'
            ? 'Doubao 的 trajectory 与 IndexedDB 本地记录未提供 Token usage，无法计算上下文用量。'
            : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <InsightSection title="Tool Statistics">
          {st.toolStats.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Errors</TableHead>
                  <TableHead>Avg ms</TableHead>
                  <TableHead className="w-[120px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {st.toolStats.map((t) => {
                  const avgMs = t.totalDurationMs > 0 && t.calls > 0 ? Math.round(t.totalDurationMs / t.calls) : null;
                  return (
                    <TableRow key={t.name}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell>{t.calls}</TableCell>
                      <TableCell className={t.errors > 0 ? 'text-destructive' : ''}>{t.errors || '—'}</TableCell>
                      <TableCell>{avgMs !== null ? formatDurationCompact(avgMs) : '—'}</TableCell>
                      <TableCell>
                        <UsageBar pct={Math.max(2, Math.round((t.calls / maxCalls) * 100))} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-[13px] text-muted-foreground">No tool calls in this session</div>
          )}
        </InsightSection>

        {/* ── Post-hoc analysis: MCP / Skill source breakdown ── */}
        {st.sourceBreakdown.length > 0 && (
          <InsightSection title="工具来源分布">
            <div className="flex flex-col gap-2">
              {st.sourceBreakdown.map((b) => {
                const pct = st.toolCallCount > 0 ? Math.round((b.calls / st.toolCallCount) * 100) : 0;
                const sourceColor =
                  b.source === 'mcp' ? '#d2a8ff' :
                  b.source === 'skill' ? '#ffa657' :
                  b.source === 'subagent' ? '#79c0ff' :
                  b.source === 'builtin' ? '#3fb950' : '#8b949e';
                return (
                  <div key={b.source} className="flex items-center gap-2 text-[13px]">
                    <span className="w-20 shrink-0 font-medium" style={{ color: sourceColor }}>
                      {b.label}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: sourceColor }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {b.calls} 次 ({pct}%)
                    </span>
                    {b.errors > 0 && (
                      <span className="w-12 shrink-0 text-right text-xs text-destructive">
                        ❌ {b.errors}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {/* MCP server detail */}
            {st.toolStats.filter((t) => t.source === 'mcp' && t.mcpServer).length > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">MCP 服务器明细</div>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(new Set(st.toolStats.filter((t) => t.mcpServer).map((t) => t.mcpServer!))).map(
                    (server) => {
                      const serverTools = st.toolStats.filter((t) => t.mcpServer === server);
                      const serverCalls = serverTools.reduce((s, t) => s + t.calls, 0);
                      return (
                        <span
                          key={server}
                          className="rounded-full border border-[#d2a8ff]/30 bg-[#d2a8ff]/10 px-2 py-0.5 text-xs text-[#d2a8ff]"
                          title={`${serverTools.map((t) => t.name).join(', ')}`}
                        >
                          🔌 {server} · {serverCalls} 次
                        </span>
                      );
                    }
                  )}
                </div>
              </div>
            )}
          </InsightSection>
        )}

        {/* ── Post-hoc analysis: tool chain patterns ── */}
        {st.toolChainBigrams.length > 0 && (
          <InsightSection title="工具调用链模式">
            <div className="mb-3 text-xs text-muted-foreground">
              分析会话中频繁出现的工具调用顺序，发现工作流模式
            </div>
            {st.toolChainBigrams.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">双工具序列 (Top {st.toolChainBigrams.length})</div>
                <div className="flex flex-col gap-1.5">
                  {st.toolChainBigrams.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-[13px]">
                      <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                      <span className="flex items-center gap-1">
                        <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{p.pattern[0]}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{p.pattern[1]}</span>
                      </span>
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {p.count} 次 ({p.pct.toFixed(1)}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {st.toolChainTrigrams.length > 0 && (
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">三工具序列 (Top {st.toolChainTrigrams.length})</div>
                <div className="flex flex-col gap-1.5">
                  {st.toolChainTrigrams.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-[13px]">
                      <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                      <span className="flex items-center gap-1">
                        <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{p.pattern[0]}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{p.pattern[1]}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{p.pattern[2]}</span>
                      </span>
                      <span className="ml-auto font-mono text-xs text-muted-foreground">
                        {p.count} 次 ({p.pct.toFixed(1)}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </InsightSection>
        )}

        <InsightSection title={`Errors (${st.errors.length})`}>
          {st.errors.length > 0 ? (
            <div className="flex flex-col gap-2">
              {st.errors.map((e, i) => (
                <div
                  key={i}
                  className="cursor-pointer rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 hover:border-destructive/60"
                  title="点击跳到该消息"
                  onClick={() => jumpToIndex(e.index)}
                >
                  <div className="flex items-start justify-between gap-2 text-[13px]">
                    <span className="min-w-0 break-all">{e.snippet}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{e.toolName}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">No errors</div>
          )}
        </InsightSection>

        <InsightSection title={`Retries (${st.retries.length})`}>
          {st.retries.length > 0 ? (
            <div className="flex flex-col gap-2">
              {st.retries.map((r, i) => (
                <div
                  key={i}
                  className="cursor-pointer rounded-md border border-border bg-secondary/40 px-3 py-2 hover:border-primary/40"
                  title="点击跳到出错消息"
                  onClick={() => jumpToIndex(r.errorIndex)}
                >
                  <div className="flex items-start justify-between gap-2 text-[13px]">
                    <span className="min-w-0 break-all">{r.errorSnippet}</span>
                    <span className="shrink-0 text-xs text-[#d29922]">🔄 x{r.attempts} → OK</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{r.toolName}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-muted-foreground">No retries</div>
          )}
        </InsightSection>

        {tokenTotal + tokenCacheRead + tokenCacheWrite + tokenReasoning > 0 && (
          <InsightSection title="Token Breakdown">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">Input: {formatNumber(tokenInput)}</Badge>
              <Badge variant="secondary">Output: {formatNumber(tokenOutput)}</Badge>
              {tokenCacheRead > 0 && (
                <Badge variant="secondary">Cache Read: {formatNumber(tokenCacheRead)}</Badge>
              )}
              {tokenCacheWrite > 0 && (
                <Badge variant="secondary">Cache Write: {formatNumber(tokenCacheWrite)}</Badge>
              )}
              {tokenReasoning > 0 && (
                <Badge variant="secondary">Reasoning: {formatNumber(tokenReasoning)}</Badge>
              )}
              <Badge variant="secondary">Total: {formatNumber(tokenTotal)}</Badge>
            </div>
          </InsightSection>
        )}
      </div>

      {st.toolCalls.length > 0 && (
        <InsightSection title="Tool Call Sequence">
          <div className="flex flex-wrap items-center gap-1 text-xs">
            {st.toolCalls.map((tc, idx) => {
              const pal = TOOL_PALETTE[toolColorMap[tc.name]];
              const hasErrorAfter = st.errors.some(
                (e) => e.toolName === tc.name && e.timestamp === tc.timestamp
              );
              return (
                <span key={idx} className="flex items-center gap-1">
                  {idx > 0 && <span className="text-muted-foreground">→</span>}
                  <span
                    className={`rounded px-1.5 py-0.5 ${hasErrorAfter ? 'ring-1 ring-destructive' : ''}`}
                    style={{ background: pal.bg, color: pal.color }}
                    title={tc.name}
                  >
                    {tc.name}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
            {Object.entries(toolColorMap).map(([name, ci]) => (
              <span key={name} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: TOOL_PALETTE[ci].color }}
                />
                {name}
              </span>
            ))}
          </div>
        </InsightSection>
      )}

      {/* ── Post-hoc analysis: per-turn efficiency ── */}
      {st.turnEfficiencies.length > 0 && (
        <InsightSection title={`每轮效率 (${st.turnEfficiencies.length} 轮)`}>
          <div className="mb-3 text-xs text-muted-foreground">
            从用户提问到最终回复的端到端效率，识别低效轮次（工具调用多/耗时长/出错多）
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>用户问题</TableHead>
                <TableHead className="w-24">耗时</TableHead>
                <TableHead className="w-20">工具调用</TableHead>
                <TableHead className="w-16">错误</TableHead>
                <TableHead className="w-24">Tokens</TableHead>
                <TableHead className="w-16">状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {st.turnEfficiencies.map((t) => {
                const isInefficient = t.toolCalls >= 5 || t.errors > 0 || t.durationMs > 60000;
                return (
                  <TableRow key={t.turnIndex} className={isInefficient ? 'bg-destructive/5' : ''}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{t.turnIndex + 1}</TableCell>
                    <TableCell className="max-w-[300px] truncate text-[13px]" title={t.userSnippet}>
                      {t.userSnippet || '(空)'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.durationMs > 0 ? formatDurationCompact(t.durationMs) : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.toolCalls}</TableCell>
                    <TableCell className={t.errors > 0 ? 'text-destructive' : ''}>
                      {t.errors > 0 ? t.errors : '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.inputTokens + t.outputTokens > 0 ? formatNumber(t.inputTokens + t.outputTokens) : '—'}
                    </TableCell>
                    <TableCell>
                      {t.hasFinalReply ? (
                        <span className="rounded-full bg-[#3fb950]/15 px-1.5 py-0.5 text-[0.65rem] text-[#3fb950]">
                          ✓ 已回复
                        </span>
                      ) : (
                        <span className="rounded-full bg-[#d29922]/15 px-1.5 py-0.5 text-[0.65rem] text-[#d29922]">
                          ⚠ 无回复
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {st.turnEfficiencies.some((t) => t.toolCalls >= 5 || t.errors > 0) && (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              ⚠️ 检测到 {st.turnEfficiencies.filter((t) => t.toolCalls >= 5 || t.errors > 0).length} 个低效轮次
              （工具调用 ≥5 次或出现错误），建议查看 Trace 瀑布图分析具体原因。
            </div>
          )}
        </InsightSection>
      )}

      {/* ── Post-hoc analysis: Prompt depth analysis ── */}
      {st.promptAnalysis && st.promptAnalysis.items.length > 0 && (
        <InsightSection title="🎯 Prompt 深度分析">
          <div className="mb-3 text-xs text-muted-foreground">
            自动分类用户提问意图，评估每个 Prompt 的执行效率和质量，发现可优化的提问方式
          </div>

          {/* Overall quality score */}
          <div className="mb-4 flex items-center gap-4 rounded-lg border border-border bg-secondary/30 p-3">
            <div className="text-center">
              <div className="text-3xl font-bold" style={{ color: st.promptAnalysis.avgQuality >= 70 ? '#3fb950' : st.promptAnalysis.avgQuality >= 50 ? '#d29922' : '#f85149' }}>
                {st.promptAnalysis.avgQuality}
              </div>
              <div className="text-xs text-muted-foreground">平均质量分</div>
            </div>
            <div className="flex-1">
              <div className="mb-1 h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${st.promptAnalysis.avgQuality}%`,
                    background: st.promptAnalysis.avgQuality >= 70 ? '#3fb950' : st.promptAnalysis.avgQuality >= 50 ? '#d29922' : '#f85149',
                  }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{st.promptAnalysis.items.length} 个 Prompt</span>
                <span>
                  {st.promptAnalysis.avgQuality >= 70 ? '✓ 整体质量良好' : st.promptAnalysis.avgQuality >= 50 ? '⚠️ 有优化空间' : '❌ 建议改进提问方式'}
                </span>
              </div>
            </div>
          </div>

          {/* Category distribution */}
          {st.promptAnalysis.categoryStats.length > 0 && (
            <div className="mb-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">提问类型分布</div>
              <div className="flex flex-wrap gap-2">
                {st.promptAnalysis.categoryStats.map((cs) => (
                  <div
                    key={cs.category}
                    className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5"
                    title={`平均工具调用: ${cs.avgToolCalls}, 平均质量: ${cs.avgQuality}`}
                  >
                    <span className="text-sm">{cs.label}</span>
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-mono text-primary">
                      {cs.count}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      质量 {cs.avgQuality}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Best vs Worst prompts */}
          <div className="mb-4 grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-medium text-[#3fb950]">⭐ 高效 Prompt (Top 3)</div>
              <div className="flex flex-col gap-2">
                {st.promptAnalysis.bestPrompts.map((p) => (
                  <div key={p.index} className="rounded-md border border-[#3fb950]/30 bg-[#3fb950]/5 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium" title={p.text}>{p.text}</span>
                      <span className="shrink-0 rounded-full bg-[#3fb950]/20 px-1.5 py-0.5 text-xs font-mono text-[#3fb950]">
                        {p.qualityScore}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[0.65rem] text-muted-foreground">
                      <span>🔧 {p.toolCalls}次</span>
                      <span>⏱ {p.durationMs > 0 ? formatDurationCompact(p.durationMs) : '—'}</span>
                      <span>📝 {p.length}字</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-[#f85149]">⚠️ 待改进 Prompt (Bottom 3)</div>
              <div className="flex flex-col gap-2">
                {st.promptAnalysis.worstPrompts.map((p) => (
                  <div key={p.index} className="rounded-md border border-[#f85149]/30 bg-[#f85149]/5 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium" title={p.text}>{p.text}</span>
                      <span className="shrink-0 rounded-full bg-[#f85149]/20 px-1.5 py-0.5 text-xs font-mono text-[#f85149]">
                        {p.qualityScore}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[0.65rem] text-muted-foreground">
                      <span>🔧 {p.toolCalls}次</span>
                      {p.errors > 0 && <span className="text-[#f85149]">❌ {p.errors}错误</span>}
                      <span>⏱ {p.durationMs > 0 ? formatDurationCompact(p.durationMs) : '—'}</span>
                    </div>
                    {p.qualityFactors.filter((f) => f.startsWith('⚠️') || f.startsWith('❌')).length > 0 && (
                      <div className="mt-1.5 flex flex-col gap-0.5">
                        {p.qualityFactors.filter((f) => f.startsWith('⚠️') || f.startsWith('❌')).slice(0, 2).map((f, i) => (
                          <div key={i} className="text-[0.65rem] text-[#f85149]">{f}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Length vs efficiency */}
          {st.promptAnalysis.lengthEfficiency.length > 0 && (
            <div className="mb-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Prompt 长度与工具调用效率</div>
              <div className="flex items-end gap-3">
                {st.promptAnalysis.lengthEfficiency.map((le) => (
                  <div key={le.range} className="flex flex-1 flex-col items-center gap-1">
                    <div className="text-xs font-mono text-muted-foreground">{le.avgToolCalls}</div>
                    <div
                      className="w-full rounded-t bg-[#58a6ff]/60"
                      style={{ height: `${Math.max(8, le.avgToolCalls * 12)}px` }}
                      title={`平均工具调用: ${le.avgToolCalls}`}
                    />
                    <div className="text-[0.65rem] text-muted-foreground">{le.range}</div>
                    <div className="text-[0.6rem] text-muted-foreground">{le.count}个</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* All prompts detail table */}
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">全部 Prompt 明细</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead className="w-28">类型</TableHead>
                  <TableHead className="w-16">长度</TableHead>
                  <TableHead className="w-16">工具</TableHead>
                  <TableHead className="w-14">错误</TableHead>
                  <TableHead className="w-20">耗时</TableHead>
                  <TableHead className="w-16">质量分</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {st.promptAnalysis.items.map((p) => (
                  <TableRow key={p.index}>
                    <TableCell className="font-mono text-xs text-muted-foreground">{p.index + 1}</TableCell>
                    <TableCell className="max-w-[250px] truncate text-[13px]" title={p.text}>{p.text || '(空)'}</TableCell>
                    <TableCell className="text-xs">{PROMPT_CATEGORY_LABELS[p.category]}</TableCell>
                    <TableCell className="font-mono text-xs">{p.length}</TableCell>
                    <TableCell className="font-mono text-xs">{p.toolCalls}</TableCell>
                    <TableCell className={p.errors > 0 ? 'text-destructive' : ''}>{p.errors > 0 ? p.errors : '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{p.durationMs > 0 ? formatDurationCompact(p.durationMs) : '—'}</TableCell>
                    <TableCell>
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[0.65rem] font-mono"
                        style={{
                          background: p.qualityScore >= 70 ? 'rgba(63,185,80,0.15)' : p.qualityScore >= 50 ? 'rgba(210,153,34,0.15)' : 'rgba(248,81,73,0.15)',
                          color: p.qualityScore >= 70 ? '#3fb950' : p.qualityScore >= 50 ? '#d29922' : '#f85149',
                        }}
                      >
                        {p.qualityScore}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </InsightSection>
      )}

      {/* ── Execution efficiency: thinking time analysis ── */}
      {st.thinkingAnalysis && st.thinkingAnalysis.thinkingCount > 0 && (
        <InsightSection title="🧠 思考时间分布">
          <div className="mb-3 flex flex-wrap gap-3">
            <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-center">
              <div className="text-xl font-bold text-[#58a6ff]">{formatDurationCompact(st.thinkingAnalysis.totalThinkingMs)}</div>
              <div className="text-xs text-muted-foreground">总思考时间</div>
            </div>
            <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-center">
              <div className="text-xl font-bold">{formatDurationCompact(st.thinkingAnalysis.avgThinkingMs)}</div>
              <div className="text-xs text-muted-foreground">平均思考时间</div>
            </div>
            <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-center">
              <div className="text-xl font-bold text-[#d29922]">{formatDurationCompact(st.thinkingAnalysis.maxThinkingMs)}</div>
              <div className="text-xs text-muted-foreground">最长思考时间</div>
            </div>
            <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-center">
              <div className="text-xl font-bold">{st.thinkingAnalysis.thinkingCount}</div>
              <div className="text-xs text-muted-foreground">思考阶段数</div>
            </div>
          </div>

          {/* Thinking by type */}
          {st.thinkingAnalysis.byType.length > 0 && (
            <div className="mb-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">按阶段类型分布</div>
              <div className="flex flex-col gap-2">
                {st.thinkingAnalysis.byType.map((t) => {
                  const pct = st.thinkingAnalysis.totalThinkingMs > 0 ? Math.round((t.totalMs / st.thinkingAnalysis.totalThinkingMs) * 100) : 0;
                  return (
                    <div key={t.type} className="flex items-center gap-2 text-[13px]">
                      <span className="w-28 shrink-0">{t.label}</span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                        <div className="h-full rounded-full bg-[#58a6ff]" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-24 shrink-0 text-right font-mono text-xs text-muted-foreground">
                        {formatDurationCompact(t.totalMs)} ({t.count}次)
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Thinking time distribution */}
          {st.thinkingAnalysis.distribution.length > 0 && (
            <div className="mb-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">思考时长分布</div>
              <div className="flex items-end gap-2">
                {st.thinkingAnalysis.distribution.map((d) => (
                  <div key={d.range} className="flex flex-1 flex-col items-center gap-1">
                    <div className="text-xs font-mono text-muted-foreground">{d.count}</div>
                    <div
                      className="w-full rounded-t bg-[#58a6ff]/60"
                      style={{ height: `${Math.max(8, d.count * 8)}px` }}
                      title={`${d.count} 次，共 ${formatDurationCompact(d.totalMs)}`}
                    />
                    <div className="text-[0.65rem] text-muted-foreground">{d.range}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Longest thinking phases */}
          {st.thinkingAnalysis.phases.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">最长思考阶段 Top 5</div>
              <div className="flex flex-col gap-1.5">
                {st.thinkingAnalysis.phases.slice(0, 5).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2 py-1.5 text-[13px]">
                    <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                    <span className="w-24 shrink-0 text-xs">
                      {p.type === 'before-tool' ? '🔧 工具前' : p.type === 'before-reply' ? '💬 回复前' : p.type === 'after-error' ? '❌ 错误后' : '📦 其他'}
                    </span>
                    {p.toolName && <span className="truncate text-xs text-muted-foreground">{p.toolName}</span>}
                    <span className="ml-auto shrink-0 font-mono text-xs text-[#58a6ff]">{formatDurationCompact(p.durationMs)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </InsightSection>
      )}

      {/* ── Execution efficiency: cost estimate ── */}
      {st.costEstimate && st.costEstimate.totalCost > 0 && (
        <InsightSection title="💰 成本估算">
          <div className="mb-3 rounded-lg border border-[#d29922]/30 bg-[#d29922]/5 p-3">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-[#d29922]">${st.costEstimate.totalCost.toFixed(4)}</span>
              <span className="text-sm text-muted-foreground">预估总成本 (USD)</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              基于 Claude Sonnet 定价：Input ${st.costEstimate.modelPricing.input}/M, Output ${st.costEstimate.modelPricing.output}/M, Cache Read ${st.costEstimate.modelPricing.cacheRead}/M
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-md border border-border bg-secondary/30 p-2 text-center">
              <div className="text-sm font-mono font-bold">${st.costEstimate.inputCost.toFixed(4)}</div>
              <div className="text-[0.65rem] text-muted-foreground">Input 成本</div>
            </div>
            <div className="rounded-md border border-border bg-secondary/30 p-2 text-center">
              <div className="text-sm font-mono font-bold">${st.costEstimate.outputCost.toFixed(4)}</div>
              <div className="text-[0.65rem] text-muted-foreground">Output 成本</div>
            </div>
            <div className="rounded-md border border-border bg-secondary/30 p-2 text-center">
              <div className="text-sm font-mono font-bold">${st.costEstimate.cacheReadCost.toFixed(4)}</div>
              <div className="text-[0.65rem] text-muted-foreground">缓存读取成本</div>
            </div>
            <div className="rounded-md border border-border bg-secondary/30 p-2 text-center">
              <div className="text-sm font-mono font-bold">{formatNumber(tokenInput + tokenOutput)}</div>
              <div className="text-[0.65rem] text-muted-foreground">总 Tokens</div>
            </div>
          </div>

          {/* Cost per turn */}
          {st.costEstimate.perTurn.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">每轮成本分布</div>
              <div className="flex items-end gap-1">
                {st.costEstimate.perTurn.map((t) => (
                  <div key={t.turnIndex} className="flex flex-1 flex-col items-center gap-0.5" title={`第${t.turnIndex + 1}轮: $${t.cost.toFixed(4)}, ${t.tokens} tokens`}>
                    <div
                      className="w-full rounded-t bg-[#d29922]/60"
                      style={{ height: `${Math.max(4, (t.cost / st.costEstimate.totalCost) * 100)}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[0.6rem] text-muted-foreground">
                <span>第1轮</span>
                <span>第{st.costEstimate.perTurn.length}轮</span>
              </div>
            </div>
          )}
        </InsightSection>
      )}

      {/* ── Knowledge asset: common commands & files ── */}
      {(st.commonCommands.length > 0 || st.commonFiles.length > 0) && (
        <InsightSection title="📦 知识资产：常用命令与文件">
          <div className="grid gap-4 md:grid-cols-2">
            {st.commonCommands.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">🔧 常用命令 (Top {st.commonCommands.length})</div>
                <div className="flex flex-col gap-1.5">
                  {st.commonCommands.map((c, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2 py-1.5">
                      <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                      <code className="min-w-0 flex-1 truncate text-xs" title={c.command}>{c.command}</code>
                      <span className="shrink-0 rounded-full bg-[#3fb950]/15 px-1.5 py-0.5 text-[0.65rem] font-mono text-[#3fb950]">
                        ×{c.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {st.commonFiles.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">📁 高频操作文件 (Top {st.commonFiles.length})</div>
                <div className="flex flex-col gap-1.5">
                  {st.commonFiles.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-2 py-1.5">
                      <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-xs" title={f.path}>{f.path}</span>
                      <span className="flex shrink-0 gap-1">
                        {f.readCount > 0 && (
                          <span className="rounded bg-[#58a6ff]/15 px-1 py-0.5 text-[0.6rem] text-[#58a6ff]" title="读取次数">
                            📖{f.readCount}
                          </span>
                        )}
                        {f.writeCount > 0 && (
                          <span className="rounded bg-[#f85149]/15 px-1 py-0.5 text-[0.6rem] text-[#f85149]" title="写入次数">
                            ✏️{f.writeCount}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </InsightSection>
      )}

      {/* ── Knowledge asset: decision records ── */}
      {st.decisionRecords.length > 0 && (
        <InsightSection title={`🎯 决策记录 (${st.decisionRecords.length} 条)`}>
          <div className="mb-2 text-xs text-muted-foreground">
            从模型思考过程中提取的关键决策和理由，可作为技术决策文档沉淀
          </div>
          <div className="flex flex-col gap-2">
            {st.decisionRecords.slice(0, 10).map((d, i) => (
              <div key={i} className="rounded-md border border-border bg-secondary/30 p-2.5">
                <div className="flex items-start gap-2">
                  <span
                    className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] ${
                      d.confidence === 'high' ? 'bg-[#3fb950]/15 text-[#3fb950]' :
                      d.confidence === 'medium' ? 'bg-[#d29922]/15 text-[#d29922]' :
                      'bg-secondary text-muted-foreground'
                    }`}
                  >
                    {d.confidence === 'high' ? '高置信' : d.confidence === 'medium' ? '中置信' : '低置信'}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-relaxed">{d.text}</span>
                </div>
                {d.keywords.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {d.keywords.slice(0, 4).map((k, ki) => (
                      <span key={ki} className="rounded bg-primary/10 px-1 py-0.5 text-[0.6rem] text-primary">
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {st.decisionRecords.length > 10 && (
            <div className="mt-2 text-center text-xs text-muted-foreground">
              还有 {st.decisionRecords.length - 10} 条决策记录，可导出完整分析查看
            </div>
          )}
        </InsightSection>
      )}

      {/* ── Knowledge asset: error knowledge base ── */}
      {st.errorKnowledge.length > 0 && (
        <InsightSection title={`📚 错误知识库 (${st.errorKnowledge.length} 条)`}>
          <div className="mb-2 text-xs text-muted-foreground">
            从工具错误和后续修复中提取的"错误→修复"知识，可加速后续类似问题的解决
          </div>
          <div className="flex flex-col gap-2">
            {st.errorKnowledge.slice(0, 10).map((e, i) => (
              <div key={i} className={`rounded-md border p-2.5 ${e.resolved ? 'border-border bg-secondary/30' : 'border-destructive/30 bg-destructive/5'}`}>
                <div className="flex items-center gap-2">
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] ${e.resolved ? 'bg-[#3fb950]/15 text-[#3fb950]' : 'bg-destructive/15 text-destructive'}`}>
                    {e.resolved ? `✓ 已解决 (${e.attempts}次尝试)` : '❌ 未解决'}
                  </span>
                  <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[0.6rem] text-muted-foreground">
                    {e.toolName}
                  </span>
                </div>
                <div className="mt-1.5 text-[13px]">
                  <span className="text-destructive">❌ {e.errorSnippet || '(无错误信息)'}</span>
                </div>
                {e.resolved && e.fixSnippet && (
                  <div className="mt-1 text-[13px]">
                    <span className="text-[#3fb950]">✓ {e.fixSnippet}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          {st.errorKnowledge.length > 10 && (
            <div className="mt-2 text-center text-xs text-muted-foreground">
              还有 {st.errorKnowledge.length - 10} 条错误记录
            </div>
          )}
        </InsightSection>
      )}

      {/* ─── 反思与总结（流程闭环：度量→归因→沉淀→建议） ─── */}
      <InsightSection title={
        <span className="flex items-center gap-2">
          🔄 反思与总结
          <span className="text-xs font-normal text-muted-foreground">流程闭环 · 浪费归因 · 健康检查 · 资产沉淀</span>
        </span>
      }>
        {/* 执行摘要 */}
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-md border border-border bg-secondary/30 p-2.5">
            <div className="text-[0.65rem] text-muted-foreground">任务目标</div>
            <div className="mt-0.5 truncate text-xs font-medium" title={reflection.summary.taskGoal}>{reflection.summary.taskGoal || '(无)'}</div>
          </div>
          <div className="rounded-md border border-border bg-secondary/30 p-2.5">
            <div className="text-[0.65rem] text-muted-foreground">完成状态</div>
            <div className={`mt-0.5 text-xs font-medium ${reflection.summary.completed ? 'text-[#3fb950]' : 'text-amber-500'}`}>
              {reflection.summary.completed ? '✓ 有最终回复' : '⚠ 无最终回复'}
            </div>
          </div>
          <div className="rounded-md border border-border bg-secondary/30 p-2.5">
            <div className="text-[0.65rem] text-muted-foreground">轮次 / 工具 / 错误</div>
            <div className="mt-0.5 text-xs font-medium">
              {reflection.summary.totalTurns} 轮 · {reflection.summary.totalToolCalls} 工具
              {reflection.summary.totalErrors > 0 && <span className="text-destructive"> · {reflection.summary.totalErrors} 错误</span>}
            </div>
          </div>
          <div className="rounded-md border border-border bg-secondary/30 p-2.5">
            <div className="text-[0.65rem] text-muted-foreground">有效 Token / 耗时</div>
            <div className="mt-0.5 text-xs font-medium">
              {fmtTokens(reflection.summary.effectiveTokens)} · {formatDurationCompact(reflection.summary.totalDurationMs)}
            </div>
          </div>
        </div>

        {/* 浪费归因 */}
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold">浪费归因</h3>
          {reflection.waste.items.length === 0 ? (
            <div className="rounded-md border border-[#3fb950]/30 bg-[#3fb950]/5 p-3 text-xs text-[#3fb950]">
              ✓ 未检测到明显浪费模式，本会话流程健康
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {reflection.waste.items.map((w, i) => (
                <div key={i} className={`rounded-md border p-2.5 ${
                  w.severity === 'high' ? 'border-destructive/40 bg-destructive/5' :
                  w.severity === 'medium' ? 'border-amber-500/40 bg-amber-500/5' :
                  'border-border bg-secondary/30'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[0.6rem] font-medium ${
                      w.severity === 'high' ? 'bg-destructive/15 text-destructive' :
                      w.severity === 'medium' ? 'bg-amber-500/15 text-amber-500' :
                      'bg-secondary text-muted-foreground'
                    }`}>
                      {w.severity === 'high' ? '高' : w.severity === 'medium' ? '中' : '低'}
                    </span>
                    <span className="text-xs font-medium">{WASTE_CATEGORY_LABELS[w.category as WasteCategory]}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{w.evidence}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 流程健康检查 */}
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold">
            流程健康检查
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {reflection.healthCheck.passCount} 通过 · {reflection.healthCheck.failCount} 未通过 · {reflection.healthCheck.manualCount} 需人工判断
            </span>
          </h3>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {reflection.healthCheck.items.map((item) => (
              <div key={item.id} className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 p-2">
                <span className={`mt-0.5 shrink-0 text-xs ${
                  item.status === 'pass' ? 'text-[#3fb950]' :
                  item.status === 'fail' ? 'text-destructive' :
                  'text-amber-500'
                }`}>
                  {item.status === 'pass' ? '✓' : item.status === 'fail' ? '✗' : '?'}
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-medium">{item.label}</div>
                  {item.evidence && <div className="mt-0.5 text-[0.65rem] text-muted-foreground">{item.evidence}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 可沉淀资产 */}
        {reflection.assets.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-2 text-sm font-semibold">
              可沉淀资产
              <span className="ml-2 text-xs font-normal text-muted-foreground">从本会话中识别，可沉淀为 CONTEXT.md / spec / workflow</span>
            </h3>
            <div className="flex flex-col gap-1.5">
              {reflection.assets.map((a, i) => (
                <div key={i} className="flex items-start gap-2 rounded-md border border-[#58a6ff]/30 bg-[#58a6ff]/5 p-2">
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-medium ${
                    a.type === 'rule' ? 'bg-amber-500/15 text-amber-500' :
                    a.type === 'workflow' ? 'bg-[#3fb950]/15 text-[#3fb950]' :
                    'bg-[#58a6ff]/15 text-[#58a6ff]'
                  }`}>
                    {a.type === 'rule' ? '规则' : a.type === 'workflow' ? 'Workflow' : '术语'}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium" title={a.label}>{a.label}</div>
                    <div className="mt-0.5 text-[0.65rem] text-muted-foreground">{a.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 改进建议 */}
        <div>
          <h3 className="mb-2 text-sm font-semibold">改进建议</h3>
          <div className="flex flex-col gap-1.5">
            {reflection.suggestions.map((s, i) => (
              <div key={i} className="flex items-start gap-2 rounded-md border border-border bg-secondary/20 p-2">
                <span className="mt-0.5 shrink-0 text-xs text-[#58a6ff]">{i + 1}.</span>
                <div className="text-xs">{s}</div>
              </div>
            ))}
          </div>
        </div>
      </InsightSection>
    </div>
  );
}
