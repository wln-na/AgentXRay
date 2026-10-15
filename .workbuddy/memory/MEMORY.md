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

## CodeQL / 安全扫描

仓库开启的是 CodeQL **default setup**，它与工作流里的 `analyze` job 是**两个独立检查项**：

- `analyze`（`.github/workflows/codeql.yml` 的 job）成功，不代表 `CodeQL` 这项会绿。
- `CodeQL` 检查的结论是「**本 PR 改动中新增的告警**」，有新增告警就以 `FAILURE` 结束（`gh pr checks` 里显示几秒即 fail，去 `actions/runs/<id>` 会 404 —— 因为它是 check-run 不是 workflow run）。
- 查告警详情：`gh api "repos/wln-na/AgentXRay/code-scanning/alerts?state=open&pr=<N>" -q '.[] | {num:.number, rule:.rule.id, sev:.rule.security_severity_level, path:.most_recent_instance.location.path, line:.most_recent_instance.location.start_line, msg:.most_recent_instance.message.text}'`

### ★ `Math.min/Math.max` 不是 CodeQL 认可的消毒器

`js/resource-exhaustion` 会把 `setInterval(fn, Math.min(10000, Math.max(500, req.query.x)))` 判为
**high 级「定时器时长由用户可控」**，即使运行时确实已被夹紧（纯误报，但会让 PR 变红）。

**修法**：把边界写成**到达 sink 的那个值上的显式比较守卫**，抽成单独可测的函数：

```js
function clampIntervalMs(raw) {
  const n = numOr(raw, DEFAULT_INTERVAL_MS);
  if (n < MIN_INTERVAL_MS) return MIN_INTERVAL_MS;
  if (n > MAX_INTERVAL_MS) return MAX_INTERVAL_MS;
  return n;
}
```

实测改完 `CodeQL` 立即 `pass`。注意重构时要**逐探针比对新旧表达式**保证零语义变化
（`Number('')` / `Number(null)` 都等于 `0` 是有限数，会走下限而不是回退默认值）。

- 辅助函数按仓库既有惯例挂到导出函数上供测试用（先例：`lib/routes/watch.js` 的
  `module.exports.watchSnapshotSession`）。
- 同类历史修复：PR #23 `fix(open): restrict locate/open to session-log roots (CodeQL path injection)`。

## 代码约定

- `biome.json` 的 `files.includes` 是**白名单**：新增目录（如 `desktop/`）不追加进去就完全逃过 CI lint。
- 根 `package.json` 的 `files` 白名单不含 `desktop/`，`electron` 只在子包 `optionalDependencies` —— 这是 PRD N4「Electron 不进主 npm 包」的落实方式。
- 根 `package.json` 无 `workspaces`，所以 `npm ci` 不会去装子包依赖。
