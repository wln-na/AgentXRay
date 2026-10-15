// 桌面宠物壳的 LaunchAgent（macOS 开机自启）：plist 生成 + 可执行文件解析 + 安装/卸载。
//
// 本文件是【纯模块】：buildPlist 是纯 XML 生成；resolveProgramArgs 是纯决策；
// install/uninstall 的 `run`（launchctl）与 `fs` 全部可注入，测试可断言命令行，
// 绝不真跑 launchctl。

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fsp = require('node:fs/promises');

const execFileAsync = promisify(execFile);

/** 默认命令 runner（execFile，参数数组）。 */
async function defaultRun(file, args) {
  const { stdout } = await execFileAsync(file, args, { timeout: 8000 });
  return String(stdout).trim();
}

/** XML 文本节点转义：& < >（plist 为 UTF-8 XML）。 */
function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 生成 launchd plist XML 字符串。
 *
 * @param {object} spec
 * @param {string} spec.label                 例如 'com.agentxray.pet'
 * @param {string[]} spec.programArgs         ProgramArguments（至少 1 项）
 * @param {string} [spec.workingDir]          WorkingDirectory
 * @param {string} [spec.stdoutPath]          StandardOutPath
 * @param {string} [spec.stderrPath]          StandardErrorPath
 * @param {boolean} [spec.keepAlive=true]     KeepAlive
 * @param {boolean} [spec.runAtLoad=true]     RunAtLoad
 * @param {string} [spec.processType]         ProcessType（默认 Background）
 * @returns {string} 完整 <plist>…</plist>
 */
function buildPlist(spec = {}) {
  if (!Array.isArray(spec.programArgs) || spec.programArgs.length === 0) {
    throw new Error('buildPlist: programArgs 至少需要一项');
  }
  const processType = spec.processType || 'Background';
  const keepAlive = spec.keepAlive === undefined ? true : !!spec.keepAlive;
  const runAtLoad = spec.runAtLoad === undefined ? true : !!spec.runAtLoad;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
  ];
  for (const arg of spec.programArgs) {
    lines.push(`    <string>${escapeXml(arg)}</string>`);
  }
  lines.push('  </array>');
  if (spec.workingDir) {
    lines.push('  <key>WorkingDirectory</key>');
    lines.push(`  <string>${escapeXml(spec.workingDir)}</string>`);
  }
  if (spec.stdoutPath) {
    lines.push('  <key>StandardOutPath</key>');
    lines.push(`  <string>${escapeXml(spec.stdoutPath)}</string>`);
  }
  if (spec.stderrPath) {
    lines.push('  <key>StandardErrorPath</key>');
    lines.push(`  <string>${escapeXml(spec.stderrPath)}</string>`);
  }
  lines.push('  <key>KeepAlive</key>');
  lines.push(keepAlive ? '  <true/>' : '  <false/>');
  lines.push('  <key>RunAtLoad</key>');
  lines.push(runAtLoad ? '  <true/>' : '  <false/>');
  lines.push('  <key>ProcessType</key>');
  lines.push(`  <string>${escapeXml(processType)}</string>`);
  lines.push('</dict>', '</plist>');

  return lines.join('\n');
}

/** 判断一个可执行路径是否「纯 node」（而非 Electron 二进制）。 */
function isPlainNode(execPath) {
  if (typeof execPath !== 'string' || execPath === '') return false;
  return /^node(\.exe)?$/i.test(path.basename(execPath));
}

/**
 * 纯决策：LaunchAgent 该拉起的可执行 + 参数。
 *
 * 护栏：mode='dev' 且 execPath 是纯 node 且无 AGENTXRAY_PET_EXEC 覆盖时，返回 warning，
 * 让 install 拒绝执行——否则会写出一个必然因缺少 Electron 运行时而崩溃的 agent。
 *
 * @param {object} opts
 * @param {'dev'|'packaged'} opts.mode
 * @param {string} [opts.execPath]    运行 installer 时的可执行（默认 process.execPath）
 * @param {string} [opts.desktopDir]  <repo>/desktop 的绝对路径
 * @param {string} [opts.appBundle]   packaged 模式：'/Applications/AgentXRay Pet.app'
 * @param {string} [opts.override]    AGENTXRAY_PET_EXEC，最高优先级
 * @returns {{programArgs: string[], resolvedMode: 'dev'|'packaged'|'override', warning?: string}}
 */
