import { BarChart3, Copy } from 'lucide-react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PetWidget } from '@/components/PetWidget';
import { PlatformBar } from '@/components/PlatformBar';
import { Sidebar } from '@/components/Sidebar';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEMO } from '@/demo/flag';
import { useVersionPoller } from '@/hooks/useVersionPoller';
import { cn } from '@/lib/utils';
import type { MainView } from '@/store';
import { useAppStore } from '@/store';

const InsightsView = lazy(() =>
  import('@/views/insights/InsightsView').then((module) => ({ default: module.InsightsView }))
);
const UsageView = lazy(() => import('@/views/usage/UsageView').then((module) => ({ default: module.UsageView })));
const LibraryView = lazy(() =>
  import('@/views/library/LibraryView').then((module) => ({ default: module.LibraryView }))
);
const PromptsView = lazy(() =>
  import('@/views/prompts/PromptsView').then((module) => ({ default: module.PromptsView }))
);
const SessionsView = lazy(() =>
  import('@/views/sessions/SessionsView').then((module) => ({ default: module.SessionsView }))
);
const HelpView = lazy(() => import('@/views/help/HelpView').then((module) => ({ default: module.HelpView })));

const SIDEBAR_WIDTH_KEY = 'agent-xray-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 520;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function loadSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* private mode etc. — non-fatal */
  }
}

function ViewFallback() {
  return <div className="p-4 text-sm text-muted-foreground">正在加载视图…</div>;
}

const TABS: { view: MainView; label: string; title: string }[] = [
  { view: 'sessions', label: '会话', title: '浏览与回放会话：消息、工具调用、耗时与 token' },
  { view: 'insights', label: '分析', title: '聚合统计：工具调用、错误聚类、token 消耗、按日趋势' },
  { view: 'prompts', label: 'Prompts', title: '自动提取历史里所有真人 prompt：搜索、收藏、聚类分析与改写' },
  { view: 'library', label: '资产库', title: 'Prompt 资产库：标签管理，一键安装为各工具的 slash command' },
  { view: 'help', label: '帮助', title: '使用指南、数据目录说明与常见问题排查' },
];

