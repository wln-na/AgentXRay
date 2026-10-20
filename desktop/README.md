# agent-xray-pet — AgentXRay 桌面状态宠物壳

macOS 上一个**透明、无边框、置顶、可点击穿透**的常驻小窗，用像素动画 + 气泡实时反映
AgentXRay 后端（`127.0.0.1:3800`）推送的 agent 状态（idle / thinking / working / done /
waiting_input / error）。点击宠物 = 跳回原会话（复用现有 `open-session` 路由）。

> 本项目是**独立子包**（N4）：Electron 只进本包的 `optionalDependencies`，绝不进根包
> `agent-xray` 的 `dependencies`/`files`。根 `npm test` 只覆盖不依赖 Electron 的纯逻辑层。

## 目录结构（三层边界）

| 目录 | 是否 `require('electron')` | 是否可 `node --test` |
|---|---|---|
| `lib/*.js` | 否（纯逻辑） | 是 |
| `main.js` / `preload.js` | 是（Electron 胶水） | 否（GUI 手动验收） |
| `renderer/*` | 否（只用 `window.pet` + Canvas） | 否（DOM 手工验收） |

## 安装

```bash
cd desktop
npm i            # 会尝试安装可选依赖 electron（^44）
npm run verify   # 无 GUI 自检：加载 lib/* 纯模块跑冒烟，全部 PASS 即退出码 0
```

说明：

- `electron` 放在 `optionalDependencies`，**下载失败（离线/沙箱）不会阻断 `npm i`**。
  本包**没有**运行时 `dependencies`——SSE / open-session 全用 Node 内置 `http`/`child_process`，
  renderer 用原生 DOM/Canvas，零构建。
- 根包**不**把本目录设为 npm workspace：根 `npm i` 不应被拉去装 Electron。

## 运行

```bash
cd desktop
npm start        # = electron .（需要已成功安装 electron）
```

`main.js` 会在启动时创建唯一 BrowserWindow，并：
- 以 HTTP+SSE 连 `AGENTXRAY_PET_HOST:AGENTXRAY_PET_PORT`（默认 `127.0.0.1:3800`）；
- 装配纯逻辑模块（`lib/*`）——它们把「时间 / 网络 / 子进程 / 文件系统」做成可注入依赖；
- 通过 `preload.js` 暴露的 `window.pet` 桥与 renderer 通信。

### 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `AGENTXRAY_PET_HOST` | `127.0.0.1` | 后端 host |
| `AGENTXRAY_PET_PORT` | `3800` | 后端端口 |
| `AGENTXRAY_PET_DIR` | `~/.agentxray/pet` | 壳自身状态目录（窗口位置、日志） |
| `AGENTXRAY_PET_PETS_DIR` | `~/.agentxray/pets` | 用户皮肤根目录 |
| `AGENTXRAY_PET_PACK` | 空 | 指定皮肤名或绝对路径（最高优先级） |
| `AGENTXRAY_PET_EXEC` | 空 | LaunchAgent 覆盖可执行文件（打包/自定义路径） |
| `AGENTXRAY_PET_NODE` | 空 | own-server 模式下 spawn `server.js` 用的 node 可执行（**最高优先级**候选，见下节）。原生模块 ABI 不匹配时指向系统 node |
| `AGENTXRAY_PET_NO_WATCHDOG` | 空 | `1` 时关闭看门狗（调试） |
| `AGENTXRAY_PET_DEBUG` | 空 | `1` 时调快全屏轮询并输出详细日志 |

### own-server 模式的 node 解析顺序（`lib/node-exec.js`）

`process.execPath` 在 Electron 下是 **Electron 二进制**，直接 spawn 会启动一个 App 而非脚本；
即便注入 `ELECTRON_RUN_AS_NODE=1`，用 Electron 内置 Node 去 `require` 为本机 Node 编译的原生模块
（根包 `better-sqlite3`）也大概率 **ABI 不匹配 → 启动即崩 → 看门狗反复重启 → giveup**。因此启动
被监督的 `server.js` 时按以下顺序选 node（**命中即止**，纯函数 `resolveNodeExec({env,execPath,whichImpl,existsImpl})`）：

| 序 | 候选 | `source` | 附加 |
|---|---|---|---|
| ① | `AGENTXRAY_PET_NODE`（存在性校验） | `env` | — |
| ② | `which node`（PATH 下真实 node） | `which` | — |
| ③ | `process.env.npm_node_execpath` | `npm` | — |
| ④ | `process.execPath`（Electron，**回退**） | `electron` | 注入 `ELECTRON_RUN_AS_NODE=1` + **打印 warning** |

