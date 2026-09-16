// Per-session insight statistics — ported verbatim from the stats loop of
// legacy public/js/app.js renderSessionInsights() (lines ~638-728). Pure, no DOM.
// Extended with post-hoc analysis: MCP/Skill source classification, tool-call
// chain pattern mining, and per-turn efficiency metrics.

import type { SessionMessage } from '@/api/types';
import type { MessageContentPart } from '@/api/types';
import { classifyToolSource, firstInformativeLine, getTextContent, parseTimestampMs } from '@/lib/pure';
import type { ToolSource } from '@/lib/pure';

export interface SessionToolStat {
  name: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  errorRate: number;
  source: ToolSource;
  mcpServer?: string;
}

export interface SessionErrorItem {
  toolName: string;
  snippet: string;
  timestamp: string | null;
  index: number;
}

export interface SessionRetryItem {
  toolName: string;
  errorIndex: number;
  successIndex: number;
  errorSnippet: string;
  attempts: number;
}

export interface SessionToolCallItem {
  index: number;
  name: string;
  timestamp: string | null;
  callId: string | null | undefined;
}

/** Tool source breakdown: how many calls came from MCP / Skill / builtin / etc. */
export interface ToolSourceBreakdown {
  source: ToolSource;
  label: string;
  calls: number;
  errors: number;
  tools: string[];
}

/** A frequent tool-call chain (bigram/trigram) found in the session. */
export interface ToolChainPattern {
  pattern: string[];
  count: number;
  pct: number; // % of all adjacent pairs/triples
}

/** Per-turn efficiency: from user question to final assistant reply. */
export interface TurnEfficiency {
  turnIndex: number;
  userSnippet: string;
  startTime: number | null;
  endTime: number | null;
  durationMs: number;
  toolCalls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  hasFinalReply: boolean;
}

export interface SessionInsightsStats {
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  errorCount: number;
  toolStats: SessionToolStat[]; // sorted by calls desc
  errors: SessionErrorItem[];
  retries: SessionRetryItem[];
  toolCalls: SessionToolCallItem[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  // ── Post-hoc analysis extensions ──
  sourceBreakdown: ToolSourceBreakdown[]; // MCP / Skill / builtin / …
  toolChainBigrams: ToolChainPattern[]; // 2-tool sequences
  toolChainTrigrams: ToolChainPattern[]; // 3-tool sequences
  turnEfficiencies: TurnEfficiency[]; // per-turn metrics
  avgTurnDurationMs: number;
  avgTurnToolCalls: number;
  avgTurnTokens: number;
  // ── Prompt depth analysis ──
  promptAnalysis: PromptDepthAnalysis;
  // ── Execution efficiency & cost ──
  thinkingAnalysis: ThinkingAnalysis;
  costEstimate: CostEstimate;
  // ── Knowledge asset extraction ──
  commonCommands: CommonCommand[];
  commonFiles: CommonFile[];
  decisionRecords: DecisionRecord[];
  errorKnowledge: ErrorKnowledgeItem[];
}

// ─── Prompt depth analysis ────────────────────────────────────────────────
// Classify each user prompt by intent, measure its effectiveness (how many
// tools/errors/tokens it took to resolve), and compute a quality score.

export type PromptCategory =
  | 'bugfix'      // Bug 修复
  | 'feature'     // 需求开发
  | 'review'      // 代码审查
  | 'refactor'    // 重构
  | 'config'      // 配置/环境
  | 'debug'       // 调试/排查
  | 'qa'          // 问答
  | 'docs'        // 文档
  | 'test'        // 测试
  | 'other';      // 其他

export const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  bugfix: '🐛 Bug 修复',
  feature: '✨ 需求开发',
  review: '👀 代码审查',
  refactor: '🔄 重构',
  config: '⚙️ 配置/环境',
  debug: '🔍 调试/排查',
  qa: '❓ 问答',
  docs: '📝 文档',
  test: '🧪 测试',
  other: '📦 其他',
};

const PROMPT_CATEGORY_KEYWORDS: Record<PromptCategory, string[]> = {
  bugfix: ['bug', 'fix', 'error', '报错', '修复', '问题', '异常', 'crash', '失败', '不工作', '不行', '404', '500', 'exception', 'stack trace'],
  feature: ['feature', 'implement', '开发', '实现', '新增', '添加', '功能', '需求', '做一个', '写一个', '创建', 'build', 'add'],
  review: ['review', '审查', '检查代码', 'code review', '看看代码', '评审', 'review this'],
  refactor: ['refactor', '重构', '优化代码', '整理代码', 'clean up', 'rewrite', '重写', '拆分', '合并'],
  config: ['config', '配置', 'setup', '环境', '安装', 'deploy', '部署', 'ci', 'pipeline', 'docker', '依赖', 'package', 'webpack', 'vite'],
  debug: ['debug', '调试', 'trace', '排查', '分析', '为什么', '原因', 'root cause', '定位', 'investigate'],
  qa: ['what', 'how', 'why', '是什么', '怎么', '为什么', '解释', '请问', '意思', '区别', 'compare', 'explain', 'tell me'],
  docs: ['doc', '文档', '写文档', '注释', 'readme', '说明', '教程', 'guide', 'comment'],
  test: ['test', '测试', '单测', '单元测试', 'e2e', 'integration', 'mock', 'jest', 'vitest'],
  other: [],
};

