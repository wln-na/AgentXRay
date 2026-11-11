// Startup sweeper for stale scratch directories left behind by killed test runs
// (`kill -9`, crashes) — those never reach their `process.on('exit')` cleanup.
//
// Only DIRECT children of the known roots that (a) match a known prefix, (b) are
// real directories (never symlinks), and (c) are older than the age threshold
// are removed. Every failure is collected into `errors` and never thrown: the
// suites also run inside a file sandbox that denies writes under the real
// $HOME, and a throw here would take down an entire test file.
//
// Options are validated defensively: an exported sweeper that silently falls
// back to the real homedir+tmpdir (or to an always-true empty prefix) is a foot
// gun, so invalid options remove NOTHING and are reported via `errors`.
//
// Node builtins only — this module must never gain a dependency.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Prefix used by `test/helpers.js` for throwaway HOME copies (no leading dot —
 * audit D3: it was missing from the sweep list). Exported so the creation site
 * and the sweeper cannot drift apart.
 */
const HELPERS_TMP_HOME_PREFIX = 'agentxray-test-';

/**
 * Scratch-dir prefixes owned by this repo's test harnesses.
 *
 * HOME-side: `.agentxray-test-`, `.agentxray-codextest-` (legacy harnesses) and
 * `agentxray-test-` (test/helpers.js makeTmpHome).
 * tmpdir-side: `axr-home-` (hermetic-HOME bootstrap of unit/boundary-b/robustness).
 */
const STALE_PREFIXES = Object.freeze([
  '.agentxray-test-',
  '.agentxray-codextest-',
  'axr-home-',
  HELPERS_TMP_HOME_PREFIX,
]);

/** Default age threshold; anything newer is left alone. */
const DEFAULT_MAX_AGE_DAYS = 7;

/** Hard cap for day counts (10 years); keeps a typo bounded. */
const MAX_MAX_AGE_DAYS = 3650;

/** A prefix shorter than this can never be specific enough to be safe (D1). */
const MIN_PREFIX_LENGTH = 3;

const DAY_MS = 86_400_000;

/**
 * Resolve the age threshold from an explicit option or AXR_STALE_HOME_DAYS.
 *
 * Explicit `maxAgeDays` (code path): integers >= 0 are accepted — 0 stays
 * allowed because it is the documented test hook ("any non-zero age qualifies");
 * negative / NaN / Infinity / non-integers fall back to the default.
 *
 * Env `AXR_STALE_HOME_DAYS` (ambient path): ONLY strict decimal digits, and the
 * value must be > 0. This asymmetry is deliberate: the env var must never be
 * able to enable the 0-day behaviour (a stray `AXR_STALE_HOME_DAYS=0`, `-0` or
 * `0x10` would otherwise delete scratch dirs of *concurrently running* tests).
 * `1e9` / hex / trailing garbage are rejected instead of coerced by parseInt.
 * Both paths are capped at MAX_MAX_AGE_DAYS.
 *
 * @param {unknown} value explicit `maxAgeDays` option
 * @returns {number}
 */
function resolveMaxAgeDays(value) {
  if (value !== undefined) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return Math.min(value, MAX_MAX_AGE_DAYS);
    }
    return DEFAULT_MAX_AGE_DAYS;
  }
  const raw = process.env.AXR_STALE_HOME_DAYS;
  if (raw === undefined || raw === null) return DEFAULT_MAX_AGE_DAYS;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_AGE_DAYS; // '-0', '0x10', '1e9', 'abc'
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_AGE_DAYS; // env cannot enable 0-day
  return Math.min(parsed, MAX_MAX_AGE_DAYS);
}

/**
 * Drop prefixes that could match too much (D1): non-strings, shorter than 3
 * chars, `.`/`..`, padded with whitespace, or containing a path separator.
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizePrefixes(value) {
  const input = Array.isArray(value) ? value : STALE_PREFIXES;
  /** @type {string[]} */
  const out = [];
  for (const prefix of input) {
    if (typeof prefix !== 'string') continue;
    if (prefix.length < MIN_PREFIX_LENGTH) continue; // drops '' and '.'
    if (prefix === '.' || prefix === '..') continue;
    if (prefix !== prefix.trim()) continue;
    if (prefix.includes('/') || prefix.includes('\\')) continue;
    if (!out.includes(prefix)) out.push(prefix);
  }
  return out;
}

/** A root must be a non-empty string that is not the cwd-disguise `.`/`..` (D5). */
function isUsableRoot(value) {
  return typeof value === 'string' && value.trim() !== '' && value !== '.' && value !== '..';
}