- 前三者若命中，**不**注入 `ELECTRON_RUN_AS_NODE`；仅第 ④ 条这一 Electron 回退才会注入并告警。
- 不猜测 nvm / Homebrew 等具体路径——只走上面四条。
- 被监督 server 的 **stdout → `~/.agentxray/pet/pet.log`**，**stderr → `~/.agentxray/pet/pet.err.log`**
  （追加写、全量），同时把**前 40 行**实时打到 `[pet:main] [server:out] / [server:err]` 日志
  （避免刷屏；排查崩溃时不再零线索）。

## LaunchAgent（开机自启）

```bash
cd desktop
npm run install-agent      # 写出 ~/Library/LaunchAgents/com.agentxray.pet.plist 并 launchctl load
npm run uninstall-agent    # launchctl unload + 删除 plist
```

- plist 路径：`~/Library/LaunchAgents/com.agentxray.pet.plist`（标签 `com.agentxray.pet`）。
- 日志：`~/.agentxray/pet/pet.log`、`~/.agentxray/pet/pet.err.log`。
- **护栏**：若 installer 由**纯 Node** 运行（`process.execPath` 是 `node`）且未设
  `AGENTXRAY_PET_EXEC`，安装会被**拒绝**并打印 warning——因为 `node main.js` 会因
  `require('electron')` 失败而崩溃。此时应改用 Electron 运行安装，或设置
  `AGENTXRAY_PET_EXEC=/path/to/Electron`。
- 打包模式：`AGENTXRAY_PET_MODE=packaged`（可搭配 `AGENTXRAY_PET_APP_BUNDLE`）。

## 皮肤包格式（P4，`~/.agentxray/pets/<name>/`）

把一套自定义动画丢进 `~/.agentxray/pets/<name>/`，宠物会自动换装；换装失败会**回退内置
像素动画**，绝不崩溃。目录约定：

```
~/.agentxray/pets/<name>/
├── pet.json                 # 清单（见下）
└── frames/
    ├── idle/*.png           # 文件名自然序即播放顺序
    ├── thinking/*.png
    ├── working/*.png
    ├── done/*.png
    ├── waiting_input/*.png
    └── error/*.png
```

`pet.json` 字段：

```jsonc
{
  "name": "我的皮肤",        // 必填，1–64 字
  "version": 1,             // 可选整数，默认 1（本设计只认 1）
  "fps": 8,                 // 必填，1–60
  "loop": true,             // 可选布尔，默认 true
  "scale": 2,               // 可选整数 1–8，默认 2（像素放大倍数）
  "anchor": { "x": 0.5, "y": 1.0 },  // 可选，帧内锚点，各 0–1
  "states": {               // 可选；键必须是 6 态之一，未知键仅告警
    "working": {
      "dir": "frames/working",  // 可选，默认 "frames/<state>"；禁止 .. 逃逸
      "fps": 12,                // 可选，覆盖全局
      "loop": true,             // 可选，默认继承全局
      "pingpong": true          // 可选布尔，默认 false（往复播放）
    }
  }
}
```

优先级：`AGENTXRAY_PET_PACK`（校验通过）→ `~/.agentxray/pets/` 下最近修改的一套 →
按名字典序第一套 → 内置像素动画。某 state 无帧文件即视为「未覆盖」，该 state 回退内置。

## 渲染层桥：`window.pet` 与 IPC 通道

renderer（`file://`，`contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`）**只有**
`window.pet` 一个出口，由 `preload.js` 经 `contextBridge` 暴露：

| `window.pet` | 方向 | 载荷 / 返回 |
|---|---|---|
| `getInfo()` | renderer → 主（invoke） | `{host,port,geom,grid,states,skin,debug}`；`skin={manifest,frames,source,name}` |
| `openSession({platform,sessionId,agent})` | renderer → 主（invoke） | `OpenSessionResult`（`{ok,action,detail}` 或 `{ok:false,error,fallback}`） |
| `setInteractive(bool)` | renderer → 主（invoke） | pointer 是否在热区；主进程去抖后调 `setIgnoreMouseEvents` |
| `drag({phase:'start'\|'end'})` | renderer → 主（invoke） | 拖动移动窗口（主进程按屏幕光标增量 `setBounds`） |
| `onState(cb)` | 主 → renderer（`pet:state`） | `{state,platform,sessionId,agent,bubble,updatedAt}` |
| `onStatus(cb)` | 主 → renderer（`pet:status`） | `{connected}` |
| `onFullscreen(cb)` | 主 → renderer（`pet:fullscreen`） | `{hidden}` |
| `onOpenResult(cb)` | 主 → renderer（`pet:open-result`） | `OpenSessionResult`（短暂气泡反馈） |