function resolveProgramArgs(opts = {}) {
  const execPath = opts.execPath || process.execPath;
  const desktopDir = opts.desktopDir || '';
  const mainPath = desktopDir ? path.join(desktopDir, 'main.js') : 'main.js';
  const override = opts.override || process.env.AGENTXRAY_PET_EXEC || '';

  if (override) {
    return { programArgs: [override, mainPath], resolvedMode: 'override' };
  }

  if (opts.mode === 'packaged') {
    const bundle = opts.appBundle || '/Applications/AgentXRay Pet.app';
    return {
      programArgs: [path.join(bundle, 'Contents', 'MacOS', 'agent-xray-pet')],
      resolvedMode: 'packaged',
    };
  }

  // dev 模式：execPath 应为 Electron 二进制。
  if (isPlainNode(execPath)) {
    return {
      programArgs: [execPath, mainPath],
      resolvedMode: 'dev',
      warning:
        `当前 installer 由纯 Node 运行（${execPath}）；启动桌面壳需要 Electron 可执行文件。` +
        '请用 Electron 运行安装（npm start 后的托盘菜单），或设置 AGENTXRAY_PET_EXEC 指向 Electron 二进制。',
    };
  }
  return { programArgs: [execPath, mainPath], resolvedMode: 'dev' };
}

/**
 * 安装 LaunchAgent：先 unload（容忍未加载错误）→ 写 plist → load。
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} opts.plist     buildPlist 产出的 XML
 * @param {string} opts.plistDir  plist 目录（如 ~/Library/LaunchAgents）
 * @param {Function} [opts.run]
 * @param {object} [opts.fs]      含 mkdir/writeFile/rm 的对象（默认 fs/promises）
 * @returns {Promise<{ok: boolean, plistPath: string, error?: string}>}
 */
async function install(opts = {}) {
  const run = opts.run || defaultRun;
  const fs = opts.fs || fsp;
  const plistPath = path.join(opts.plistDir, `${opts.label}.plist`);

  try {
    await run('launchctl', ['unload', '-w', plistPath]);
  } catch {
    // 尚未加载 → 忽略。
  }

  try {
    await fs.mkdir(opts.plistDir, { recursive: true });
    await fs.writeFile(plistPath, opts.plist, 'utf8');
  } catch (err) {
    return { ok: false, plistPath, error: `写入 plist 失败：${err?.message ? err.message : err}` };
  }

  try {
    await run('launchctl', ['load', '-w', plistPath]);
  } catch (err) {
    return { ok: false, plistPath, error: `launchctl load 失败：${err?.message ? err.message : err}` };
  }

  return { ok: true, plistPath };
}

/**
 * 卸载 LaunchAgent：launchctl unload → 删除 plist。
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} opts.plistDir
 * @param {Function} [opts.run]
 * @param {object} [opts.fs]
 * @returns {Promise<{ok: boolean, plistPath: string, error?: string}>}
 */
async function uninstall(opts = {}) {
  const run = opts.run || defaultRun;
  const fs = opts.fs || fsp;
  const plistPath = path.join(opts.plistDir, `${opts.label}.plist`);
  let ok = true;
  let error;

  try {
    await run('launchctl', ['unload', '-w', plistPath]);
  } catch (err) {
    ok = false;
    error = `launchctl unload 失败：${err?.message ? err.message : err}`;
  }

  try {
    await fs.rm(plistPath, { force: true });
  } catch {
    // 文件不存在也视为清理完成。
  }

  return error ? { ok, plistPath, error } : { ok, plistPath };
}

module.exports = {
  escapeXml,
  buildPlist,
  isPlainNode,
  resolveProgramArgs,
  install,
  uninstall,
};
