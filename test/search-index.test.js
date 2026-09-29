const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { indexedCodexCandidates, defaultIndexPath, quoteFtsTerm } = require('../lib/search-index');
const { extractSearchDocuments } = require('../lib/search');

function codexMessage(text) {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })}\n`;
}

describe('Codex incremental FTS index', () => {
  it('quotes literal FTS terms safely', () => {
    assert.equal(quoteFtsTerm('alpha"beta'), '"alpha""beta"');
  });

  it('indexes files, skips unchanged files, updates changed files and removes deleted files', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'axr-fts-'));
    const indexDir = path.join(dir, 'index');
    const firstPath = path.join(dir, 'first.jsonl');
    const secondPath = path.join(dir, 'second.jsonl');
    const first = { path: firstPath, file: 'first.jsonl', platform: 'codex' };
    const second = { path: secondPath, file: 'second.jsonl', platform: 'codex' };
    await fsp.writeFile(firstPath, codexMessage('alpha needle'));
    await fsp.writeFile(secondPath, codexMessage('unrelated content'));

    try {
      const options = { sourceDir: dir, baseDir: indexDir };
      let candidates = await indexedCodexCandidates([first, second], ['needle'], extractSearchDocuments, options);
      assert.deepEqual(candidates, [first]);

      const indexPath = defaultIndexPath(dir, indexDir);
      const db = new Database(indexPath, { readonly: true });
      const indexedAt = db.prepare('SELECT indexed_at FROM indexed_files WHERE file_path=?').get(firstPath).indexed_at;
      db.close();

      candidates = await indexedCodexCandidates([first, second], ['needle'], extractSearchDocuments, options);
      const unchangedDb = new Database(indexPath, { readonly: true });
      assert.equal(
        unchangedDb.prepare('SELECT indexed_at FROM indexed_files WHERE file_path=?').get(firstPath).indexed_at,
        indexedAt
      );
      unchangedDb.close();
      assert.deepEqual(candidates, [first]);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await fsp.writeFile(firstPath, codexMessage('replacement phrase'));
      candidates = await indexedCodexCandidates([first, second], ['needle'], extractSearchDocuments, options);
      assert.deepEqual(candidates, []);
      candidates = await indexedCodexCandidates([first, second], ['replacement'], extractSearchDocuments, options);
      assert.deepEqual(candidates, [first]);

      await fsp.rm(secondPath);
      await indexedCodexCandidates([first], ['replacement'], extractSearchDocuments, options);
      const cleanedDb = new Database(indexPath, { readonly: true });
      assert.equal(cleanedDb.prepare('SELECT COUNT(*) count FROM indexed_files').get().count, 1);
      cleanedDb.close();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for short terms so the caller preserves substring semantics', async () => {
    const missingPath = path.join(os.tmpdir(), 'agentxray-missing-session');
    assert.equal(await indexedCodexCandidates([{ path: missingPath }], ['ab'], extractSearchDocuments), null);
  });
});
