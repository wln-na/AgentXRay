import { useEffect, useState } from 'react';
import { List, Moon, Sun } from 'lucide-react';
import type { Platform } from '@/api/types';
import { PLATFORM_LABELS, PLATFORMS } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { usePlatformProbe } from '@/hooks/usePlatformProbe';
import { pickAutoPlatform } from '@/lib/pure';
import { useAppStore } from '@/store';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const PLATFORM_TIPS: Record<Platform, string> = {
  openclaw: 'OpenClaw 会话（~/.openclaw/agents）',
  codex: 'Codex 会话（~/.codex/sessions）',
  'claude-code': 'Claude Code 会话（~/.claude/projects）',
  'claude-desktop': 'Claude Desktop Agent/Cowork 会话（~/Library/Application Support/Claude-3p/local-agent-mode-sessions）',
  hermes: 'Hermes 会话（~/.hermes）',
  omp: 'oh-my-pi 会话（~/.omp/agent/sessions）',
  dsh: 'DeepSeek Harness 会话（~/.dsh/sessions）',
  gemini: 'Gemini CLI 会话（~/.gemini/tmp）',
  cursor: 'Cursor Agent 会话（~/.cursor/projects）',
  doubao: 'Doubao 会话（~/.doubao/agent_mode/workspace/.sessions）',
};

export function PlatformBar({ onOpenSessions }: { onOpenSessions: () => void }) {
  const platform = useAppStore((s) => s.platform);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const [expanded, setExpanded] = useState(false);
  const { data: counts } = usePlatformProbe();

  // First-launch auto-pick (#13): no platform persisted yet → land on the
  // first platform that actually has sessions. SessionList then auto-selects
  // the most recent session. The demo build already defaults to a populated
  // tab, and setPlatform persists the choice so this runs at most once.
  useEffect(() => {
    if (DEMO || !counts || useAppStore.getState().hasStoredPlatform) return;
    const target = pickAutoPlatform(counts, PLATFORMS);
    if (target) setPlatform(target);
  }, [counts, setPlatform]);

  // While probing (counts undefined) every platform stays visible — same as legacy.
  const isCollapsed = (p: Platform) => p !== platform && !expanded && counts?.[p] === 0;
  const shown = PLATFORMS.filter((p) => !isCollapsed(p));
  const collapsed = PLATFORMS.filter((p) => isCollapsed(p));

  return (
    <div className="flex min-h-14 items-center gap-2 border-b border-border/70 bg-panel-alt/80 px-2 py-2 backdrop-blur-sm sm:px-3">
      <button
        type="button"
        title="打开会话列表"
        aria-label="打开会话列表"
        onClick={onOpenSessions}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
      >
        <List className="h-5 w-5" />
      </button>
      <div className="min-w-0 flex-1 lg:hidden">
        <Select value={platform} onValueChange={(value) => setPlatform(value as Platform)}>
          <SelectTrigger className="h-9 w-full" aria-label="选择 AI Agent 平台">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLATFORMS.map((p) => (
              <SelectItem key={p} value={p}>
                {PLATFORM_LABELS[p]}{typeof counts?.[p] === 'number' ? `（${counts[p]}）` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:flex">
        {shown.map((p) => (
          <button
            key={p}
            type="button"
            title={PLATFORM_TIPS[p]}
            onClick={() => setPlatform(p)}
            className={cn(
              'min-h-8 shrink-0 rounded-full px-3.5 text-[13px] font-medium transition-all',
              p === platform
                ? 'bg-primary/10 text-primary shadow-soft-sm ring-1 ring-primary/20'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
          >
            {PLATFORM_LABELS[p]}
          </button>
        ))}
        {collapsed.length > 0 && (
          <button
            type="button"
            title={`暂无会话的平台：${collapsed.map((p) => PLATFORM_LABELS[p]).join('、')} — 点击展开`}
            onClick={() => setExpanded(true)}
            className="min-h-8 shrink-0 rounded-full px-3 text-[13px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            +{collapsed.length}
          </button>
        )}
      </div>
      <button
        type="button"
        title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
        onClick={toggleTheme}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </div>
  );
}
