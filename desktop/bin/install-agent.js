#!/usr/bin/env node
// `agent-xray-pet install-agent` / `uninstall-agent`：调用 lib/launchagent.js，
// 写出 ~/Library/LaunchAgents/com.agentxray.pet.plist 并做 launchctl load/unload。
//
// 纯 node 下运行（execPath 非 Electron）会被 resolveProgramArgs 拒绝——否则会写出一个
// 必然因缺少 Electron 运行时而崩溃的 agent。真正的安装应在 Electron 内或经
// AGENTXRAY_PET_EXEC 指定 Electron 二进制。

const path = require('node:path');
const { LAUNCH_AGENT_LABEL, PLIST_PATH, PET_LOG, PET_ERR_LOG } = require('../lib/config');
const { buildPlist, resolveProgramArgs, install, uninstall } = require('../lib/launchagent');

function desktopDir() {
  return path.join(__dirname, '..');
}

function plistDir() {
  return path.dirname(PLIST_PATH);
}

async function doInstall() {
  const resolved = resolveProgramArgs({
    mode: process.env.AGENTXRAY_PET_MODE === 'packaged' ? 'packaged' : 'dev',
    execPath: process.execPath,
    desktopDir: desktopDir(),
    appBundle: process.env.AGENTXRAY_PET_APP_BUNDLE,
    override: process.env.AGENTXRAY_PET_EXEC,
  });

  if (resolved.warning) {
    console.error(`[pet:launchagent] ${resolved.warning}`);
    console.error('[pet:launchagent] 已拒绝安装（避免写出无法启动的 agent）。');
    process.exit(1);
  }

  const plist = buildPlist({
    label: LAUNCH_AGENT_LABEL,
    programArgs: resolved.programArgs,
    workingDir: desktopDir(),
    stdoutPath: PET_LOG,
    stderrPath: PET_ERR_LOG,
  });

  console.log(`[pet:launchagent] 模式：${resolved.resolvedMode}`);
  console.log(`[pet:launchagent] ProgramArguments：${resolved.programArgs.join(' ')}`);

  const result = await install({ label: LAUNCH_AGENT_LABEL, plist, plistDir: plistDir() });
  if (result.ok) {
    console.log(`[pet:launchagent] 已安装：${result.plistPath}`);
    process.exit(0);
  }
  console.error(`[pet:launchagent] 安装失败：${result.error}`);
  process.exit(1);
}

async function doUninstall() {
  const result = await uninstall({ label: LAUNCH_AGENT_LABEL, plistDir: plistDir() });
  if (result.ok) {
    console.log(`[pet:launchagent] 已卸载：${result.plistPath}`);
    process.exit(0);
  }
  console.error(`[pet:launchagent] 卸载失败：${result.error}`);
  process.exit(1);
}

async function main() {
  const command = process.argv[2];
  if (command === 'install-agent') return doInstall();
  if (command === 'uninstall-agent') return doUninstall();
  console.log('用法：agent-xray-pet <install-agent|uninstall-agent>');
  process.exit(2);
}

main().catch((err) => {
  console.error(`[pet:launchagent] 未预期的错误：${err?.message ? err.message : err}`);
  process.exit(1);
});
