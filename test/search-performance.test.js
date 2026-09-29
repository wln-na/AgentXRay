const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  mapConcurrentOrdered,
  searchFileCached,
  clearSearchFileCache,
  ripgrepCandidatePaths,
  prefilterJsonlFiles,
} = require('../lib/search');

describe('search execution optimizations', () => {
  beforeEach(() => clearSearchFileCache());

  it('runs bounded work concurrently while preserving input order', async () => {
    let active = 0;
    let peak = 0;
    const items = [30, 5, 20, 1, 15];
    const output = await mapConcurrentOrdered(items, 2, async (delay, index) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active--;
      return index;
    });

    assert.deepEqual(output, [0, 1, 2, 3, 4]);
    assert.equal(peak, 2);
  });

  it('reuses a file result until size or mtime changes and returns defensive copies', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'axr-search-cache-'));
    const file = path.join(dir, 'session.jsonl');
    await fsp.writeFile(file, '{"message":"first"}\n');
    const sf = { path: file, file: 'session.jsonl', platform: 'codex' };
    let calls = 0;
    const searchOne = async () => ({
      sessionId: 's1',
      platform: 'codex',
      matches: [{ role: 'user', snippet: `call-${++calls}` }],
    });

    try {
      const first = await searchFileCached(sf, ['needle'], searchOne);
      first.matches.push({ role: 'assistant', snippet: 'caller mutation' });
      const second = await searchFileCached(sf, ['needle'], searchOne);
      assert.equal(calls, 1);
      assert.deepEqual(
        second.matches.map((match) => match.snippet),
        ['call-1']
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      await fsp.appendFile(file, '{"message":"second"}\n');
      const third = await searchFileCached(sf, ['needle'], searchOne);
      assert.equal(calls, 2);
      assert.equal(third.matches[0].snippet, 'call-2');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses ripgrep to keep only files containing the primary term', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'axr-search-rg-'));
    const hit = path.join(dir, 'hit.jsonl');
    const miss = path.join(dir, 'miss.jsonl');
    await fsp.writeFile(hit, '{"message":"Needle"}\n');
    await fsp.writeFile(miss, '{"message":"other"}\n');
    const files = [hit, miss].map((file) => ({ path: file }));

    try {
      const candidates = await ripgrepCandidatePaths(files, ['needle'], { minFiles: 0 });
      if (candidates !== null) {
        assert.deepEqual([...candidates], [hit]);
        assert.deepEqual(await prefilterJsonlFiles(files, ['needle'], { minFiles: 0 }), [files[0]]);
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips ripgrep startup overhead for small file sets', async () => {
    const files = [
      { path: path.join(os.tmpdir(), 'a.jsonl') },
      { path: path.join(os.tmpdir(), 'b.jsonl') },
    ];
    assert.equal(await ripgrepCandidatePaths(files, ['needle']), null);
    assert.deepEqual(await prefilterJsonlFiles(files, ['needle']), files);
  });

  it('falls back to the original file set when ripgrep is unavailable', async () => {
    const files = [
      { path: path.join(os.tmpdir(), 'a.jsonl') },
      { path: path.join(os.tmpdir(), 'b.jsonl') },
    ];
    const candidates = await ripgrepCandidatePaths(files, ['needle'], {
      command: path.join(os.tmpdir(), 'agentxray-missing-rg'),
      minFiles: 0,
    });
    assert.equal(candidates, null);
    assert.deepEqual(
      await prefilterJsonlFiles(files, ['needle'], {
        command: path.join(os.tmpdir(), 'agentxray-missing-rg'),
        minFiles: 0,
      }),
      files
    );
  });
});
