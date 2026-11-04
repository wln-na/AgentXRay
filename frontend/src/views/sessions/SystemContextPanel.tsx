// 系统上下文折叠区块 — dsh v4 把运行时注入的上下文（runtime/time/skill/指令…）
// 单独放在详情响应里（contextMessages），不混进 messages。这里默认折叠、按
// sourceKind 分组，并按「版本」折叠：同一条上下文往往每轮重新注入一次
// （时间上下文几乎每次都变、runtime-context 偶尔变、skill-catalog 只在
// 变更时重发），逐条列出 N 条只会淹没真正的变化。折叠后给出
// 「N 条 / M 个版本」，每个版本只展示与上一版的差异。
//
// 折叠逻辑是纯函数，见 lib/contextVersions.ts（有 node 单测覆盖）。

import { useMemo } from 'react';
import type { SessionMessage } from '@/api/types';
import {
  type ContextDiffRow,
  type ContextKindGroup,
  type ContextVersion,
  condenseContextDiff,
  foldContextVersions,
} from '@/lib/contextVersions';
import { getTextContent, parseTimestampMs } from '@/lib/pure';

const KIND_LABELS: Record<string, string> = {
  // dsh v4 source.kind
  'runtime-context': '运行时上下文',
  'time-context': '时间上下文',
  'skill-catalog': '技能目录',
  'agent-instructions': 'Agent 指令',
  'working-directory': '工作目录',
  'model-selection': '模型选择',
  'user-approval': '审批',
  'tool-jobs': '后台任务',
  // Claude Code attachment types (rec.rendered system-reminders)
  environment: '运行环境',
  model: '模型身份',
  instructions: '项目指令',
  session_context: '会话上下文',
  date: '日期上下文',
  skill_listing: '技能目录',
  agent_listing_delta: 'Agent 目录',
  mcp_instructions_delta: 'MCP 指令',
  deferred_tools_delta: '工具清单',
  command_permissions: '权限',
  task_reminder: '任务提醒',
  prompt_snapshot: '系统提示词快照',
  remote_session_change: '会话变更',
  // Codex developer-message tags
  'app-context': '应用上下文',
  skills_instructions: '技能名单',
  collaboration_mode: '协作模式',
  codex_apps_client_time_context: '时间上下文',
  current_date: '日期上下文',
  image_resize_notice: '图片提示',
  tools: '工具定义',
  model_switch: '模型切换',
  developer: '开发者指令',
  // Codex user-message injections (provenance=agents_md / harness)
  'agents-md': '项目指令 (AGENTS.md)',
  'injected-context': '注入上下文',
};

const PRE_CLASS =
  'mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed';

const DIFF_LINE_STYLES: Record<ContextDiffRow['type'], string> = {
  add: 'text-[#3fb950]',
  del: 'text-destructive',
  same: 'text-muted-foreground',
  gap: 'text-muted-foreground/60',
};

function sourceKindOf(message: SessionMessage): string {
  const kind = message.details?.sourceKind;
  return typeof kind === 'string' && kind.trim() ? kind : 'unknown';
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] || (kind === 'unknown' ? '系统上下文' : kind);
}

