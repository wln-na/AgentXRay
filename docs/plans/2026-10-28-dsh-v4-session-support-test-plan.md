# DeepSeek Harness v4 会话支持：测试用例与回归方案

- 日期：2026-10-28
- 配套设计：`2026-10-28-dsh-v4-session-support-design.md`
- 测试框架：Node 内置 `node:test`，命令入口 `npm test`（`node --test test/*.test.js`）
- 目标：让 dsh v4 会话“看得见、读得对、下游不重复”，同时保证 v0 和其它平台不回归
- 范围：P0/P1/P2 已实现

## 测试目标

1. 文件名发现不再依赖 `session.jsonl` 两个精确字符串，v4 和未来代际都能被发现并选择正确文件。
2. 版本分派只对已知版本做完整承诺；未知版本有可读错误，不静默丢会话。
3. v4 的工具结果错误、压缩区间、注入消息、标题、子代理字段都能被正确归一化。
4. 搜索、提示词、用量、备份、watch、定位/打开在 v4 上可用。
5. v0 fixture 和现有 15 个 dsh 用例继续通过，其它平台计数不变。

## 基线

在开始改动前记录一组可对比的基线。下面是 2026-10-28 在 Node v22.22.2、macOS 上的实测：

| 命令 | 结果 | 耗时 |
|---|---|---|
| `npm test`（实现前） | 612 tests / 611 pass / 1 fail | 13 到 16 秒 |
| `npm test`（P1 实现后） | 658 tests / 658 pass / 0 fail | 约 11 秒 |
| `node --test test/dsh.test.js` | 15 / 15 pass | 约 3.3 秒 |
| `npx biome check .` | 通过 | 数秒 |

唯一的可复现失败是 `test/usage.test.js:358` 的 `computeDailyUsage: platform directory overrides are honored and affect the cache key`。用例把时钟冻结在 `TEST_NOW = 2026-10-27 12:00`，写入数据却用 `new Date()`（实际是 2026-10-28），`days: 1` 的窗口把记录排除，断言得到 `undefined !== 17`。这是测试自身的日期问题，与 dsh 无关。建议在本次改动前单独修掉：

```js
// test/usage.test.js，写入记录时使用冻结时钟
timestamp: new Date(TEST_NOW).toISOString(),
```

修完后基线应为 612 / 612。本次实现已经修掉该用例，最终全量为 658 / 658。若不修，则把它记为已知失败，验收时只要求“不新增失败”，不要把 611 当成全绿。

第一次全量运行曾出现 2 个失败，其中一个后续三次都没复现，疑为并发或端口抖动。回归时以三次稳定结果为准，并在失败时保留完整输出。

## 测试分层

| 层 | 做什么 | 怎么跑 | 特点 |
|---|---|---|---|
| 单元 | 文件名解析、选择、header 分派、事件归一化、压缩区间 | `node --test test/dsh-v4.test.js` | 不启服务，最快，覆盖边界 |
| 集成 | 直接调 adapter 的 list/find/parse，或临时目录 | 同上 | 验证发现到解析的链路 |
| API/E2E | 起真实 server，打 `/api/dsh/*` 和下游接口 | `startServer` + `getJson` | 验证路由、缓存、下游 |
| 回归 | v0、其它平台、lint、构建 | `npm test`、`biome`、`build:ui` | 防止连带破坏 |
| 手工 | 真实 `~/.dsh` 数据、实时写入、Finder 定位 | 按清单 | 覆盖测试环境造不出的真实形态 |

## Fixture 设计

### 不往共享 fixture home 里塞 v4

现有 `test/fixtures/home` 被所有 API 测试共享，里面有 v0 plain 和 v0 三帧 zstd 两个会话。直接加 v4 会改变 `test/api.test.js` 里的 backup 计数、全平台搜索、prompts、tools audit、OTLP 等断言，容易把一次格式适配变成大面积改测试。

推荐两个隔离方案，二选一：

1. 给 `startServer` 加一个可选的 `prepareHome` 回调，在复制完 fixture home、启动服务之前，往临时 HOME 写入 v4 会话。现有调用 `startServer(extraEnv)` 不受影响。
2. 新建 `test/fixtures/home-dsh-v4/`，给 `startServer` 加可选的 `fixtureHome`。需要复制一份基础 home，维护成本略高。

优先选 1，改动小，计数完全隔离。

### 测试内构造 v4 会话

新增 `test/dsh-v4-fixtures.js`。文件名不要以 `.test.js` 结尾，否则会被 `npm test` 当测试执行。