IPC 通道命名：`ipcMain.handle` = `pet:get-info` / `pet:open-session` / `pet:set-interactive` / `pet:drag`；
`webContents.send` = `pet:state` / `pet:status` / `pet:fullscreen` / `pet:open-result`。
**主进程不接受 renderer 传入的任意 URL/命令**（`open-session` 只接受 `{platform,sessionId,agent}`，路径由 `buildOpenRequest` 组装）。

## 后端两种模式（看门狗）

- **external-server**（用户已自行起服务）：启动时探测 `3800` 已占用 → 不 spawn，`childAlive` 恒 `true`；
  liveness 来自 SSE 帧 + 周期 `GET /api/version`。假死仍判定，重启动作退化为「重建 SSE + 重试 HTTP」。
- **own-server**（只想要宠物）：探测到 `3800` 未占用 → 用 `resolveNodeExec` 选出的 node
  `spawn(<node>, ['<repoRoot>/server.js'])`（stdout/stderr 接管道落盘，见上）；
  `childAlive` = 子进程未退出。崩溃/假死/启动即崩 → 退避重启，连杀到 `maxRestarts=5` → giveup（托盘提示）。
- `AGENTXRAY_PET_NO_WATCHDOG=1` 可整体关闭看门狗。renderer 进程崩溃**不走**看门狗：`render-process-gone` 直接重载窗口。

## 桌面壳 GUI 手动验收清单（需有人机环境执行）

本仓库 CI / 沙箱**无 GUI、装不了 Electron**，以下行为只能由有桌面环境（macOS）的一方手动执行。
每条给出「操作步骤 + 期望现象」。沙箱侧的替代验证见文末「无 GUI 环境的验证降级路径」。

### 1. 透明置顶
- **步骤**：`cd desktop && npm i && npm start`；把任意 App 窗口拖到宠物下方。
- **期望**：出现无边框、背景透明的小窗；宠物像素可见，其**透明区域**能透出下层应用；
  窗口始终浮于其它窗口之上（`alwaysOnTop('screen-saver')`）；Dock 无图标（后台应用，仅托盘）。
  关掉/重开仍在原位置（持久化于 `~/.agentxray/pet/window-state.json`）。

### 2. 点击穿透 + 热区可点（**仅 macOS**）
- **前置**：`forward:true` 的 mousemove 转发是 **macOS 特有语义**。非 macOS 一律**不做穿透**，
  窗口保持可交互（否则 renderer 收不到 pointer → 热区永不触发 → 宠物永久点不动），启动时打一条
  `非 macOS：不做点击穿透…` 日志。以下步骤需在 macOS 执行。
- **步骤 A**：把鼠标移到宠物**本体之外**的透明区域，点击。
- **期望 A**：点击**穿透**到下层应用（下层响应），宠物不拦截。
- **步骤 B**：把鼠标移到宠物本体（或气泡）上，点击。
- **期望 B**：宠物被点中（触发「跳回会话」，见第 4 条）；鼠标移开即恢复穿透。
- **步骤 C（安全阀）**：① **先点击宠物使其获得焦点**，再按 `Esc`；② 点其它窗口使宠物失焦；
  ③ 静置满 5s 后再点。
- **期望 C**：三者都会强制恢复穿透（点回下层应用），不会卡在可交互态。
  Esc 走 **renderer 本地 keydown**（非全局快捷键）——必须窗口已获焦点才生效，因此要先点一下宠物。
- **步骤 D（拖动）**：按住鼠标**左键**拖动宠物（位移超过 5px 才进入拖拽；原地松开 = 点击跳回会话）。
- **期望 D**：窗口跟随移动；松手后位置持久化。

### 3. 全屏自动隐藏
- **步骤**：先在「系统设置 → 隐私与安全性 → 辅助功能/自动化」给本 App 授权；进入任一全屏应用；再退出全屏。
- **期望**：进入全屏 → 宠物**自动隐藏**；退出全屏后**约 1.5s 恢复**（恢复去抖）。
- **未授权时**：**不隐藏、控制台仅首次告警一条**，主功能（穿透/跳回）不受影响。

