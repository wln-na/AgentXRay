// 桌面宠物壳精灵图包单测：parseManifest 校验（人话错误、不抛）+ resolveFrame（loop/pingpong/
// 末帧保持/frameCount<=0）+ scanPacks（假 fs + 真实 fs 临时目录）/selectPack 优先级。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsSync = require('node:fs');
const vm = require('node:vm');

const { parseManifest, scanPacks, selectPack, resolveFrame, triangle, listStateFrames, naturalCompare } = require(
  path.join(__dirname, '..', 'desktop', 'lib', 'sprite')
);

// --- parseManifest ---

test('parseManifest：最小合法清单规范化默认值', () => {
  const res = parseManifest(JSON.stringify({ name: '我的皮肤', fps: 8 }), { dir: '/packs/p1' });
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  assert.equal(res.manifest.name, '我的皮肤');
  assert.equal(res.manifest.fps, 8);
  assert.equal(res.manifest.loop, true);
  assert.equal(res.manifest.scale, 2);
  assert.deepEqual(res.manifest.anchor, { x: 0.5, y: 1.0 });
  assert.equal(res.manifest.version, 1);
});

test('parseManifest：非法 JSON → ok:false 且不抛', () => {
  const res = parseManifest('{oops', { dir: '/p' });
  assert.equal(res.ok, false);
  assert.equal(res.manifest, null);
  assert.match(res.errors[0], /不是合法的 JSON/);
});

test('parseManifest：fps 越界 / 缺失 → 人话错误', () => {
  assert.match(parseManifest(JSON.stringify({ name: 'p', fps: 0 }), { dir: '/p' }).errors.join(), /"fps" 必须是 1–60/);
  assert.match(parseManifest(JSON.stringify({ name: 'p', fps: 61 }), { dir: '/p' }).errors.join(), /"fps" 必须是 1–60/);
  assert.match(parseManifest(JSON.stringify({ name: 'p' }), { dir: '/p' }).errors.join(), /"fps" 必须是 1–60/);
});

test('parseManifest：name 缺失 / 过长 → 错误', () => {
  assert.match(parseManifest(JSON.stringify({ fps: 8 }), { dir: '/p' }).errors.join(), /"name"/);
  const longName = 'x'.repeat(65);
  assert.match(parseManifest(JSON.stringify({ name: longName, fps: 8 }), { dir: '/p' }).errors.join(), /"name"/);
});

test('parseManifest：anchor / scale 非法 → 错误', () => {
  assert.match(
    parseManifest(JSON.stringify({ name: 'p', fps: 8, anchor: { x: 2, y: 0 } }), { dir: '/p' }).errors.join(),
    /"anchor"/
  );
  assert.match(parseManifest(JSON.stringify({ name: 'p', fps: 8, scale: 9 }), { dir: '/p' }).errors.join(), /"scale"/);
});

test('parseManifest：dir 逃逸检查（.. 与解析后越界）', () => {
  const res = parseManifest(JSON.stringify({ name: 'p', fps: 8, states: { idle: { dir: '../evil' } } }), {
    dir: '/packs/p1',
  });
  assert.equal(res.ok, false);
  const joined = res.errors.join('|');
  assert.match(joined, /不允许包含 "\.\."/);
  assert.match(joined, /逃逸出皮肤目录/);
});

test('parseManifest：未知 state 键 → warning 而非 error', () => {
  const res = parseManifest(JSON.stringify({ name: 'p', fps: 8, states: { bogus: {} } }), { dir: '/p' });
  assert.equal(res.ok, true);
  assert.match(res.warnings.join(), /未知的 state 键 "bogus"/);
});

test('parseManifest：per-state fps/loop/pingpong 覆盖 + version 告警', () => {
  const res = parseManifest(
    JSON.stringify({
      name: 'p',
      version: 2,
      fps: 8,
      states: { working: { fps: 20, loop: false, pingpong: true } },
    }),
    { dir: '/packs/p1' }
  );
  assert.equal(res.ok, true);
  assert.match(res.warnings.join(), /未知的包格式版本 2/);
  // 文案与产物不再自相矛盾：保留真实 version=2（不归一），告警只说「按当前版本(1)的字段规则解析」。
  assert.equal(res.manifest.version, 2);
  assert.match(res.warnings.join(), /将按当前版本\(1\)的字段规则解析/);
  const w = res.manifest.states.working;
  assert.equal(w.fps, 20);
  assert.equal(w.loop, false);
  assert.equal(w.pingpong, true);
  assert.equal(w.dir, path.join('/packs/p1', 'frames', 'working'));
});