```js
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), OPTS);

// 按行边界切成多帧，模拟 DSH 每个 durable append 一个 frame
function packFrames(records, groups) {
  const chunks = [];
  let at = 0;
  for (let i = 0; i < groups.length; i++) {
    const take = i === groups.length - 1 ? records.length - at : groups[i];
    const body = records.slice(at, at + take).map(JSON.stringify).join('\n');
    if (body) chunks.push(frame(`${body}\n`));
    at += take;
  }
  return Buffer.concat(chunks);
}

function writeSession(root, project, sessionId, records, groups, fileName = 'session.v4.jsonl.zstd') {
  const dir = path.join(root, project, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, packFrames(records, groups));
  return file;
}
```

最小 v4 事件集要覆盖这些点：

- header：`version:4`、`isSeeded:false`、`delegationDepth:0`、`agentPreset:"standard"`
- `session/title`：先 fallback 再 provider，验证取最后一条
- `user/message`：一条 `runtime-context` 注入、一条 `skill-catalog` 注入、一条真人 `user`
- `assistant/message`：reasoning 加 text，`message.source` 带 model/provider，`data.usage` 带四个字段
- `tool/call` 和 `tool/result`：callId 相同，result 用扁平 text 块，`message.isError:true`
- `surfaceOp` replace：用 `startSeq` / `endSeq` 覆盖前面两条消息
- `turn/end`：`reason.kind:"error"`，带 `error.message`
- 子代理 header：另建一个会话，带 `parentSession`、`origin:"subagent"`、`delegationDepth:1`

多帧要真的多帧，至少三帧：header 一帧，消息一帧，压缩和结尾一帧。单帧 fixture 测不出多帧解压回归。

### 并存与未知版本

- 并存目录：同一个 session 目录放 `session.jsonl`（v0，内容写“stale”）和 `session.v4.jsonl`（v4，内容写“fresh”），断言列表只有一条且 `firstUserMessage` 是 fresh。
- 未知版本：临时目录放 `session.v9.jsonl`，断言列表有一条带 `unsupported`/`error` 的会话，详情返回 422，其它会话不受影响。
- 旧代际：临时目录放 `session.v2.jsonl`，断言列表保留该会话、带 `unsupported` 和“在 DeepSeek Harness 中打开以迁移到 v4”的提示，详情返回 422；不做尽力解析。
- 版本不一致：`session.v4.jsonl` 里 header 写 `version:0`，断言带错误、详情返回 422。
- 空会话：只有 header，没有消息，断言 `messageCount: 0` 且仍能列出。

### 真实样本脱敏

可选。把一份真实 v4 会话脱敏后放到 `test/fixtures/dsh-v4-real/`，不要放在 `home` 下。脱敏脚本可以复用 `decompressDshLog`，只保留 `session`、`turn/*`、`step/*`、`user/message`、`assistant/message`、`tool/*`、`system/message`、`developer/message`、`session/title`，删掉 `request/header`、`request/context`、`*-llm-request`、`assistant/attempt`、`agent/inbox/spliced`、`job/*`、`workspace/*`、`command/*`，以及所有 `data.stream`。文本替换成 `fixture: redacted len=N`，工具参数替换成 `{"redacted":true}`，输出截断。控制在一百 KB 以内，提交前 grep 一遍 `sk-`、`Bearer`、`api_key`。

## 用例矩阵

优先级按 P0、P1、P2 排。P0 是本次必须通过；P1/P2 用例保留，供后续版本使用。v1 到 v3 已确认不支持，因此对应用例验证的是错误提示，不是解析结果。

### 发现与版本

