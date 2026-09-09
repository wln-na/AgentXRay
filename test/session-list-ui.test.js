const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_LIST_PATH = path.join(__dirname, '..', 'frontend', 'src', 'views', 'sessions', 'SessionList.tsx');

function sessionListSource() {
  return fs.readFileSync(SESSION_LIST_PATH, 'utf8');
}

describe('React session list semantic badges', () => {
  it('keeps semantic badge order and always renders the tool-call count', () => {
    const source = sessionListSource();
    const user = source.indexOf("kind: 'user', text: `👤 ${session.userCount} 条用户消息`");
    const assistant = source.indexOf("kind: 'assistant', text: `🤖 ${session.assistantCount} 条助手消息`");
    const tool = source.indexOf("kind: 'tool', text: `🔧 ${session.toolCallCount || 0} 次工具调用`");
    const spawn = source.indexOf("kind: 'spawn', text: `🌳 ${spawnCount} 个子 Agent`");
    const model = source.indexOf("kind: 'model', text: `🧠 ${session.model.split('/').pop() || session.model}`");

    for (const [name, index] of Object.entries({ user, assistant, tool, spawn, model })) {
      assert.notEqual(index, -1, `missing ${name} badge`);
    }
    assert.ok(user < assistant && assistant < tool && tool < spawn && spawn < model);
    assert.match(source, /if \(session\.userCount > 0\)/);
    assert.match(source, /if \(session\.assistantCount > 0\)/);
    assert.match(source, /if \(spawnCount > 0\)/);
  });

  it('selects the session and opens trace without bubbling from the spawn chip', () => {
    const source = sessionListSource();
    const handler = source.match(/const onSpawnClick = [\s\S]*?\n  };/)?.[0] || '';

    assert.match(handler, /event\.stopPropagation\(\)/);
    assert.match(handler, /onSelect\(session\.id\)/);
    assert.match(handler, /useAppStore\.getState\(\)\.setSessionView\('trace'\)/);
    assert.match(source, /chip\.kind === 'spawn'/);
    assert.match(source, /onClick=\{onSpawnClick\}/);
    assert.match(source, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  });
});