test('parseManifest：非字符串 / 非对象顶层不抛', () => {
  assert.equal(parseManifest(null, { dir: '/p' }).ok, false);
  assert.equal(parseManifest('[]', { dir: '/p' }).ok, false);
  assert.equal(parseManifest('123', { dir: '/p' }).ok, false);
});

// --- resolveFrame ---

test('resolveFrame：frameCount<=0 → index:-1', () => {
  const { manifest } = parseManifest(JSON.stringify({ name: 'p', fps: 8 }), { dir: '/p' });
  assert.equal(resolveFrame(manifest, 'idle', 100, 0).index, -1);
  assert.equal(resolveFrame(manifest, 'idle', 100, -1).index, -1);
  assert.equal(resolveFrame(null, 'idle', 100, 4).index, -1);
});

test('resolveFrame：loop 取模（raw % frameCount）', () => {
  const { manifest } = parseManifest(JSON.stringify({ name: 'p', fps: 10 }), { dir: '/p' });
  // elapsed 500ms * 10fps = raw 5 → 5 % 4 = 1
  assert.equal(resolveFrame(manifest, 'idle', 500, 4).index, 1);
  assert.equal(resolveFrame(manifest, 'idle', 500, 4).loop, true);
});

test('resolveFrame：pingpong 往复（triangle）', () => {
  const { manifest } = parseManifest(JSON.stringify({ name: 'p', fps: 10, states: { idle: { pingpong: true } } }), {
    dir: '/p',
  });
  // raw 4, frameCount 4 → triangle: period 6 → 6-4 = 2
  assert.equal(resolveFrame(manifest, 'idle', 400, 4).index, 2);
  assert.equal(triangle(0, 4), 0);
  assert.equal(triangle(3, 4), 3);
  assert.equal(triangle(4, 4), 2);
  assert.equal(triangle(5, 4), 1);
  assert.equal(triangle(6, 4), 0);
  assert.equal(triangle(5, 1), 0);
});

test('resolveFrame：loop=false 停在末帧', () => {
  const { manifest } = parseManifest(JSON.stringify({ name: 'p', fps: 10, loop: false }), { dir: '/p' });
  assert.equal(resolveFrame(manifest, 'idle', 1000, 4).index, 3); // raw 10 → min(10,3)
  assert.equal(resolveFrame(manifest, 'idle', 100, 4).index, 1);
});

test('resolveFrame：负 elapsedMs 且 loop=false → 夹到 0（不再产负索引）', () => {
  // 修复前 `index = Math.min(raw, frameCount-1)`：elapsed 为负时 raw 为负 → 负索引。
  const { manifest } = parseManifest(JSON.stringify({ name: 'p', fps: 10, loop: false }), { dir: '/p' });
  assert.equal(resolveFrame(manifest, 'idle', -1000, 4).index, 0);
  assert.equal(resolveFrame(manifest, 'idle', -1, 4).index, 0);
  // 所有路径的 index 均落在 [0, frameCount-1]（-1 只留给 frameCount<=0）。
  for (const ms of [-5000, -1, 0, 1, 999, 1e9]) {
    const idx = resolveFrame(manifest, 'idle', ms, 4).index;
    assert.ok(idx >= 0 && idx <= 3, `ms=${ms} → index=${idx} 越界`);
  }
});

test('resolveFrame：state 未覆盖时回退全局 fps', () => {
  const { manifest } = parseManifest(JSON.stringify({ name: 'p', fps: 10 }), { dir: '/p' });
  const r = resolveFrame(manifest, 'working', 200, 4); // raw 2
  assert.equal(r.index, 2);
  assert.equal(r.fps, 10);
});

// --- scanPacks ---

test('scanPacks：跳过坏清单与非目录，仅返回有效皮肤', async () => {
  const fakeFs = {
    readdir: async () => [
      { name: 'good', isDirectory: () => true },
      { name: 'badjson', isDirectory: () => true },
      { name: 'afile', isDirectory: () => false },
    ],
    readFile: async (p) => {
      if (p.endsWith(path.join('good', 'pet.json'))) return JSON.stringify({ name: 'good', fps: 8 });
      if (p.endsWith(path.join('badjson', 'pet.json'))) return 'not json';
      throw new Error('ENOENT');
    },
    stat: async () => ({ mtimeMs: 111 }),
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const packs = await scanPacks('/pets', { fs: fakeFs });
    assert.equal(packs.length, 1);
    assert.equal(packs[0].name, 'good');
    assert.equal(packs[0].mtimeMs, 111);
    assert.equal(packs[0].manifest.fps, 8);
  } finally {
    console.warn = origWarn;
  }
});

test('scanPacks：目录不存在 → 返回空数组', async () => {
  const fakeFs = {
    readdir: async () => {
      throw new Error('ENOENT');
    },
  };
  assert.deepEqual(await scanPacks('/nope', { fs: fakeFs }), []);
});