function formatClock(ts: number | null): string {
  if (ts === null) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function versionTimeRange(version: ContextVersion): string {
  const first = formatClock(version.firstTs);
  if (!first) return '';
  if (version.occurrences <= 1 || version.firstTs === version.lastTs) return first;
  const last = formatClock(version.lastTs);
  return last && last !== first ? `${first} → ${last}` : first;
}

function DiffView({ rows }: { rows: ContextDiffRow[] }) {
  return (
    <pre className={PRE_CLASS}>
      {rows.map((row, index) => {
        if (row.type === 'gap') {
          return (
            <div key={index} className={DIFF_LINE_STYLES.gap}>
              {`… ${row.skipped} 行未变 …`}
            </div>
          );
        }
        const marker = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
        return (
          <div key={index} className={DIFF_LINE_STYLES[row.type]}>
            {`${marker} ${row.text}`}
          </div>
        );
      })}
    </pre>
  );
}

function VersionBlock({ version, label, compact }: { version: ContextVersion; label: string; compact: boolean }) {
  const changed = version.addedLines + version.removedLines > 0;
  const rows = changed && version.diff ? condenseContextDiff(version.diff) : null;
  const timeRange = versionTimeRange(version);

  return (
    <details className="rounded border border-border/50 bg-secondary/10 px-2 py-1.5">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 text-[11px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
        {compact ? <span>{label}</span> : <span className="text-muted-foreground">v{version.index}</span>}
        {version.occurrences > 1 ? (
          <span className="rounded bg-secondary px-1 py-px text-[9px] font-normal text-muted-foreground">
            ×{version.occurrences} 次相同
          </span>
        ) : null}
        {version.repeatOf ? (
          <span className="rounded bg-secondary px-1 py-px text-[9px] font-normal text-muted-foreground">
            同 v{version.repeatOf}
          </span>
        ) : null}
        {timeRange ? <span className="font-normal text-muted-foreground">{timeRange}</span> : null}
        {changed ? <span className="font-normal text-[#3fb950]">+{version.addedLines}</span> : null}
        {changed ? <span className="font-normal text-destructive">-{version.removedLines}</span> : null}
        <span className="font-normal text-muted-foreground">{version.text.length.toLocaleString()} 字符</span>
      </summary>
      <div>
        {rows ? (
          <>
            <DiffView rows={rows} />
            <details className="mt-1">
              <summary className="cursor-pointer text-[10px] text-muted-foreground">完整文本</summary>
              <pre className={PRE_CLASS}>{version.text || '（空）'}</pre>
            </details>
          </>
        ) : (
          <pre className={PRE_CLASS}>{version.text || '（空）'}</pre>
        )}
      </div>
    </details>
  );
}

function KindSection({ group }: { group: ContextKindGroup }) {
  const label = kindLabel(group.kind);
  const folded = group.records > 1 || group.versions.length > 1;

  // 单一注入：直接一行，展开看原文。
  if (!folded) {
    const [version] = group.versions;
    return <VersionBlock version={version} label={label} compact />;
  }

  const firstTs = group.versions.reduce<number | null>(
    (min, version) => (version.firstTs !== null && (min === null || version.firstTs < min) ? version.firstTs : min),
    null
  );
  const lastTs = group.versions.reduce<number | null>(
    (max, version) => (version.lastTs !== null && (max === null || version.lastTs > max) ? version.lastTs : max),
    null
  );
  const span = [formatClock(firstTs), formatClock(lastTs)].filter(Boolean);
  const range = span.length === 2 && span[0] !== span[1] ? `${span[0]} → ${span[1]}` : span[0] || '';

  // 多次注入：默认只占一行（这是关键——不能把 N 条记录平铺出来），
  // 展开后才看到"不变部分 + 每个版本与上一版的差异"。
  return (
    <details className="rounded border border-border/50 bg-card/30">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
        <span>▶</span>
        <span>{label}</span>
        <span className="font-normal text-muted-foreground">
          {group.records} 次注入 · {group.versions.length} 个版本
        </span>
        {group.changedVersions ? (
          <span className="font-normal text-muted-foreground">· {group.changedVersions} 次变更</span>
        ) : (
          <span className="font-normal text-muted-foreground">· 内容未变</span>
        )}
        {range ? <span className="font-normal text-muted-foreground">· {range}</span> : null}
      </summary>
      <div className="space-y-1 border-t border-border/50 px-2 py-1.5">
        {group.commonLines.length > 0 ? (
          <details className="rounded border border-border/50 bg-secondary/5 px-2 py-1.5">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              不变部分 · {group.commonLines.length} 行（各版本共有）
            </summary>
            <pre className={PRE_CLASS}>{group.commonLines.join('\n')}</pre>
          </details>
        ) : null}
        {group.versions.map((version) => (
          <VersionBlock key={version.index} version={version} label={label} compact={false} />
        ))}
      </div>
    </details>
  );
}

export function SystemContextPanel({ messages }: { messages?: SessionMessage[] | null }) {
  const fold = useMemo(
    () =>
      foldContextVersions(
        (messages ?? []).map((message) => ({
          kind: sourceKindOf(message),
          text: getTextContent(message.content),
          timestampMs: parseTimestampMs(message.timestamp),
        }))
      ),
    [messages]
  );

  if (!messages || messages.length === 0) return null;

  return (
    <details data-testid="system-context-panel" className="mb-2 rounded-lg border border-border bg-card/40 px-3 py-2">
      <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
        🧩 系统上下文 · {fold.totalRecords} 条 / {fold.totalVersions} 个版本（默认折叠）
      </summary>
      <div className="mt-2 space-y-2 border-t border-border/60 pt-2">
        {fold.groups.map((group) => (
          <KindSection key={group.kind} group={group} />
        ))}
      </div>
    </details>
  );
}