/** realpath that returns null instead of throwing (path may already be gone). */
function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isSafeBasename(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

/**
 * @typedef {{ scanned: number, removed: string[], wouldRemove: string[],
 *             skipped: {path: string, reason: string}[],
 *             errors: {path: string, message: string}[] }} SweepResult
 */

/**
 * Remove stale scratch dirs. Never throws.
 *
 * Safety rules (enforced literally, see task design):
 *  1. only direct children of each root (`readdir(..., {withFileTypes: true})`);
 *  2. directories only, symlinks never followed or removed;
 *  3. basename must start with a known prefix and be strictly longer than it;
 *  4. `now - mtimeMs > maxAgeDays * DAY_MS` (maxAgeDays 0 → `> 0`);
 *  5. never the root itself, never `~/.agentxray` / `<root>/.agentxray`, never a
 *     path whose parent realpath differs from the root realpath;
 *  6. `rmSync` per entry in try/catch, failures recorded in `errors`;
 *  7. `dryRun` only reports (`wouldRemove`), never deletes;
 *  8. `lstat` re-check immediately before `rm` (no TOCTOU on type);
 *  9. no output unless AXR_SWEEP_VERBOSE=1 (one summary line to stderr).
 *
 * @param {{ roots?: (string|import('node:fs').PathLike)[], prefixes?: string[],
 *           maxAgeDays?: number, now?: number, dryRun?: boolean,
 *           log?: (summary: string) => void, key?: string }} [options]
 * @returns {SweepResult}
 */
function sweepStaleDirs(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxAgeDays = resolveMaxAgeDays(opts.maxAgeDays);
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const dryRun = opts.dryRun === true;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const verbose = process.env.AXR_SWEEP_VERBOSE === '1';

  /** @type {SweepResult} */
  const result = { scanned: 0, removed: [], wouldRemove: [], skipped: [], errors: [] };

  const finish = () => {
    // RULE 9: silent by default; one-line summary only when explicitly verbose.
    const summary =
      `scanned=${result.scanned} removed=${result.removed.length}` +
      ` wouldRemove=${result.wouldRemove.length} skipped=${result.skipped.length}` +
      ` errors=${result.errors.length}`;
    if (verbose) process.stderr.write(`[stale-home] ${summary}\n`);
    log(summary);
    return result;
  };

  // RULE D5: a non-array `roots` must NOT silently fall back to the real
  // homedir+tmpdir (blast radius) — report and remove nothing.
  if (opts.roots !== undefined && !Array.isArray(opts.roots)) {
    result.errors.push({ path: '(options)', message: 'roots must be an array' });
    return finish();
  }
  const rawRoots = opts.roots === undefined ? [os.homedir(), os.tmpdir()] : opts.roots;

  // RULE D1: an empty/too-short prefix list can only mean "match everything".
  const prefixes = normalizePrefixes(opts.prefixes);
  if (prefixes.length === 0) {
    result.errors.push({ path: '(options)', message: 'no valid prefixes' });
    return finish();
  }

  // RULE 5: protected paths. `<root>/.agentxray` is added per root below; the
  // real home's `~/.agentxray` is always protected even if a custom root is used.
  const protectedPaths = new Set([path.resolve(path.join(os.homedir(), '.agentxray'))]);
  const protectedRealPaths = new Set();
  const homeReal = safeRealpath(path.join(os.homedir(), '.agentxray'));
  if (homeReal) protectedRealPaths.add(homeReal);

  // Deduplicate roots (defaults can collapse to the same dir under a hermetic HOME).
  const seenRoots = new Set();
  const uniqueRoots = [];
  for (const entry of rawRoots) {
    if (!isUsableRoot(entry)) {
      // RULE D5: '' / '.' / '..' would scan process.cwd() — refuse, don't guess.
      result.errors.push({ path: String(entry), message: 'invalid root (empty, dot or non-string)' });
      continue;
    }
    let resolved;
    try {
      resolved = path.resolve(entry);
    } catch {
      result.errors.push({ path: String(entry), message: 'invalid root' });
      continue;
    }
    if (seenRoots.has(resolved)) continue;
    seenRoots.add(resolved);
    uniqueRoots.push(resolved);
  }

  for (const root of uniqueRoots) {
    protectedPaths.add(path.resolve(path.join(root, '.agentxray')));

    let rootReal = null;
    let dirents = null;
    try {
      rootReal = fs.realpathSync(root);
    } catch (error) {
      result.errors.push({ path: root, message: error.message });
      continue;
    }
    try {
      if (!fs.statSync(rootReal).isDirectory()) {
        result.errors.push({ path: root, message: 'root is not a directory' });
        continue;
      }
      // RULE 1: direct children only; never recursive descent from the root.
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      result.errors.push({ path: root, message: error.message });
      continue;
    }

    for (const dirent of dirents) {
      result.scanned += 1;
      const name = dirent.name;
      const target = path.join(root, name);

      try {
        // RULE 3 (with D1 hardening): the basename must be strictly LONGER than
        // a known prefix — `startsWith('')` must never match everything.
        if (
          !isSafeBasename(name) ||
          !prefixes.some((prefix) => name.length > prefix.length && name.startsWith(prefix))
        ) {
          result.skipped.push({ path: target, reason: 'prefix' });
          continue;
        }
        // RULE 2: never follow or remove symlinks.
        if (dirent.isSymbolicLink()) {
          result.skipped.push({ path: target, reason: 'symlink' });
          continue;
        }
        if (!dirent.isDirectory()) {
          result.skipped.push({ path: target, reason: 'not-directory' });
          continue;
        }
        // RULE 5: root itself, protected paths, and parent-realpath containment.
        const resolvedTarget = path.resolve(target);
        if (resolvedTarget === path.resolve(root) || resolvedTarget === rootReal) {
          result.skipped.push({ path: target, reason: 'root' });
          continue;
        }
        if (protectedPaths.has(resolvedTarget)) {
          result.skipped.push({ path: target, reason: 'protected' });
          continue;
        }
        const targetReal = safeRealpath(resolvedTarget);
        if (targetReal) {
          if (targetReal === rootReal) {
            result.skipped.push({ path: target, reason: 'root' });
            continue;
          }
          if (protectedRealPaths.has(targetReal)) {
            result.skipped.push({ path: target, reason: 'protected' });
            continue;
          }
          const parentReal = safeRealpath(path.dirname(targetReal));
          if (parentReal !== rootReal) {
            result.skipped.push({ path: target, reason: 'outside-root' });
            continue;
          }
        }
        // RULE 4/8: age from lstat of the actual path (symlinks are not followed).
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
          result.skipped.push({ path: target, reason: 'symlink' });
          continue;
        }
        if (!stat.isDirectory()) {
          result.skipped.push({ path: target, reason: 'not-directory' });
          continue;
        }
        const ageMs = now - stat.mtimeMs;
        const tooOld = maxAgeDays === 0 ? ageMs > 0 : ageMs > maxAgeDays * DAY_MS;
        if (!tooOld) {
          result.skipped.push({ path: target, reason: 'recent' });
          continue;
        }

        // RULE 7: dry run only reports.
        if (dryRun) {
          result.wouldRemove.push(target);
          continue;
        }

        // RULE 8: re-check the type immediately before deleting.
        const recheck = fs.lstatSync(target);
        if (recheck.isSymbolicLink()) {
          result.skipped.push({ path: target, reason: 'symlink' });
          continue;
        }
        if (!recheck.isDirectory()) {
          result.skipped.push({ path: target, reason: 'not-directory' });
          continue;
        }

        // RULE 6: per-entry try/catch; failures land in `errors`, never thrown.
        fs.rmSync(target, { recursive: true, force: true });
        result.removed.push(target);
      } catch (error) {
        result.errors.push({ path: target, message: error && error.message ? error.message : String(error) });
      }
    }
  }

  return finish();
}

