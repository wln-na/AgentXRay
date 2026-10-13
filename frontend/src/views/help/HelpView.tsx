import {
  Activity,
  BookOpen,
  ChevronRight,
  CircleHelp,
  Copy,
  Database,
  FolderCog,
  GitBranch,
  Lightbulb,
  MessageSquareText,
  Search,
  Settings,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAppStore } from '@/store';
import type { MainView } from '@/store';

interface GuideCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}

const DEFAULT_DIRS = [
  ['OpenClaw', '~/.openclaw/agents'],
  ['Codex', '~/.codex/sessions'],
  ['Claude Code', '~/.claude/projects'],
  ['Claude Desktop', '~/Library/Application Support/Claude-3p/local-agent-mode-sessions'],
  ['Hermes', '~/.hermes'],
  ['OMP', '~/.omp/agent/sessions'],
  ['DeepSeek Harness', '~/.dsh/sessions'],
  ['Gemini CLI', '~/.gemini/tmp'],
  ['Doubao', '~/.doubao/agent_mode/workspace/.sessions'],
] as const;

const TROUBLESHOOTING = [
  {
    symptom: '左侧没有会话',
    checks: ['确认顶部选择了正确平台', '点击侧栏齿轮，检查该平台日志目录', '确认 Agent 工具已经产生过本地会话', '尝试开启“包含归档”，检查会话是否已被归档'],
  },
  {
    symptom: '修改代码后页面没有更新',
    checks: ['源码开发需先运行 npm run build:ui', '确认 npm start 启动的是当前项目目录', '强制刷新浏览器，排除旧静态资源缓存', '检查终端是否仍有旧进程占用 3800 端口'],
  },
  {
    symptom: 'Trace 显示“无内容”或工具结果未配对',
    checks: ['先在“消息”视图确认原始记录是否存在', '部分平台只保存工具摘要，不保存参数或独立结果', '检查日志是否仍在写入；未结束的工具调用可能暂时无结果', '切换排序不会改变配对关系，可用时间与工具名核对上下文'],
  },
  {
    symptom: 'Token 或成本不完整',
    checks: ['Token 仅在上游日志提供 usage 时显示', '部分平台只在最终回复汇总 usage', '缓存 Token、推理 Token 不一定由所有平台提供', '成本是按内置模型单价估算，不等同于账单'],
  },
  {
    symptom: 'Prompt 优化不可用',
    checks: ['在设置中配置 OpenAI 兼容端点和模型', '或确认服务器 PATH 中能运行 claude CLI', '保存配置后重新进入 Prompts 页面', '本地端点可不填 API Key，远程端点按服务要求填写'],
  },
  {
    symptom: '搜索结果不符合预期',
    checks: ['侧栏直接输入只过滤当前列表，按回车打开历史证据搜索', '历史搜索覆盖消息、思考、工具参数、执行命令、工作目录和工具结果', '使用 ⌘K / Ctrl+K 可随时跨平台搜索', '多关键词采用 AND 匹配，支持直接粘贴完整文件或目录路径'],
  },
] as const;

