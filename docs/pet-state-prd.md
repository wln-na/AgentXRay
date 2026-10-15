# AgentXRay 桌面状态宠物（Pet）PRD

> 状态：草案 v0.1 · 2026-10-14
> 关联 ROADMAP：「Watch mode ergonomics — surface agent waiting-for-input state」

## 1. 背景

把长任务交给 CLI 编码 agent（Claude Code / Codex / Gemini CLI / …）之后，开发者频繁切回终端确认三件事：

1. 它还在跑吗？
2. 跑完了吗？
3. 它是不是在等我点确认？

Codex 自带了全局悬浮宠物解决这个问题；Vibe Island / Agent Island / Mu Pet / better-dsh-pet 是社区派的同类方案。它们的共同形态是：一个常驻桌面的小形象，用动画和气泡告诉你 agent 的实时状态，不用切窗口。

AgentXRay 已经在做"tail 全平台会话日志 + SSE 推送"，数据管道现成。本 PRD 定义在这条管道之上补一层**状态归约**，并逐步长出一个桌面 overlay。

## 2. 目标与非目标

### 目标

- **G1** 把已经 normalized 的 messages 流归约成一个统一的 agent 状态枚举，供 sidebar、web 组件、未来的桌面 overlay 共用。
- **G2** 最高价值信号是 `waiting_input`（agent 在等你）和 `error`（出错了）——这两个状态必须显眼、不能漏报。
- **G3** 复用现有 `/api/watch` SSE，不新增日志解析路径。
- **G4** 状态推导是纯函数、可单测、可注入时间。

### 非目标（边界，写死）

- **N1** 不做"点击宠物直接回复 agent"。AgentXRay 是只读查看器，写回复发生在原 CLI / 原 App 里。点击宠物 = 跳过去（复用现有 `open-session` 逻辑）。
- **N2** 不做情绪系统、番茄钟、喂食、语音唤醒——这些是 better-dsh-pet 的玩法，不是本项目核心。
- **N3** 不做 agent 主动 push 的 HTTP API（那是 Mu Pet 的路子，需要 agent 配合改造）。本项目只 tail 日志。
- **N4** 不把 Electron 塞进主 `agent-xray` npm 包。桌面壳是独立子包 / 子命令。

## 3. 用户场景

| # | 场景 | 期望表现 |
|---|---|---|
| S1 | 我给 Codex 派了个重构任务，切去写文档 | 宠物显示 working/thinking，我不用切回去看 |
| S2 | Claude Code 弹了个 permission prompt 等我确认 | 宠物明显跳一下 + 气泡"需要你的输入"，我点它跳到终端 |
| S3 | agent 跑了半小时报错退出 | 宠物变 error 状态，气泡显示错误摘要 |
| S4 | 我半天没理它，它早就没事干了 | 宠物回 idle，不再打扰 |
| S5 | 多个 agent 同时在跑 | 宠物只显示"最高优先级"的那个（最近活跃 / waiting_input 优先） |

## 4. 核心：状态机

### 4.1 状态枚举

```
idle          空闲，无活跃会话
thinking      刚收到 user 消息，等模型吐下一段
working       正在调用工具（toolCall 已发，对应 toolResult 未回来）
done          这一轮回复刚结束（assistant 文本刚落地）
waiting_input 这一轮结束后超过阈值仍无新活动 → agent 在等你
error         最近一次 toolResult 失败，且后续没有 assistant 文本把它盖过去
```

状态优先级（用于多 session 聚合）：`waiting_input > error > working > thinking > done > idle`。

### 4.2 转移规则（单 session）

输入：按时间正序的 normalized messages（即 `makeMessage` 形状的 11 字段对象）。
跟踪量：
- `pendingToolCalls: Set<toolCallId>` —— 已发未收结果的工具调用
- `lastEventAt: number` —— 最后一条消息时间
- `lastAssistantTextAt: number` —— 最后一段 assistant 纯文本时间
- `errorSticky: boolean` —— 最近一次 toolResult.isError=true 之后是否已被 assistant 文本覆盖

转移：

