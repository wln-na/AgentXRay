# AgentXRay 项目长期记忆

## 仓库与 PR 约定

- 本地仓库 `/Users/linda/Projects/aicode_library/AgentXRay`；`origin` = fork **`wln-na/AgentXRay`**；`upstream` = `alloevil/AgentXRay`。
- ★ **PR 一律提给 `wln-na/AgentXRay` 自己的 `master`**。历史上从未向上游提过 PR（`gh pr list --repo alloevil/AgentXRay --author wln-na` 返回空）；PR #10–#26 全部是 fork 内部的自提自合。
- **fork 的 master 与上游长期分叉，不要当上游快照用**：上游已到 v1.24.0，本地 master 有 60 个上游没有的提交（doubao 适配器、open-session 深链、pet 等），同时缺上游 34 个提交。拿本地 master 去对上游开 PR 会变成 223 文件 / ±36000 行的错乱 diff。
- 分支命名沿用 `feat/<topic>` / `fix/<topic>`；提交信息用 `type(scope): 中文描述`（近期惯例），**不加** AI 署名 footer。

## CI 触发条件（决定 PR 形态）

`.github/workflows/test.yml` 与 `codeql.yml` 都是 `pull_request: branches: [master]`：

- **只有 base 是 `master` 的 PR 才会跑 CI。**
- **堆叠 PR（base 是另一个特性分支）不会触发任何检查** —— `gh pr checks` 显示 `no checks reported`。需靠本地隔离复现，或等下一层合并后 retarget 到 master。

## 验证方法（教训：工作区绿 ≠ 提交绿）

- `npm test` = `node --test test/*.test.js`，按**文件系统** glob —— 工作区里未跟踪的测试文件也会被跑，因此"工作区全绿"会掩盖某个提交自己红。
- 正确做法：`git worktree add --detach <dir> <commit>` 只检出该提交，再 `ln -sfn` 根与 `frontend/node_modules` 进去跑，跑完 `git worktree remove --force`。
- ★ **worktree 必须建在 `$HOME` 内，绝不能放 `/tmp`**：`lib/platforms/codex.js` 的 `collectCodexSessionEntries` 有 `isPathWithin(HOME, ...)` 纵深防御，逃出 HOME 直接抛 `Directory path escapes allowed scope`，会让 `test/performance.test.js` 假失败（曾误判为真缺陷）。
- CI 四步及本地等价复现：
  1. `npm ci`（`prepare` 会触发 `tsc -b && vite build`）→ 本地用 `npm run build:ui`
  2. `git diff --exit-code public/js/pure.js`（生成物漂移检查）
  3. `npx biome check .`（整仓，exit 0 = 通过；有 warning/info 不影响）
  4. `npm test`

## 代码约定

- `biome.json` 的 `files.includes` 是**白名单**：新增目录（如 `desktop/`）不追加进去就完全逃过 CI lint。
- 根 `package.json` 的 `files` 白名单不含 `desktop/`，`electron` 只在子包 `optionalDependencies` —— 这是 PRD N4「Electron 不进主 npm 包」的落实方式。
- 根 `package.json` 无 `workspaces`，所以 `npm ci` 不会去装子包依赖。
