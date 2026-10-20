// 桌面宠物壳的纯配置层：解析环境变量 + 计算路径常量。
//
// 与根包 lib/config.js 的 `~/.agentxray/` 数据目录约定保持同构：桌面壳自身
// 的状态目录是 `~/.agentxray/pet`，用户皮肤目录是 `~/.agentxray/pets`。
//
// 本文件是【纯模块】：不 require electron、不产生副作用，可被根 `node --test`
// 直接 require。默认值在模块加载时用 process.env 解析一次（与 lib/config.js
// 一致），同时导出 createConfig(env) 以便测试注入环境变量。

const path = require('node:path');

// LaunchAgent 标签与 plist 位置（macOS 约定，固定值）。
const LAUNCH_AGENT_LABEL = 'com.agentxray.pet';

// 状态枚举（单一事实源）：必须与 frontend/src/api/types.ts 的 PetStateName 以及
// lib/pet-state.js 的取值完全一致。顺序即 PRD §4.1 的枚举列举顺序——桌面壳只渲染，
// 不重排优先级（优先级由 lib/pet-aggregator.js 决定）。
const PET_STATES = Object.freeze(['idle', 'thinking', 'working', 'done', 'waiting_input', 'error']);

/**
 * 根据给定的环境变量对象（默认真实 process.env）计算全部配置项。
 *
 * @param {Record<string, string|undefined>} [env] 环境变量来源，便于单测注入。
 * @returns {{
 *   HOME: string, HOST: string, PORT: number,
 *   PET_DIR: string, PETS_DIR: string, PACK: string, EXEC: string, NODE: string,
 *   NO_WATCHDOG: boolean, DEBUG: boolean,
 *   PET_LOG: string, PET_ERR_LOG: string, WINDOW_STATE: string, PLIST_PATH: string
 * }}
 */
function createConfig(env = process.env) {
  const HOME = env.HOME || '/root';
  const HOST = env.AGENTXRAY_PET_HOST || '127.0.0.1';
  const PORT = Number(env.AGENTXRAY_PET_PORT) || 3800;
  const PET_DIR = env.AGENTXRAY_PET_DIR || path.join(HOME, '.agentxray', 'pet');
  const PETS_DIR = env.AGENTXRAY_PET_PETS_DIR || path.join(HOME, '.agentxray', 'pets');
  const PACK = env.AGENTXRAY_PET_PACK || '';
  const EXEC = env.AGENTXRAY_PET_EXEC || '';
  // own-server 模式下用于 spawn server.js 的 node 可执行（空 → 用 process.execPath 并以
  // ELECTRON_RUN_AS_NODE 运行）。当根包原生模块与 Electron 的 Node ABI 不匹配时，指向系统 node。
  const NODE = env.AGENTXRAY_PET_NODE || '';
  const NO_WATCHDOG = env.AGENTXRAY_PET_NO_WATCHDOG === '1';
  const DEBUG = env.AGENTXRAY_PET_DEBUG === '1';
  const PET_LOG = path.join(PET_DIR, 'pet.log');
  const PET_ERR_LOG = path.join(PET_DIR, 'pet.err.log');
  const WINDOW_STATE = path.join(PET_DIR, 'window-state.json');
  const PLIST_PATH = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

  return {
    HOME,
    HOST,
    PORT,
    PET_DIR,
    PETS_DIR,
    PACK,
    EXEC,
    NODE,
    NO_WATCHDOG,
    DEBUG,
    PET_LOG,
    PET_ERR_LOG,
    WINDOW_STATE,
    PLIST_PATH,
  };
}

// 模块加载时解析一次的默认配置（对齐 lib/config.js 的用法）。
const config = createConfig();

module.exports = {
  LAUNCH_AGENT_LABEL,
  PET_STATES,
  createConfig,
  ...config,
};