| ID | 层 | 场景 | 预期 | 文件 | 优先级 |
|---|---|---|---|---|---|
| DISC-01 | U | v4 明文 `session.v4.jsonl` | 被发现，`file` 正确 | `test/dsh-v4.test.js` | P0 |
| DISC-02 | U | v4 压缩 `session.v4.jsonl.zstd` | 被发现并完整解压 | 同上 | P0 |
| DISC-03 | U | v0 plain / v0 zstd | 继续被发现，行为不变 | `test/dsh.test.js` | P0 |
| DISC-04 | U | 同目录 v0 + v4 | 只返回一条，取 v4 | `test/dsh-v4.test.js` | P0 |
| DISC-05 | U | 同目录 v4 + v9 | 取 v9，标记不支持；不静默丢 | 同上 | P0 |
| DISC-06 | U | 非 canonical 文件 | `session.v0.jsonl`、`session.v04.jsonl`、`session.lock`、`notes.jsonl`、`.DS_Store` 全部忽略 | 同上 | P0 |
| DISC-07 | U | list / find / collectFiles 一致性 | 三者指向同一 canonical 路径 | 同上 | P0 |
| DISC-08 | U | 目录名与 header.id 不一致 | list 用 header.id；find 能回扫到 | 同上 | P1 |
| DISC-09 | U | `DSH_DIR` 不存在或无权限 | list 返回 `[]`，不抛未捕获异常 | 同上 | P1 |
| VER-01 | U | v0 header | `session.version === 0`，旧断言不变 | `test/dsh.test.js` | P0 |
| VER-02 | U | v4 header | `session.version === 4`，字段完整 | `test/dsh-v4.test.js` | P0 |
| VER-03 | U | v9 header | 列表带 `unsupported`；详情 422 | 同上 | P0 |
| VER-04 | U | 文件名 v4、header v0 | 带错误；详情 422 | 同上 | P0 |
| VER-05 | U | v1 到 v3 | 列表带 `unsupported`；详情 422；提示在 DSH 中迁移 | 同上 | P0 |

### 解压

| ID | 层 | 场景 | 预期 | 文件 | 优先级 |
|---|---|---|---|---|---|
| ZSTD-01 | U | 三帧拼接 | 全文完整，帧边界正确 | `test/dsh.test.js` | P0 |
| ZSTD-02 | U | torn 尾帧 | 只解完整帧，不产出半行 | 同上 | P0 |
| ZSTD-03 | U | 空文件 / 纯垃圾 | 不崩溃；返回空并带 parse error | `test/dsh-v4.test.js` | P1 |
| ZSTD-04 | U | 无 zstd 的 Node | `.zstd` 给出升级提示；明文仍可读 | 同上 | P1 |

### 归一化

| ID | 层 | 场景 | 预期 | 文件 | 优先级 |
|---|---|---|---|---|---|
| PARSE-01 | U | v4 工具结果带 `message.isError` | `toolResult.isError === true` | `test/dsh-v4.test.js` | P0 |
| PARSE-02 | U | v4 扁平 text 块 | 内容读出，`toolCallId` 取自 `message.toolCallId` | 同上 | P0 |
| PARSE-03 | U | call/result 配对 | `toolName` 由 callId 反查，参数解析为对象 | 同上 | P0 |
| PARSE-04 | U | v4 `surfaceOp` replace（seq 闭区间） | 区间内旧消息被屏蔽，摘要保留一次 | 同上 | P0 |
| PARSE-05 | U | v0 `surfaceOp` replace（旧下标） | 旧测试继续通过 | `test/dsh.test.js` | P0 |
| PARSE-06 | U | 注入 `runtime-context` / `time-context` / `skill-catalog` | 不进入消息列表，不计入 `userCount` | `test/dsh-v4.test.js` | P0 |
| PARSE-07 | U | `agent-message` / `subagent-settled` / `compact-checkpoint` | 保留为可读消息，不被误过滤 | 同上 | P0 |
| PARSE-08 | U | 标题先 fallback 后 provider | 取 provider 标题 | 同上 | P0 |
| PARSE-09 | U | 只有 fallback 标题 | 回退首条真人 prompt | 同上 | P1 |
| PARSE-10 | U | usage 四字段 | input、output、cacheRead 分别累加；`reasoning` 为 0 | 同上 | P0 |
| PARSE-11 | U | `totalTokens` | 不被重复累加 | 同上 | P0 |
| PARSE-12 | U | 子代理 header 和 badge | `parentSession`、`origin`、`delegationDepth` 正确；summary 的 `status` 为 `subagent` | 同上 | P0 |
| PARSE-13 | U | `turn/end` error | 错误气泡带 `reason.error.message` | 同上 | P0 |
| PARSE-14 | U | 空助手消息 / 只有 reasoning | 不崩溃；reasoning 仍保留 | 同上 | P1 |

### P1：子代理、上下文与错误摘要