export default function App() {
  useVersionPoller();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const isUsage = view === 'usage';
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  const resizeSidebarTo = (width: number) => {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    saveSidebarWidth(next);
  };

  const handleResizeStart = (event: ReactPointerEvent<HTMLHRElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const handleEnd = (upEvent: PointerEvent) => {
      const next = clampSidebarWidth(startWidth + upEvent.clientX - startX);
      setSidebarWidth(next);
      saveSidebarWidth(next);
      setIsResizingSidebar(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
    };
    setIsResizingSidebar(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      resizeSidebarTo(sidebarWidth - (event.shiftKey ? 40 : 10));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      resizeSidebarTo(sidebarWidth + (event.shiftKey ? 40 : 10));
    } else if (event.key === 'Home') {
      event.preventDefault();
      resizeSidebarTo(SIDEBAR_MIN_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      resizeSidebarTo(SIDEBAR_MAX_WIDTH);
    }
  };

  // Close mobile drawer when the user switches top-level tabs
  useEffect(() => {
    if (mobileSidebarOpen) setMobileSidebarOpen(false);
  }, [view]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col overflow-hidden">
        {DEMO ? (
          <div className="flex items-center justify-center gap-2 border-b border-[#e3b341]/40 bg-[#e3b341]/15 px-3 py-1.5 text-center text-xs text-[#e3b341]">
            <span>🧪 Demo mode — synthetic sample data (not real user sessions). Inspect your own agent logs:</span>
            <button
              type="button"
              title="Copy install command"
              onClick={() => {
                navigator.clipboard?.writeText('npx @alloevil/agent-xray').then(
                  () => toast.success('Copied: npx @alloevil/agent-xray'),
                  () => toast.error('Copy failed')
                );
              }}
              className="inline-flex items-center gap-1 rounded border border-[#e3b341]/50 bg-black/20 px-1.5 py-0.5 font-mono text-[11px] hover:border-[#e3b341] hover:text-foreground"
            >
              npx @alloevil/agent-xray
              <Copy className="h-3 w-3" />
            </button>
            <a
              href="https://github.com/alloevil/AgentXRay"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              GitHub
            </a>
          </div>
        ) : null}
        <PlatformBar onOpenSessions={() => setMobileSidebarOpen(true)} />
        <div
          className={cn(
            'grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]',
            isUsage && 'lg:grid-cols-1'
          )}
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          {!isUsage && (
            <div className="contents lg:relative lg:block lg:h-full lg:min-h-0">
              <Sidebar mobileOpen={mobileSidebarOpen} onMobileOpenChange={setMobileSidebarOpen} />
              <hr
                aria-label="调整会话侧栏宽度"
                aria-orientation="vertical"
                aria-valuemin={SIDEBAR_MIN_WIDTH}
                aria-valuemax={SIDEBAR_MAX_WIDTH}
                aria-valuenow={sidebarWidth}
                tabIndex={0}
                title={`拖动调整侧栏宽度（当前 ${sidebarWidth}px）；方向键微调，双击恢复默认`}
                onPointerDown={handleResizeStart}
                onDoubleClick={() => resizeSidebarTo(SIDEBAR_DEFAULT_WIDTH)}
                onKeyDown={handleResizeKeyDown}
                className={`absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none border-0 bg-transparent outline-none transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary/70 focus-visible:after:bg-primary lg:block ${isResizingSidebar ? 'after:bg-primary' : ''}`}
              />
            </div>
          )}
          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            {/* 导航：会话浏览类主标签（会话/分析/Prompts/资产库/帮助）+ 独立「用量」仪表盘入口 */}
            <div className="flex items-center gap-2 px-3 pt-3 sm:px-5">
              <nav className="inline-flex h-9 min-w-max items-center gap-0.5 rounded-full bg-secondary/70 p-1">
                {TABS.map((tab) => (
                  <button
                    key={tab.view}
                    type="button"
                    title={tab.title}
                    onClick={() => setView(tab.view)}
                    className={cn(
                      'rounded-full px-3.5 text-[13px] font-medium transition-all',
                      view === tab.view
                        ? 'bg-card text-foreground shadow-soft-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
              <div className="mx-0.5 h-5 w-px bg-border" />
              <button
                type="button"
                title="用量统计：每日 token 消耗总量与分应用明细（独立仪表盘）"
                onClick={() => setView('usage')}
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all',
                  isUsage
                    ? 'bg-card text-foreground shadow-soft-sm'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                <BarChart3 className="h-4 w-4" />
                用量
              </button>
            </div>

            {isUsage ? (
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <Suspense fallback={<ViewFallback />}>
                  <UsageView />
                </Suspense>
              </div>
            ) : (
              <Tabs value={view} onValueChange={(v) => setView(v as MainView)} className="flex min-h-0 flex-1 flex-col">
                <Suspense fallback={<ViewFallback />}>
                  {view === 'sessions' ? (
                    <TabsContent value="sessions" forceMount className="mt-0 min-h-0 flex-1 overflow-auto p-2 sm:p-4">
                      <SessionsView />
                    </TabsContent>
                  ) : null}
                  {view === 'insights' ? (
                    <TabsContent value="insights" forceMount className="mt-0 min-h-0 flex-1 overflow-auto p-4">
                      <InsightsView />
                    </TabsContent>
                  ) : null}
                  {view === 'prompts' ? (
                    <TabsContent value="prompts" forceMount className="mt-0 min-h-0 flex-1 overflow-auto p-4">
                      <PromptsView />
                    </TabsContent>
                  ) : null}
                  {view === 'library' ? (
                    <TabsContent value="library" forceMount className="mt-0 min-h-0 flex-1 overflow-auto p-4">
                      <LibraryView />
                    </TabsContent>
                  ) : null}
                  {view === 'help' ? (
                    <TabsContent value="help" forceMount className="mt-0 min-h-0 flex-1 overflow-auto p-3 sm:p-4">
                      <HelpView />
                    </TabsContent>
                  ) : null}
                </Suspense>
              </Tabs>
            )}
          </main>
        </div>
      </div>
      <PetWidget />
    </TooltipProvider>
  );
}
