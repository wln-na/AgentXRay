// 系统上下文面板的版本折叠（frontend/src/lib/contextVersions.ts，经
// public/js/pure.js 打包）：相同内容折叠成一条版本、变化内容只在差异里露出。
// 这是纯逻辑，不需要起服务，所以直接 require 生成后的 pure bundle。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  commonVersionLines,
  condenseContextDiff,
  contextTextSignature,
  diffContextLines,
  foldContextVersions,
  normalizeContextText,
} = require(path.join(__dirname, '..', 'public', 'js', 'pure.js'));

const RUNTIME = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\ncwd: /repo';
const TIME_V1 = 'Time sampled while preparing turn 1: 2026-11-04T11:07:52+08:00\nElapsed: unavailable.';
const TIME_V2 = 'Time sampled while preparing turn 2: 2026-11-04T12:00:11+08:00\nElapsed: 52m.';

test('normalizeContextText strips CRLF and trailing whitespace only', () => {
  assert.equal(normalizeContextText('a\r\nb  \r\n\r\nc'), 'a\nb\n\nc');
  assert.equal(normalizeContextText('  \n a \n  '), 'a');
  assert.equal(normalizeContextText(null), '');
});

test('contextTextSignature is stable and content-sensitive', () => {
  assert.equal(contextTextSignature('abc'), contextTextSignature('abc'));
  assert.notEqual(contextTextSignature('abc'), contextTextSignature('abd'));
  // cosmetic differences disappear after normalization; the signature is only a hint
  assert.equal(contextTextSignature(normalizeContextText('a  \r\nb')), contextTextSignature('a\nb'));
});

test('diffContextLines keeps a one-line change to one del + one add', () => {
  const diff = diffContextLines('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(diff, [
    { type: 'same', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'x' },
    { type: 'same', text: 'c' },
  ]);
});

test('diffContextLines survives oversized blocks with a coarse diff', () => {
  const bigA = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n');
  const bigB = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n');
  const diff = diffContextLines(bigA, bigB);
  assert.equal(diff.filter((line) => line.type === 'del').length, 600);
  assert.equal(diff.filter((line) => line.type === 'add').length, 600);
  assert.equal(diff.filter((line) => line.type === 'same').length, 0);
});

test('condenseContextDiff hides long unchanged runs but keeps context around changes', () => {
  const prev = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const next = prev.replace('line 20', 'line 20 changed');
  const rows = condenseContextDiff(diffContextLines(prev, next));

  const gaps = rows.filter((row) => row.type === 'gap');
  assert.equal(gaps.length, 2, 'one gap before and one after the single change');
  assert.ok(gaps.every((row) => row.skipped > 0));
  // 2 lines of context + the del/add pair stay visible
  assert.equal(rows.filter((row) => row.type === 'same').length, 4);
  assert.equal(rows.filter((row) => row.type === 'del').length, 1);
  assert.equal(rows.filter((row) => row.type === 'add').length, 1);
});

test('commonVersionLines keeps only lines present in every version', () => {
  assert.deepEqual(commonVersionLines(['a\nb\nc', 'a\nX\nc', 'a\nb\nc']), ['a', 'c']);
  // multiplicity matters: 'a' appears twice in the first version but only once
  // in the second, so it is common once — not twice.
  assert.deepEqual(commonVersionLines(['a\na\nb', 'a\nb']), ['a', 'b']);
});

test('foldContextVersions collapses identical consecutive injections into one version', () => {
  const fold = foldContextVersions([
    { kind: 'runtime-context', text: RUNTIME, timestampMs: 1000 },
    { kind: 'runtime-context', text: RUNTIME, timestampMs: 2000 },
    { kind: 'runtime-context', text: RUNTIME, timestampMs: 3000 },
  ]);

  assert.equal(fold.totalRecords, 3);
  assert.equal(fold.totalVersions, 1);
  const [group] = fold.groups;
  assert.equal(group.kind, 'runtime-context');
  assert.equal(group.records, 3);
  assert.equal(group.versions.length, 1);
  assert.equal(group.versions[0].occurrences, 3);
  assert.equal(group.versions[0].firstTs, 1000);
  assert.equal(group.versions[0].lastTs, 3000);
  assert.equal(group.versions[0].diff, null);
  assert.equal(group.changedVersions, 0);
  assert.deepEqual(group.commonLines, []);
});

