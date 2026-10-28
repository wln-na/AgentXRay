# DeepSeek Harness v4 会话支持：需求与方案设计

- 日期：2026-10-28
- 状态：P0/P1/P2 已实现，待发布
- 范围：`lib/platforms/dsh.js`、`lib/platforms/index.js` 及其下游读取链
- 结论：这是 dsh 平台的格式升级适配，不是新增一个 DeepSeek 应用平台

## 一句话结论

本机 DeepSeek Harness 已经把会话写成 `~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd`，AgentXRay 的 dsh 适配器仍在找 `session.jsonl[.zstd]`，并且只接受 `header.version === 0`。于是列表返回空数组，平台页签被前端当成“没有会话”折叠掉。修复要同时处理文件名发现、版本分派，以及 v4 在工具结果、压缩区间、注入消息、标题上的语义差异。

## 已确认决策

以下决策在 2026-10-28 评审中确认，后续实现按这里执行：

| 事项 | 决策 |
|---|---|
| 未知版本 v5 | 列表保留该会话并带可读错误；详情返回 422 |
| v1 到 v3 | 不支持，不尽力解析；列表保留错误提示，详情 422，提示在 DSH 中打开以迁移到 v4 |
| 本期范围 | P0/P1/P2 已实现 |
| API 契约 | 接受 422 作为“版本不支持/版本不一致”的状态码 |
| 性能上限 | 压缩日志超过 64 MB 时详情返回 413，并提示用导出或分段查看 |
| 发布方式 | 跟随下一个 patch release，功能提交不改版本号 |
| 子代理展示 | P0 保留全部会话并加 `subagent` badge；P1 已改为主列表只显示根会话，父会话带 `childCount` 与 chip，`?include_subagents=1` 返回全部 |
| 注入消息展示 | P0 默认过滤；P1 已改为详情 `contextMessages` + 前端默认折叠、按 kind 分组的系统上下文区块 |
| 实现边界 | P0 修格式；P1 做根会话列表、子代理 chip、注入折叠、上下文卡、turn/end 错误摘要；P2 做上下文重建、任务时间线、diff 视图、启动 DSH 应用 |

## 现象与复现

用户在 AgentXRay 里看不到 DeepSeek Harness。整个页签被折叠了，连“列表为空”的状态都看不到。前端探测每个平台的会话数，数量为 0 且当前未选中时隐藏该页签（`frontend/src/hooks/usePlatformProbe.ts:18-35`、`frontend/src/components/PlatformBar.tsx:47-49`）。所以“没有内容”和“没有入口”是同一个问题的两个表现。

下面三条命令可以直接复现，不需要启动服务：

```bash
node -e "const {listDshSessions}=require('./lib/platforms/dsh'); listDshSessions().then(s=>console.log(s.length))"
# 0

find ~/.dsh/sessions -type f -name 'session*.jsonl*' | wc -l
# 12

find ~/.dsh/sessions -type f -name 'session*.jsonl*' -exec basename {} \; | sort | uniq -c
# 12 session.v4.jsonl.zstd
```

真实 header 长这样：