| ID | 层 | 场景 | 预期 | 文件 | 优先级 |
|---|---|---|---|---|---|
| SUB-01 | U | 主列表默认只返回根会话 | `/api/dsh/sessions` 不含子代理；父会话 `childCount` 正确 | `test/dsh-v4.test.js` | P1 |
| SUB-02 | U | `include_subagents=1` | 子代理作为普通行返回，`status='subagent'`、`childCount=0` | 同上 | P1 |
| SUB-03 | U | children API | `/api/dsh/sessions/:id/children` 返回直接子代理；`:name` 返回详情；非子会话 404 | 同上 | P1 |
| SUB-04 | E2E | 子代理内容搜索 | 命中归到根会话，带 `childSessionId`，Cmdk 可直接打开子代理 transcript | `test/dsh-v4.test.js` | P1 |
| CTX-01 | U | 详情 `contextMessages` | 注入消息与 `messages` 分离，按 `sourceKind` 标记；对话流仍不含注入 | 同上 | P1 |
| CTX-02 | U | 详情 `contextUsage` | `used=最后 input+cacheRead`、`limit=request/context.contextWindow`、percent 正确 | 同上 | P1 |
| TURN-01 | U | `turn/end` 异常 | 错误气泡文本包含 `reason.error.message` | 同上 | P1 |
| REG-06 | U | 前端构建 | `npm run build:ui` 通过；`SystemContextPanel` 默认折叠 | 手工/CI | P1 |

### API 与下游

| ID | 层 | 场景 | 预期 | 文件 | 优先级 |
|---|---|---|---|---|---|
| API-01 | E2E | `/api/dsh/sessions` 含 v4 | 200；字段与 v0 同形；按 createdAt 倒序 | `test/dsh-v4.test.js` | P0 |
| API-02 | E2E | `/api/dsh/sessions/:id` | 200；roles 含 user/reasoning/assistant/toolCall/toolResult；`stats` 存在 | 同上 | P0 |
| API-03 | E2E | 不存在或非法 id | 404 或 400，不 500 | 同上 | P0 |
| API-04 | E2E | 未知版本详情 | 422 加可读错误 | 同上 | P0 |
| API-05 | E2E | `?dir=` 指向 HOME 内的 v4 目录 | 生效；越界路径回退默认目录 | 同上 | P1 |
| XF-01 | E2E | 全局搜索 v4 关键词 | 命中一次，platform 为 dsh | 同上 | P0 |
| XF-02 | E2E | `/api/prompts?platform=dsh` | 只含真人 prompt；注入不出现 | 同上 | P0 |
| XF-03 | E2E | `/api/usage/daily?platform=dsh` | input/output/cacheRead 与日志求和一致；session 数按 sessionId 去重，不同名文件不塌成 1 | `test/usage.test.js` | P0 |
| XF-04 | E2E | `POST /api/backup` | 归档 `session.v4.jsonl.zstd`；二次运行跳过 | `test/api.test.js` 或新文件 | P0 |
| XF-05 | E2E | watch 追加一个完整帧 | 收到 `newMessages`；torn 帧不前进 | `test/watch.test.js` 或新文件 | P0 |
| XF-06 | U | 定位 v4 文件 | `open -R` 收到白名单内路径 | `test/open.test.js` | P1 |
| XF-07 | E2E | Markdown/OTLP 导出 | 工具配对和角色正确 | `test/export.test.js` | P1 |

### P2：上下文、时间线、diff、打开应用

| ID | 层 | 场景 | 预期 | 文件 | 优先级 |
|---|---|---|---|---|---|
| CTX-03 | E2E | `/api/dsh/sessions/:id/context?messageIndex=N` | 200；systemPrompt.components 含 system-prompt（present）；tools.definitions 非空 | `test/dsh-v4.test.js` | P2 |
| ACT-01 | E2E | 详情 `activityEvents` | 包含 job（completed）、approval（decided/allowed-once）、retry（RATE_LIMIT） | 同上 | P2 |
| DIFF-01 | E2E | 工具结果 `details.diffs` | 非空数组，含 path/oldText/newText；details.path/operation 正确 | 同上 | P2 |
| OPEN-01 | U | dsh 打开 | 走 `open -b com.deepseek.dsh`；日志不存在回退 copy-path | `test/open.test.js` | P2 |
| REG-07 | — | `npx biome check .` | 0 错误 | CI | P2 |

### 回归、性能、安全