test('foldContextVersions turns a changed injection into a new version with a diff', () => {
  const fold = foldContextVersions([
    { kind: 'time-context', text: TIME_V1, timestampMs: 1000 },
    { kind: 'time-context', text: TIME_V1, timestampMs: 2000 },
    { kind: 'time-context', text: TIME_V2, timestampMs: 3000 },
    { kind: 'time-context', text: TIME_V2, timestampMs: 4000 },
  ]);

  assert.equal(fold.totalRecords, 4);
  assert.equal(fold.totalVersions, 2, 'two distinct contents → two versions, not four entries');
  const [group] = fold.groups;
  assert.equal(group.changedVersions, 1);

  const [v1, v2] = group.versions;
  assert.equal(v1.index, 1);
  assert.equal(v1.occurrences, 2);
  assert.equal(v2.index, 2);
  assert.equal(v2.occurrences, 2);
  assert.equal(v2.firstTs, 3000);
  assert.equal(v2.lastTs, 4000);
  assert.equal(v2.addedLines, 2);
  assert.equal(v2.removedLines, 2);
  assert.ok(v2.diff.some((line) => line.type === 'add' && line.text.includes('12:00:11')));
  assert.deepEqual(group.commonLines, [], 'both lines changed, nothing is common');
});

test('foldContextVersions marks a re-appearing content as a repeat of the earlier version', () => {
  const fold = foldContextVersions([
    { kind: 'runtime-context', text: 'A', timestampMs: 1000 },
    { kind: 'runtime-context', text: 'B', timestampMs: 2000 },
    { kind: 'runtime-context', text: 'A', timestampMs: 3000 },
  ]);

  const [group] = fold.groups;
  assert.equal(group.versions.length, 3);
  assert.equal(group.versions[2].repeatOf, 1);
  assert.equal(group.versions[1].repeatOf, null);
});

test('foldContextVersions keeps first-appearance kind order and per-kind counts', () => {
  const fold = foldContextVersions([
    { kind: 'runtime-context', text: 'r1', timestampMs: null },
    { kind: 'skill-catalog', text: 's1', timestampMs: null },
    { kind: 'time-context', text: 't1', timestampMs: null },
    { kind: 'skill-catalog', text: 's2', timestampMs: null },
  ]);

  assert.deepEqual(
    fold.groups.map((group) => group.kind),
    ['runtime-context', 'skill-catalog', 'time-context']
  );
  assert.deepEqual(
    fold.groups.map((group) => [group.records, group.versions.length]),
    [
      [1, 1],
      [2, 2],
      [1, 1],
    ]
  );
  assert.equal(fold.totalRecords, 4);
  assert.equal(fold.totalVersions, 4);
});

test('foldContextVersions treats cosmetic whitespace as the same version', () => {
  const fold = foldContextVersions([
    { kind: 'runtime-context', text: 'a\r\nb  ', timestampMs: 1 },
    { kind: 'runtime-context', text: 'a\nb', timestampMs: 2 },
  ]);
  assert.equal(fold.totalVersions, 1);
  assert.equal(fold.groups[0].versions[0].occurrences, 2);
});

test('foldContextVersions handles empty input and missing kinds', () => {
  assert.deepEqual(foldContextVersions([]), { groups: [], totalRecords: 0, totalVersions: 0 });
  const fold = foldContextVersions([{ kind: '', text: 'x', timestampMs: null }]);
  assert.equal(fold.groups[0].kind, 'unknown');
});

test('foldContextVersions reports a realistic dsh session shape', () => {
  // 运行时上下文变了 1 次、时间上下文每轮都变、技能目录只注入一次
  const fold = foldContextVersions([
    { kind: 'runtime-context', text: 'cwd: /repo\npolicy: workspace-write', timestampMs: 1 },
    { kind: 'skill-catalog', text: '184 skills', timestampMs: 1 },
    { kind: 'time-context', text: 'turn 1 @ 11:07', timestampMs: 1 },
    { kind: 'time-context', text: 'turn 2 @ 11:30', timestampMs: 2 },
    { kind: 'time-context', text: 'turn 3 @ 12:00', timestampMs: 3 },
    { kind: 'runtime-context', text: 'cwd: /repo\npolicy: danger-full-access', timestampMs: 4 },
  ]);

  assert.equal(fold.totalRecords, 6);
  assert.equal(fold.totalVersions, 6);
  const byKind = Object.fromEntries(fold.groups.map((group) => [group.kind, group]));
  assert.equal(byKind['time-context'].versions.length, 3);
  assert.equal(byKind['skill-catalog'].versions.length, 1);
  assert.equal(byKind['runtime-context'].versions.length, 2);
  assert.deepEqual(byKind['runtime-context'].commonLines, ['cwd: /repo']);
  assert.equal(byKind['runtime-context'].changedVersions, 1);
});