| 事件 | 动作 |
|---|---|
| `role === 'user'` | 清空 pending；state 直接定 `thinking`；更新 lastEventAt |
| `role === 'assistant'` 且 content 含 text | 记录 lastAssistantTextAt；若 pending 为空 → 本轮结束，候选 `done`；若 pending 非空 → 仍 `working` |
| `role === 'toolCall'` | 加入 pending；state = `working` |
| `role === 'toolResult'` | 从 pending 移除；`isError=true` → 置 errorSticky；pending 空 → `thinking`，否则 `working` |
| `role === 'reasoning'` | 不改变状态，只刷新 lastEventAt |

然后用时间阈值把"瞬时状态"冷却成"语义状态"（`now` 可注入，默认 `Date.now()`）：

| 条件 | 结果 |
|---|---|
| `now - lastEventAt > idleAfter`（默认 120s） | `idle` |
| errorSticky 且状态是 thinking/done/idle | `error` |
| state === `done` 且 `now - lastAssistantTextAt > waitingAfter`（默认 15s） | `waiting_input` |
| state === `done` 且 `now - lastAssistantTextAt <= doneBubbleWindow`（默认 8s） | `done` |
| 其余 | 沿用瞬时状态 |

### 4.3 bubble 文案

| state | bubble 来源 |
|---|---|
| working | `正在调用 ${toolName}`（取 pending 里最新一个 toolName） |
| thinking | `思考中…` |
| done | 最后一段 assistant 文本前 60 字 |
| waiting_input | `需要你的输入` |
| error | `出错了：${最后一条 error toolResult 的输出前 60 字}` |
| idle | `空闲` |

### 4.4 per-platform 扩展点

`waiting_input` 在日志层面是"assistant 说完话 + 时间过了"的启发式。某些平台有更精确的信号（例如 Claude Code 的 permission prompt 文本、Codex 的 confirmation 事件），在对应 platform adapter 上挂一个可选 hook：

```js
// lib/platforms/<x>.js，可选导出
detectWaiting(messages) => boolean
```

reducer 优先采用 hook 结果，否则走时间启发式。P0 只定义接口，不实现具体 hook。

## 5. API 设计

### 5.1 纯函数（P0，本 PRD 落地范围）

```js
// lib/pet-state.js
deriveState(messages, { now, thresholds } = {})
  => { state, bubble, lastEventAt, pendingToolCalls, errorSticky }
```

- 输入是该 session 当前**全量** normalized messages（不是增量）。SSE 新消息到达时重算即可——单 session 消息量在千级，重算成本可忽略。
- 时间阈值通过 `thresholds` 覆盖，测试里注入。

### 5.2 全局聚合 SSE（P1）

```
GET /api/pet/state
```

不指定 sessionId。后端维护所有"最近活跃"session 的状态 Map，按 4.1 的优先级选 top-1 推送：

```json
{
  "state": "working",
  "platform": "codex",
  "sessionId": "…",
  "bubble": "正在调用 shell",
  "updatedAt": 1728890000000
}
```

P1 不在本次落地范围，只在本 PRD 登记。

## 6. 分阶段路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | `lib/pet-state.js` 纯函数 + 单测 | 状态转移表全覆盖；注入 `now` 可测时间冷却；fixture 覆盖 codex/claude-code/openclaw 三种消息形状 |
| P1 | `/api/pet/state` 全局聚合 SSE；web 端一个最小 web 组件 dogfood | 浏览器里能看到宠物随日志动 |
| P2 | 独立 Electron 壳 `agent-xray-pet`（Canvas 像素动画起步，零图片资源） | 透明置顶窗、点击穿透、连本地 3800 |
| P3 | 看门狗 / 全屏隐藏 / LaunchAgent 自启动；点击宠物走 open-session 跳回 | 崩溃自拉、全屏自动隐、点击跳到终端 |
| P4 | 精灵图包格式（`frames/<state>/*.png + pet.json`） | 用户能丢一套自定义动画进 `~/.agentxray/pets/` |

## 7. 验收标准（P0）

- [ ] `node --test test/pet-state.test.js` 全绿
- [ ] 转移表 4.2 的每一行都有正向用例
- [ ] 时间冷却（done → waiting_input → idle）有注入 `now` 的用例
- [ ] error 粘性：error 之后跟一段 assistant 文本，state 必须从 error 恢复
- [ ] 并发工具：两个 toolCall 只回一个 result，state 仍是 working
- [ ] 空消息数组 → idle，不抛错
- [ ] 纯函数：相同输入两次调用返回相同结果
