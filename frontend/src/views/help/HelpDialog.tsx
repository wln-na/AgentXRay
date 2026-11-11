// 帮助对话框（原「帮助」一级 tab 降级为顶栏 ? 入口）。
// 只保留无法从 README / 设置页 / 各视图 tooltip 得到的两块内容：
// 常见问题排查、数据边界说明。

import { CircleHelp, Database, Wrench } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const TROUBLESHOOTING = [
  {
    symptom: '左侧没有会话',
    checks: [
      '确认顶部选择了正确的平台',
      '点右上角 ⚙ 设置，检查该平台的日志目录',
      '确认对应的 Agent 工具已经产生过本地会话',
      '尝试开启「包含归档」，检查会话是否已被归档',
    ],
  },
  {
    symptom: '修改代码后页面没有更新',
    checks: [
      '源码开发需先运行 npm run build:ui',
      '确认 npm start 启动的是当前项目目录',
      '强制刷新浏览器，排除旧静态资源缓存',
      '检查终端是否仍有旧进程占用 3800 端口',
    ],
  },
  {
    symptom: 'Trace 显示「无内容」或工具结果未配对',
    checks: [
      '先在「消息」视图确认原始记录是否存在',
      '部分平台只保存工具摘要，不保存参数或独立结果',
      '检查日志是否仍在写入；未结束的工具调用可能暂时无结果',
      '切换排序不会改变配对关系，可用时间与工具名核对上下文',
    ],
  },
  {
    symptom: 'Token 或成本不完整',
    checks: [
      'Token 仅在上游日志提供 usage 时显示',
      '部分平台只在最终回复汇总 usage',
      '缓存 Token、推理 Token 不一定由所有平台提供',
      '成本是按内置模型单价估算，不等同于账单',
    ],
  },
  {
    symptom: 'Prompt 聚类分析不可用',
    checks: [
      '在设置中配置 OpenAI 兼容端点和模型',
      '或确认服务器 PATH 中能运行 claude CLI',
      '保存配置后重新进入 Prompts 页面',
      '本地端点可不填 API Key，远程端点按服务要求填写',
    ],
  },
  {
    symptom: '搜索结果不符合预期',
    checks: [
      '侧栏直接输入只过滤当前列表，按回车打开历史证据搜索',
      '历史搜索覆盖消息、思考、工具参数、执行命令、工作目录和工具结果',
      '使用 ⌘K / Ctrl+K 可随时跨平台搜索',
      '多关键词采用 AND 匹配，支持直接粘贴完整文件或目录路径',
    ],
  },
] as const;

const DATA_BOUNDARIES = [
  {
    title: '原始日志决定可见性：',
    body: '平台没记录的 thinking、arguments、result 或 usage 无法还原，界面会明确标记缺失。',
  },
  {
    title: '成本是估算：',
    body: '按可识别 Token 和内置模型单价计算，不含平台折扣、阶梯价和未知缓存策略。',
  },
  {
    title: '时间可能是推断：',
    body: '部分日志缺少工具结束时间或细粒度时间戳，瀑布图会使用可获得的相邻事件估算。',
  },
  {
    title: '本地优先：',
    body: '会话解析在本机完成；只有主动配置并使用 LLM 相关功能时，相关文本才会发送到所选后端。',
  },
] as const;

export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleHelp className="h-4 w-4 text-primary" />
            帮助与数据边界
          </DialogTitle>
          <DialogDescription>
            常见问题排查与数据口径说明。日志目录、LLM 后端与会话备份都在右上角 ⚙ 设置里。
          </DialogDescription>
        </DialogHeader>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            常见问题与排查
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {TROUBLESHOOTING.map((item) => (
              <article key={item.symptom} className="rounded-md border border-border bg-secondary/20 p-3">
                <h4 className="text-sm font-semibold">{item.symptom}</h4>
                <ol className="mt-1.5 space-y-1 text-xs leading-5 text-muted-foreground">
                  {item.checks.map((check, index) => (
                    <li key={check}>
                      {index + 1}. {check}
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Database className="h-4 w-4 text-muted-foreground" />
            理解数据边界
          </h3>
          <ul className="space-y-1.5 text-xs leading-5 text-muted-foreground">
            {DATA_BOUNDARIES.map((item) => (
              <li key={item.title}>
                <strong className="text-foreground">{item.title}</strong>
                {item.body}
              </li>
            ))}
          </ul>
        </section>
      </DialogContent>
    </Dialog>
  );
}
