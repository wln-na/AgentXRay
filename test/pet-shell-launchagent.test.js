// 桌面宠物壳 LaunchAgent 单测：buildPlist（结构与转义）+ resolveProgramArgs（dev/packaged/
// override/纯 node 护栏）+ install/uninstall（假 run + 假 fs，断言命令行）。绝不真跑 launchctl。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 确保环境不干扰 override 分支。
delete process.env.AGENTXRAY_PET_EXEC;

const { buildPlist, resolveProgramArgs, install, uninstall, isPlainNode } = require(
  path.join(__dirname, '..', 'desktop', 'lib', 'launchagent')
);

function recordingRun() {
  const calls = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push({ file, args: args.slice() });
      return '';
    },
  };
}

function fakeFs() {
  const ops = [];
  return {
    ops,
    fs: {
      mkdir: async (p, o) => {
        ops.push({ op: 'mkdir', p, o });
      },
      writeFile: async (p, c, e) => {
        ops.push({ op: 'writeFile', p, c, e });
      },
      rm: async (p, o) => {
        ops.push({ op: 'rm', p, o });
      },
    },
  };
}

// --- buildPlist ---

test('buildPlist 生成完整 plist 结构', () => {
  const xml = buildPlist({
    label: 'com.agentxray.pet',
    programArgs: ['/app/Electron', '/app/main.js'],
    workingDir: '/app',
    stdoutPath: '/logs/pet.log',
    stderrPath: '/logs/pet.err.log',
  });
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<plist version="1.0">'));
  assert.ok(xml.endsWith('</plist>'));
  assert.ok(xml.includes('<key>Label</key>\n  <string>com.agentxray.pet</string>'));
  assert.ok(xml.includes('<key>ProgramArguments</key>'));
  assert.ok(xml.includes('<string>/app/Electron</string>'));
  assert.ok(xml.includes('<string>/app/main.js</string>'));
  assert.ok(xml.includes('<key>WorkingDirectory</key>'));
  assert.ok(xml.includes('<key>StandardOutPath</key>'));
  assert.ok(xml.includes('<key>StandardErrorPath</key>'));
  assert.ok(xml.includes('<key>KeepAlive</key>\n  <true/>'));
  assert.ok(xml.includes('<key>RunAtLoad</key>\n  <true/>'));
  assert.ok(xml.includes('<key>ProcessType</key>\n  <string>Background</string>'));
});

test('buildPlist 转义 & < >，并支持 keepAlive/runAtLoad=false', () => {
  const xml = buildPlist({
    label: 'a&b<c>',
    programArgs: ['x&y', 'p<q>r'],
    keepAlive: false,
    runAtLoad: false,
  });
  assert.ok(xml.includes('<string>a&amp;b&lt;c&gt;</string>'));
  assert.ok(xml.includes('<string>x&amp;y</string>'));
  assert.ok(xml.includes('<string>p&lt;q&gt;r</string>'));
  assert.ok(xml.includes('<key>KeepAlive</key>\n  <false/>'));
  assert.ok(xml.includes('<key>RunAtLoad</key>\n  <false/>'));
});

test('buildPlist 空 programArgs 抛错', () => {
  assert.throws(() => buildPlist({ label: 'x', programArgs: [] }), /programArgs/);
});

// --- resolveProgramArgs ---

test('resolveProgramArgs：dev + Electron 可执行 → 无 warning', () => {
  const r = resolveProgramArgs({
    mode: 'dev',
    execPath: '/Applications/Electron.app/Contents/MacOS/Electron',
    desktopDir: '/repo/desktop',
    override: '',
  });
  assert.deepEqual(r.programArgs, ['/Applications/Electron.app/Contents/MacOS/Electron', '/repo/desktop/main.js']);
  assert.equal(r.resolvedMode, 'dev');
  assert.equal(r.warning, undefined);
});

