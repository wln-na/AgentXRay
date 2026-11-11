// 「框架」视图：介绍各支持框架的 Agent 设计与会话存储方式。
// 内容为手工整理的静态数据（./data，依据 lib/platforms/ 解析器源码），
// 不依赖后端接口，Demo 模式下同样可用。
import { Bot, Braces, FileJson2, FolderTree, History, Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { PLATFORM_DOC_COLORS, PLATFORM_DOCS } from './data';
import type { PlatformDoc } from './types';

type Selection = 'overview' | string;

function platformColor(id: string): string {
  return PLATFORM_DOC_COLORS[id] || 'var(--muted-foreground)';
}

function SectionCard({ icon: Icon, title, children }: { icon: typeof Bot; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <h2 className="text-base font-semibold">存储方式总览</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          12 个框架的会话日志全部落在本机磁盘上，但目录组织、文件格式与子 Agent 机制各不相同。
          下表是速查对比；点击任意平台查看完整手册（目录结构、消息 schema、spawn 机制与生命周期）。
          全部内容依据各平台解析器源码整理。
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-32">平台</TableHead>
              <TableHead className="min-w-40">默认目录</TableHead>
              <TableHead className="min-w-40">存储格式</TableHead>
              <TableHead className="min-w-40">子 Agent 机制</TableHead>
              <TableHead className="min-w-36">续跑与归档</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PLATFORM_DOCS.map((doc) => (
              <TableRow
                key={doc.id}
                className="cursor-pointer"
                title={`查看 ${doc.label} 完整手册`}
                onClick={() => onOpen(doc.id)}
              >
                <TableCell>
                  <span className="flex items-center gap-2 font-medium">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: platformColor(doc.id) }}
                    />
                    {doc.label}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{doc.defaultDir}</TableCell>
                <TableCell className="text-sm">{doc.storageKind}</TableCell>
                <TableCell className="text-sm">{doc.subagents}</TableCell>
                <TableCell className="text-sm">{doc.resume}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function PlatformDetail({ doc }: { doc: PlatformDoc }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: platformColor(doc.id) }}
            />
            {doc.label}
          </h2>
          <span className="text-sm text-muted-foreground">{doc.tagline}</span>
          <span
            className="ml-auto rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            title="本页内容依据该解析器源码整理"
          >
            {doc.source}
          </span>
        </div>
        <p className="mt-3 flex items-baseline gap-2 text-sm">
          <span className="shrink-0 font-medium">默认目录</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{doc.defaultDir}</code>
        </p>
      </div>

      <SectionCard icon={FolderTree} title="目录结构">
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">{doc.dirTree}</pre>
      </SectionCard>

      <SectionCard icon={FileJson2} title="文件格式">
        <Markdown text={doc.fileFormat} />
      </SectionCard>

      <SectionCard icon={Braces} title="消息与事件 Schema">
        <Markdown text={doc.messageSchema} />
      </SectionCard>

      <SectionCard icon={Bot} title="Agent 设计">
        <Markdown text={doc.agentDesign} />
      </SectionCard>

      <SectionCard icon={History} title="会话生命周期">
        <Markdown text={doc.lifecycle} />
      </SectionCard>

      {doc.special.length > 0 && (
        <SectionCard icon={Lightbulb} title="解析器特殊行为">
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
            {doc.special.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

export function FrameworksView() {
  const [selected, setSelected] = useState<Selection>('overview');
  const selectedDoc = PLATFORM_DOCS.find((doc) => doc.id === selected);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {/* 左侧平台导航：窄屏为横向滚动 chips，宽屏为固定侧栏 */}
      <nav
        aria-label="平台选择"
        className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 lg:w-64 lg:flex-col lg:overflow-y-auto lg:pb-0"
      >
        <button
          type="button"
          onClick={() => setSelected('overview')}
          className={cn(
            'shrink-0 rounded-md border px-3 py-1.5 text-left text-[13px] font-medium transition-colors',
            selected === 'overview'
              ? 'border-primary/50 bg-secondary text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
          )}
        >
          总览对比
        </button>
        {PLATFORM_DOCS.map((doc) => (
          <button
            key={doc.id}
            type="button"
            onClick={() => setSelected(doc.id)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-left text-[13px] transition-colors lg:py-2',
              selected === doc.id
                ? 'border-primary/50 bg-secondary text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
            )}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: platformColor(doc.id) }}
            />
            <span className="font-medium">{doc.label}</span>
            <span className="hidden truncate text-[11px] opacity-70 xl:inline">{doc.tagline}</span>
          </button>
        ))}
      </nav>

      {/* 右侧内容 */}
      <div className="min-h-0 min-w-0 flex-1 lg:overflow-y-auto lg:pr-1">
        {selectedDoc ? <PlatformDetail doc={selectedDoc} /> : <Overview onOpen={setSelected} />}
      </div>
    </div>
  );
}