| ID | 层 | 场景 | 预期 | 文件 | 优先级 |
|---|---|---|---|---|---|
| REG-01 | U | 现有 dsh 15 个用例 | 15/15 通过 | `test/dsh.test.js` | P0 |
| REG-02 | U | registry / capabilities | dsh 六项能力全为 true（spawn/context 均已打开） | `test/registry.test.js` | P0 |
| REG-03 | E2E | 其它平台列表/详情 | 计数和断言不变 | `test/api.test.js` 等 | P0 |
| REG-04 | — | 全量 `npm test` | 无新增失败；基线失败单独记录 | CI | P0 |
| REG-05 | — | `npx biome check .` | 0 错误 | CI | P0 |
| PERF-01 | U | 12 个真实 v4 会话 cold/warm list | cold < 500 ms，warm < 100 ms | 手工或脚本 | P1 |
| PERF-02 | U | 687 KB 会话详情 | < 200 ms | 手工或脚本 | P1 |
| PERF-03 | U | 50 MB 纯 JSONL | metadata < 1.5 s；详情有上限或提示 | 压力脚本 | P2 |
| PERF-04 | U | 压缩文件超过 64 MB | 详情返回 413；不先解压再判断 | 压力脚本 | P0 |
| SEC-01 | U | sessionId 路径穿越 | 400 或限制在 DSH_DIR | `test/dsh-v4.test.js` | P0 |
| SEC-02 | U | 打开路径逃逸/symlink | 拒绝并回退 copy-path | `test/open.test.js` | P1 |

## 测试文件改动

| 文件 | 动作 | 内容 |
|---|---|---|
| `test/dsh-v4-fixtures.js` | 新建 | 帧构造、会话写入、最小 v4 事件集 |
| `test/dsh-v4.test.js` | 新建 | 发现、版本、归一化、API 主链路 |
| `test/dsh.test.js` | 保留 | v0 回归；如实现改变文件名常量，只改必要断言 |
| `test/helpers.js` | 小改 | `startServer(extraEnv, { prepareHome })`，默认行为不变 |
| `test/usage.test.js` | 小改 | 修日期冻结；加一条 v4 求和用例 |
| `test/open.test.js` | 小改 | 加 v4 文件定位用例 |
| `test/watch.test.js` | 小改 | 加 v4 多帧增量用例 |
| `test/api.test.js` | 视情况 | 若用隔离 fixture，计数断言不动 |

## Fixture 放置

```text
test/fixtures/home/.dsh/sessions/                     # 现有 v0，保留
  --fixtures-project-delta--/dsh-fixture-session-0001/session.jsonl
  --fixtures-project-epsilon--/dsh-fixture-session-0002/session.jsonl.zstd

# 运行时写入临时 HOME，不入库：
<tmp-home>/.dsh/sessions/--fixtures-project-v4--/dsh-v4-fixture-0001/session.v4.jsonl.zstd
<tmp-home>/.dsh/sessions/--fixtures-project-v4--/dsh-v4-subagent-0002/session.v4.jsonl
<tmp-home>/.dsh/sessions/--fixtures-project-mixed--/dsh-v4-mixed-0003/session.jsonl
<tmp-home>/.dsh/sessions/--fixtures-project-mixed--/dsh-v4-mixed-0003/session.v4.jsonl
```

如果确实要提交真实形态样本，放 `test/fixtures/dsh-v4-real/`，并在 `test/fixtures/README.md` 记录来源、脱敏方式和再生成命令。现有 dsh fixture 没有生成脚本，这是一个可以顺手补的债。

## 回归执行

### 本地命令

```bash
# 1. 先确认基线
npm test

# 2. dsh 定向
node --test test/dsh.test.js test/dsh-v4.test.js

# 3. 受影响模块
node --test test/registry.test.js test/api.test.js test/export.test.js test/open.test.js
node --test test/usage.test.js test/usage-index.test.js
node --test test/search-watch.test.js test/watch.test.js test/watch-mtime.test.js

# 4. 其它平台
node --test test/cli.test.js test/cursor.test.js test/doubao-import.test.js \
  test/gemini.test.js test/trae.test.js test/workbuddy.test.js

# 5. 质量门
npx biome check .
git diff --exit-code public/js/pure.js

# 6. 覆盖率（Node 22 支持）
node --test --experimental-test-coverage test/dsh.test.js test/dsh-v4.test.js
```

### CI

现有工作流已经包含 `npm ci`、`public/js/pure.js` 漂移检查、`biome check`、`npm test`。建议加一个 dsh 定向步骤，失败时上传完整输出：

```yaml
- name: dsh v4 focused
  run: node --test test/dsh.test.js test/dsh-v4.test.js
```

如果 CI 有 Node 20 矩阵，再加一个无 zstd 的定向 job，验证明文可读、压缩日志给出升级提示、列表不崩。本机 Node 22.22.2 自带 zstd，不能替代这个 job。

### 手工验收

用真实 `~/.dsh/sessions`，不要只用 fixture：