test('resolveProgramArgs：dev + 纯 node → 返回 warning（护栏）', () => {
  const r = resolveProgramArgs({
    mode: 'dev',
    execPath: '/usr/local/bin/node',
    desktopDir: '/repo/desktop',
    override: '',
  });
  assert.equal(r.resolvedMode, 'dev');
  assert.ok(r.warning, '纯 node 必须给出 warning');
  assert.match(r.warning, /Electron/);
  assert.ok(isPlainNode('/usr/bin/node.exe'));
  assert.equal(isPlainNode('/Applications/Electron.app/Contents/MacOS/Electron'), false);
});

test('resolveProgramArgs：packaged → app bundle 内可执行', () => {
  const r = resolveProgramArgs({
    mode: 'packaged',
    appBundle: '/Applications/AgentXRay Pet.app',
    desktopDir: '/repo/desktop',
    override: '',
  });
  assert.deepEqual(r.programArgs, ['/Applications/AgentXRay Pet.app/Contents/MacOS/agent-xray-pet']);
  assert.equal(r.resolvedMode, 'packaged');
  assert.equal(r.warning, undefined);
});

test('resolveProgramArgs：override 最高优先级', () => {
  const r = resolveProgramArgs({
    mode: 'dev',
    execPath: '/usr/local/bin/node',
    desktopDir: '/repo/desktop',
    override: '/custom/Electron',
  });
  assert.deepEqual(r.programArgs, ['/custom/Electron', '/repo/desktop/main.js']);
  assert.equal(r.resolvedMode, 'override');
  assert.equal(r.warning, undefined);
});

// --- install / uninstall ---

test('install：先 unload → 写文件 → load，返回 plistPath', async () => {
  const { run, calls } = recordingRun();
  const { fs, ops } = fakeFs();
  const result = await install({
    label: 'com.agentxray.pet',
    plist: '<plist/>',
    plistDir: '/LaunchAgents',
    run,
    fs,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plistPath, '/LaunchAgents/com.agentxray.pet.plist');
  assert.deepEqual(calls, [
    { file: 'launchctl', args: ['unload', '-w', '/LaunchAgents/com.agentxray.pet.plist'] },
    { file: 'launchctl', args: ['load', '-w', '/LaunchAgents/com.agentxray.pet.plist'] },
  ]);
  const write = ops.find((o) => o.op === 'writeFile');
  assert.ok(write, '应写入 plist 文件');
  assert.equal(write.p, '/LaunchAgents/com.agentxray.pet.plist');
  assert.equal(write.c, '<plist/>');
});

test('install：unload 失败被容忍（尚未加载）', async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args: args.slice() });
    if (args[0] === 'unload') throw new Error('not loaded');
    return '';
  };
  const { fs } = fakeFs();
  const result = await install({ label: 'l', plist: 'x', plistDir: '/L', run, fs });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test('install：写文件失败 / load 失败 → ok:false 且带 error', async () => {
  const { run } = recordingRun();
  const writeFailFs = {
    mkdir: async () => {},
    writeFile: async () => {
      throw new Error('disk full');
    },
    rm: async () => {},
  };
  const r1 = await install({ label: 'l', plist: 'x', plistDir: '/L', run, fs: writeFailFs });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /写入 plist 失败/);

  const loadFailRun = async (_file, args) => {
    if (args[0] === 'load') throw new Error('load rejected');
    return '';
  };
  const { fs } = fakeFs();
  const r2 = await install({ label: 'l', plist: 'x', plistDir: '/L', run: loadFailRun, fs });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /launchctl load 失败/);
});

test('uninstall：unload 并删除 plist', async () => {
  const { run, calls } = recordingRun();
  const { fs, ops } = fakeFs();
  const result = await uninstall({ label: 'com.agentxray.pet', plistDir: '/LaunchAgents', run, fs });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ file: 'launchctl', args: ['unload', '-w', '/LaunchAgents/com.agentxray.pet.plist'] }]);
  assert.ok(ops.some((o) => o.op === 'rm' && o.p === '/LaunchAgents/com.agentxray.pet.plist'));
});

test('uninstall：launchctl unload 失败 → ok:false', async () => {
  const { fs } = fakeFs();
  const run = async () => {
    throw new Error('nope');
  };
  const result = await uninstall({ label: 'l', plistDir: '/L', run, fs });
  assert.equal(result.ok, false);
  assert.match(result.error, /launchctl unload 失败/);
});
