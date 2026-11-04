// Version folding for the 系统上下文 (system context) panel.
//
// Agents re-inject the same context blocks over and over: DSH writes a fresh
// runtime/time-context snapshot per turn, Claude Code re-sends the same
// system-reminder, Codex repeats an identical turn_context every request.
// Listing each record ("N 条") buries the interesting part — when did the
// context actually change? This module folds consecutive identical injections
// into one version and keeps a line diff against the previous version, so the
// UI can render "12 条 / 3 个版本" plus "只改了 2 行" instead of 12 blobs.
//
// Pure (no DOM, no timestamps formatting) so the panel, the legacy bundle and
// the node tests share exactly one implementation.

export interface ContextRecordInput {
  /** sourceKind (dsh) or an inferred label for other platforms. */
  kind: string;
  text: string;
  /** Epoch ms; null when the log carries no timestamp. */
  timestampMs: number | null;
}

export interface ContextDiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface ContextVersion {
  /** 1-based version number inside its kind group. */
  index: number;
  /** Normalized content of this version. */
  text: string;
  /** How many consecutive records shared this exact content. */
  occurrences: number;
  firstTs: number | null;
  lastTs: number | null;
  addedLines: number;
  removedLines: number;
  /** Line diff against the previous version; null for the first version. */
  diff: ContextDiffLine[] | null;
  /** Set when this content already appeared as an earlier version (rollback). */
  repeatOf: number | null;
}

export interface ContextKindGroup {
  kind: string;
  records: number;
  versions: ContextVersion[];
  /** Lines present in every version, in first-version order (blank lines dropped). */
  commonLines: string[];
  /** Versions that differ from their predecessor. */
  changedVersions: number;
}

export interface ContextFold {
  groups: ContextKindGroup[];
  totalRecords: number;
  totalVersions: number;
}

/** Lines above this are compared as one replaced block instead of line-by-line. */
const MAX_DIFF_LINES = 400;
/** LCS cells (n*m) above this fall back to a coarse block diff. */
const MAX_DIFF_CELLS = 250_000;

/** Normalize line endings and trailing whitespace so cosmetic noise never creates a version. */
export function normalizeContextText(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split('\n');
}

/** FNV-1a over UTF-16 code units — identity hint only, callers compare text too. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** Stable signature of a normalized content block (length + FNV-1a). */
export function contextTextSignature(text: string): string {
  return `${text.length}:${hashText(text)}`;
}

function coarseDiff(prevLines: string[], nextLines: string[]): ContextDiffLine[] {
  const out: ContextDiffLine[] = [];
  for (const text of prevLines) out.push({ type: 'del', text });
  for (const text of nextLines) out.push({ type: 'add', text });
  return out;
}

/**
 * Line diff between two context blocks: unchanged prefix/suffix are matched
 * first, the changed middle uses an LCS when small enough (so a one-line change
 * is one del + one add, not a wholesale replacement).
 */