1. 启动 `npm start`，打开 AgentXRay。
2. DeepSeek Harness 页签出现，不再是折叠状态。
3. 列表显示当前真实会话数（本次扫描是 12 条，子代理会让数量继续增长），按时间倒序，标题可读。
4. 打开一个长会话，确认没有 1.2 万字符的 skill catalog 气泡，用户消息数和真实提问数接近。
5. 展开一个工具调用，确认参数和结果配对，失败的调用标红。
6. 找一个含 `session/title` 的会话，确认标题是 provider 生成的那条，不是 fallback 或首条 prompt。
7. 看一个子代理会话，确认 `origin` 和父会话字段存在；如果产品决定隐藏，确认开关可用。
8. 全局搜索一个只在 v4 日志里出现的词，确认命中一次，不重复。
9. Prompts 页只出现真人提问，按 cwd 分组正确。
10. Usage 页有 dsh 数据；把一个会话的 input/output/cacheRead 与日志求和对比。
11. 对一个正在写入的 v4 会话打开 watch，确认新消息增量出现，压缩帧不丢。
12. 执行一次备份，确认归档目录出现 `session.v4.jsonl.zstd`，二次执行跳过。
13. 在 Finder 里定位该会话，确认选中的是 v4 文件。
14. 构造一个 v9 文件（临时目录），确认只有该会话报错，其他会话正常。

## 验收门槛

| 门槛 | 值 |
|---|---|

| 新增用例 | 不少于 40 条 P0/P1 用例，0 失败 |
| dsh 覆盖率 | `lib/platforms/dsh.js` 行覆盖不低于 85%，分支不低于 80% |
| 全量 | `npm test` 无新增失败，耗时不超过 25 秒（本机） |
| Lint | `npx biome check .` 0 错误 |
| 构建 | `npm run build:ui` 通过；前端未改也要确认 |
| 性能 | 12 个真实会话 cold list < 500 ms；687 KB 详情 < 200 ms；压缩超过 64 MB 返回 413 |
| 一致性 | list 的 `file`、`find()`、`collectFiles()`、watch 监听路径指向同一文件 |
| 安全 | 路径穿越和 symlink 逃逸被拒绝 |

## 风险与注意事项

1. **fixture 污染全局计数**：把 v4 塞进 `test/fixtures/home` 会连带改 backup、search、prompts、tools audit、OTLP 的断言。用 `prepareHome` 或独立 fixture home。
2. **压缩区间最容易回归**：v4 用 seq 闭区间，v0 用旧下标开区间，两条路径都要有用例。真实数据目前只有 system message 的 replace，必须合成正文压缩样本。
3. **注入过滤可能误伤**：`compact-checkpoint` 和 `agent-message` 不能被白名单漏掉，否则压缩摘要或子代理回传会消失。
4. **子代理数量会变**：真实目录里子代理会话随使用增长，测试断言不要写死 12 或 6，用 fixture 或范围断言。
5. **缓存陈旧**：insights 60 秒、prompts 60 秒、tool-audit 5 分钟、usage 5 分钟。升级后若仍看到空数据，先重启或等 TTL；测试不要依赖跨用例的缓存状态。
6. **Node zstd 版本**：v4 默认压缩，Node < 22.15 读不了。CI 的 Node 22 覆盖正常路径，Node 20 job 覆盖错误路径。
7. **大文件**：8 MB 压缩、百万事件的合成样本在 512 MB 堆下会 OOM。上限保护要先于流式解析实现。
8. **既有失败**：`usage.test.js` 的日期用例不是本次引入，但会干扰“全绿”判断。修它，或在验收记录里单独列出。

## 实施顺序

按测试先行的顺序推进，每一步都能独立提交：

1. 修 `usage.test.js` 的日期冻结，拿到 612/612 基线（已完成）。
2. 写文件名解析、选择、并存、非 canonical 的失败用例。
3. 实现发现原语，接进 `find`、`list`、`collectFiles`，跑 DISC 组。
4. 写 v4 header、工具结果、压缩、注入、标题、子代理 badge 的失败用例。
5. 实现版本分派和 v4 归一化，跑 PARSE 组。
6. 写 API、搜索、prompts、usage、backup、watch 的集成用例。
7. 修 insights/tool-audit 的 `isError`，跑下游组。
8. 更新 README、Help、版本说明，跑全量和 lint。
9. 用真实 `~/.dsh` 做手工验收，记录会话数、标题、工具错误、token 对比。