/** Classify a user prompt by its intent using keyword matching. */
export function classifyPrompt(text: string): PromptCategory {
  const lower = (text || '').toLowerCase();
  if (!lower.trim()) return 'other';
  // Score each category by keyword matches
  let best: PromptCategory = 'other';
  let bestScore = 0;
  for (const [cat, keywords] of Object.entries(PROMPT_CATEGORY_KEYWORDS) as [PromptCategory, string[]][]) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score += kw.length > 2 ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

export interface PromptAnalysisItem {
  index: number;
  text: string;
  category: PromptCategory;
  length: number;
  toolCalls: number;
  errors: number;
  retries: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  hasFinalReply: boolean;
  /** 0-100 quality score: higher = more efficient / better-structured prompt */
  qualityScore: number;
  qualityFactors: string[]; // human-readable factors that affected the score
}

export interface PromptCategoryStat {
  category: PromptCategory;
  label: string;
  count: number;
  avgToolCalls: number;
  avgDurationMs: number;
  errorRate: number;
  avgQuality: number;
}

export interface PromptDepthAnalysis {
  items: PromptAnalysisItem[];
  categoryStats: PromptCategoryStat[];
  avgQuality: number;
  bestPrompts: PromptAnalysisItem[]; // top 3 by quality
  worstPrompts: PromptAnalysisItem[]; // bottom 3 by quality
  lengthEfficiency: { range: string; avgToolCalls: number; count: number }[];
}

/** Compute a 0-100 quality score for a prompt based on efficiency metrics. */
function computePromptQuality(item: Omit<PromptAnalysisItem, 'qualityScore' | 'qualityFactors'>): {
  score: number;
  factors: string[];
} {
  let score = 70; // baseline
  const factors: string[] = [];

  // Length: too short (<20 chars) may be under-specified, too long (>500) may be rambling
  if (item.length < 20) {
    score -= 10;
    factors.push('⚠️ 描述过短，可能上下文不足');
  } else if (item.length >= 20 && item.length <= 200) {
    score += 10;
    factors.push('✓ 长度适中');
  } else if (item.length > 500) {
    score -= 5;
    factors.push('⚠️ 描述较长，可考虑精简');
  }

  // Tool calls: 0 = maybe didn't need tools (good for Q&A), 1-3 = efficient, >5 = heavy
  if (item.toolCalls === 0) {
    score += 5;
    factors.push('✓ 无需工具调用');
  } else if (item.toolCalls <= 3) {
    score += 10;
    factors.push('✓ 工具调用精简');
  } else if (item.toolCalls > 5) {
    score -= 10;
    factors.push(`⚠️ 工具调用较多 (${item.toolCalls}次)，可考虑拆分任务`);
  }

  // Errors
  if (item.errors === 0) {
    score += 5;
    factors.push('✓ 无工具错误');
  } else {
    score -= item.errors * 8;
    factors.push(`❌ ${item.errors} 次工具错误`);
  }

  // Retries
  if (item.retries > 0) {
    score -= item.retries * 5;
    factors.push(`🔄 ${item.retries} 次重试`);
  }

  // Final reply
  if (item.hasFinalReply) {
    score += 5;
    factors.push('✓ 有最终回复');
  } else {
    score -= 10;
    factors.push('⚠️ 无最终回复');
  }

  // Duration: <10s = fast, >60s = slow
  if (item.durationMs > 0 && item.durationMs < 10000) {
    score += 5;
    factors.push('✓ 响应快速');
  } else if (item.durationMs > 60000) {
    score -= 5;
    factors.push('⚠️ 耗时较长');
  }

  return { score: Math.max(0, Math.min(100, score)), factors };
}

// ─── Execution efficiency & cost analysis interfaces ─────────────────────

export interface ThinkingPhase {
  type: 'before-tool' | 'before-reply' | 'after-error' | 'other';
  durationMs: number;
  toolName?: string;
  hasText: boolean;
}

export interface ThinkingAnalysis {
  totalThinkingMs: number;
  avgThinkingMs: number;
  maxThinkingMs: number;
  thinkingCount: number;
  phases: ThinkingPhase[];
  byType: { type: string; label: string; count: number; totalMs: number; avgMs: number }[];
  distribution: { range: string; count: number; totalMs: number }[];
}

export interface CostEstimate {
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  reasoningCost: number;
  currency: string;
  modelPricing: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  perTurn: { turnIndex: number; cost: number; tokens: number }[];
}

// ─── Knowledge asset extraction interfaces ────────────────────────────────

export interface CommonCommand {
  command: string;
  count: number;
  avgDurationMs: number;
  errors: number;
}

export interface CommonFile {
  path: string;
  readCount: number;
  writeCount: number;
  totalOps: number;
}

export interface DecisionRecord {
  text: string;
  timestamp: string | null;
  confidence: 'high' | 'medium' | 'low';
  keywords: string[];
}

export interface ErrorKnowledgeItem {
  errorSnippet: string;
  toolName: string;
  fixSnippet: string;
  fixToolName: string;
  attempts: number;
  resolved: boolean;
}

// ─── Model pricing (per 1M tokens, USD) ──────────────────────────────────
const DEFAULT_MODEL_PRICING = {
  input: 3.0,
  output: 15.0,
  cacheRead: 0.30,
  cacheWrite: 3.75,
  reasoning: 15.0,
};

function computeCost(
  input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number,
  pricing = DEFAULT_MODEL_PRICING
): number {
  return (
    (input * pricing.input +
      output * pricing.output +
      cacheRead * pricing.cacheRead +
      cacheWrite * pricing.cacheWrite +
      reasoning * pricing.reasoning) / 1_000_000
  );
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function tsToMs(ts: string | number | null | undefined): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.getTime();
}

const SOURCE_LABELS: Record<ToolSource, string> = {
  builtin: '内置工具',
  mcp: 'MCP 工具',
  skill: 'Skill 工具',
  subagent: '子 Agent',
  other: '其他',
};

export function computeSessionInsights(msgs: SessionMessage[]): SessionInsightsStats {
  let userCount = 0,
    assistantCount = 0,
    toolCallCount = 0,
    toolResultCount = 0,
    errorCount = 0;
  const toolStats: Record<string, { calls: number; errors: number; totalDurationMs: number }> = {};
  const errors: SessionErrorItem[] = [];
  const toolCallsList: SessionToolCallItem[] = [];
  let totalInputTokens = 0,
    totalOutputTokens = 0,
    totalCacheRead = 0;

  // Retry detection: track error→success chains per tool per turn
  let turnToolErrors: Record<string, { errorIndex: number; snippet: string; attempts: number } | null> = {};
  const retries: SessionRetryItem[] = [];
  // callId → toolName map (Claude Code format: toolResult has no name)
  const callIdToName: Record<string, string> = {};

  // ── Post-hoc analysis: per-turn collection ──
  interface TurnAccumulator {
    index: number;
    userSnippet: string;
    startTime: number | null;
    endTime: number | null;
    toolCalls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    toolSequence: string[]; // ordered tool names in this turn
    hasFinalReply: boolean;
  }
  const turns: TurnAccumulator[] = [];
  let currentTurn: TurnAccumulator | null = null;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const msgTs = tsToMs(msg.timestamp);

    if (msg.role === 'user') {
      turnToolErrors = {};
      userCount++;
      // Start a new turn
      currentTurn = {
        index: turns.length,
        userSnippet: firstInformativeLine(getTextContent(msg.content)).slice(0, 80),
        startTime: msgTs,
        endTime: msgTs,
        toolCalls: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolSequence: [],
        hasFinalReply: false,
      };
      turns.push(currentTurn);
    }
    if (msg.role === 'assistant') {
      assistantCount++;
      const inTokens = num(msg.usage?.input) || num(msg.usage?.input_tokens);
      const outTokens = num(msg.usage?.output) || num(msg.usage?.output_tokens);
      if (msg.usage) {
        totalInputTokens += inTokens;
        totalOutputTokens += outTokens;
        totalCacheRead += num(msg.usage.cacheRead) || num(msg.usage.cache_read);
      }
      if (currentTurn) {
        currentTurn.endTime = msgTs;
        currentTurn.inputTokens += inTokens;
        currentTurn.outputTokens += outTokens;
        // An assistant message with text content = a visible reply
        const text = getTextContent(msg.content || []);
        if (text.trim().length > 0) currentTurn.hasFinalReply = true;
      }
    }
    if (msg.role === 'toolResult') {
      toolResultCount++;
      const name = msg.toolName || (msg.toolCallId ? callIdToName[msg.toolCallId] : undefined) || '?';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      const pending = turnToolErrors[name];
      if (msg.isError) {
        errorCount++;
        toolStats[name].errors++;
        if (currentTurn) currentTurn.errors++;
        const snippet = firstInformativeLine(getTextContent(msg.content));
        errors.push({ toolName: name, snippet, timestamp: msg.timestamp, index: i });
        if (!pending) turnToolErrors[name] = { errorIndex: i, snippet, attempts: 1 };
        else pending.attempts++;
      } else if (pending) {
        // Success after errors = retry resolved
        if (pending.attempts >= 2) {
          retries.push({
            toolName: name,
            errorIndex: pending.errorIndex,
            successIndex: i,
            errorSnippet: pending.snippet,
            attempts: pending.attempts,
          });
        }
        turnToolErrors[name] = null;
      }
      if (msg.details && typeof msg.details.durationMs === 'number') {
        toolStats[name].totalDurationMs += msg.details.durationMs;
      }
      if (currentTurn) currentTurn.endTime = msgTs;
    }
    // Standalone toolCall records (Codex/OMP style: separate role instead of content part)
    if (msg.role === 'toolCall') {
      toolCallCount++;
      const name = msg.toolName || 'unknown';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls++;
      toolCallsList.push({ index: i, name, timestamp: msg.timestamp, callId: msg.toolCallId });
      if (msg.toolCallId) callIdToName[msg.toolCallId] = name;
      if (currentTurn) {
        currentTurn.toolCalls++;
        currentTurn.toolSequence.push(name);
        currentTurn.endTime = msgTs;
      }
    }
    for (const c of msg.content || []) {
      // 'toolCall' = normalized content part; 'tool_use' = Claude Code assistant block
      if (c.type === 'toolCall' || c.type === 'tool_use') {
        toolCallCount++;
        const name = c.name || 'unknown';
        if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
        toolStats[name].calls++;
        toolCallsList.push({ index: i, name, timestamp: msg.timestamp, callId: c.id });
        if (c.id) callIdToName[c.id] = name;
        if (currentTurn) {
          currentTurn.toolCalls++;
          currentTurn.toolSequence.push(name);
          currentTurn.endTime = msgTs;
        }
      }
    }
  }

  const toolStatsArray: SessionToolStat[] = Object.entries(toolStats)
    .map(([name, st]) => {
      const src = classifyToolSource(name);
      return {
        name,
        ...st,
        errorRate: st.calls > 0 ? st.errors / st.calls : 0,
        source: src.source,
        mcpServer: src.mcpServer,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  // ── Post-hoc analysis: source breakdown ──
  const sourceMap: Record<ToolSource, ToolSourceBreakdown> = {
    builtin: { source: 'builtin', label: SOURCE_LABELS.builtin, calls: 0, errors: 0, tools: [] },
    mcp: { source: 'mcp', label: SOURCE_LABELS.mcp, calls: 0, errors: 0, tools: [] },
    skill: { source: 'skill', label: SOURCE_LABELS.skill, calls: 0, errors: 0, tools: [] },
    subagent: { source: 'subagent', label: SOURCE_LABELS.subagent, calls: 0, errors: 0, tools: [] },
    other: { source: 'other', label: SOURCE_LABELS.other, calls: 0, errors: 0, tools: [] },
  };
  for (const t of toolStatsArray) {
    const b = sourceMap[t.source];
    b.calls += t.calls;
    b.errors += t.errors;
    b.tools.push(t.name);
  }
  const sourceBreakdown = (Object.values(sourceMap) as ToolSourceBreakdown[])
    .filter((b) => b.calls > 0)
    .sort((a, b) => b.calls - a.calls);

  // ── Post-hoc analysis: tool chain patterns (bigrams + trigrams) ──
  const bigramCounts = new Map<string, { pattern: string[]; count: number }>();
  const trigramCounts = new Map<string, { pattern: string[]; count: number }>();
  let totalBigrams = 0, totalTrigrams = 0;
  for (const turn of turns) {
    const seq = turn.toolSequence;
    for (let j = 0; j < seq.length - 1; j++) {
      const key = `${seq[j]}→${seq[j + 1]}`;
      const existing = bigramCounts.get(key);
      if (existing) existing.count++;
      else bigramCounts.set(key, { pattern: [seq[j], seq[j + 1]], count: 1 });
      totalBigrams++;
    }
    for (let j = 0; j < seq.length - 2; j++) {
      const key = `${seq[j]}→${seq[j + 1]}→${seq[j + 2]}`;
      const existing = trigramCounts.get(key);
      if (existing) existing.count++;
      else trigramCounts.set(key, { pattern: [seq[j], seq[j + 1], seq[j + 2]], count: 1 });
      totalTrigrams++;
    }
  }
  const toolChainBigrams: ToolChainPattern[] = Array.from(bigramCounts.values())
    .map((v) => ({ ...v, pct: totalBigrams > 0 ? (v.count / totalBigrams) * 100 : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const toolChainTrigrams: ToolChainPattern[] = Array.from(trigramCounts.values())
    .map((v) => ({ ...v, pct: totalTrigrams > 0 ? (v.count / totalTrigrams) * 100 : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // ── Post-hoc analysis: per-turn efficiency ──
  const turnEfficiencies: TurnEfficiency[] = turns.map((t) => ({
    turnIndex: t.index,
    userSnippet: t.userSnippet,
    startTime: t.startTime,
    endTime: t.endTime,
    durationMs: t.startTime && t.endTime ? t.endTime - t.startTime : 0,
    toolCalls: t.toolCalls,
    errors: t.errors,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    hasFinalReply: t.hasFinalReply,
  }));
  const validTurns = turnEfficiencies.filter((t) => t.durationMs > 0);
  const avgTurnDurationMs = validTurns.length > 0
    ? Math.round(validTurns.reduce((s, t) => s + t.durationMs, 0) / validTurns.length)
    : 0;
  const avgTurnToolCalls = turnEfficiencies.length > 0
    ? Math.round((turnEfficiencies.reduce((s, t) => s + t.toolCalls, 0) / turnEfficiencies.length) * 10) / 10
    : 0;
  const avgTurnTokens = turnEfficiencies.length > 0
    ? Math.round(turnEfficiencies.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0) / turnEfficiencies.length)
    : 0;

  // ── Post-hoc analysis: Prompt depth analysis ──
  // Retry detection per turn: approximate from error count (errors that were
  // followed by success = retries). Exact attribution requires message-index
  // mapping, which is complex; errors already factor into the quality score.

  const promptItems: PromptAnalysisItem[] = turns.map((t, ti) => {
    const text = t.userSnippet;
    const category = classifyPrompt(text);
    const base = {
      index: ti,
      text,
      category,
      length: text.length,
      toolCalls: t.toolCalls,
      errors: t.errors,
      retries: 0, // retries are approximated by errors in quality scoring
      durationMs: t.startTime && t.endTime ? t.endTime - t.startTime : 0,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      hasFinalReply: t.hasFinalReply,
    };
    const { score, factors } = computePromptQuality(base);
    return { ...base, qualityScore: score, qualityFactors: factors };
  });

  // Category stats
  const categoryMap = new Map<PromptCategory, { count: number; toolCalls: number; duration: number; errors: number; quality: number }>();
  for (const item of promptItems) {
    const existing = categoryMap.get(item.category) || { count: 0, toolCalls: 0, duration: 0, errors: 0, quality: 0 };
    existing.count++;
    existing.toolCalls += item.toolCalls;
    existing.duration += item.durationMs;
    existing.errors += item.errors;
    existing.quality += item.qualityScore;
    categoryMap.set(item.category, existing);
  }
  const categoryStats: PromptCategoryStat[] = Array.from(categoryMap.entries())
    .map(([cat, s]) => ({
      category: cat,
      label: PROMPT_CATEGORY_LABELS[cat],
      count: s.count,
      avgToolCalls: s.count > 0 ? Math.round((s.toolCalls / s.count) * 10) / 10 : 0,
      avgDurationMs: s.count > 0 ? Math.round(s.duration / s.count) : 0,
      errorRate: s.toolCalls > 0 ? Math.round((s.errors / s.toolCalls) * 100) : 0,
      avgQuality: s.count > 0 ? Math.round(s.quality / s.count) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const avgQuality = promptItems.length > 0
    ? Math.round(promptItems.reduce((s, p) => s + p.qualityScore, 0) / promptItems.length)
    : 0;

  const sortedByQuality = [...promptItems].sort((a, b) => b.qualityScore - a.qualityScore);
  const bestPrompts = sortedByQuality.slice(0, 3);
  const worstPrompts = sortedByQuality.slice(-3).reverse();

  // Length efficiency: group prompts by length range and compute avg tool calls
  const lengthRanges = [
    { range: '<20字', min: 0, max: 20 },
    { range: '20-100字', min: 20, max: 100 },
    { range: '100-300字', min: 100, max: 300 },
    { range: '>300字', min: 300, max: Infinity },
  ];
  const lengthEfficiency = lengthRanges.map((lr) => {
    const inRange = promptItems.filter((p) => p.length >= lr.min && p.length < lr.max);
    return {
      range: lr.range,
      avgToolCalls: inRange.length > 0 ? Math.round((inRange.reduce((s, p) => s + p.toolCalls, 0) / inRange.length) * 10) / 10 : 0,
      count: inRange.length,
    };
  }).filter((l) => l.count > 0);

  const promptAnalysis: PromptDepthAnalysis = {
    items: promptItems,
    categoryStats,
    avgQuality,
    bestPrompts,
    worstPrompts,
    lengthEfficiency,
  };

  // ── Execution efficiency: thinking time analysis ──
  const thinkingPhases: ThinkingPhase[] = [];
  let prevEventTs: number | null = null;
  let lastToolName: string | null = null;
  let lastWasError = false;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const msgTs = tsToMs(msg.timestamp);
    if (msg.role === 'assistant' && prevEventTs && msgTs && msgTs > prevEventTs) {
      const duration = msgTs - prevEventTs;
      const hasText = getTextContent(msg.content || []).trim().length > 0;
      let type: ThinkingPhase['type'] = 'other';
      if (lastWasError) type = 'after-error';
      else if (hasText) type = 'before-reply';
      else if (lastToolName) type = 'before-tool';
      thinkingPhases.push({ type, durationMs: duration, toolName: lastToolName || undefined, hasText });
    }
    if (msg.role === 'toolCall') { lastToolName = msg.toolName || null; lastWasError = false; }
    if (msg.role === 'toolResult') { lastWasError = !!msg.isError; }
    for (const c of msg.content || []) {
      if (c.type === 'toolCall' || c.type === 'tool_use') { lastToolName = c.name || null; lastWasError = false; }
    }
    if (msgTs) prevEventTs = msgTs;
  }

  const totalThinkingMs = thinkingPhases.reduce((s, p) => s + p.durationMs, 0);
  const thinkingByType = new Map<string, { count: number; totalMs: number }>();
  for (const p of thinkingPhases) {
    const existing = thinkingByType.get(p.type) || { count: 0, totalMs: 0 };
    existing.count++; existing.totalMs += p.durationMs;
    thinkingByType.set(p.type, existing);
  }
  const THINKING_TYPE_LABELS: Record<string, string> = {
    'before-tool': '🔧 工具调用前', 'before-reply': '💬 最终回复前',
    'after-error': '❌ 错误后重试', 'other': '📦 其他',
  };
  const thinkingByTypeArray = Array.from(thinkingByType.entries())
    .map(([type, s]) => ({ type, label: THINKING_TYPE_LABELS[type] || type, count: s.count, totalMs: s.totalMs, avgMs: s.count > 0 ? Math.round(s.totalMs / s.count) : 0 }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const THINKING_BUCKETS = [
    { range: '<1s', min: 0, max: 1000 }, { range: '1-5s', min: 1000, max: 5000 },
    { range: '5-10s', min: 5000, max: 10000 }, { range: '10-30s', min: 10000, max: 30000 },
    { range: '>30s', min: 30000, max: Infinity },
  ];
  const thinkingDistribution = THINKING_BUCKETS.map((b) => {
    const inRange = thinkingPhases.filter((p) => p.durationMs >= b.min && p.durationMs < b.max);
    return { range: b.range, count: inRange.length, totalMs: inRange.reduce((s, p) => s + p.durationMs, 0) };
  }).filter((d) => d.count > 0);

  const thinkingAnalysis: ThinkingAnalysis = {
    totalThinkingMs,
    avgThinkingMs: thinkingPhases.length > 0 ? Math.round(totalThinkingMs / thinkingPhases.length) : 0,
    maxThinkingMs: thinkingPhases.length > 0 ? Math.max(...thinkingPhases.map((p) => p.durationMs)) : 0,
    thinkingCount: thinkingPhases.length,
    phases: thinkingPhases.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    byType: thinkingByTypeArray,
    distribution: thinkingDistribution,
  };

  // ── Execution efficiency: cost estimate ──
  const totalCost = computeCost(totalInputTokens, totalOutputTokens, totalCacheRead, 0, 0);
  const costPerTurn = turnEfficiencies.map((t) => ({
    turnIndex: t.turnIndex,
    cost: computeCost(t.inputTokens, t.outputTokens, 0, 0, 0),
    tokens: t.inputTokens + t.outputTokens,
  }));
  const costEstimate: CostEstimate = {
    totalCost,
    inputCost: (totalInputTokens * DEFAULT_MODEL_PRICING.input) / 1_000_000,
    outputCost: (totalOutputTokens * DEFAULT_MODEL_PRICING.output) / 1_000_000,
    cacheReadCost: (totalCacheRead * DEFAULT_MODEL_PRICING.cacheRead) / 1_000_000,
    cacheWriteCost: 0, reasoningCost: 0,
    currency: 'USD',
    modelPricing: { ...DEFAULT_MODEL_PRICING },
    perTurn: costPerTurn,
  };

  // ── Knowledge asset: common commands & files ──
  const commandMap = new Map<string, { count: number; totalDurationMs: number; errors: number }>();
  const fileMap = new Map<string, { readCount: number; writeCount: number }>();

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const extractFromArgs = (name: string, args: Record<string, unknown> | undefined) => {
      const lower = name.toLowerCase();
      if (lower.includes('bash') || lower.includes('shell') || lower.includes('command') || lower.includes('exec')) {
        const cmd = typeof args?.command === 'string' ? args.command : typeof args?.cmd === 'string' ? args.cmd : '';
        if (cmd) {
          const normalized = cmd.split('\n')[0].trim().slice(0, 100);
          if (normalized) {
            const existing = commandMap.get(normalized) || { count: 0, totalDurationMs: 0, errors: 0 };
            existing.count++;
            commandMap.set(normalized, existing);
          }
        }
      }
      if (lower.includes('read') || lower.includes('view') || lower.includes('cat')) {
        const path = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : '';
        if (path) { const existing = fileMap.get(path) || { readCount: 0, writeCount: 0 }; existing.readCount++; fileMap.set(path, existing); }
      }
      if (lower.includes('write') || lower.includes('edit') || lower.includes('patch') || lower.includes('create')) {
        const path = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : '';
        if (path) { const existing = fileMap.get(path) || { readCount: 0, writeCount: 0 }; existing.writeCount++; fileMap.set(path, existing); }
      }
    };
    if (msg.role === 'toolCall') extractFromArgs(msg.toolName || '', msg.args as Record<string, unknown> | undefined);
    for (const c of msg.content || []) {
      if (c.type === 'toolCall' || c.type === 'tool_use') extractFromArgs(c.name || '', c.input as Record<string, unknown> | undefined);
    }
  }

  const commonCommands: CommonCommand[] = Array.from(commandMap.entries())
    .map(([command, s]) => ({ command, count: s.count, avgDurationMs: s.count > 0 ? Math.round(s.totalDurationMs / s.count) : 0, errors: s.errors }))
    .sort((a, b) => b.count - a.count).slice(0, 15);
  const commonFiles: CommonFile[] = Array.from(fileMap.entries())
    .map(([path, s]) => ({ path, readCount: s.readCount, writeCount: s.writeCount, totalOps: s.readCount + s.writeCount }))
    .sort((a, b) => b.totalOps - a.totalOps).slice(0, 15);

  // ── Knowledge asset: decision records from thinking ──
  const DECISION_KEYWORDS = ['决定', '选择', '方案', '因为', '所以', '因此', 'decide', 'choose', 'because', 'therefore', 'approach', 'strategy', 'plan'];
  const decisionRecords: DecisionRecord[] = [];
  for (const msg of msgs) {
    if (msg.role !== 'assistant') continue;
    for (const c of msg.content || []) {
      if (c.type === 'thinking' || c.type === 'reasoning') {
        const text = typeof c.text === 'string' ? c.text : '';
        if (!text.trim()) continue;
        const sentences = text.split(/[。！？.!?\n]/).filter((s) => s.trim().length > 10);
        for (const sentence of sentences) {
          const lower = sentence.toLowerCase();
          const matchedKeywords = DECISION_KEYWORDS.filter((k) => lower.includes(k));
          if (matchedKeywords.length > 0) {
            decisionRecords.push({
              text: sentence.trim().slice(0, 200),
              timestamp: msg.timestamp,
              confidence: matchedKeywords.length >= 2 ? 'high' : 'medium',
              keywords: matchedKeywords,
            });
          }
        }
      }
    }
  }

  // ── Knowledge asset: error knowledge base ──
  const errorKnowledge: ErrorKnowledgeItem[] = [];
  for (const r of retries) {
    const errorMsg = msgs[r.errorIndex];
    const successMsg = msgs[r.successIndex];
    errorKnowledge.push({
      errorSnippet: errorMsg ? firstInformativeLine(getTextContent(errorMsg.content || [])).slice(0, 100) : '',
      toolName: r.toolName,
      fixSnippet: successMsg ? firstInformativeLine(getTextContent(successMsg.content || [])).slice(0, 100) : '',
      fixToolName: successMsg?.toolName || r.toolName,
      attempts: r.attempts,
      resolved: true,
    });
  }
  for (const e of errors) {
    const isResolved = retries.some((r) => r.errorIndex === e.index);
    if (!isResolved) {
      errorKnowledge.push({ errorSnippet: e.snippet.slice(0, 100), toolName: e.toolName, fixSnippet: '', fixToolName: '', attempts: 1, resolved: false });
    }
  }

  return {
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    errorCount,
    toolStats: toolStatsArray,
    errors,
    retries,
    toolCalls: toolCallsList,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    sourceBreakdown,
    toolChainBigrams,
    toolChainTrigrams,
    turnEfficiencies,
    avgTurnDurationMs,
    avgTurnToolCalls,
    avgTurnTokens,
    promptAnalysis,
    thinkingAnalysis,
    costEstimate,
    commonCommands,
    commonFiles,
    decisionRecords,
    errorKnowledge,
  };
}

// ─── Reflection & Retrospective (流程闭环：度量→归因→沉淀→建议) ───────────
// Inspired by 团队 AI Coding 实践准则: waste attribution, process health
// checklist, and harvestable-asset detection — all computed locally from
// session messages, no LLM needed.

/** Five waste root-cause categories from the cost-optimization playbook. */
export type WasteCategory = 'unclear_requirement' | 'search_divergence' | 'tool_retry' | 'context_bloat' | 'other';

export const WASTE_CATEGORY_LABELS: Record<WasteCategory, string> = {
  unclear_requirement: '需求不清',
  search_divergence: '检索发散',
  tool_retry: '工具失败重试',
  context_bloat: '上下文膨胀',
  other: '其他',
};

export interface WasteAttributionItem {
  category: WasteCategory;
  severity: 'high' | 'medium' | 'low';
  evidence: string;
  turnIndex?: number;
  estimatedWastedTokens?: number;
}

export interface WasteAttribution {
  items: WasteAttributionItem[];
  totalEstimatedWastedTokens: number;
  primaryCategory: WasteCategory | null;
}

export type HealthCheckStatus = 'pass' | 'fail' | 'manual';

export interface HealthCheckItem {
  id: string;
  label: string;
  description: string;
  status: HealthCheckStatus;
  evidence?: string;
}

export interface ProcessHealthCheck {
  items: HealthCheckItem[];
  passCount: number;
  failCount: number;
  manualCount: number;
}

export type HarvestableAssetType = 'terminology' | 'rule' | 'workflow';

export interface HarvestableAsset {
  type: HarvestableAssetType;
  label: string;
  description: string;
  confidence: 'high' | 'medium' | 'low';
  source?: string;
}

export interface ReflectionReport {
  summary: {
    taskGoal: string;
    completed: boolean;
    totalTurns: number;
    totalToolCalls: number;
    totalErrors: number;
    effectiveTokens: number;
    totalDurationMs: number;
  };
  waste: WasteAttribution;
  healthCheck: ProcessHealthCheck;
  assets: HarvestableAsset[];
  suggestions: string[];
}

/** Detect whether text contains a file path, code reference, or error line. */
function hasLocationInfo(text: string): boolean {
  if (!text) return false;
  return (
    /\/[\w.-]+\/[\w.-]+/.test(text) || // absolute/relative path
    /\b[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|java|md|json|yaml|yml|css|html)\b/.test(text) || // file with ext
    /line\s*\d+/i.test(text) || // line N
    /:\d+:\d+/.test(text) || // file:line:col
    /(error|exception|traceback|failed)/i.test(text) // error mention
  );
}

/** Compute waste attribution for a session. Pure, no LLM. */
export function computeWasteAttribution(msgs: SessionMessage[]): WasteAttribution {
  const items: WasteAttributionItem[] = [];
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const firstUserText = userMsgs.length > 0 ? getTextContent(userMsgs[0].content || []) : '';

  // 1. Unclear requirement: first user message is short and lacks location info
  if (firstUserText && firstUserText.length < 30 && !hasLocationInfo(firstUserText)) {
    items.push({
      category: 'unclear_requirement',
      severity: firstUserText.length < 15 ? 'high' : 'medium',
      evidence: `首条提问仅 ${firstUserText.length} 字，未包含文件路径/代码/错误信息："${firstUserText.slice(0, 50)}"`,
      turnIndex: 0,
    });
  }

  // 2. Search divergence: many distinct file reads or consecutive search tools
  const readFiles = new Set<string>();
  let searchRun = 0;
  let maxSearchRun = 0;
  for (const m of msgs) {
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.name) {
        const name = c.name.toLowerCase();
        if (name.includes('read') || name.includes('grep') || name.includes('glob')) {
          searchRun++;
          maxSearchRun = Math.max(maxSearchRun, searchRun);
          // Try to extract file path from args
          const args = (c as MessageContentPart).arguments ?? (c as MessageContentPart).input;
          if (args && typeof args === 'object') {
            const fp = (args as Record<string, unknown>).file_path || (args as Record<string, unknown>).path || (args as Record<string, unknown>).file;
            if (typeof fp === 'string') readFiles.add(fp);
          }
        } else {
          searchRun = 0;
        }
      }
    }
  }
  if (readFiles.size > 8 || maxSearchRun >= 4) {
    items.push({
      category: 'search_divergence',
      severity: readFiles.size > 12 || maxSearchRun >= 6 ? 'high' : 'medium',
      evidence: `读取了 ${readFiles.size} 个不同文件，最长连续检索 ${maxSearchRun} 次${readFiles.size > 0 ? `（如 ${[...readFiles].slice(0, 3).join(', ')}${readFiles.size > 3 ? '…' : ''}）` : ''}`,
    });
  }

  // 3. Tool failure retry: error followed by same tool call
  const toolCalls: { name: string; isError: boolean; index: number }[] = [];
  for (const m of msgs) {
    if (m.role === 'toolCall' && m.toolName) {
      toolCalls.push({ name: m.toolName, isError: false, index: toolCalls.length });
    }
    if (m.role === 'toolResult' && m.isError) {
      const last = toolCalls[toolCalls.length - 1];
      if (last) last.isError = true;
    }
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.name) {
        toolCalls.push({ name: c.name, isError: false, index: toolCalls.length });
      }
      if (c.type === 'tool_result' && c.is_error) {
        const last = toolCalls[toolCalls.length - 1];
        if (last) last.isError = true;
      }
    }
  }
  let retryCount = 0;
  const retryTools = new Set<string>();
  for (let i = 1; i < toolCalls.length; i++) {
    if (toolCalls[i - 1].isError && toolCalls[i].name === toolCalls[i - 1].name) {
      retryCount++;
      retryTools.add(toolCalls[i].name);
    }
  }
  if (retryCount > 0) {
    items.push({
      category: 'tool_retry',
      severity: retryCount >= 3 ? 'high' : 'medium',
      evidence: `${retryCount} 次失败后重试${retryTools.size > 0 ? `（涉及 ${[...retryTools].join(', ')}）` : ''}，每次重试都携带完整历史`,
    });
  }

  // 4. Context bloat: many turns or growing input tokens
  const turnCount = userMsgs.length;
  if (turnCount > 15) {
    items.push({
      category: 'context_bloat',
      severity: turnCount > 25 ? 'high' : 'medium',
      evidence: `会话共 ${turnCount} 轮，超过 15 轮阈值；每轮新调用都要携带全部历史，后期轮次的输入 Token 会显著膨胀`,
    });
  }

  // Sort by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const totalEstimatedWastedTokens = items.reduce((s, i) => s + (i.estimatedWastedTokens || 0), 0);
  const primaryCategory = items.length > 0 ? items[0].category : null;

  return { items, totalEstimatedWastedTokens, primaryCategory };
}

/** Compute process health checklist (9 items from the playbook). */
export function computeProcessHealthCheck(msgs: SessionMessage[]): ProcessHealthCheck {
  const items: HealthCheckItem[] = [];
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const firstUserText = userMsgs.length > 0 ? getTextContent(userMsgs[0].content || []) : '';

  // 1. Deterministic tasks don't need model — manual judgment
  items.push({
    id: 'deterministic',
    label: '确定性任务不调模型',
    description: '格式化/批量重命名/简单文案等有唯一答案的任务应交给工具，不消耗模型调用',
    status: 'manual',
    evidence: '需人工判断本会话中是否有可交给确定性工具的步骤',
  });

  // 2. Prompt with location info
  const hasLocation = hasLocationInfo(firstUserText);
  items.push({
    id: 'location_info',
    label: '提问带定位信息',
    description: '首条提问应包含入口文件、关注重点和排除项；给路径不贴整段内容',
    status: hasLocation ? 'pass' : 'fail',
    evidence: hasLocation ? '首条提问包含文件路径/代码/错误信息' : `首条提问未包含定位信息（${firstUserText.length} 字）`,
  });

  // 3. Batch related questions
  const avgToolsPerTurn = userMsgs.length > 0 ? msgs.filter((m) => m.role === 'toolCall').length / userMsgs.length : 0;
  const batchOk = !(userMsgs.length > 3 && avgToolsPerTurn < 2);
  items.push({
    id: 'batch_questions',
    label: '相关问题批量提',
    description: '共享代码背景的问题应一次性列全，避免串行提问导致工具结果反复携带',
    status: batchOk ? 'pass' : 'fail',
    evidence: batchOk ? `平均每轮 ${avgToolsPerTurn.toFixed(1)} 次工具调用` : `${userMsgs.length} 轮用户提问但平均每轮仅 ${avgToolsPerTurn.toFixed(1)} 次工具调用，可能是串行提问`,
  });

  // 4. Session hygiene — one task per session
  const turnCount = userMsgs.length;
  const hygieneOk = turnCount <= 20;
  items.push({
    id: 'session_hygiene',
    label: '一事一会话，跑偏就重开',
    description: '任务切换/上下文跑偏/超 20 轮/同一错误重试 3 次时应重开会话',
    status: hygieneOk ? 'pass' : 'fail',
    evidence: hygieneOk ? `共 ${turnCount} 轮，在 20 轮阈值内` : `共 ${turnCount} 轮，超过 20 轮阈值，建议拆会话`,
  });

  // 5. Process intensity matches risk — manual
  items.push({
    id: 'process_intensity',
    label: '按任务风险选流程强度',
    description: '小需求走轻量路径（澄清→spec→实现→验收），跨服务/迁移/安全才走完整 spec',
    status: 'manual',
    evidence: '需人工判断流程强度与任务风险是否匹配',
  });

  // 6. Verification via deterministic tools
  const hasBuildOrTest = msgs.some((m) => {
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.name) {
        const n = c.name.toLowerCase();
        if (n.includes('build') || n.includes('test') || n.includes('lint') || n.includes('typecheck') || n.includes('npm') || n.includes('make')) return true;
      }
    }
    return m.role === 'toolCall' && m.toolName && /build|test|lint|typecheck|npm|make/i.test(m.toolName);
  });
  items.push({
    id: 'deterministic_verification',
    label: '验证交确定性工具',
    description: '构建/测试/lint 由 CLI 确定性执行，Agent 只负责调用和解读结果，不每次从零拼装',
    status: hasBuildOrTest ? 'pass' : 'fail',
    evidence: hasBuildOrTest ? '会话中使用了 build/test/lint 等确定性验证工具' : '会话中未检测到 build/test/lint 等验证工具调用',
  });

  // 7. Large search goes to subagent
  const searchCount = msgs.filter((m) => {
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.name) {
        const n = c.name.toLowerCase();
        if (n.includes('grep') || n.includes('glob') || n.includes('search')) return true;
      }
    }
    return false;
  }).length;
  const hasSubagent = msgs.some((m) => m.role === 'assistant' && m.content?.some((c) => (c.type === 'toolCall' || c.type === 'tool_use') && c.name && /task|spawn|agent|subagent/i.test(c.name)));
  const largeSearchOk = !(searchCount > 5 && !hasSubagent);
  items.push({
    id: 'subagent_search',
    label: '大搜索丢给子代理',
    description: '全仓搜索/批量文件扫描的中间产物远大于结论，应交给 subagent，主会话只收结论',
    status: largeSearchOk ? 'pass' : 'fail',
    evidence: largeSearchOk ? '检索量适中或使用了子代理' : `${searchCount} 次搜索/扫描但未使用子代理，中间产物可能膨胀上下文`,
  });

  // 8. Model selection — manual
  items.push({
    id: 'model_selection',
    label: '按任务选模型和推理强度',
    description: '格式改动/简单问答用轻量模型，复杂设计/跨模块变更才上旗舰+高推理',
    status: 'manual',
    evidence: '需人工判断模型选择与任务难度是否匹配',
  });

  // 9. Review consumption distribution — pass (this report is doing it)
  items.push({
    id: 'consumption_review',
    label: '定期看消耗分布',
    description: '每月统计 Token 消耗分布，Top 高消耗会话归因，沉淀改进动作',
    status: 'pass',
    evidence: '本反思报告即为消耗分布审查的产物',
  });

  const passCount = items.filter((i) => i.status === 'pass').length;
  const failCount = items.filter((i) => i.status === 'fail').length;
  const manualCount = items.filter((i) => i.status === 'manual').length;

  return { items, passCount, failCount, manualCount };
}

/** Identify harvestable assets from the session (terminology, rules, workflows). */
export function computeHarvestableAssets(msgs: SessionMessage[]): HarvestableAsset[] {
  const assets: HarvestableAsset[] = [];

  // 1. Rules: user corrections/instructions
  const ruleKeywords = ['不要', '应该', '必须', '记得', '注意', '别', '禁止', '始终', '永远'];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const text = getTextContent(m.content || []);
    if (!text || text.length > 200) continue;
    for (const kw of ruleKeywords) {
      if (text.includes(kw)) {
        assets.push({
          type: 'rule',
          label: text.slice(0, 60),
          description: `用户指令："${text.slice(0, 100)}"`,
          confidence: 'medium',
          source: '用户消息',
        });
        break;
      }
    }
  }

  // 2. Workflow: repeated tool sequences (build → test → lint etc.)
  const toolSequence: string[] = [];
  for (const m of msgs) {
    if (m.role === 'toolCall' && m.toolName) toolSequence.push(m.toolName.toLowerCase());
    for (const c of m.content || []) {
      if ((c.type === 'toolCall' || c.type === 'tool_use') && c.name) toolSequence.push(c.name.toLowerCase());
    }
  }
  // Look for repeated 3-step sequences
  const seqCount = new Map<string, number>();
  for (let i = 0; i < toolSequence.length - 2; i++) {
    const seq = `${toolSequence[i]} → ${toolSequence[i + 1]} → ${toolSequence[i + 2]}`;
    seqCount.set(seq, (seqCount.get(seq) || 0) + 1);
  }
  for (const [seq, count] of seqCount) {
    if (count >= 2) {
      assets.push({
        type: 'workflow',
        label: seq,
        description: `该工具序列重复出现 ${count} 次，可沉淀为 CLI workflow 或脚本`,
        confidence: count >= 3 ? 'high' : 'medium',
        source: '工具调用序列',
      });
    }
  }

  // Deduplicate by label
  const seen = new Set<string>();
  return assets.filter((a) => {
    if (seen.has(a.label)) return false;
    seen.add(a.label);
    return true;
  });
}

/** Generate actionable improvement suggestions based on waste + health check. */
function generateSuggestions(waste: WasteAttribution, health: ProcessHealthCheck): string[] {
  const suggestions: string[] = [];

  for (const item of waste.items) {
    switch (item.category) {
      case 'unclear_requirement':
        suggestions.push('提问时带上入口文件路径、关注重点和明确排除项，减少 Agent 的自由探索轮次');
        break;
      case 'search_divergence':
        suggestions.push('大范围文件搜索考虑交给子代理执行，主会话只接收结论，避免中间产物膨胀上下文');
        break;
      case 'tool_retry':
        suggestions.push('工具连续失败 3 次时应人工介入或重开会话，不要让 Agent 在污染的上下文里继续猜');
        break;
      case 'context_bloat':
        suggestions.push('超过 15 轮时考虑拆分会话或触发上下文压缩，指定要保留的内容比等自动截断更可控');
        break;
    }
  }

  for (const item of health.items) {
    if (item.status === 'fail') {
      switch (item.id) {
        case 'deterministic_verification':
          suggestions.push('将构建/测试/lint 流程沉淀为可复用脚本或 CLI workflow，Agent 只负责调用和解读 report.json');
          break;
        case 'subagent_search':
          suggestions.push('批量检索类任务拆给子代理，主会话只收结论，过程随子会话一起消失');
          break;
      }
    }
  }

  // Always include the meta-suggestion
  if (suggestions.length === 0) {
    suggestions.push('本会话流程健康，无明显浪费。可关注是否有可沉淀的术语/规则/workflow 供后续会话复用。');
  }

  return suggestions.slice(0, 5);
}

/** Full reflection report: summary + waste attribution + health check + assets + suggestions. */
export function computeReflectionReport(msgs: SessionMessage[]): ReflectionReport {
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const firstUserText = userMsgs.length > 0 ? getTextContent(userMsgs[0].content || []) : '';
  const waste = computeWasteAttribution(msgs);
  const health = computeProcessHealthCheck(msgs);
  const assets = computeHarvestableAssets(msgs);

  // Summary stats
  let totalToolCalls = 0;
  let totalErrors = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;
  let lastTs: number | null = null;
  for (const m of msgs) {
    if (m.role === 'toolCall') totalToolCalls++;
    if (m.role === 'toolResult' && m.isError) totalErrors++;
    const u = m.usage || {};
    totalInputTokens += (u.input || u.input_tokens || 0) as number;
    totalOutputTokens += (u.output || u.output_tokens || 0) as number;
    const ts = parseTimestampMs(m.timestamp);
    if (ts && lastTs) totalDurationMs += ts - lastTs;
    if (ts) lastTs = ts;
  }
  // Also count tool calls inside content blocks
  for (const m of msgs) {
    for (const c of m.content || []) {
      if (c.type === 'toolCall' || c.type === 'tool_use') totalToolCalls++;
      if (c.type === 'tool_result' && c.is_error) totalErrors++;
    }
  }

  const completed = msgs.some((m) => m.role === 'assistant' && getTextContent(m.content || []).trim().length > 0);

  return {
    summary: {
      taskGoal: firstUserText.slice(0, 100) || '(无用户提问)',
      completed,
      totalTurns: userMsgs.length,
      totalToolCalls,
      totalErrors,
      effectiveTokens: totalInputTokens + totalOutputTokens,
      totalDurationMs,
    },
    waste,
    healthCheck: health,
    assets,
    suggestions: generateSuggestions(waste, health),
  };
}
