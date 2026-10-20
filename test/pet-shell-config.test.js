// 桌面宠物壳纯配置层单测：默认值、环境变量覆盖、路径基于 HOME、PET_STATES 冻结。
// 纯 Node——不 require electron，不触碰真实桌面。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const config = require(path.join(__dirname, '..', 'desktop', 'lib', 'config'));

test('createConfig 默认值：HOST/PORT 与后端 server.js 默认一致', () => {
  const c = config.createConfig({ HOME: '/home/u' });
  assert.equal(c.HOST, '127.0.0.1');
  assert.equal(c.PORT, 3800);
  assert.equal(c.PACK, '');
  assert.equal(c.EXEC, '');
  assert.equal(c.NO_WATCHDOG, false);
  assert.equal(c.DEBUG, false);
});

test('createConfig 全部路径基于 HOME（~/.agentxray/ 约定）', () => {
  const home = '/Users/tester';
  const c = config.createConfig({ HOME: home });
  assert.equal(c.PET_DIR, path.join(home, '.agentxray', 'pet'));
  assert.equal(c.PETS_DIR, path.join(home, '.agentxray', 'pets'));
  assert.equal(c.PET_LOG, path.join(home, '.agentxray', 'pet', 'pet.log'));
  assert.equal(c.PET_ERR_LOG, path.join(home, '.agentxray', 'pet', 'pet.err.log'));
  assert.equal(c.WINDOW_STATE, path.join(home, '.agentxray', 'pet', 'window-state.json'));
  assert.equal(c.PLIST_PATH, path.join(home, 'Library', 'LaunchAgents', 'com.agentxray.pet.plist'));
});

test('createConfig 环境变量覆盖所有可配置项', () => {
  const c = config.createConfig({
    HOME: '/home/u',
    AGENTXRAY_PET_HOST: '10.0.0.5',
    AGENTXRAY_PET_PORT: '4321',
    AGENTXRAY_PET_DIR: '/tmp/petdir',
    AGENTXRAY_PET_PETS_DIR: '/tmp/petsdir',
    AGENTXRAY_PET_PACK: 'my-pack',
    AGENTXRAY_PET_EXEC: '/Applications/Electron.app/Contents/MacOS/Electron',
    AGENTXRAY_PET_NO_WATCHDOG: '1',
    AGENTXRAY_PET_DEBUG: '1',
  });
  assert.equal(c.HOST, '10.0.0.5');
  assert.equal(c.PORT, 4321);
  assert.equal(c.PET_DIR, '/tmp/petdir');
  assert.equal(c.PETS_DIR, '/tmp/petsdir');
  assert.equal(c.PACK, 'my-pack');
  assert.equal(c.EXEC, '/Applications/Electron.app/Contents/MacOS/Electron');
  assert.equal(c.NO_WATCHDOG, true);
  assert.equal(c.DEBUG, true);
  // 派生路径跟随被覆盖的 PET_DIR。
  assert.equal(c.PET_LOG, path.join('/tmp/petdir', 'pet.log'));
});

test('createConfig 非法 PORT 回退到 3800', () => {
  assert.equal(config.createConfig({ HOME: '/h', AGENTXRAY_PET_PORT: 'not-a-number' }).PORT, 3800);
});

test('PET_STATES 为冻结的 6 态，取值与 PetStateName 一致', () => {
  assert.deepEqual(config.PET_STATES, ['idle', 'thinking', 'working', 'done', 'waiting_input', 'error']);
  assert.ok(Object.isFrozen(config.PET_STATES));
  assert.equal(config.PET_STATES.length, 6);
});

test('LAUNCH_AGENT_LABEL 为固定值', () => {
  assert.equal(config.LAUNCH_AGENT_LABEL, 'com.agentxray.pet');
});