export function diffContextLines(prevText: string, nextText: string): ContextDiffLine[] {
  const prev = splitLines(prevText);
  const next = splitLines(nextText);
  if (prev.length > MAX_DIFF_LINES || next.length > MAX_DIFF_LINES) return coarseDiff(prev, next);

  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length - 1;
  let endNext = next.length - 1;
  while (endPrev >= start && endNext >= start && prev[endPrev] === next[endNext]) {
    endPrev--;
    endNext--;
  }

  const midPrev = prev.slice(start, endPrev + 1);
  const midNext = next.slice(start, endNext + 1);
  const out: ContextDiffLine[] = prev.slice(0, start).map((text) => ({ type: 'same' as const, text }));

  if (midPrev.length === 0 || midNext.length === 0 || midPrev.length * midNext.length > MAX_DIFF_CELLS) {
    out.push(...coarseDiff(midPrev, midNext));
  } else {
    // LCS table: lcs[i][j] = length of the LCS of midPrev[i:] and midNext[j:].
    const rows = midPrev.length + 1;
    const cols = midNext.length + 1;
    const lcs: Uint16Array[] = [];
    for (let i = 0; i < rows; i++) lcs.push(new Uint16Array(cols));
    for (let i = midPrev.length - 1; i >= 0; i--) {
      for (let j = midNext.length - 1; j >= 0; j--) {
        lcs[i][j] = midPrev[i] === midNext[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midPrev.length && j < midNext.length) {
      if (midPrev[i] === midNext[j]) {
        out.push({ type: 'same', text: midPrev[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        out.push({ type: 'del', text: midPrev[i] });
        i++;
      } else {
        out.push({ type: 'add', text: midNext[j] });
        j++;
      }
    }
    while (i < midPrev.length) out.push({ type: 'del', text: midPrev[i++] });
    while (j < midNext.length) out.push({ type: 'add', text: midNext[j++] });
  }

  out.push(...prev.slice(endPrev + 1).map((text) => ({ type: 'same' as const, text })));
  return out;
}

export interface ContextDiffRow {
  type: 'same' | 'add' | 'del' | 'gap';
  text: string;
  /** For 'gap' rows: how many unchanged lines were hidden. */
  skipped?: number;
}

/**
 * Collapse long runs of unchanged lines into a single "… N 行未变 …" row so a
 * changed version shows only the delta, not the whole 13KB skill catalog.
 */
export function condenseContextDiff(diff: ContextDiffLine[], context = 2): ContextDiffRow[] {
  const keep = new Set<number>();
  diff.forEach((line, i) => {
    if (line.type === 'same') return;
    for (let offset = -context; offset <= context; offset++) {
      const target = i + offset;
      if (target >= 0 && target < diff.length) keep.add(target);
    }
  });

  const rows: ContextDiffRow[] = [];
  let i = 0;
  while (i < diff.length) {
    if (keep.has(i)) {
      rows.push(diff[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < diff.length && !keep.has(j)) j++;
    rows.push({ type: 'gap', text: '', skipped: j - i });
    i = j;
  }
  return rows;
}

/** Lines present in every version of a group (multiplicity-aware), blank lines dropped. */
export function commonVersionLines(texts: string[]): string[] {
  if (texts.length === 0) return [];
  const perText = texts.map((text) => {
    const counts = new Map<string, number>();
    for (const line of splitLines(text)) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  });
  const out: string[] = [];
  const used = new Map<string, number>();
  for (const line of splitLines(texts[0])) {
    const seen = (used.get(line) ?? 0) + 1;
    used.set(line, seen);
    let min = Number.POSITIVE_INFINITY;
    for (const counts of perText) min = Math.min(min, counts.get(line) ?? 0);
    if (seen <= min && line.trim()) out.push(line);
  }
  return out;
}

function finalizeVersion(version: ContextVersion): ContextVersion {
  const added = version.diff?.filter((line) => line.type === 'add').length ?? 0;
  const removed = version.diff?.filter((line) => line.type === 'del').length ?? 0;
  return { ...version, addedLines: added, removedLines: removed };
}

/**
 * Fold records into per-kind version chains, preserving first-appearance order
 * so the panel keeps mirroring the log's chronology.
 */
export function foldContextVersions(records: ContextRecordInput[]): ContextFold {
  const order: string[] = [];
  const byKind = new Map<string, ContextRecordInput[]>();
  for (const record of records) {
    const kind = record.kind || 'unknown';
    const list = byKind.get(kind);
    if (list) {
      list.push(record);
    } else {
      byKind.set(kind, [record]);
      order.push(kind);
    }
  }

  const groups: ContextKindGroup[] = order.map((kind) => {
    const list = byKind.get(kind) ?? [];
    const versions: ContextVersion[] = [];

    for (const record of list) {
      const text = normalizeContextText(record.text);
      const last = versions[versions.length - 1];
      if (last && last.text === text) {
        last.occurrences += 1;
        if (record.timestampMs !== null) last.lastTs = record.timestampMs;
        continue;
      }
      const earlier = versions.find((candidate) => candidate.text === text);
      versions.push(
        finalizeVersion({
          index: versions.length + 1,
          text,
          occurrences: 1,
          firstTs: record.timestampMs,
          lastTs: record.timestampMs,
          addedLines: 0,
          removedLines: 0,
          diff: last ? diffContextLines(last.text, text) : null,
          repeatOf: earlier ? earlier.index : null,
        })
      );
    }

    const commonLines = versions.length > 1 ? commonVersionLines(versions.map((v) => v.text)) : [];
    return {
      kind,
      records: list.length,
      versions,
      commonLines,
      changedVersions: versions.filter((v) => v.addedLines + v.removedLines > 0).length,
    };
  });

  return {
    groups,
    totalRecords: records.length,
    totalVersions: groups.reduce((sum, group) => sum + group.versions.length, 0),
  };
}
