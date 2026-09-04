// Left sidebar: header/settings + session search (type = filter, Enter = ⌘K
// global search), OpenClaw agent nav, archived/auto-refresh/auto-scroll
// toggles, and the (virtualized) session list.

import { useQuery } from '@tanstack/react-query';
import { Search, Settings, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getAgents, searchSessions } from '@/api/client';
import { PLATFORM_LABELS } from '@/api/types';
import { SettingsDialog } from '@/components/SettingsDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/store';
import { CmdkDialog } from '@/views/sessions/CmdkDialog';
import { SessionList } from '@/views/sessions/SessionList';

function ToggleRow({
  label,
  title,
  checked,
  onChange,
}: {
  label: string;
  title: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground" title={title}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="h-3.5 w-3.5" />
      {label}
    </label>
  );
}

// OpenClaw stores sessions per agent (~/.openclaw/agents/<name>/sessions)
function AgentNav() {
  const settings = useAppStore((s) => s.settings);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const setSelectedAgent = useAppStore((s) => s.setSelectedAgent);
  const { data: agents } = useQuery({
    queryKey: ['agents', settings.openclawDir],
    queryFn: () => getAgents(settings.openclawDir || undefined),
  });

  // Legacy loadAgents: default to the first agent
  useEffect(() => {
    if (agents?.length && !useAppStore.getState().selectedAgent) setSelectedAgent(agents[0]);
  }, [agents, setSelectedAgent]);

  if (!agents?.length) {
    return (
      <div className="text-[11px] text-muted-foreground">
        未检测到 OpenClaw agent（~/.openclaw/agents 不存在或为空）
      </div>
    );
  }
  return (
    <Select value={selectedAgent || undefined} onValueChange={setSelectedAgent}>
      <SelectTrigger className="h-8 text-xs" title="选择要浏览哪个 OpenClaw agent 的会话">
        <SelectValue placeholder="选择 agent" />
      </SelectTrigger>
      <SelectContent>
        {agents.map((agent) => (
          <SelectItem key={agent} value={agent} className="text-xs">
            {agent}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Sidebar() {
  const platform = useAppStore((s) => s.platform);
  const settings = useAppStore((s) => s.settings);
  const includeArchived = useAppStore((s) => s.includeArchived);
  const setIncludeArchived = useAppStore((s) => s.setIncludeArchived);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const setAutoRefresh = useAppStore((s) => s.setAutoRefresh);
  const autoScroll = useAppStore((s) => s.autoScroll);
  const setAutoScroll = useAppStore((s) => s.setAutoScroll);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterTerm, setFilterTerm] = useState('');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkSeed, setCmdkSeed] = useState('');
  const [matchedSessionIds, setMatchedSessionIds] = useState<Set<string> | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // Full-text search within the current platform on Enter.
  // Clearing the input restores the full session list.
  const runPlatformSearch = async (q: string) => {
    if (!q.trim()) {
      setMatchedSessionIds(null);
      return;
    }
    setIsSearching(true);
    try {
      const results = await searchSessions(q, settings, platform);
      setMatchedSessionIds(new Set(results.map((r) => r.sessionId)));
    } catch {
      setMatchedSessionIds(new Set());
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setFilterTerm('');
    setMatchedSessionIds(null);
  };

  // Global ⌘K / Ctrl+K toggle (legacy document keydown)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkSeed('');
        setCmdkOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-hidden border-r border-border bg-panel-alt/95 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-wide">AgentXRay</h1>
          <div className="text-xs text-muted-foreground">{PLATFORM_LABELS[platform]} sessions</div>
        </div>
        <Button variant="outline" size="icon" title="Settings" onClick={() => setSettingsOpen(true)}>
          <Settings className="h-4 w-4" />
        </Button>
      </div>
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={filterTerm}
          onChange={(e) => {
            setFilterTerm(e.target.value);
            if (!e.target.value.trim()) setMatchedSessionIds(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const q = filterTerm.trim();
              if (!q) return;
              runPlatformSearch(q);
            } else if (e.key === 'Escape') {
              clearSearch();
            }
          }}
          placeholder="输入过滤 · 回车全文搜索当前平台"
          title="直接输入：按 ID/标题/首条消息过滤列表；按回车：在当前平台全文搜索；Esc 清除"
          className="pl-7 pr-16 text-xs"
        />
        {filterTerm ? (
          <button
            type="button"
            onClick={clearSearch}
            className="absolute right-10 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            title="清除搜索"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setCmdkSeed('');
            setCmdkOpen(true);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          title="全平台全局搜索（⌘K / Ctrl+K）"
        >
          ⌘K
        </button>
      </div>
      {matchedSessionIds !== null ? (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {isSearching ? '搜索中…' : `全文搜索命中 ${matchedSessionIds.size} 个会话`}
          </span>
          <button onClick={clearSearch} className="text-primary hover:underline">
            清除
          </button>
        </div>
      ) : null}
      {platform === 'openclaw' && <AgentNav />}
      <div className="flex flex-wrap items-center gap-3">
        {platform === 'openclaw' && (
          <ToggleRow
            label="Include archived"
            title="同时列出已归档的会话"
            checked={includeArchived}
            onChange={setIncludeArchived}
          />
        )}
        <ToggleRow
          label="Auto-refresh"
          title="每 5 秒刷新列表；当前会话通过 SSE 实时追加"
          checked={autoRefresh}
          onChange={setAutoRefresh}
        />
        <ToggleRow
          label="Auto-scroll"
          title="新消息到达时自动滚到最新"
          checked={autoScroll}
          onChange={setAutoScroll}
        />
      </div>
      <SessionList filterTerm={filterTerm} matchedSessionIds={matchedSessionIds} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <CmdkDialog open={cmdkOpen} onOpenChange={setCmdkOpen} seedQuery={cmdkSeed} />
    </aside>
  );
}