const EMPTY_RESULT = Object.freeze({ scanned: 0, removed: [], wouldRemove: [], skipped: [], errors: [] });

const DEFAULT_ONCE_KEY = 'default';

/** Per-key results so different call sites don't shadow each other (audit D4). */
const onceResults = new Map();

/**
 * Run `sweepStaleDirs` once per key per process. Never throws.
 *
 * `key` (default 'default') lets distinct call sites each get their own
 * once-only sweep: `sweepOnce({ key: 'helpers' })` and
 * `sweepOnce({ key: 'unit-bootstrap' })` both run. Repeating a key returns the
 * cached result without rescanning.
 *
 * @param {Parameters<typeof sweepStaleDirs>[0] & { key?: string }} [options]
 * @returns {SweepResult} this key's result
 */
function sweepOnce(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const key = typeof opts.key === 'string' && opts.key !== '' ? opts.key : DEFAULT_ONCE_KEY;
  if (onceResults.has(key)) return onceResults.get(key);

  let result;
  try {
    result = sweepStaleDirs(opts);
  } catch (error) {
    // sweepStaleDirs already guards itself; this is belt-and-braces so a bad
    // option can never break test startup.
    result = {
      ...EMPTY_RESULT,
      errors: [{ path: '(sweep)', message: error && error.message ? error.message : String(error) }],
    };
    if (process.env.AXR_SWEEP_VERBOSE === '1') {
      process.stderr.write(`[stale-home] fatal ${result.errors[0].message}\n`);
    }
  }
  onceResults.set(key, result);
  return result;
}

/** Test-only escape hatch: forget cached once-results. */
function __resetSweeperForTests() {
  onceResults.clear();
}

module.exports = {
  STALE_PREFIXES,
  DEFAULT_MAX_AGE_DAYS,
  HELPERS_TMP_HOME_PREFIX,
  sweepStaleDirs,
  sweepOnce,
  // exposed for tests/auditors; not part of the public wiring surface
  resolveMaxAgeDays,
  __resetSweeperForTests,
};
