// Left sidebar: header/settings + session search (type = filter, Enter = ⌘K
// global search), OpenClaw agent nav, archived/auto-refresh/auto-scroll
// toggles, and the (virtualized) session list.

import { useQuery } from '@tanstack/react-query';
import { Search, Settings, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { getAgents, searchSessions } from '@/api/client';
import { PLATFORM_LABELS } from '@/api/types';
import { SettingsDialog } from '@/components/SettingsDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
  const checkboxId = useId();
  return (
    <label
      htmlFor={checkboxId}
      className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground"
      title={title}
    >
      <Checkbox
        id={checkboxId}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="h-3.5 w-3.5"
      />
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

export function Sidebar({
  mobileOpen,
  onMobileOpenChange,
}: {
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}) {
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
  const [searchError, setSearchError] = useState('');
  const searchRequestRef = useRef(0);

  useEffect(() => {
    searchRequestRef.current += 1;
    setFilterTerm('');
    setMatchedSessionIds(null);
    setIsSearching(false);
    setSearchError('');
  }, [platform]);

  // Full-text search within the current platform on Enter.
  // Clearing the input restores the full session list.
  const runPlatformSearch = async (q: string) => {
    if (!q.trim()) {
      setMatchedSessionIds(null);
      setSearchError('');
      return;
    }
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setIsSearching(true);
    setSearchError('');
    try {
      const results = await searchSessions(q, settings, platform);
      if (searchRequestRef.current !== requestId) return;
      setMatchedSessionIds(new Set(results.flatMap((result) => (result.sessionId ? [result.sessionId] : []))));
    } catch (searchError) {
      if (searchRequestRef.current !== requestId) return;
      setMatchedSessionIds(null);
      setSearchError(searchError instanceof Error ? searchError.message : '全文搜索失败');
    } finally {
      if (searchRequestRef.current === requestId) setIsSearching(false);
    }
  };

  const clearSearch = () => {
    searchRequestRef.current += 1;
    setFilterTerm('');
    setMatchedSessionIds(null);
    setIsSearching(false);
    setSearchError('');
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

  // Close mobile drawer when platform changes (e.g. via PlatformBar)
  useEffect(() => {
    if (mobileOpen) onMobileOpenChange(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onMobileOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen, onMobileOpenChange]);

  const sidebarContent = (
    <aside
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden border-r border-border/60 bg-panel-alt/70 p-4 backdrop-blur-sm"
      aria-label="会话列表与筛选"
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-gradient-to-br from-primary to-assistant shadow-soft-sm" />
            <h1 className="truncate text-[17px] font-semibold tracking-tight">AgentXRay</h1>
          </div>
          <div className="mt-0.5 pl-[18px] text-[11px] font-medium text-muted-foreground">
            {PLATFORM_LABELS[platform]} 会话
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="设置"
            onClick={() => setSettingsOpen(true)}
            className="rounded-full"
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="关闭会话列表"
            aria-label="关闭会话列表"
            className="rounded-full lg:hidden"
            onClick={() => onMobileOpenChange(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={filterTerm}
          onChange={(e) => {
            searchRequestRef.current += 1;
            setFilterTerm(e.target.value);
            setMatchedSessionIds(null);
            setIsSearching(false);
            setSearchError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const q = filterTerm.trim();
              if (!q) return;
              setCmdkSeed(q);
              setCmdkOpen(true);
            } else if (e.key === 'Escape') {
              clearSearch();
            }
          }}
          placeholder="输入过滤 · 回车查看历史命中证据"
          title="直接输入：按 ID/标题/首条消息过滤列表；按回车：跨平台搜索消息、思考、工具参数、命令和结果；Esc 清除"
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
      {searchError ? (
        <div className="flex items-start justify-between gap-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          <span className="min-w-0 break-words">全文搜索失败：{searchError}</span>
          <button type="button" onClick={() => void runPlatformSearch(filterTerm)} className="shrink-0 underline">
            重试
          </button>
        </div>
      ) : matchedSessionIds !== null ? (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{isSearching ? '搜索中…' : `全文搜索命中 ${matchedSessionIds.size} 个会话`}</span>
          <button type="button" onClick={clearSearch} className="text-primary hover:underline">
            清除
          </button>
        </div>
      ) : null}
      {platform === 'openclaw' && <AgentNav />}
      <div className="flex flex-wrap items-center gap-3">
        {platform === 'openclaw' && (
          <ToggleRow
            label="包含归档"
            title="同时列出已归档的会话"
            checked={includeArchived}
            onChange={setIncludeArchived}
          />
        )}
        <ToggleRow
          label="自动刷新"
          title="每 5 秒刷新列表；当前会话通过 SSE 实时追加"
          checked={autoRefresh}
          onChange={setAutoRefresh}
        />
        <ToggleRow label="自动跟随" title="新消息到达时自动滚到最新" checked={autoScroll} onChange={setAutoScroll} />
      </div>
      <SessionList
        filterTerm={filterTerm}
        matchedSessionIds={matchedSessionIds}
        isSearching={isSearching}
        onSessionSelected={() => onMobileOpenChange(false)}
      />
    </aside>
  );

  return (
    <>
      <div className="hidden h-full min-h-0 lg:block">{sidebarContent}</div>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="会话列表">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            aria-label="关闭会话列表"
            onClick={() => onMobileOpenChange(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[min(88vw,360px)] shadow-xl">{sidebarContent}</div>
        </div>
      ) : null}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <CmdkDialog open={cmdkOpen} onOpenChange={setCmdkOpen} seedQuery={cmdkSeed} />
    </>
  );
}