```json
{"type":"session","version":4,"id":"session-094d51ad-01e6-4134-b333-6a281c00607b","createdAt":1793176279062,"cwd":"/Users/linda/Projects/aicode_library/AgentXRay","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

子代理会话多两个字段：

```json
{"type":"session","version":4,"id":"2ed40345-2a89-4534-aeb1-3f5001dd9fc9","createdAt":1793176616125,"cwd":"/Users/linda/Projects/aicode_library/AgentXRay","parentSession":"session-094d51ad-01e6-4134-b333-6a281c00607b","isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```

## 根因

### 文件名门

适配器用精确字符串匹配两个文件名：

- `lib/platforms/dsh.js:136` 的 `findDshSessionFile`
- `lib/platforms/dsh.js:457` 的 `listDshSessions`
- `lib/platforms/index.js:336` 的 dsh `collectFiles`

真实文件叫 `session.v4.jsonl.zstd`，三处都匹配不到。`listDshSessions` 会静默跳过该目录，`findDshSessionFile` 返回 `null`。详情、定位、打开、watch 全部依赖 `find`，所以一起失效。

### 版本门

`lib/platforms/dsh.js:26` 把 `SESSION_FORMAT_VERSION` 写成 `0`，`parseDshHeader` 在 `:122-127` 对任何非 0 版本直接抛错。即便文件名匹配上了，列表会带一条 `error`，详情会 500。当前的文件名门在前面，所以实际表现是连这条错误都看不到。

### v4 语义差异

只放开文件名和版本号，列表能出来，但详情仍有几处会读错。这些差异来自 DSH 自己的格式定义，不是猜测：

| 差异 | v0 现有假设 | v4 实际 | 影响 |
|---|---|---|---|
| 压缩区间 | `surfaceOp {op:'replace', start, end}`，按 surface 下标、end 开区间 | `{op:'replace', startSeq, endSeq}`，按事件 seq、闭区间 | 压缩后的旧消息不会被屏蔽，摘要和旧内容重复；`surfaceCount` 还可能被写成 `NaN` |
| 工具结果错误 | `data.error` 或 `tool-result` 块的 `isError` | 错误标记在 `data.message.isError`，文本块已经是扁平结构 | 401、被中断的调用会显示成成功 |
| 用户消息 | 所有 `user/message` 都当用户气泡 | `source.kind` 有 `user`、`runtime-context`、`time-context`、`skill-catalog`、`agent-instructions`、`working-directory`、`model-selection`、`user-approval`、`agent-message`、`subagent-settled`、`tool-jobs` 等 | 一个会话里 1 条真人消息可能配 5 条注入，单条 skill catalog 可到 1.2 万字符，详情页会被系统上下文淹没 |
| 标题 | 首条用户消息 | `session/title` 事件，可能有 fallback 和 provider 两条 | 列表标题质量差，且与 DSH 应用里看到的不一致 |
| 子代理 | 无 | header 带 `parentSession`、`origin:'subagent'`、`delegationDepth` | 修好后 12 条里会多出 6 条左右的子代理会话，列表变吵 |

### 已经兼容、不用改的部分

这些结论来自源码和真实数据，能避免把改动面放大：

- **多帧 zstd**：`scanZstdFrames` 和 `decompressDshLog` 已经处理拼接帧，实测单文件 77 到 132 帧都能完整解出，torn 尾帧也有容忍。
- **备份**：`lib/backup.js:185` 按 `.jsonl` / `.jsonl.zstd` 后缀递归拷贝，`session.v4.jsonl.zstd` 已经会被备份。
- **搜索枚举**：`lib/search.js:461-523` 通过 `collectFiles` 和 `readDshSessionLines` 读取，修好 `collectFiles` 后自动生效。
- **提示词提取**：`extractDshUserPromptText` 已经按 `source.kind === 'user'` 过滤，标题和 prompt 列表没有被注入消息污染。
- **定位/打开**：`DSH_DIR` 在 `lib/open-session.js:47-60` 的白名单里，v4 文件名不影响路径校验。
- **前端**：平台 key、显示名、设置项、能力矩阵都已存在，后端返回数据后页签会自动出现，不需要新增平台或改路由。

## 这是修 dsh，不是新增平台

dsh 平台在 2026-08-19 就已接入（提交 `6f26216`），registry、`/api/dsh/*`、设置项、capabilities、README、测试都在。v4 与原格式共用同一个目录根、同一套 header 加事件信封、同一批事件名。DSH 应用自身也把 v0 到 v3 作为历史代读取，当前写入代是 v4。desktop 和 web 只是 `~/.dsh/profiles` 下的运行形态，会话根是同一份 `~/.dsh/sessions`。拆成两个平台会重复同一批会话，也会让 API、设置项、README 多出一套没有数据支撑的入口。

因此对外口径保持不变：

- 平台 key：`dsh`
- 显示名：`DeepSeek Harness`
- 默认目录：`~/.dsh/sessions`，继续兼容 `DSH_HOME` 和 `DSH_DIR`
- API：`/api/dsh/sessions`、`/api/dsh/sessions/:id`
- 能力矩阵：`spawn` 已打开（子代理 chip/详情）；`context` 仍为 false（完整上下文重建未做），上下文占用走 `contextUsage` 卡

## 需求分层

### P0：不做就等于没修

1. 列表能发现 v4 会话，按 `createdAt` 倒序返回，字段与 v0 同形。
2. 详情能读出 user、assistant、reasoning、toolCall、toolResult，工具按 `callId` 配对。
3. v4 的 `message.isError` 能标出失败的工具结果。
4. v4 的 `surfaceOp {startSeq,endSeq}` 能正确屏蔽被压缩的消息，摘要只出现一次。
5. 注入消息不进入默认对话流，`userCount` 不把系统上下文算成用户发言。
6. 标题优先用 `session/title`，没有时回退首条真人 prompt。
7. 搜索、提示词、用量、备份、watch、定位/打开在 v4 会话上可用。
8. v0 fixture 和现有 15 个 dsh 测试继续通过。
9. 未知版本 v5 和 v1 到 v3 不让整页 500：列表保留一条带错误的会话，详情返回 422。
10. 压缩日志超过 64 MB 时详情返回 413，并给出可读提示。
11. 子代理会话先保留在列表里，带 `origin`、`parentSession`、`delegationDepth` 和 `subagent` badge。P1 已改为默认只显示根会话，子代理挂在父会话的 chip 下；`?include_subagents=1` 可返回全部。

### P1：已实现

1. 子代理改成父子分组：主列表默认只显示根会话，父会话带 `childCount` 和 🌳 chip，通过 children API 查看直接子代理。
2. 注入消息从“默认过滤”升级为详情里的 `contextMessages`，前端渲染成默认折叠、按 sourceKind 分组的系统上下文区块。
3. `turn/end` 的 `reason.error.message` 已拼进错误摘要。
4. `spawn` 能力已打开，做直接子代理的 chip 和详情；`contextUsage` 卡已做。context 重建和任务时间线已在 P2 实现；更深层父子树（孙代理逐层返回）仍是后续工作。
5. 聚合缓存说明已写入测试计划：升级后重启或等 TTL（insights/prompts 60 秒，tool-audit/usage 5 分钟）。

### P2：已实现

- `subagent/descriptor` 标签已解析进元数据 `agentLabel`/`agentType`，children API 的 `description` 优先用 descriptor 标签而非 prompt；任务/审批/重试时间线已在详情 `activityEvents` 中提供。
- 上下文重建 `buildDshContext` 已实现（system/message、request/header 工具定义、request/context、developer 工具变更 + 主消息链）；dsh 的 `context` 能力已打开，ContextPanel 可用。
- `job/*`、`approval/*`、`llm/retry*` 已通过 `activityEvents` 进入前端 `DshActivityPanel`（messages 和 trace 视图均渲染，默认折叠）。
- 工具 `data.meta.diffs` 已通过 `details.diffs` 暴露，前端 `DshDiffView` 在工具结果下方渲染行级对比。
- “打开”从默认编辑器改成启动 DeepSeek Harness 应用。

### 明确不做

- 写回会话、续跑、修改 DSH 数据。
- 把 `~/.dsh/storages/session_projcache` 当主数据源。它是派生缓存，可能落后于日志，只适合做可选加速。
- 新增 `/api/deepseek/...` 别名，或把 dsh-desktop 拆成第二个平台。

## 方案对比

| 方案 | 做法 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| A. 最小补丁 | 只改文件名正则和版本判断 | 半小时内能让列表出数据 | 注入消息、压缩、错误标记、标题仍然错；下次换版本还要再改 | 线上救急 |
| B. 版本感知适配层 | 把“发现、版本分派、归一化”收敛进 dsh 适配器，下游复用 | 一次修干净；v0 保持兼容；未来 v5 至少能发现并报错；测试可覆盖 | 要动约两个源文件，补一套 v4 fixture 和用例 | 推荐 |
| C. 复用 DSH 官方解析器 | 依赖 `@deepseek-ai/dsh-session-format`，或调 DSH 的导出接口 | 语义最准 | 包是 ESM、依赖重、版本耦合；导出接口需要 DSH 在运行并有鉴权，违背 local-first 的零接入前提 | 不推荐 |
| D. 只读 projcache | 从 `session_projcache` 拿标题和 token | 列表快 | 没有消息正文，缓存可能落后，目录不在会话根内 | 只能做旁路加速 |

推荐 B。A 可以作为热修，但不应该作为最终方案；C 和 D 都不解决“读消息正文”这个主问题。

## 详细设计

### 数据流

```
GET /api/dsh/sessions
  -> platform.list(DSH_DIR)
  -> listDshSessions
       -> 遍历 <root>/<project>/<session>/
       -> pickDshLogFile(目录项)        取版本最高的 canonical 文件
       -> parseDshSessionMetadata       按 mtime 缓存
            -> readDshSessionLines       多帧 zstd 解压
            -> parseDshHeader            版本分派
            -> 统计事件                  只把真人 user 计入 userCount
            -> 读取 session/title        生成标题
  -> 按 createdAt 倒序

GET /api/dsh/sessions/:id
  -> findDshSessionFile                同样走 pickDshLogFile
  -> parseDshSessionFile
       -> header
       -> normalizeDshEvents(lines, version)
            -> user/assistant/tool 归一化
            -> 按 seq 或旧下标处理 replace
            -> 过滤注入消息
       -> withStats
```

### 文件发现与代际选择

DSH 的 canonical 文件名由格式版本决定：

- v0：`session.jsonl` 或 `session.jsonl.zstd`
- v1 及以上：`session.vN.jsonl` 或 `session.vN.jsonl.zstd`，N 是不带前导零的正整数

正则只认这一种形状：

```js
const DSH_LOG_RE = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/;
```

`session.v0.jsonl`、`session.v04.jsonl`、大写 `V4`、`session.migration.*.tmp`、`session.lock` 都不算 canonical。DSH 的迁移临时文件会在发布前改名，读取方不应该碰。

选择规则与 DSH 自身一致：一个 session 目录里如果有多个代际文件，取版本号最大的那个，不合并、不重复列。迁移只发布新代，不删除源文件，所以 v0 与 v4 并存是正常状态。列表、`find`、`collectFiles`、watch 必须用同一个选择函数，否则会出现“列表有、点开 404”或者“搜索和用量把同一会话算两遍”。

同一版本出现两个文件（例如明文和 zstd 各一份）在 DSH 里属于编码不一致，正常不会发生。适配器可以取 mtime 较新的一个，并在元数据里留一条 warning；不要两份都读。

`sessionId` 仍以 header 的 `id` 为准，目录名只作回退。DSH 用 `encodeSegment` 处理特殊字符，正常 UUID 和 `session-<uuid>` 目录名与 id 一致。若未来出现不一致，`find` 需要回扫目录并读 header，不能只按目录名拼路径。

### 版本分派

把“支持哪些版本”和“文件叫什么”分开：

```js
const SUPPORTED_VERSIONS = new Set([0, 4]);   // 有 fixture、有测试
const CURRENT_MAX = 4;
```

- v0：现有归一化路径，保留全部旧测试。
- v4：新归一化路径，处理工具结果、压缩区间、注入消息。
- v1 到 v3：不支持。列表保留 header-only 的会话，带 `unsupported: true` 和错误提示“该会话是 vN，请在 DeepSeek Harness 中打开以迁移到 v4”；详情返回 422。不做尽力解析，避免用错 schema 产出看似正常、实际错误的内容。
- 大于 4：同样不硬解。列表保留 header-only 的会话，带 `unsupported: true` 和错误提示“需要升级 AgentXRay”；详情返回 422。

这样 v5 或旧代际来了，至少能看见“有会话，但当前版本读不了”，不会整页空白或整页 500。

文件名版本与 header 版本必须一致。不一致按损坏处理，列表带错误，详情拒绝解析。DSH 自己也会做这个校验，跟着做可以避免用错 schema。

### 市面通用做法与 P0 取舍

这两个展示问题没有唯一标准，但同类产品的默认行为比较一致。

**子代理会话：默认不铺在主列表，挂在父会话下面。**

- OpenAI Agents SDK 的 span 带 `parent_id`，默认嵌套在最近的当前 span 下（[Tracing](https://openai.github.io/openai-agents-python/tracing/)）。
- LangSmith 的 child run 需要 `parent_run_id` 才会在 UI 里嵌套；缺失时会被当成独立 run（[Troubleshoot trace nesting](https://docs.langchain.com/langsmith/nest-traces)）。
- Langfuse 的 agent graph 默认用 Aggregated 视图，把重复步骤收成一个带计数的节点，需要时再切到 Expanded 看逐次调用（[Agent Graphs](https://langfuse.com/docs/observability/features/agent-graphs)）。
- 编码 Agent 的界面也类似：子代理通常表现为父会话里的一个 task/tool 调用或 chip，点开才看子会话。AgentXRay 自己对 Codex/OMP 就是 chip 加子会话跳转；Cursor 则明确排除子代理转写（`README.md:44`）。

所以市场默认是“父子关系 + 默认折叠”，不是把子代理当普通会话平铺。

**注入消息：和用户消息分开，默认折叠或隐藏。**

- system、developer、user、assistant、tool 是不同角色，聊天 UI 不会把 system prompt 画成用户气泡（[LangChain Messages](https://docs.langchain.com/oss/python/langchain/messages)）。
- 观测类产品把完整输入放在 trace 的 inputs/raw JSON 里，对话视图只展示可读回合；要看 system prompt 时展开具体 run。
- AgentXRay 已有先例：`isDisplayableMessage` 直接隐藏 developer 消息（`frontend/src/views/sessions/lib.ts:32-45`），Claude Code 的 `<system-reminder>` 被过滤，连续的用户上下文片段会被压缩（`frontend/src/views/sessions/lib.ts:256-294`）。

所以市场默认是“默认隐藏/折叠，需要时展开或看原始 JSON”，不是全量铺开。

**落到本期 P0：**

- 子代理：市场标准是嵌套。本期只做 P0，不做树，也不做过滤开关。折中方案是保留全部会话，在列表里给子代理加一个可见标识（`status: 'subagent'`，现有卡片会渲染这个 badge），同时返回 `parentSession` 和 `delegationDepth`，为 P1 的分组留数据。这样不会丢会话，也不会假装已经做了父子导航。
- 注入消息：按上面的白名单默认过滤，保留 `agent-message`、`subagent-settled`、`compact-checkpoint`。原始 JSON 和搜索仍然能看到这些内容；P1 再加“显示系统注入”的折叠区。

这两条如果按“市场标准”一步到位，就需要前端分组、子会话路由和开关，已经超出 P0。P0 先保证不丢数据、不误导，P1 再补交互。

### 归一化差异

#### 用户消息

v4 的 `user/message` 的 `data` 本身就是一条消息，字段是 `data.content`、`data.source`、`data.id`。现有代码读的就是这些，不存在“读不到用户输入”的问题；真正的问题是所有 kind 都被当成用户气泡。

建议维护一张显示白名单：

| source.kind | 默认展示 | 形式 |
|---|---|---|
| `user` | 是 | 普通用户气泡 |
| `agent-message` | 是 | 用户气泡，文本自带 “Agent … sent a message”，不额外加工 |
| `subagent-settled` | 是 | 用户气泡，作为子代理结束通知 |
| `compact-checkpoint` | 是 | 用户气泡或带“压缩摘要”标记，不能隐藏，否则压缩后旧消息没了、摘要也没了 |
| `runtime-context`、`time-context`、`skill-catalog`、`agent-instructions`、`working-directory`、`model-selection`、`user-approval`、`tool-jobs` | 否 | 默认过滤；后续可做“显示系统注入”开关 |

白名单比黑名单更可控，但未来出现新的有意义 kind 时会被漏掉。折中是维护一个“已知机器注入”黑名单，其余默认展示；风险是 v5 的新噪声会漏进来。本期 P0 用白名单，测试锁死已知 kind；P1 再加“显示系统注入”折叠区，把原始内容放出来。

`userCount` 只统计默认展示的用户消息，不再把 5 条注入算成 5 条用户发言。`firstUserMessage` 继续用 `extractDshUserPromptText`，只取 `kind === 'user'`。

#### 助手消息

`assistant/message` 的结构与 v0 同构：`data.message.content` 里有 `reasoning`、`text`、`tool-call`。工具调用仍以独立的 `tool/call` 事件为准，助手消息里的 `tool-call` 块不重复渲染，保持现有做法。

有些助手消息只有 reasoning 或只有 tool-call，没有 text。前端 `isDisplayableMessage` 会隐藏空助手气泡，但 reasoning 和 trace 仍然需要这条消息，所以适配器继续返回它，交给前端决定显示。

#### 工具结果

v4 的 `tool/result` 是扁平结构：

```json
{"type":"tool/result","data":{"message":{"role":"tool","source":{"kind":"tool","callId":"call_x"},"toolCallId":"call_x","isError":true,"content":[{"type":"text","text":"..."}]}}}
```

需要改三处：

1. `toolCallId` 优先取 `message.toolCallId`，回退 `message.source.callId`。
2. `isError` 取 `message.isError === true || Boolean(data.error) || 旧式 tool-result 块的 isError`。
3. 内容继续用 `flattenToolResultContent`，它已经支持扁平 text 块和旧式嵌套块。

`data.error` 存在时补 `details: { error, code }`。v4 的 `data.error` 和 `message.isError` 通常同时出现，但实测有 1 条只有 `message.isError`，所以不能只看 `data.error`。

#### 压缩区间

v4 的 `surfaceOp` 只有两种：

- `"append"`
- `{op:"replace", startSeq, endSeq}`，`startSeq` / `endSeq` 是事件 seq，闭区间，且都指向更早的事件

现有代码按 surface 下标和 `{start,end}` 处理，v4 会拿到 `undefined`，比较结果恒为 false，压缩完全失效。改法：

- 每个进入列表的 item 记录 `seq` 和（旧格式用的）`surfaceIndex`。
- 遇到 replace：
  - 有 `startSeq` / `endSeq` 时，按 `item.seq >= startSeq && item.seq <= endSeq` 标记 compacted。
  - 只有 `start` / `end` 时，按旧的 surface 下标 `>= start && < end` 处理，保证 v0 fixture 不回归。
- 不要把 replace 的 `start` 当 surface 下标去更新 `surfaceCount`，v4 没有这个概念。

v4 的 surface 类型包括 `system/message` 和 `developer/message`。适配器不展示这两类，但压缩区间可能覆盖它们。按 seq 标记时只标记实际进入列表的消息即可，不需要为系统消息维护下标。

实测这 12 个会话只有 3 条 replace，都是 `system/message` 替换上一条 system 节点。也就是说，压缩正文的场景目前没有真实样本，必须用合成 fixture 锁住，不能只看真实数据就认为没问题。

#### 标题

v4 有 `session/title` 事件：

```json
{"type":"session/title","data":{"title":"DeepSeek会话功能方案设计","messageSeqs":[16],"source":{"kind":"provider"}}}
```

同一个会话可能先有一条 `fallback` 标题，后面再有一条 `provider` 标题。取最后一条；若最后一条是 `fallback`，优先用首条真人 prompt，没有真人 prompt 时再用 fallback。这样既跟 DSH 应用一致，也避免子代理会话把 “You are in a clean,” 这种系统提示词当标题。

#### token 语义

这一节容易读反，单独说清楚。

v4 的 `assistant/message.data.usage` 字段是：

```json
{"inputTokens":4415,"outputTokens":565,"cacheReadTokens":8448,"totalTokens":13428}
```

- `inputTokens` 和 `outputTokens` 是这一步的增量。
- `cacheReadTokens` 是这一步请求命中的缓存输入量。它在一个 turn 内会随着前缀增长而变大，换 turn 时可能回落。
- `totalTokens` 是这一步的合计，满足 `totalTokens = inputTokens + cacheReadTokens + outputTokens`。

AgentXRay 现有做法是把每条助手消息的 input、output、cacheRead 分别累加。每一次助手请求都实际读取了当步 `cacheReadTokens` 那么多的缓存 token，所以按请求累加是有意义的，DSH 自己也这么算。以 `session-2800e5b0…` 为例，逐条求和得到 input 185,619、output 70,211、cacheRead 11,606,144，与 `~/.dsh/storages/session_projcache/sessions/session-2800e5b0….json` 里的 `totals` 完全对上。因此不需要把 cacheRead 改成“取最后一个值”或“取最大值”。

需要避免的是把 `totalTokens` 也累加。那样会把 cacheRead 再加一遍，得到大约两倍的量。现有代码没有用 `totalTokens`，保持不动即可。

这 12 个会话里没有出现 `reasoningTokens`。该字段在类型定义里是可选的，缺失时按 0 处理，不要拿 `totalTokens` 去凑。

#### turn/end

`turn/end` 的异常原因在 `data.reason.kind`，错误详情在 `data.reason.error.message`。现有代码只拼了 kind。P1 可以把 message 带进错误气泡，例如 `Turn 3 ended without completing: error — <message>`。

### 下游链路影响

| 模块 | 位置 | 处理 |
|---|---|---|
| 平台注册 | `lib/platforms/index.js:314-356` | dsh 条目的 `collectFiles` 改为调用新的发现函数，删掉重复的目录遍历 |
| 会话路由 | `lib/routes/sessions.js:158-190` | 列表/详情主链路复用；本期（P0）增加 `statusCode` → 422 的映射，让未知版本和版本不一致有可读状态码 |
| watch | `lib/watch.js:17-39`、`lib/routes/watch.js:386` | 不用改逻辑，`find` 修好后自动指向 v4；`.zstd` 后缀判断仍成立 |
| 搜索 | `lib/search.js:461-523` | 不用改，走 `collectFiles` 和 `readDshSessionLines` |
| 提示词 | `lib/prompts.js:122-149` | 不用改，已有真人过滤 |
| 用量 | `lib/usage.js:183-194`、`:384` | token 字段不用改，逐条求和与 DSH 一致；另修 session 去重 key，优先用 `sessionId`，否则所有 `session.v4.jsonl` 会被当成同一个会话 |
| insights | `lib/insights-scanner.js:279-320` | 修 `message.isError` 判定；用户消息计数只算展示的用户消息 |
| 工具审计 | `lib/tool-audit.js:132-160` | 修 `message.isError` 判定 |
| 备份 | `lib/backup.js:178-196` | 已兼容；可把后缀匹配收窄成 `DSH_LOG_RE`，防止未来误拷 |
| 定位/打开 | `lib/open-session.js:47-60`、`:465-505` | P2 已改为启动 DeepSeek Harness 应用，应用不可用回退默认编辑器 |
| 前端 | `PlatformBar.tsx`、`SettingsDialog.tsx`、`types.ts` | 不用改；列表有数据后页签自动出现 |

### 子代理

v4 用 header 表达父子关系：子会话 `origin:"subagent"`、`parentSession` 指向父 id、`delegationDepth:1`。子会话是独立目录、独立计费，不与父会话共用文件。

市场标准是挂在父会话下面、默认折叠。本期只做 P0，不做树，也不做过滤开关。元数据里加 `origin`、`parentSession`、`delegationDepth`，列表先保留全部会话，给子代理会话设 `status: 'subagent'`，现有卡片会渲染这个 badge。这样用户能看见它是什么，也不会丢内容。P1 再把主列表默认收敛到根会话，加“包含子代理”开关或父子分组；默认隐藏必须同时给入口，不要只在后端过滤。

### 错误处理

| 情况 | 列表 | 详情 |
|---|---|---|
| 目录不存在 / 无权限 | 返回 `[]`，服务端 warning | 404 |
| 文件名不 canonical | 忽略该文件 | 404 |
| 文件名版本与 header 不一致 | 返回带 `error` 的会话 | 422，说明版本不一致 |
| header 版本大于 4 | 返回 header-only 会话，`unsupported: true` | 422，提示升级 AgentXRay |
| header 版本 1 到 3 | 返回 header-only 会话，`unsupported: true` | 422，提示在 DSH 中打开并迁移到 v4 |
| 首帧损坏 / 空文件 | 返回带 `error` 的会话，时间排最后 | 422 或空消息 |
| 解压需要 zstd 但 Node 不支持 | 返回带 `error` 的会话 | 422，提示 Node ≥ 22.15 |

原则是“能看见、能解释”，不要静默丢会话。当前 `readdir` 失败被 catch 成 `[]`，用户分不清“真没有”和“没权限”，P1 可以把 EACCES/EPERM 作为 warning 冒泡到服务端日志。

### 性能与上限

实测数据：

- 12 个真实会话，压缩后约 2.3 MB，cold list 约 101 ms，warm list 约 1 ms。
- 687 KB 的会话详情约 31 ms。
- 50 MB 纯 JSONL 的元数据约 355 ms，详情约 609 ms，堆内存约 285 MB。
- 8 MB 压缩、约 130 万事件的合成文件，在 512 MB 堆下详情会 OOM。

现有实现会把整份日志解压成字符串，再切成行数组，再生成全量消息数组。会话数量不大时没问题，但不能假设永远不大。本期 P0 做一道明确保护：

1. 详情入口检查压缩文件大小，超过 64 MB 返回 413，并提示用导出或分段查看。64 MB 是评审确认的阈值，不再留“例如”。
2. 列表元数据仍然全量扫描，但依赖 mtime 缓存；如果未来会话上千，再考虑只读 header 加尾部时间的轻量路径。

按 64 MB 的阈值，本机最大的 687 KB 会话离上限很远；8 MB 压缩、百万事件的合成样本仍可能在大堆内存下吃紧。64 MB 是产品层的粗粒度上限，实现时还要在读取前检查大小，并记录解压后的行数/消息数；如果 64 MB 以内仍出现极高事件数，用事件数兜底，不让进程被单个会话打爆。

不要为了性能提前做流式解析。先把正确性修好，性能阈值和实测数据写进测试计划，等有真实大文件再优化。

### 安全

- 文件名正则锚定，不接受 `..`、绝对路径、临时文件。
- `find` 仍使用经过 `sanitizeSessionId` 的 id，路由层已经校验。
- 打开/定位仍走 `DSH_DIR` 白名单，v4 文件名不改变路径范围。
- 新增的错误信息不要拼接未转义的会话内容；会话 id 和文件名可以出现在错误里，正文不要。
- 不写入 DSH 目录，不删除旧代文件。

## 实施拆分

按测试先行的顺序拆，每一步都能单独跑。

| 任务 | 改动 | 测试 | 预估 |
|---|---|---|---|
| 1. 发现原语 | 在 `dsh.js` 加 `parseDshLogName`、`pickDshLogFile`、`collectDshFiles` 并导出；`find`、`list`、`index.js` 的 `collectFiles` 改用它们 | 文件名表驱动测试；v0/v4 并存只出一条 | 0.5 天 |
| 2. 版本分派 | `parseDshHeader` 接受 0/4；1 到 3 和 >4 标记 unsupported；`parseDshSessionFile` 按版本归一化；元数据加 `formatVersion`、`parentSession`、`delegationDepth`、`origin`；`routes/sessions.js` 把带 `statusCode` 的解析错误映射成 422 | v0 回归；v4 详情；v1-v3/v5 列表带错误、详情 422 | 0.5 天 |
| 3. v4 归一化 | 工具结果 `isError`/`toolCallId`；压缩改 seq；注入消息白名单；标题取最后一条；子代理会话加 `status: 'subagent'` | 工具错误、压缩、注入过滤、标题、子代理 badge 各一组 | 0.5 天 |
| 4. 下游修正 | insights 和 tool-audit 的 `isError`；watch 增量验证；备份收窄；详情入口加 64 MB 上限并返回 413 | v4 watch、错误统计、备份、超限用例 | 0.5 天 |
| 5. fixture 与集成 | 新 v4 明文和多帧 zstd fixture；临时 HOME 注入；API 列表/详情/搜索/prompts/usage | 集成用例 | 0.5 天 |
| 6. 文档与回归 | README 中英、Help 路径说明、版本说明；全量测试、lint、手工验收 | 回归清单 | 0.25 天 |

总计约 2.5 个开发日。P1 的子代理分组、注入折叠区、父子树、上下文卡另外算 0.5 到 1 天。

发布上，仓库没有 CHANGELOG，平台接入提交通常不动版本号。已确认跟随下一个 patch release：功能提交只改代码和文档，合并后按现有流程单独发 release commit 和 tag。

## 风险与回滚

| 风险 | 触发方式 | 守卫 |
|---|---|---|
| 发现规则三处不一致 | 只改 list，没改 find/collectFiles | 同一函数复用；一致性测试断言 list.file、find、collectFiles 指向同一路径 |
| 同目录多代被读两遍 | 把“所有 session* 文件”都塞进 collectFiles | 一个 session 目录只返回一个文件；usage/search 去重测试 |
| 压缩区间改错 | `startSeq` 当 `start` 用，或把闭区间当开区间 | 合成 v4 压缩 fixture；v0 旧用例同时保留 |
| 注入过滤误伤 | 白名单漏掉 `compact-checkpoint` 或 `agent-message` | 白名单表单测；压缩摘要和子代理回传各一条用例 |
| 子代理列表变吵 | 修好后子会话全进主列表 | P0 先加 `subagent` badge，P1 再做分组/开关 |
| 缓存陈旧 | 聚合缓存 60 秒到 5 分钟 | 文档写明重启/刷新；必要时把目录 mtime 并入缓存 key |
| Node 版本不支持 zstd | 用户 Node < 22.15 | 保持现有明确报错；README 写清楚 |
| 大文件 OOM | 超大压缩日志 | P0 在详情入口检查大小，超过 64 MB 返回 413；性能测试用 8 MB 压缩样本 |
| 既有测试失败被当成新问题 | `usage.test.js` 的日期用例 | 先修该用例或把它列为已知基线，见测试计划 |

回滚很简单：改动只在读取侧，没有数据迁移。回退提交并重启服务即可，DSH 目录不会被修改。

## 开放问题与建议

| 问题 | 选项 | 结论 |
|---|---|---|
| v0 与 v4 并存怎么排 | 按文件 mtime / 按 header createdAt / 按文件名 | 按 header createdAt 倒序；同 id 只取最高代。工程实现，agent 决定 |
| 标题用哪条 | 首条 prompt / 最后一条 title / projcache | 最后一条 `session/title`，fallback 时回退首条真人 prompt。按此实现 |
| 子代理默认显示吗 | 全显示 / 默认隐藏加开关 / 建树 | **已确认**：P0 保留全部并加 `subagent` badge，P1 再做分组 |
| v5 怎么处理 | 静默跳过 / 列表报错 / 当 v4 硬解 | **已确认**：列表保留并报错，详情 422；不硬解 |
| v1 到 v3 支持吗 | 完全不支持 / 尽力解析 / 等 DSH 迁移 | **已确认**：不支持，列表报错，详情 422，提示在 DSH 中迁移 |
| 打开 .zstd 怎么做 | 默认编辑器 / 启动 DSH 应用 / 解压到临时文件 | 已改为启动 DSH 应用（P2），应用不可用回退默认编辑器 |
| 空会话列不列 | 列 / 隐藏 | 列，`messageCount: 0`，与 v0 行为一致 |
| 注入消息要不要给开关 | 永不显示 / 默认隐藏可展开 / 全显示 | **已确认**：P0 默认过滤，P1 再做折叠区 |

## 证据附录

### 关键代码位置

| 事实 | 位置 |
|---|---|
| 只认版本 0 | `lib/platforms/dsh.js:26`、`:122-127` |
| 只认两个文件名 | `lib/platforms/dsh.js:136`、`:457`、`lib/platforms/index.js:336` |
| 用户消息不过滤 | `lib/platforms/dsh.js:196-206` |
| 工具结果只认 data.error | `lib/platforms/dsh.js:267-283` |
| 压缩按 surface 下标 | `lib/platforms/dsh.js:310-339` |
| userCount 全量累加 | `lib/platforms/dsh.js:392-398` |
| 标题用首条 prompt | `lib/platforms/dsh.js:429-430` |
| 平台能力 | `lib/platforms/capabilities.json:8` |
| 目录解析 | `lib/config.js:15-18` |
| 前端折叠空平台 | `frontend/src/components/PlatformBar.tsx:47-49` |

### 真实数据统计

- 2026-10-28 扫描：12 个会话，全部 `session.v4.jsonl.zstd`，无 v0 文件，无同目录多代。
- header：12/12 `version:4`，`isSeeded:false`，`delegationDepth` 为 0 或 1；扫描时 6 个 `origin:"subagent"`，分析过程中又新增了子代理会话，数量会继续变化。
- 事件量约 4,000 条；`surfaceOp` 中 append 1,162 条、replace 3 条，3 条都是 `system/message`。
- 扫描时 `session/title` 13 条，fallback 9 条、provider 2 条，2 个会话没有标题。
- 扫描时用户消息约 98 条，其中真人 `kind:"user"` 30 条，其余是注入；单条 `skill-catalog` 可达 1.2 万字符。
- 扫描时工具结果 568 条，9 条 `message.isError`，8 条 `data.error`，至少 1 条只能靠 `message.isError` 识别。
- token 示例：`session-2800e5b0…` 逐条求和 input 185,619、output 70,211、cacheRead 11,606,144，与 DSH projcache 的 `totals` 一致。

### 复现命令

```bash
# 当前适配器返回 0
node -e "const {listDshSessions}=require('./lib/platforms/dsh'); listDshSessions().then(s=>console.log(s.length))"

# 真实文件名
find ~/.dsh/sessions -type f -name 'session*.jsonl*' -exec basename {} \; | sort | uniq -c

# 解压一个真实会话，看事件类型
node -e "
const fs=require('fs');
const {decompressDshLog}=require('./lib/platforms/dsh');
const p=process.env.HOME+'/.dsh/sessions/--Users-linda-Projects-aicode_library-AgentXRay--/session-094d51ad-01e6-4134-b333-6a281c00607b/session.v4.jsonl.zstd';
const lines=decompressDshLog(fs.readFileSync(p)).split('\n').filter(Boolean);
const types={}; for(const l of lines){const r=JSON.parse(l); types[r.type]=(types[r.type]||0)+1;}
console.log(types);
"
```

## 与测试计划的衔接

具体用例、fixture 构造、回归命令和验收门槛见同目录的 `2026-10-28-dsh-v4-session-support-test-plan.md`。设计评审通过后，按测试计划先补失败用例，再实施第 1 到第 6 项任务。
