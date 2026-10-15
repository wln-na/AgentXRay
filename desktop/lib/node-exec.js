// 桌面宠物壳的 node 可执行解析（own-server 模式专用，纯模块）。
//
// 为什么需要它：Electron 下 `process.execPath` 是 Electron 二进制，直接 spawn 跑 server.js 会
// 启动一个 App 而非脚本；即便注入 ELECTRON_RUN_AS_NODE=1 用 Electron 内置 Node 去 require
// 为本机 Node 编译的原生模块（server.js 顶层经 lib/platforms/*、lib/search-index.js 硬依赖
// better-sqlite3），ABI 大概率不匹配 → 启动即崩 → 看门狗重启 → giveup。故优先用「真正的 node」。
//
// 本文件是【纯模块】：`env`/`whichImpl`/`existsImpl` 全部可注入，测试不碰真实进程/文件系统。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

/** 默认真实实现：`which <name>`（失败返回 null）。 */
function defaultWhich(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** 默认真实实现：路径存在**且是普通文件**（目录不算合法 node 可执行；异常一律视为不存在）。 */
function defaultExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeWhich(whichImpl, name) {
  try {
    return whichImpl(name);
  } catch {
    return null;
  }
}

function safeExists(existsImpl, p) {
  try {
    return !!existsImpl(p);
  } catch {
    return false;
  }
}

const ELECTRON_FALLBACK_WARNING =
  '未找到独立的 node 可执行（AGENTXRAY_PET_NODE / PATH 下的 node / npm_node_execpath 均不可用）；' +
  '将回退用 Electron 内置 Node（ELECTRON_RUN_AS_NODE=1）运行 server.js。若根包原生模块' +
  '（better-sqlite3）ABI 不匹配，会启动即崩——请设置 AGENTXRAY_PET_NODE 指向构建原生模块所用的 node。';

/**
 * 纯决策：own-server 模式该用哪个 node 启动 server.js。
 *
 * 发现顺序（命中即止）：
 *   ① `AGENTXRAY_PET_NODE`            → source 'env'
 *   ② PATH 下的 `node`（whichImpl）    → source 'which'
 *   ③ `process.env.npm_node_execpath` → source 'npm'
 *   ④ 回退 `execPath` + ELECTRON_RUN_AS_NODE=1 → source 'electron'（**必带 warning**）
 * 不猜测 nvm/Homebrew 等具体路径——只走上面四条。
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]        默认 process.env
 * @param {string} [opts.execPath]                            默认 process.execPath（Electron 二进制）
 * @param {(name: string) => string|null} [opts.whichImpl]    默认真实 `which`
 * @param {(p: string) => boolean} [opts.existsImpl]          默认真实「存在且是普通文件」校验
 * @returns {{exec: string, injectElectronRunAsNode: boolean, source: 'env'|'which'|'npm'|'electron', warning?: string}}
 */
function resolveNodeExec(opts = {}) {
  const env = opts.env || process.env || {};
  const execPath = opts.execPath || process.execPath;
  const whichImpl = opts.whichImpl || defaultWhich;
  const existsImpl = opts.existsImpl || defaultExists;

  const candidates = [
    { source: 'env', value: env.AGENTXRAY_PET_NODE },
    { source: 'which', value: safeWhich(whichImpl, 'node') },
    { source: 'npm', value: env.npm_node_execpath },
  ];

  for (const candidate of candidates) {
    if (typeof candidate.value === 'string' && candidate.value && safeExists(existsImpl, candidate.value)) {
      return { exec: candidate.value, injectElectronRunAsNode: false, source: candidate.source };
    }
  }

  return {
    exec: execPath,
    injectElectronRunAsNode: true,
    source: 'electron',
    warning: ELECTRON_FALLBACK_WARNING,
  };
}

module.exports = { resolveNodeExec, defaultWhich, defaultExists, ELECTRON_FALLBACK_WARNING };