### 4. 点击跳回终端 / App
- **步骤**：先让后端进入 `waiting_input`/`working`（如在 Claude Code 里制造一次等待确认）；点宠物本体。
- **期望**：CLI 平台 → 新开 iTerm2/Terminal 窗口并 `resume` 该会话；GUI 平台 → 深链/唤起对应 App。
  若失败且后端返回 `fallback`，则把 `path`/`command` **复制到剪贴板**并短暂提示。
  **任何时候都不向 agent 发送任何回复（N1）。**
- openclaw 会话会走 `/api/agents/:agent/sessions/:id/open`（与前端一致）。

### 5. 看门狗自拉（含「启动即崩」）
- **步骤 A（external 模式）**：先在根目录起后端（`node server.js`），再 `npm start` 起宠物；
  观察日志 `[pet:main] 检测到后端已在运行`。然后 `kill` 掉后端再重启它。
- **期望 A**：宠物不崩；自动重建 SSE；后端恢复后宠物继续更新。
- **步骤 B（own-server 模式）**：**不要**先起后端，直接 `npm start`；观察 `[pet:main] 已启动被监督的 server.js`。
  然后 `kill` 掉被监督的 server 进程。
- **期望 B**：约 2s 内出现 `[pet:watchdog] 重启（child-exited），退避 …`，随后自动拉起；
  连杀到 5 次 → `[pet:watchdog] 已达重启上限，放弃`，托盘提示「后端不可达」。
  被监督 server 的 **stderr** 可在 `~/.agentxray/pet/pet.err.log` 查看，且启动后**前 40 行**会实时
  打到 `[pet:main] [server:err] …`（崩溃时不再零线索）。
- **步骤 C（启动即崩回归）**：让被监督的 server 一启动就退出（或以 `AGENTXRAY_PET_EXEC` 指向一个立刻退出的脚本做等价验证）。
- **期望 C**：**首次 liveness 之前就崩**也会被判为 `child-exited` 并重启——不会永久静默（这是本批修复点）。

### 6. LaunchAgent 安装与卸载
- **步骤**：`npm run agent:install`（等价 `npm run install-agent`）；看 `ls -l ~/Library/LaunchAgents/com.agentxray.pet.plist`
  与 `launchctl list | grep com.agentxray.pet`；登出再登入。随后 `npm run agent:uninstall`。
- **期望**：plist 写出、`launchctl load -w` 成功、重登后自动拉起宠物；卸载后 plist 被删除、`launchctl list` 无该标签。
- **护栏**：若在纯 node 下执行安装，会打印 warning 并**拒绝安装**（退出码 1），**不写任何文件**。

## 无 GUI 环境的验证降级路径

- `npm run verify`：加载 `lib/*` 纯模块跑冒烟（config 默认值、SSE 分帧、buildFrame、
  decideWatchdog 含启动即崩、decideHidden、buildPlist、parseManifest、buildOpenRequest、
  resolveNodeExec 分支），输出 PASS/FAIL 并以退出码反映结果。
- 根仓库 `npm test`：`test/pet-shell-*.test.js` 只在**纯 Node** 下 require `desktop/lib/*`，
  不触碰 `main.js`/`preload.js`/`renderer/`。**透明/穿透/全屏/跳回/看门狗自拉**这些 GUI 行为
  只能在上面的人机清单里验证——沙箱仅能保证纯逻辑与装配契约。

## 默认外观：Codex 矢量吉祥物（`renderer/codex-pet.js`）

内置像素动画（`lib/pixel.js`）已**不再作为默认外观**，只留作兜底。renderer 的绘制优先级：

1. 皮肤帧（`PetSpriteRenderer`，用户皮肤包校验通过时）；
2. **Codex 矢量吉祥物**（`CodexPet.draw`，默认）——蓝色云朵头 + 深色终端屏（青色 `>_`）+
   小身体肚皮 `>_`，全部 Canvas 路径绘制，零图片；6 态动画：idle 呼吸 / thinking 三点 +
   歪头 / working 打字光标小跳 / done 绿勾一蹦 / waiting_input 问号弹跳 + 青色光环 /
   error 红叉抖动 + 红色光环；
3. 内置像素动画（兜底，`CodexPet` 缺失或 state 非法时，绝不画空白）。

点击热区由 `CodexPet.hotTest`（椭圆近似吉祥物轮廓）承担；像素兜底路径沿用原
`PetPixel.hotZone`。气泡锚点跟随实际绘制者提供（`bubblePx`）。

