// 会话头操作区：原来六个同级按钮（改为最早在上 / 更多信息 / 复制恢复命令 / 定位 / 打开 / 导出）
// 收成两个入口 —— 「打开 ▾」放与"把会话带出去"相关的动作，⋯ 放排序、摘要折叠与导出。

import {
  ChevronDown,
  ClipboardList,
  Ellipsis,
  FileCode2,
  FileJson,
  FolderSearch,
  ListOrdered,
  Loader2,
  Rocket,
  Terminal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { openSession } from '@/api/client';
import type { OpenSessionResult, SessionDetail } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { dirForPlatform, useAppStore, useSessionViewSelectors } from '@/store';
import type { ExportFormat } from './exports';
import { runExport } from './exports';
import { resumeCommand } from './lib';

const ACTION_BTN =
  'rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground shadow-soft-sm disabled:cursor-default disabled:opacity-50';

// Platforms whose sessions resume natively in a terminal CLI (open → new window).
const RESUME_PLATFORM_TITLES: Record<string, string> = {
  codex: '打开 ChatGPT 应用（codex:// 深链直达会话；应用缺失时回退终端续跑）',
  'claude-code': '在终端新窗口中恢复此会话（claude --resume）',
  omp: '在终端新窗口中恢复此会话（omp --resume）',
  doubao: '打开 Doubao 2 应用（深链直达会话；应用缺失时回退应用启动）',
  'claude-desktop': '打开 Claude 应用（无会话级深链；应用缺失时回退默认编辑器）',
  cursor: '打开 Cursor 应用（无会话级深链；应用缺失时回退默认编辑器）',
  workbuddy: '打开 WorkBuddy 应用（无会话级深链；应用缺失时回退默认编辑器）',
  trae: '打开 Trae CN 应用（无会话级深链；应用缺失时回退默认编辑器）',
};

// Mirror of lib/platforms/capabilities.json `open` flag: hermes sessions share
// a single SQLite store, so "open" has no native target (locate still works).
const NO_OPEN_PLATFORMS = new Set(['hermes']);

function openTitleFor(platform: string): string {
  return RESUME_PLATFORM_TITLES[platform] || '用默认应用打开会话日志文件';
}

/** 菜单项：统一样式，图标可选。 */
function MenuItem({
  icon,
  children,
  onClick,
  disabled,
  testId,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function MenuGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function MenuDivider() {
  return <div className="my-1 h-px bg-border" />;
}

/** 点击遮罩 / Esc 关闭的浮层菜单（沿用导出菜单的实现方式，未引入新依赖）。 */
function Menu({
  label,
  title,
  testId,
  width = 'w-52',
  disabled = false,
  trigger,
  children,
}: {
  label: string;
  title: string;
  testId: string;
  width?: string;
  disabled?: boolean;
  trigger: (open: boolean) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        className={ACTION_BTN}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger(open)}
      </button>
      {open ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="fixed inset-0 z-10 cursor-default bg-transparent"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label={label}
            className={`absolute right-0 z-20 mt-1 ${width} rounded-md border border-border bg-popover p-1 shadow-lg`}
          >
            {children(() => setOpen(false))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function HeaderActions({
  detail,
  collapsed,
  onToggleCollapsed,
}: {
  detail: SessionDetail;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { platform, sessionId: selectedSessionId, agent: selectedAgent, settings } = useSessionViewSelectors();
  const msgOrder = useAppStore((s) => s.msgOrder);
  const setMsgOrder = useAppStore((s) => s.setMsgOrder);
  const [pending, setPending] = useState<'locate' | 'open' | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedExport, setCopiedExport] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const needsAgent = platform === 'openclaw';
  const canOpen = !NO_OPEN_PLATFORMS.has(platform);
  const dir = dirForPlatform(settings, platform) || undefined;
  const openDisabled = needsAgent && !selectedAgent;
  const resumeCmd = resumeCommand(platform, selectedSessionId, detail.session?.cwd);

  const runOpen = async (action: 'locate' | 'open') => {
    setPending(action);
    try {
      const res: OpenSessionResult = await openSession(platform, selectedSessionId, action, {
        agent: selectedAgent || undefined,
        dir,
      });
      if (res.ok) {
        // A session being actively written by another process is the "open in
        // another app" situation: warn that live updates won't land here.
        if (action === 'open' && res.hint?.process) {
          toast.warning(
            `已打开，但该会话正被 ${res.hint.process}（PID ${res.hint.pid}）活跃使用，可能在别的客户端中打开中`
          );
          return;
        }
        toast.success(res.detail || (action === 'locate' ? '已定位' : '已打开'));
        return;
      }
      const fb = res.fallback;
      if (fb?.type === 'copy-path' && fb.path) {
        await navigator.clipboard.writeText(fb.path);
        toast.error(`${res.error || '操作失败'}（已复制路径）`);
      } else if (fb?.type === 'copy-command' && fb.command) {
        await navigator.clipboard.writeText(fb.command);
        toast.error(`${res.error || '操作失败'}（已复制命令）`);
      } else {
        toast.error(res.error || '操作失败');
      }
    } catch (error) {
      toast.error(`操作失败: ${(error as Error).message}`);
    } finally {
      setPending(null);
    }
  };

  const copyResumeCommand = async () => {
    if (!resumeCmd) return;
    try {
      await navigator.clipboard.writeText(resumeCmd);
      setCopiedCmd(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopiedCmd(false), 1500);
    } catch (error) {
      toast.error(`复制失败: ${(error as Error).message}`);
    }
  };

  const onExport = async (format: ExportFormat) => {
    const result = await runExport(
      format,
      detail,
      platform,
      selectedSessionId,
      dirForPlatform(settings, platform) || undefined,
      platform === 'openclaw' ? selectedAgent : undefined
    );
    if (result === 'copied') {
      setCopiedExport(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopiedExport(false), 1500);
    }
  };

  const exportEntries: [ExportFormat, string, React.ReactNode][] = [
    ['markdown', 'Markdown (.md)', <FileCode2 key="md" className="h-3.5 w-3.5" />],
    ...(DEMO
      ? []
      : ([['html', 'HTML (.html)', <FileCode2 key="html" className="h-3.5 w-3.5" />]] as [
          ExportFormat,
          string,
          React.ReactNode,
        ][])),
    ['json', 'JSON (.json)', <FileJson key="json" className="h-3.5 w-3.5" />],
    ['clipboard', '复制到剪贴板', <ClipboardList key="clip" className="h-3.5 w-3.5" />],
  ];
  if (['codex', 'claude-code', 'claude-desktop', 'omp', 'dsh', 'gemini'].includes(platform)) {
    exportEntries.push(['otlp', 'OTLP JSON', <FileJson key="otlp" className="h-3.5 w-3.5" />]);
  }

  return (
    <div className="flex items-center gap-2" data-testid="header-actions">
      {DEMO ? null : (
        <Menu
          label={canOpen ? '打开' : '定位'}
          title={openDisabled ? '请先选择 OpenClaw agent' : openTitleFor(platform)}
          testId="header-open-menu"
          disabled={openDisabled}
          trigger={(open) => (
            <>
              {pending ? <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" /> : null}
              {canOpen ? '打开' : '定位'}
              <span className="ml-1 text-[10px]">{open ? '▴' : '▾'}</span>
            </>
          )}
        >
          {(close) => (
            <>
              {canOpen ? (
                <MenuItem
                  icon={<Rocket className="h-3.5 w-3.5" />}
                  testId="open-btn"
                  disabled={pending !== null}
                  onClick={() => {
                    close();
                    void runOpen('open');
                  }}
                >
                  {pending === 'open' ? '打开中…' : '打开'}
                </MenuItem>
              ) : null}
              <MenuItem
                icon={<FolderSearch className="h-3.5 w-3.5" />}
                testId="locate-btn"
                disabled={pending !== null}
                onClick={() => {
                  close();
                  void runOpen('locate');
                }}
              >
                {pending === 'locate' ? '定位中…' : '在 Finder 中定位'}
              </MenuItem>
              {resumeCmd ? (
                <MenuItem
                  icon={<Terminal className="h-3.5 w-3.5" />}
                  testId="resume-btn"
                  onClick={() => {
                    close();
                    void copyResumeCommand();
                  }}
                >
                  {copiedCmd ? '已复制恢复命令' : '复制恢复命令'}
                </MenuItem>
              ) : null}
            </>
          )}
        </Menu>
      )}

      <Menu
        label="更多操作"
        title="更多操作：摘要折叠、消息排序、导出"
        testId="header-more-menu"
        width="w-56"
        trigger={() => <Ellipsis className="h-4 w-4" aria-hidden="true" />}
      >
        {(close) => (
          <>
            <MenuItem
              icon={<ChevronDown className={collapsed ? 'h-3.5 w-3.5' : 'h-3.5 w-3.5 rotate-180'} />}
              testId="summary-toggle"
              onClick={() => {
                close();
                onToggleCollapsed();
              }}
            >
              {collapsed ? '更多信息' : '收起信息'}
            </MenuItem>
            <MenuItem
              icon={<ListOrdered className="h-3.5 w-3.5" />}
              testId="msg-order-toggle"
              onClick={() => {
                close();
                setMsgOrder(msgOrder === 'newest-first' ? 'oldest-first' : 'newest-first');
              }}
            >
              {msgOrder === 'newest-first' ? '改为最早在上' : '改为最新在上'}
            </MenuItem>
            <MenuDivider />
            <MenuGroupLabel>导出</MenuGroupLabel>
            {exportEntries.map(([format, label, icon]) => (
              <MenuItem
                key={format}
                icon={icon}
                testId={`export-${format}`}
                onClick={() => {
                  close();
                  void onExport(format);
                }}
              >
                {copiedExport && format === 'clipboard' ? '已复制到剪贴板' : label}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
    </div>
  );
}