test('scanPacks：真实 fs 临时目录集成', async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'axr-pets-'));
  try {
    const packDir = path.join(dir, 'p1');
    fsSync.mkdirSync(path.join(packDir, 'frames', 'idle'), { recursive: true });
    fsSync.writeFileSync(path.join(packDir, 'pet.json'), JSON.stringify({ name: 'real', fps: 6 }));
    const packs = await scanPacks(dir);
    assert.equal(packs.length, 1);
    assert.equal(packs[0].name, 'p1');
    assert.equal(packs[0].manifest.name, 'real');
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

// --- selectPack ---

test('selectPack：requested 命中（按名字或路径）', () => {
  const packs = [
    { name: 'a', path: '/p/a' },
    { name: 'b', path: '/p/b' },
  ];
  assert.equal(selectPack({ requested: 'b', packs }).source, 'requested');
  assert.equal(selectPack({ requested: 'b', packs }).pack.name, 'b');
  assert.equal(selectPack({ requested: '/p/a', packs }).pack.name, 'a');
});

test('selectPack：requested 未命中但有皮肤 → recent（最近修改）', () => {
  const packs = [
    { name: 'a', mtimeMs: 100 },
    { name: 'b', mtimeMs: 200 },
  ];
  const r = selectPack({ requested: 'missing', packs });
  assert.equal(r.source, 'recent');
  assert.equal(r.pack.name, 'b');
});

test('selectPack：无 mtime → first（名字典序）', () => {
  const packs = [{ name: 'z' }, { name: 'a' }];
  const r = selectPack({ packs });
  assert.equal(r.source, 'first');
  assert.equal(r.pack.name, 'a');
});

test('selectPack：无皮肤 → builtin', () => {
  assert.deepEqual(selectPack({ packs: [] }), { source: 'builtin' });
  assert.deepEqual(selectPack({}), { source: 'builtin' });
});

// --- naturalCompare / listStateFrames ---

test('naturalCompare：numeric-aware（2.png 在 10.png 前）', () => {
  assert.ok(naturalCompare('2.png', '10.png') < 0);
  assert.ok(naturalCompare('10.png', '2.png') > 0);
  assert.ok(naturalCompare('1.png', '1.png') === 0);
});

test('listStateFrames：列出 *.png 绝对路径并按自然序排序，缺目录返回 []', async () => {
  const fakeFs = {
    readdir: async () => [
      { name: '10.png', isFile: () => true },
      { name: '2.png', isFile: () => true },
      { name: 'note.txt', isFile: () => true },
      { name: 'sub', isFile: () => false },
    ],
  };
  const frames = await listStateFrames('/p/frames/idle', { fs: fakeFs });
  assert.deepEqual(frames, ['/p/frames/idle/2.png', '/p/frames/idle/10.png']);

  const missing = await listStateFrames('/nope', {
    fs: {
      readdir: async () => {
        throw new Error('ENOENT');
      },
    },
  });
  assert.deepEqual(missing, []);
});

test('listStateFrames：真实 fs 临时目录集成（自然序）', async () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'axr-frames-'));
  try {
    for (const n of ['10.png', '2.png', '1.png', 'ignore.jpg']) {
      fsSync.writeFileSync(path.join(dir, n), '');
    }
    const frames = await listStateFrames(dir);
    assert.deepEqual(
      frames.map((p) => path.basename(p)),
      ['1.png', '2.png', '10.png']
    );
    assert.ok(frames.every((p) => path.isAbsolute(p)));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

// --- UMD 浏览器分支 ---

test('sprite.js UMD：浏览器分支只挂 PetSprite{resolveFrame,triangle,DEFAULT_STATES}', () => {
  const src = fsSync.readFileSync(path.join(__dirname, '..', 'desktop', 'lib', 'sprite.js'), 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox; // 模拟浏览器全局
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  assert.ok(sandbox.PetSprite, '浏览器下应挂 globalThis.PetSprite');
  assert.deepEqual(Object.keys(sandbox.PetSprite).sort(), ['DEFAULT_STATES', 'resolveFrame', 'triangle']);
  assert.equal(sandbox.PetSprite.DEFAULT_STATES.length, 6);
  // Node-only 的面不进浏览器分支。
  assert.equal(sandbox.PetSprite.parseManifest, undefined);
  assert.equal(sandbox.PetSprite.scanPacks, undefined);
  assert.equal(sandbox.PetSprite.listStateFrames, undefined);
  // 浏览器分支的 resolveFrame 可用（不依赖 path/fs）。
  const manifest = { fps: 10, loop: true, states: {} };
  assert.equal(sandbox.PetSprite.resolveFrame(manifest, 'idle', 500, 4).index, 1);
});