function GuideCard({ icon: Icon, title, description, action, onAction }: GuideCardProps) {
  return (
    <div className="flex min-h-32 flex-col rounded-lg border border-border bg-card p-4">
      <Icon className="mb-3 h-5 w-5 text-primary" aria-hidden="true" />
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 flex-1 text-xs leading-5 text-muted-foreground">{description}</p>
      {action && onAction ? (
        <button type="button" onClick={onAction} className="mt-3 inline-flex items-center gap-1 text-left text-xs font-medium text-primary hover:underline">
          {action}<ChevronRight className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function CodeLine({ children }: { children: string }) {
  const copy = () => {
    navigator.clipboard?.writeText(children).then(
      () => toast.success('命令已复制'),
      () => toast.error('复制失败')
    );
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
      <code className="min-w-0 overflow-x-auto">{children}</code>
      <button type="button" onClick={copy} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground" title="复制命令" aria-label="复制命令">
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function HelpView() {
  const setView = useAppStore((s) => s.setView);
  const setSessionView = useAppStore((s) => s.setSessionView);

  const openView = (view: MainView, sessionView?: 'messages' | 'trace') => {
    if (sessionView) setSessionView(sessionView);
    setView(view);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-8">
      <header className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary">
              <CircleHelp className="h-4 w-4" />
              AgentXRay 使用与排查
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">从本地会话到可解释的 Agent 执行轨迹</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              AgentXRay 直接读取本机 Agent 日志，不需要给原工具接入 SDK。按下面流程选择平台、定位会话、检查 Trace，再用分析和资产库沉淀经验。
            </p>
          </div>
          <Badge variant="secondary" className="shrink-0">数据留在本机</Badge>
        </div>
        <div className="mt-5 grid gap-2 sm:grid-cols-4">
          {['选择平台', '打开会话', '检查 Trace', '复盘沉淀'].map((step, index) => (
            <div key={step} className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[10px] text-primary">{index + 1}</span>
              {step}
            </div>
          ))}
        </div>
      </header>

      <section aria-labelledby="quick-start-title">
        <div className="mb-2 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <h2 id="quick-start-title" className="text-base font-semibold">快速开始</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <GuideCard icon={MessageSquareText} title="1. 浏览会话" description="顶部选择 Agent 平台，左侧选择会话。桌面端可拖动侧栏右边缘改变宽度，双击分隔线恢复默认。" action="打开会话" onAction={() => openView('sessions', 'messages')} />
          <GuideCard icon={GitBranch} title="2. 阅读 Trace" description="切换到 Trace 查看每轮模型、工具与子 Agent 的父子关系、耗时、Token 和错误。" action="打开 Trace" onAction={() => openView('sessions', 'trace')} />
          <GuideCard icon={Activity} title="3. 事后分析" description="查看 Prompt 质量、成本、工具模式、错误知识库，以及“度量→归因→沉淀→建议”的反思闭环。" action="打开分析" onAction={() => openView('insights')} />
          <GuideCard icon={Lightbulb} title="4. 沉淀资产" description="从历史中提取高质量 Prompt，收藏到资产库，并安装为 Claude Code、Codex 或 OMP 的命令。" action="打开资产库" onAction={() => openView('library')} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <Search className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold">界面怎么用</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div><strong>会话</strong><span className="text-muted-foreground"> — 消息适合连续阅读；Trace 适合检查调用顺序、耗时、Token、工具参数与结果。</span></div>
            <div><strong>分析</strong><span className="text-muted-foreground"> — 全局视角看趋势，本会话视角看 Prompt、成本、错误、决策与反思。</span></div>
            <div><strong>Prompts</strong><span className="text-muted-foreground"> — 自动过滤系统注入和工具噪声，搜索、聚类、优化真人提问。</span></div>
            <div><strong>资产库</strong><span className="text-muted-foreground"> — 管理值得复用的 Prompt，并同步为目标 CLI 的 slash command。</span></div>
            <div><strong>搜索</strong><span className="text-muted-foreground"> — 输入时过滤当前列表；回车打开跨平台历史证据搜索；⌘K / Ctrl+K 可随时唤起。</span></div>
            <div><strong>排序</strong><span className="text-muted-foreground"> — 消息与 Trace 共享“最新在上 / 最早在上”设置。</span></div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold">启动与更新</h2>
          </div>
          <div className="space-y-2">
            <CodeLine>npm start</CodeLine>
            <CodeLine>npm run build:ui</CodeLine>
            <CodeLine>npm test</CodeLine>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            源码开发时，修改前端后先构建，再重启或刷新页面。默认服务地址为 localhost:3800；可用 PORT 和 HOST 环境变量调整。
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FolderCog className="h-4 w-4 text-primary" />
            <h2 className="text-base font-semibold">默认数据目录</h2>
          </div>
          <span className="text-xs text-muted-foreground">可在侧栏齿轮设置中覆盖，保存后无需重启</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {DEFAULT_DIRS.map(([platform, path]) => (
            <div key={platform} className="min-w-0 rounded-md border border-border bg-secondary/20 px-3 py-2">
              <div className="text-xs font-medium">{platform}</div>
              <code className="mt-1 block overflow-x-auto text-[0.68rem] text-muted-foreground">{path}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Wrench className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold">常见问题与排查</h2>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {TROUBLESHOOTING.map((item) => (
            <article key={item.symptom} className="rounded-md border border-border bg-secondary/20 p-3">
              <h3 className="text-sm font-semibold">{item.symptom}</h3>
              <ol className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">
                {item.checks.map((check, index) => <li key={check}>{index + 1}. {check}</li>)}
              </ol>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold">理解数据边界</h2>
        </div>
        <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
          <li><strong className="text-foreground">原始日志决定可见性：</strong>平台没记录的 thinking、arguments、result 或 usage 无法还原，界面会明确标记缺失。</li>
          <li><strong className="text-foreground">成本是估算：</strong>按可识别 Token 和内置模型单价计算，不含平台折扣、阶梯价和未知缓存策略。</li>
          <li><strong className="text-foreground">时间可能是推断：</strong>部分日志缺少工具结束时间或细粒度时间戳，瀑布图会使用可获得的相邻事件估算。</li>
          <li><strong className="text-foreground">本地优先：</strong>会话解析在本机完成；只有主动配置并使用 Prompt 优化时，相关文本才会发送到所选 LLM 后端。</li>
        </ul>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
        <span>需要修改日志目录、LLM 后端或执行备份时，请使用左侧 AgentXRay 标题旁的设置按钮。</span>
        <Button variant="outline" size="sm" onClick={() => openView('sessions')}>
          <Settings className="mr-1.5 h-3.5 w-3.5" />返回会话
        </Button>
      </footer>
    </div>
  );
}
