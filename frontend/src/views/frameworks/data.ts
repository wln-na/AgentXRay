// 「框架」视图内容：12 个支持平台的 Agent 设计与会话存储方式。
// 全部内容依据 lib/platforms/ 各解析器源码手工整理（2026-10），
// 平台目录或格式变更时需同步更新对应条目。
import type { PlatformDoc } from './types';

/** 平台色标（与 CmdkDialog 的 PLAT_BADGE 保持一致，补 cursor） */
export const PLATFORM_DOC_COLORS: Record<string, string> = {
  openclaw: '#3fb950',
  codex: '#58a6ff',
  'claude-code': '#d2a8ff',
  'claude-desktop': '#c690f0',
  hermes: '#f78166',
  omp: '#ffd33d',
  dsh: '#4d6bfe',
  gemini: '#4285f4',
  cursor: '#8b949e',
  doubao: '#00a870',
  workbuddy: '#0052d9',
  trae: '#ff5a1f',
};

export const PLATFORM_DOCS: PlatformDoc[] = [
  // ------------------------------------------------------------------ openclaw
  {
    id: 'openclaw',
    label: 'OpenClaw',
    tagline: '多 agent 目录制，spawn 树最完整的平台',
    defaultDir: '~/.openclaw/agents（OPENCLAW_DIR 可覆盖）',
    storageKind: 'JSONL · 每 agent 每会话一文件',
    subagents: 'sessions_spawn / exec 派生，按名字 + 时间窗匹配',
    resume: '同 id 多轮转文件取最新；后缀判定归档',
    dirTree: `~/.openclaw/agents/
├── <agentName>/
│   └── sessions/
│       ├── <sessionId>.jsonl               # 会话主文件
│       ├── <sessionId>.jsonl.reset.<ts>    # 重置归档
│       ├── <sessionId>.jsonl.deleted.<ts>  # 删除归档
│       └── <sessionId>.trajectory.jsonl    # 可选：prompt 编译上下文
└── <agent2>/sessions/…`,
    fileFormat: `JSONL 单文件，逐行流式解析、坏行跳过。记录只有两种类型：

- **session** — 会话头，携带 id / cwd / timestamp / version
- **message** — 消息体，role 为 **user / assistant / toolResult**

工具调用作为 assistant content 的 \`toolCall\` 部件（id / name / arguments）记录，工具结果则是独立的 \`toolResult\` 消息，两者经 \`toolCallId\` + \`toolName\` 配对。usage 原样透传自 \`message.usage\`；时间戳为 ISO 字符串，最后一条 message 的时间即会话活跃时间。`,
    messageSchema: `content 部件枚举 \`text\` 与 \`toolCall\`。首条用户消息会经过去噪（见特殊行为），列表标题与 prompt 提取都基于去噪后的文本。`,
    agentDesign: `**agent = 数据目录下的一级子目录**，目录名即 agent 名，每个 agent 有独立的 sessions/ 目录。

派生（spawn）有两条路径：

- **sessions_spawn 工具调用** — 参数含 agentId / label / task，声明式派生子 agent
- **exec 执行外部 CLI** — 通过 exec 调起 codex / claude 时，解析器会推断目标平台并纳入同一棵 spawn 树

子会话按「agent 名（忽略大小写）+ spawn 之后 5 分钟时间窗」匹配到父会话；spawn 树深度上限 6 层并做防环。Hermes 会话若带 parent_session_id 也会并入这棵树。`,
    lifecycle: `会话 id 取首条 session 记录，缺失时回退文件名去 \`.jsonl\`。文件名含 \`.jsonl.reset.\` / \`.jsonl.deleted.\` 后缀即为归档，否则视为活跃。同一 id 存在多个轮转文件时，精确 \`.jsonl\` 优先，其余按名称倒序取最新作为续跑目标。`,
    special: [
      '首条用户消息去噪：System: 行、```json 元数据块、[message_id:]、ou_ 发送者前缀、[Subagent Context] 注入、时间戳频道行、HEARTBEAT_OK',
      '.trajectory.jsonl 的 context.compiled 记录可为命中的用户消息补写完整编译 prompt（剔除重复尾段）',
      '模型统计剔除 delivery-mirror 通道',
      '路径访问经 assertSafePath + realpath 防穿越；元数据按 mtime 缓存',
    ],
    source: 'lib/platforms/openclaw.js',
  },

  // --------------------------------------------------------------------- codex
  {
    id: 'codex',
    label: 'Codex',
    tagline: 'rollout 文件流，parent_thread_id 显式关联子线程',
    defaultDir: '~/.codex/sessions（CODEX_DIR），归档 ~/.codex/archived_sessions（CODEX_ARCHIVED_DIR）',
    storageKind: 'JSONL · 每线程一个 rollout 文件',
    subagents: '独立 rollout 文件，parent_thread_id 显式指向父线程',
    resume: '同 id 活跃/归档并存取活跃副本',
    dirTree: `~/.codex/
├── sessions/                      # 活跃会话（递归扫描，允许安全 symlink）
│   └── rollout-<ts>-<uuid>.jsonl  # 每会话一文件；子线程同为独立 rollout
└── archived_sessions/`,
    fileFormat: `JSONL 单文件、不压缩。记录类型：

- **session_meta** — 线程元数据（id / cwd / originator / parent_thread_id 等），会话 id 取 \`payload.id\`，回退文件名去 \`.jsonl\`
- **response_item** — 对话内容：\`message\`（role = user / assistant）、\`function_call\` / \`custom_tool_call\`、\`function_call_output\` / \`custom_tool_call_output\`、\`reasoning\`
- **event_msg** — 事件流，token 用量来自 \`token_count\` 事件的 \`info.total_token_usage\`（input / output / cached_input / cache_write_input / reasoning_output / total），并带 \`model_context_window\`
- **turn_context** / **world_state** / **compacted** — 模型切换、状态与压缩替代历史

工具调用与结果按 \`call_id\` 配对，结果带 exit_code / duration。每条记录有顶层 ISO timestamp。`,
    messageSchema: `模型可出自 turn_context / world_state / thread_settings / session_meta.provenance 多处。合成注入（\`<environment_context>\`、\`<user_instructions>\`、AGENTS.md / CLAUDE.md 前缀、超长文件粘贴）会被过滤，首个真实用户提示作标题。`,
    agentDesign: `**子代理 = 独立的线程文件**，通过 \`session_meta.payload.parent_thread_id\` 显式指向父线程；\`source\` 为 \`'subagent'\` 或 \`payload.source.subagent.thread_spawn\`，另有 \`agent_role\` / \`agent_nickname\` 身份字段。列表只显示无 parent 的主线程，子孙线程按 BFS 展开；子会话响应补 \`parentThreadId\` / \`rootThreadId\`。`,
    lifecycle: `解析器本身无 resume 命令逻辑；同一 id 活跃/归档副本并存时取活跃副本，archived 按路径判定。lastActivity = 文件内最大 timestamp，主会话会并入子孙活动取最大。查找先按文件名快速命中，失败再全量扫描（sessionId 可能是内部 meta.id）。`,
    special: [
      '从日志重构系统上下文三组件：环境上下文 + 用户指令（起始合成消息）+ base_instructions',
      'compacted.replacement_history 还原压缩后的替代历史',
      '元数据按 mtime LRU 缓存并做并发去重；路径限定 HOME 内 + symlink 校验',
    ],
    source: 'lib/platforms/codex.js',
  },

  // -------------------------------------------------------------- claude-code
  {
    id: 'claude-code',
    label: 'Claude Code',
    tagline: '项目 slug 分目录，子代理靠目录约定归位',
    defaultDir: '~/.claude/projects（CLAUDE_CODE_DIR）',
    storageKind: 'JSONL · 每项目每会话一文件',
    subagents: 'subagents/ 目录约定 + agent-*.meta.json 身份',
    resume: '同文件追加，无归档机制',
    dirTree: `~/.claude/projects/
└── <project-slug>/                # 每项目一目录
    ├── <session-uuid>.jsonl       # 主会话，一 session 一文件
    ├── subagents/*.jsonl          # 项目级子代理（按文件名匹配会话）
    └── <session-uuid>/subagents/
        ├── agent-<id>.jsonl       # 该会话派生的子代理
        └── agent-<id>.meta.json   # { agentType, description }`,
    fileFormat: `JSONL 单文件、不压缩。sessionId 即文件名，同时内嵌于每条记录的 \`rec.sessionId\`。记录类型：

- **user** — content 为字符串或块数组；纯 tool_result 数组规范化为 toolResult
- **assistant** — 块含 text + tool_use，带 \`message.usage / model / id\`
- **system** — subtype = turn_duration（计数时跳过）
- **attachment** — 环境附件（见特殊行为）

工具经 \`tool_use_id\` ↔ \`tool_use.id\` 配对。usage 字段：input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens，total 缺失按分量和。日志中 input / cache 是每请求累计值，会话级取最后一次请求、output 跨请求求和。每条记录含 uuid / timestamp（ISO）/ sessionId / cwd / slug / version / parentUuid。`,
    messageSchema: `噪声过滤：isMeta、纯 tool_result、\`<command-name>\` / \`<command-message>\` / \`<local-command-stdout>\`、\`<task-notification>\`、Caveat:、[Request interrupted…]；真实 prompt 内嵌的 \`<system-reminder>\` 会被剥离。`,
    agentDesign: `主会话与子代理之间**没有 parent 指针**，完全靠目录约定归位：\`<slug>/<sessionId>/subagents/agent-<id>.jsonl\`。子代理身份 = 文件名 \`agent-<id>\` + 可选 meta.json 的 agentType / description。`,
    lifecycle: `续跑即同文件追加，无归档处理。lastActivity = 最后一条记录的 timestamp；列表按首条 user/assistant 时间降序。`,
    special: [
      'attachment 记录（task_reminder / skill_listing / agent_listing_delta / mcp_instructions_delta / command_permissions / date_change / deferred_tools_delta）转 <task-context> 等 XML 块，按 parentUuid 注入父 user 消息',
      '模型 <synthetic> 忽略；标题 = 首条真实用户消息 > slug',
      '子代理目录做 symlink 校验',
    ],
    source: 'lib/platforms/claude.js',
  },

  // ----------------------------------------------------------- claude-desktop
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    tagline: '双文件制：JSON 元数据 + Claude Code 同构 JSONL',
    defaultDir: '~/Library/Application Support/Claude-3p/local-agent-mode-sessions（CLAUDE_DESKTOP_DIR）',
    storageKind: 'JSON 元数据 + JSONL 日志（同构 Claude Code）',
    subagents: '无子代理概念',
    resume: 'isArchived 元数据标记归档',
    dirTree: `…/local-agent-mode-sessions/      # 递归整棵树
├── **/local_<uuid>.json          # 桌面会话元数据
├── **/<cliSessionId>.jsonl       # 消息日志（Claude Code 同构）
└── **/audit.jsonl                # 审计日志（仅记录路径，不解析）

# 跳过的子目录：title-gen、IndexedDB、Local Storage、
# Cache、Code Cache、GPUCache、vm_bundles`,
    fileFormat: `**JSONL 日志 + JSON 元数据双文件**。元数据必须同时含 \`sessionId\`（桌面 id，形如 \`local_<uuid>\`）与 \`cliSessionId\`（= 日志文件名），否则丢弃。消息 schema 完全复用 Claude Code 解析器，仅改写上下文占用提示文案。`,
    messageSchema: '与 Claude Code 相同：user / assistant / system / attachment，tool_use_id 配对，usage 字段一致。',
    agentDesign: `无子代理概念。单会话通过**双 ID 关联**：桌面 \`sessionId\` ↔ CLI \`cliSessionId\`。`,
    lifecycle: `同一 cliSessionId 的日志可能存在于多处，按打分选择：路径含 id 前 8 位 +20、含完整 sessionId +20、含 \`.claude/projects/session/\` +5，平分按字典序。archived 取元数据 \`isArchived\`。时间优先级：日志 lastActivity > 元数据 lastActivityAt > createdAt（epoch 毫秒转 ISO）。`,
    special: [
      'audit.jsonl 从日志目录向上逐级查找',
      '标题 = metadata.title（"New session" 视为空）> initialMessage > 日志首条用户消息',
      'cwd / 项目路径取 userSelectedFolders 首个非空项；模型列表取自消息并排除 <synthetic>，最后一个为当前模型',
    ],
    source: 'lib/platforms/claude-desktop.js',
  },

  // ------------------------------------------------------------------- hermes
  {
    id: 'hermes',
    label: 'Hermes',
    tagline: '唯一的单 SQLite 库平台，会话级 usage 最完整',
    defaultDir: '~/.hermes（HERMES_DIR）',
    storageKind: 'SQLite · 全部会话集中一个 state.db',
    subagents: 'delegate_task 派生，parent_session_id 关联',
    resume: '按 id 直查；ended_at 判定归档',
    dirTree: `~/.hermes/
└── state.db   # 表：sessions、messages、messages_fts (FTS5)`,
    fileFormat: `单个 SQLite 库（better-sqlite3 只读打开；SSE watch 时另开连接并设 WAL pragma）。两张核心表：

- **sessions** — id / source / user_id / model / title / started_at / ended_at / message_count / tool_call_count / 6 个 token 字段（input / output / cache_read / cache_write / reasoning / estimated_cost_usd / actual_cost_usd）/ parent_session_id
- **messages** — id / session_id / role / content / timestamp / tool_calls / tool_call_id / tool_name / token_count / reasoning

role 枚举 **user / assistant / tool**（归一化 tool → toolResult，system 等透传）。工具调用：assistant 行 \`tool_calls\` JSON（OpenAI 风格），arguments parse 失败存 \`{_raw}\`，与 tool 行经 tool_call_id 配对。时间戳为 unix 秒（×1000 转 ISO）；消息级 usage 仅 token_count → total_tokens，会话级 6 个 token 字段 + 成本都在 sessions 表。`,
    messageSchema: '消息额外携带 reasoning 字段；成本取 actual_cost_usd 优先、estimated 兜底。',
    agentDesign: `派生 = **delegate_task 工具调用**（spawnCount 按其出现次数统计）；子代理经 \`sessions.parent_session_id\` 关联父会话。agent 身份用 \`source\` 列（OpenClaw spawn 树即以 source 作 agent 名并入）。`,
    lifecycle: `ended_at 为空 = 活跃，有值 = 归档。lastActivity = MAX(messages.timestamp)，无消息则用 ended_at。续跑按 id 直查。`,
    special: [
      '全文检索优先 FTS5（messages_fts JOIN messages），异常回退 LIKE，摘录匹配点前 40 / 后 60 字符',
      'usage 聚合直读 sessions 表，避免逐条重建会话',
      'state.db 不存在时静默返回空列表',
    ],
    source: 'lib/platforms/hermes.js',
  },

  // ---------------------------------------------------------------------- omp
  {
    id: 'omp',
    label: 'OMP',
    tagline: 'cwd-slug 两层目录，assistant 记录扇出为三类消息',
    defaultDir: '~/.omp/agent/sessions（OMP_DIR）',
    storageKind: 'JSONL · cwd-slug 目录 + 同名子代理目录',
    subagents: '同名目录约定（<AgentName>.jsonl），无父子字段',
    resume: '按文件名尾缀 _<sessionId> 反查',
    dirTree: `~/.omp/agent/sessions/
└── <cwd-slug>/
    ├── 2026-07-27T09-38-24-417Z_<uuid>.jsonl   # 主会话
    └── 2026-07-27T09-38-24-417Z_<uuid>/        # 同名目录 = 子代理容器
        └── <AgentName>.jsonl`,
    fileFormat: `JSONL 单文件、两层目录。文件名 \`<时间戳(冒号改连字符)>_<uuid>.jsonl\`，session id = 首个 \`_\` 之后。记录类型：

- **session** — id / cwd / timestamp / version
- **title / title_change** 与 **model_change** — 标题与模型切换
- **message** — role 为 **user / assistant / toolResult**；assistant content 部件为 \`thinking | text | toolCall\`

归一化时一条 assistant 记录**扇出为 reasoning / assistant / toolCall 三类消息**（codex 式）；toolResult 经 toolCallId / toolName / details / isError 配对。usage 取 assistant 的 \`msg.usage\`；模型由 model_change 与 message.model 跟踪；时间戳 ISO。custom / custom_message / ttsr_injection / thinking_level_change 等类型忽略。`,
    messageSchema: '用户 prompt 过滤：attribution 非 user、文本以 `<` 开头（如 `<system-notice>`）、空内容。',
    agentDesign: `**无显式父子字段**，子代理放在与主文件同名（去 .jsonl）目录下的 \`<AgentName>.jsonl\`，解析器按此目录约定定位；子代理与父会话的链接由上层（spawn 视图）计算。`,
    lifecycle: `id 首选 session 记录、回退文件名。无归档机制、无 status 字段；查找 = 扫描全部 slug 目录按文件名尾缀匹配。标题回退首条用户消息。`,
    special: ['列表不做 archived 过滤；其余噪声过滤见消息 schema 一节'],
    source: 'lib/platforms/omp.js',
  },

  // ---------------------------------------------------------------------- dsh
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    tagline: '事件信封 + 多帧 zstd，子代理是独立会话目录',
    defaultDir: '~/.dsh/sessions（DSH_DIR 优先，其次 DSH_HOME/sessions）',
    storageKind: 'JSONL 事件流 · 支持 zstd 多帧压缩',
    subagents: '独立会话目录，header.origin = subagent',
    resume: '版本化文件并存，取最高版本；v1–v3 需先迁移',
    dirTree: `~/.dsh/sessions/<projectKey>/<sessionId>/
├─ session.jsonl            # v0
├─ session.vN.jsonl         # vN (N ≥ 1)
└─ session[.vN].jsonl.zstd  # zstd 压缩版

# 迁移期间同目录可并存多代文件：
# 取最高版本、同版本 zstd 优先，每会话只读一个`,
    fileFormat: `JSONL 事件流。首行 header \`{type:'session', version:0|4, id, createdAt, cwd, origin…}\`，其后为信封 \`{type, seq, time, data, surfaceOp?}\` 或 packed chunk 行（text / reasoning / tool-call-chunks）。

压缩文件是**多帧 zstd 拼接**（header 一帧 + 每批追加一帧）——Node 原生只解首帧，因此解析器自实现 RFC8878 帧边界扫描逐帧解压，尾部残帧容忍丢弃；超过 64MB 拒读并报 413。

事件 type：\`user/message\`、\`assistant/message\`、\`tool/call\`、\`tool/result\`、\`turn/end\`、\`session/title\`、\`subagent/descriptor\`、\`request/context\`、\`job/registered|settled\`、\`approval/asked|decided\`、\`llm/retry\`。时间戳 time 为 epoch 毫秒 → ISO。

assistant/message 携带 content blocks（reasoning / text / tool-call）+ \`source.model / provider\` + usage（inputTokens / outputTokens / cacheReadTokens / reasoningTokens）。content 内的 tool-call 块故意跳过，由独立 \`tool/call\`（callId / name / arguments）渲染；\`tool/result\` 经 callId → name Map 配对工具名，v4 在 \`message.toolCallId\` / \`message.isError\`，v0 在嵌套 tool-result 块。\`turn/end\` 的 reason.kind ≠ completed 转为 error 消息。`,
    messageSchema: '上下文占用 = 最后请求 input + cacheRead，上下文窗口取 request/context.contextWindow。',
    agentDesign: `**子代理 = 独立的会话目录**，header 带 \`origin:'subagent'\`、\`parentSession\`（父 id）、\`delegationDepth\`、\`isSeeded\`、\`agentPreset\`；\`subagent/descriptor\` 事件提供 agentLabel / agentType（provider | mode）。子会话按 \`parentSession === 父 id\` 聚合，root 会话显示 childCount（列表 🌳 chip）。`,
    lifecycle: `仅支持 **v0 / v4**：v1–v3 报「请在 DeepSeek Harness 中打开以迁移到 v4」，> v4 报「请升级 AgentXRay」；文件名版本与 header 版本不一致报 DSH_FORMAT_MISMATCH。会话压缩（compaction）由 \`surfaceOp:{op:'replace'}\` 表达：v4 掩蔽闭区间 seq [startSeq, endSeq]，v0 掩蔽 surface index [start, end) 并复用首个槽位。会话 id 取 header.id。`,
    special: [
      'user/message 的 source.kind 白名单 {user, agent-message, subagent-settled, compact-checkpoint}，其余机注上下文（如 skill 目录，可超 12k 字符）折叠为可展开的 role:context 区块，且不参与 compaction 掩蔽',
      '< 开头的用户文本不算真实 prompt；标题 fallback 让位于首条真实 prompt',
    ],
    source: 'lib/platforms/dsh.js',
  },

  // ------------------------------------------------------------------- gemini
  {
    id: 'gemini',
    label: 'Gemini CLI',
    tagline: 'projectHash 目录 + /rewind 折叠算法',
    defaultDir: '~/.gemini/tmp（GEMINI_DIR）',
    storageKind: 'JSONL · 首行 metadata + 消息行',
    subagents: 'chats/<parentSessionId>/ 子目录，顶层列表天然跳过',
    resume: '/rewind 与 $set 以折叠算法重放',
    dirTree: `~/.gemini/tmp/<projectHash>/chats/
├─ session-<YYYY-MM-DDTHH-mm>-<id8>.jsonl   # 主会话
└─ <parentSessionId>/<id>.jsonl             # 子代理（嵌套一层）`,
    fileFormat: `JSONL、一文件一会话。首行 metadata \`{sessionId, projectHash, startTime, lastUpdated, kind…}\`，其后每消息一行 \`{id, timestamp, type, content…}\`；极旧格式为单行 JSON 带 \`messages[]\`。

type 枚举 **user / gemini / error**（info / warning 是 CLI chrome，丢弃）。\`gemini\` 记录内联 \`toolCalls[]\`（id / name / args / result / status）、\`thoughts[]\`、\`tokens\`、\`model\`。归一化扇出（codex 式）：thoughts → reasoning、content → assistant、每个 call 拆 toolCall + toolResult（结果内联于 call.result；status='error' 置 isError，cancelled 也生成错误 result）。tokens 字段 input / output / cached / thoughts → input / output / cacheRead / reasoning。时间戳字符串原样传递。`,
    messageSchema: '用户 prompt 过滤以 /、@、< 开头的斜杠命令与噪音。',
    agentDesign: `子代理转录位于 \`chats/<parentSessionId>/<id>.jsonl\`；顶层列表只扫 chats/ 下直接匹配 \`session-*.jsonl\` 的文件，天然跳过子代理。`,
    lifecycle: `折叠算法处理三类特殊记录：\`{$rewindTo:<id>}\`（/rewind：删除该消息及其后全部，找不到则清空）；\`{$set:{…}}\`（元数据合并更新，\`$set.messages\` 作为 checkpoint 整体替换历史）；同 id 重写即覆盖并移到末尾。文件名只含 id 前 8 字符且 resume 后 metadata sessionId 可能重写而文件名不变，故查找为两段式：文件名 → metadata 行 → 全量解析。标题 = metadata.summary > 首条真实 prompt；cwd 取 directories[0]。`,
    special: ['极旧单行 JSON 格式兼容；info/warning 行直接丢弃'],
    source: 'lib/platforms/gemini.js',
  },

  // ------------------------------------------------------------------- cursor
  {
    id: 'cursor',
    label: 'Cursor',
    tagline: '无时间戳的转写，路径即身份',
    defaultDir: '~/.cursor/projects（CURSOR_DIR）',
    storageKind: 'JSONL · 每会话一目录一文件',
    subagents: 'subagents/ 转写刻意排除（身份可能是复用 id）',
    resume: '无归档/续跑逻辑，实时读文件',
    dirTree: `~/.cursor/projects/
└── <project-slug>/                  # 如 -Users-me-repo
    └── agent-transcripts/
        └── <session-uuid>/
            ├── <session-uuid>.jsonl  # 主转写
            └── subagents/*.jsonl     # 子代理转写（不采集）`,
    fileFormat: `JSONL 单文件，每行一个 JSON 对象；session id = 文件名去 \`.jsonl\`。行记录为 \`{role:'user'|'assistant', message:{content:[块]}}\` 或 \`{type:'turn_ended',…}\`；块为 \`{type:'text', text}\` 与 \`{type:'tool_use', name, input, id}\`。assistant 记录内的 tool_use 展开为独立 toolCall 消息。

**只记调用、从无工具结果**（toolResultCount 恒 0）。无 usage / token / model / cwd 字段。**记录不带时间戳**，timestamp / lastActivity 取文件 mtime。`,
    messageSchema: '人类提问包在 `<user_query>…</user_query>` 内，标签外是 harness 注入上下文，提取标题时剥离。',
    agentDesign: `只解析主转写；子代理转写在会话目录 \`subagents/\` 下且**刻意排除**——数量约为主转写 5 倍、且可能复用父会话 id，**转写路径才是身份，不是 id**。无 spawn / 父子链解析。`,
    lifecycle: `id 即目录 / 文件 UUID；无归档与续跑逻辑，每次实时读文件。容错解析：尾部撕裂行 / 坏 JSON / 未知类型跳过。`,
    special: ['project-slug（如 -Users-me-repo）反解码为路径展示', '元数据走 mtime 缓存 + in-flight 去重'],
    source: 'lib/platforms/cursor.js',
  },

  // ------------------------------------------------------------------- doubao
  {
    id: 'doubao',
    label: 'Doubao',
    tagline: 'trajectory.jsonl + IndexedDB 双数据源合并',
    defaultDir: '~/Library/Application Support/Doubao/Profile 2/.doubao/agent_mode/workspace/.sessions（DOUBAO_DIR）',
    storageKind: 'JSONL trajectory + IndexedDB(LevelDB) 双源',
    subagents: 'agents/<agentId> 目录，解析取第一个含 trajectory 的 agent',
    resume: '会话内容主体在宿主 IndexedDB，磁盘为历史副本',
    dirTree: `.doubao/agent_mode/workspace/.sessions/
└── <sessionId>/
    └── agents/<agentId>/
        └── system/trajectory.jsonl    # 会话轨迹

# IndexedDB 源（同 Profile）：
IndexedDB/chrome_doubao-chat_0.indexeddb.leveldb
# 解析缓存（sha1 隔离不同 Profile）：
~/.agentxray/cache/doubao-<hash8>.sqlite`,
    fileFormat: `**双数据源**：

1. **trajectory.jsonl** — 每行一条 OpenAI 式 chat 记录
2. **豆包 IndexedDB（LevelDB）** — 经 Python 脚本 + dfindexeddb 导出为 SQLite（schema_version=3，表 sessions / messages / projects / meta，含 FTS5 \`messages_fts\`）；缺解析器时用 uv 自动安装；源本身是 .sqlite 时直接透传

role 为 **user / assistant / tool**。assistant 带 \`tool_calls[{id, function:{name, arguments}}]\`，arguments 为字符串时尝试 JSON.parse；tool 行 → toolResult，按 tool_call_id 配对。

**记录无逐条时间戳**：解析器合成时间轴——assistant 时长按输出 ~30 字/秒（≥500ms）+ 工具时长累计，偏移使末条等于文件 mtime。无真实 usage：token 按字符数/3 估算，assistant 记 output、其余记 input。trajectory 无 model；缓存侧取消息 model 去重、provider='doubao'。`,
    messageSchema:
      '剥离豆包注入的 14 类标签（system-reminder / environment_context / attachments 等）；tool 结果按 content_json 的 is_error / status / 文本标记判错。',
    agentDesign: `一个 session 下多个 agent（主 + 子代理），身份即 \`agents/<agentId>\` 目录名；解析只取**第一个**含 trajectory.jsonl 的 agent；spawnCount 恒 0；sessionId 取路径中 \`.sessions/<sessionId>\` 段。`,
    lifecycle: `会话 = 目录。IndexedDB 侧有 created_at / updated_at / title / project。列表合并两源（计数取 max、标 \`dataSource: indexeddb | trajectory | indexeddb+trajectory\`），详情按去噪 merge key 去重合并后按时间排序。缓存刷新节流 2s，源签名取 CURRENT / LOG / ldb 的 size+mtime。无归档。`,
    special: ['merge key 必须基于去噪文本，否则双源去重失败、出现重复「用户实际输入」', 'FTS5 搜索失败回退内存搜索'],
    source: 'lib/platforms/doubao.js · doubao-store.js',
  },

  // ---------------------------------------------------------------- workbuddy
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    tagline: '与 Claude Code 同构的 JSONL，epoch 毫秒时间戳',
    defaultDir: '~/.workbuddy/projects（WORKBUDDY_DIR）',
    storageKind: 'JSONL · 项目 slug 目录制',
    subagents: '<sessionId>/subagents/agent-*.jsonl，无父子链',
    resume: '文件名前缀/后缀匹配查找',
    dirTree: `~/.workbuddy/projects/
└── <project-slug>/
    ├── <sessionId>.jsonl                    # 主会话
    ├── <sessionId>/subagents/agent-*.jsonl  # 子代理
    └── <sessionId>.file-rollback.ndjson     # 非会话文件，跳过`,
    fileFormat: `JSONL 单文件，布局与 Claude Code 同构。sessionId = 文件名去 \`.jsonl\`。记录 type 枚举：

- **session-meta** — \`{sessionId, timestamp}\`
- **message** — \`{role: user|assistant, content:[{type: input_text|output_text, text}], status}\`
- **reasoning** — \`{content | rawContent:[{type: reasoning_text, text}]}\`
- **function_call** — \`{callId, name, arguments(JSON 字符串)}\`
- **function_call_result** — \`{callId, name, status, output:{type:'text', text}}\`
- **ai-title** — \`{aiTitle}\`

file-history-snapshot / credit-usage / resend-fork-notice（重发/分叉通知）忽略。**时间戳为 epoch 毫秒数**，归一化统一转 ISO。工具按 callId 配对，\`status !== 'completed'\` 记 isError。无 usage / token 字段；model 取 \`providerData.model\`。`,
    messageSchema: 'content 兼容纯字符串与块数组；function_call 的 arguments 解析失败回退 {raw}。',
    agentDesign: `主会话与子代理分置两处（主为 \`<slug>/<id>.jsonl\`，子代理为 \`<slug>/<id>/subagents/agent-*.jsonl\`），采集与查找均覆盖子代理；agent 身份即转写文件名，解析器不建 spawn 父子链。`,
    lifecycle: `会话头来自 session-meta 记录，详情解析同时接受任意行首现的 sessionId / cwd / model。watch SSE tail 把 session-meta 当 session 帧、其余行走同一归一化。无归档逻辑。标题优先 ai-title，回退首条用户提问。`,
    special: [
      'user 消息内嵌 <system-reminder data-role="user-context">（user_info / workspace / skills 清单）整块剥离，<user_query> 包装标签同样剥掉',
      '目录解析经 resolveDir 校验（绝对路径、无 ..、在 HOME 内）',
    ],
    source: 'lib/platforms/workbuddy.js',
  },

  // --------------------------------------------------------------------- trae
  {
    id: 'trae',
    label: 'Trae CN',
    tagline: 'Codex fork 的 rollout 格式，event_msg 流为主',
    defaultDir: '~/.trae/cli/sessions（TRAE_DIR）',
    storageKind: 'JSONL rollout · 日期分层目录',
    subagents: 'parent_thread_id 关联，枚举含归档目录',
    resume: '同 Codex：文件名 fast-path + 全量回退',
    dirTree: `~/.trae/cli/sessions/
├── <YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
└── archived_sessions/                    # 归档（同 id 时 active 优先）`,
    fileFormat: `trae-cli 是 **Codex fork**，rollout 格式与 \`~/.codex/sessions\` 同构：\`session_meta\` / \`response_item\` / \`event_msg\` / \`turn_context\`；枚举与查找复用 codex 解析器（归档在 baseDir/archived_sessions）。session id 缺省取文件名去 \`.jsonl\`。

\`session_meta.payload\`：id / timestamp / cwd / model_provider / originator / parent_thread_id / cli_version / model_catalog_snapshot.default_model。\`turn_context.payload.model\` 支持中途切模型。

本机版本（0.202.x-tob）对话活动在 **event_msg 流**：payload.type 有 \`user_message\` / \`agent_message\` / \`agent_reasoning_raw_content\` / \`agent_reasoning_section_break\` / \`item_completed\` / \`item_started\` / \`token_count\`——小会话可能完全没有 response_item。工具走 item_completed 的 item.type \`function_call\` / \`custom_tool_call\`（call_id / name / arguments）与 \`*_call_output\` → toolResult。\`token_count\` → total_token_usage + model_context_window。时间戳字符串。response_item 走 codex 归一化。`,
    messageSchema:
      'item_completed 里的 UserMessage / AgentMessage 跳过防重复计数；user_message 才算真实 prompt、agent_message 为最终回答；标题 = 首条 prompt 前 120 字。',
    agentDesign: `父子经 \`session_meta.parent_thread_id\` 关联（parentThreadId）；列表 includeChildren=true 全收并按 meta.id 去重，archived 让位 active。`,
    lifecycle: `查找 / 归档语义同 Codex（fast-path 文件名定位 + 全量回退）。`,
    special: [
      'Trae CN IDE 的 AI 会话库是加密 DB（ModularData/ai-agent/database.db，非明文 SQLite），不做监控——仅覆盖 CLI',
    ],
    source: 'lib/platforms/trae.js',
  },
];
