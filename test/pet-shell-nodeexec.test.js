// 桌面宠物壳 node 可执行解析单测：4 条发现分支 + warning 分支 + 优先级 + 注入实现抛错的容错。
// 纯 Node，注入 fake whichImpl/existsImpl/env，不碰真实进程/文件系统。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsSync = require('node:fs');

const { resolveNodeExec } = require(path.join(__dirname, '..', 'desktop', 'lib', 'node-exec'));

test('分支① AGENTXRAY_PET_NODE 存在 → source env', () => {
  const r = resolveNodeExec({
    env: { AGENTXRAY_PET_NODE: '/opt/node/bin/node' },
    execPath: '/electron',
    whichImpl: () => '/usr/bin/node',
    existsImpl: (p) => p === '/opt/node/bin/node',
  });
  assert.equal(r.exec, '/opt/node/bin/node');
  assert.equal(r.source, 'env');
  assert.equal(r.injectElectronRunAsNode, false);
  assert.equal(r.warning, undefined);
});

test('分支② PATH 下的 node（which）→ source which', () => {
  const r = resolveNodeExec({
    env: {},
    execPath: '/electron',
    whichImpl: (name) => (name === 'node' ? '/usr/local/bin/node' : null),
    existsImpl: () => true,
  });
  assert.equal(r.exec, '/usr/local/bin/node');
  assert.equal(r.source, 'which');
  assert.equal(r.injectElectronRunAsNode, false);
});

test('分支③ npm_node_execpath → source npm', () => {
  const r = resolveNodeExec({
    env: { npm_node_execpath: '/nvm/versions/node/node' },
    execPath: '/electron',
    whichImpl: () => null,
    existsImpl: (p) => p === '/nvm/versions/node/node',
  });
  assert.equal(r.exec, '/nvm/versions/node/node');
  assert.equal(r.source, 'npm');
  assert.equal(r.injectElectronRunAsNode, false);
});

test('分支④ 回退 Electron 内置 Node → source electron 且必带 warning', () => {
  const r = resolveNodeExec({
    env: {},
    execPath: '/Applications/Electron.app/Contents/MacOS/Electron',
    whichImpl: () => null,
    existsImpl: () => false,
  });
  assert.equal(r.exec, '/Applications/Electron.app/Contents/MacOS/Electron');
  assert.equal(r.source, 'electron');
  assert.equal(r.injectElectronRunAsNode, true);
  assert.ok(r.warning, '回退分支必须带 warning');
  assert.match(r.warning, /AGENTXRAY_PET_NODE|ABI/);
});

test('优先级：env 指向不存在的路径 → 忽略并落到 which', () => {
  const r = resolveNodeExec({
    env: { AGENTXRAY_PET_NODE: '/gone/node' },
    execPath: '/e',
    whichImpl: () => '/usr/bin/node',
    existsImpl: (p) => p === '/usr/bin/node',
  });
  assert.equal(r.source, 'which');
  assert.equal(r.exec, '/usr/bin/node');
});

test('优先级：env 与 which 均可用 → 取 env', () => {
  const r = resolveNodeExec({
    env: { AGENTXRAY_PET_NODE: '/a/node' },
    execPath: '/e',
    whichImpl: () => '/b/node',
    existsImpl: () => true,
  });
  assert.equal(r.exec, '/a/node');
  assert.equal(r.source, 'env');
});

test('注入实现抛错 → 不抛，安全回退 electron', () => {
  const r = resolveNodeExec({
    env: {},
    execPath: '/e',
    whichImpl: () => {
      throw new Error('which crashed');
    },
    existsImpl: () => {
      throw new Error('exists crashed');
    },
  });
  assert.equal(r.source, 'electron');
  assert.equal(r.injectElectronRunAsNode, true);
  assert.ok(r.warning);
});

test('缺省入参不抛（用真实 which/execPath 冒烟）', () => {
  const r = resolveNodeExec({ env: {} });
  assert.ok(['which', 'npm', 'electron'].includes(r.source));
  assert.equal(typeof r.exec, 'string');
  assert.ok(r.exec.length > 0);
});

test('默认可执行校验：候选是目录 → 跳过（目录不是合法 node）并落到 electron', () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'axr-nodeexec-dir-'));
  try {
    const r = resolveNodeExec({
      env: { AGENTXRAY_PET_NODE: dir }, // 真实目录
      execPath: '/electron',
      whichImpl: () => null,
      // 不注入 existsImpl → 走默认「存在且是普通文件」校验：目录应被拒。
    });
    assert.equal(r.source, 'electron');
    assert.equal(r.exec, '/electron');
    assert.equal(r.injectElectronRunAsNode, true);
    assert.ok(r.warning);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test('默认可执行校验：候选是真实文件 → 接受（与目录相对照）', () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'axr-nodeexec-file-'));
  try {
    const file = path.join(dir, 'node');
    fsSync.writeFileSync(file, '#!/bin/sh\n');
    const r = resolveNodeExec({
      env: { AGENTXRAY_PET_NODE: file }, // 真实普通文件
      execPath: '/electron',
      whichImpl: () => null,
    });
    assert.equal(r.source, 'env');
    assert.equal(r.exec, file);
    assert.equal(r.injectElectronRunAsNode, false);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});
