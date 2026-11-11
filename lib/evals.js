const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { HOME } = require('./config');
const { atomicWrite } = require('./fs-utils');

// Eval loop store: manual annotations (👍/👎 + note), LLM-as-judge results,
// and the regression set (curated bad cases). Everything lives in one JSON
// file at ~/.agentxray/evals.json with atomic writes and no new dependencies.
// Judgements reuse the rule-based health score's shape (overall + four
// dimensions) so the UI can render both side by side.

const EVALS_FILE = path.join(HOME, '.agentxray', 'evals.json');

// Per-session judge attempts kept in `history[key]` (newest first). Small on
// purpose: history entries omit the transcript/reasoning audit bulk, which
// stays only on the latest judgement in `judgements[key]`.
const MAX_JUDGE_HISTORY = 10;

const THUMBS = new Set(['up', 'down']);

function evalKey(platform, sessionId) {
  return `${String(platform || '')}/${encodeURIComponent(String(sessionId || ''))}`;
}

function clampScore(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.min(100, Math.max(0, Math.round(Number(fallback) || 0)));
  return Math.min(100, Math.max(0, Math.round(n)));
}

function sanitizeThumb(thumb) {
  return THUMBS.has(thumb) ? thumb : null;
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) =>
      String(t || '')
        .trim()
        .slice(0, 24)
    )
    .filter(Boolean)
    .slice(0, 6);
}

function newCaseId(key) {
  return `reg-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

// Tolerant read: a corrupt or missing file behaves like an empty store.
async function loadEvalStore() {
  try {
    const parsed = JSON.parse(await fsp.readFile(EVALS_FILE, 'utf8'));
    return {
      annotations:
        parsed.annotations && typeof parsed.annotations === 'object' && !Array.isArray(parsed.annotations)
          ? parsed.annotations
          : {},
      judgements:
        parsed.judgements && typeof parsed.judgements === 'object' && !Array.isArray(parsed.judgements)
          ? parsed.judgements
          : {},
      // Judge attempt history (newest first); stores written before this
      // field existed simply start with an empty map.
      history:
        parsed.history && typeof parsed.history === 'object' && !Array.isArray(parsed.history) ? parsed.history : {},
      regression: Array.isArray(parsed.regression) ? parsed.regression : [],
    };
  } catch {
    return { annotations: {}, judgements: {}, history: {}, regression: [] };
  }
}

async function saveEvalStore(store) {
  await fsp.mkdir(path.dirname(EVALS_FILE), { recursive: true });
  await atomicWrite(EVALS_FILE, `${JSON.stringify(store, null, 2)}\n`);
  return store;
}

function findCase(store, platform, sessionId) {
  return store.regression.find((c) => c && c.platform === platform && c.sessionId === sessionId);
}

/**
 * Upsert the manual annotation for one session. A 👎 auto-collects the
 * session into the regression set (source 'thumb-down', tags/note carried
 * over); flipping back to 👍 — or clearing — removes that auto-collected
 * case unless the user curated it (tags or note present).
 */
async function setAnnotation(platform, sessionId, { thumb, note, tags } = {}) {
  const store = await loadEvalStore();
  const key = evalKey(platform, sessionId);
  const cleanThumb = sanitizeThumb(thumb);
  const cleanNote = String(note || '').slice(0, 2000);
  if (!cleanThumb && !cleanNote.trim()) {
    delete store.annotations[key];
  } else {
    store.annotations[key] = { thumb: cleanThumb, note: cleanNote, updatedAt: new Date().toISOString() };
  }

  if (cleanThumb === 'down') {
    const existing = findCase(store, platform, sessionId);
    if (existing) {
      // Keep the case's origin; refresh the curation fields the user sent.
      if (Array.isArray(tags)) existing.tags = sanitizeTags(tags);
      if (cleanNote) existing.note = cleanNote;
    } else {
      store.regression.push({
        id: newCaseId(key),
        platform,
        sessionId,
        source: 'thumb-down',
        tags: sanitizeTags(tags),
        note: cleanNote,
        createdAt: new Date().toISOString(),
      });
    }
  } else {
    // Flipping away from 👎: drop the auto-collected case unless the user
    // curated it (added tags or a note).
    store.regression = store.regression.filter((c) => {
      if (!c || c.platform !== platform || c.sessionId !== sessionId) return true;
      if (c.source !== 'thumb-down') return true;
      return (Array.isArray(c.tags) && c.tags.length > 0) || String(c.note || '').trim().length > 0;
    });
  }

  await saveEvalStore(store);
  return { annotation: store.annotations[key] || null, store };
}

/** Clamp an LLM judgement into the health-score shape and stamp provenance. */
function sanitizeJudgement(parsed, { model, backend, contentHash, transcript, reasoning } = {}) {
  const overall = clampScore(parsed.overall, 0);
  const dims = parsed.dimensions && typeof parsed.dimensions === 'object' ? parsed.dimensions : {};
  return {
    overall,
    dimensions: {
      completion: clampScore(dims.completion, overall),
      efficiency: clampScore(dims.efficiency, overall),
      toolQuality: clampScore(dims.toolQuality, overall),
      errorResilience: clampScore(dims.errorResilience, overall),
    },
    summary: String(parsed.summary || '').slice(0, 2000),
    issues: Array.isArray(parsed.issues)
      ? parsed.issues
          .map((i) => String(i || '').slice(0, 500))
          .filter(Boolean)
          .slice(0, 10)
      : [],
    model: String(model || '').slice(0, 120),
    backend: String(backend || '').slice(0, 40),
    contentHash: String(contentHash || '').slice(0, 16),
    judgedAt: new Date().toISOString(),
    // Audit trail: exactly what the judge saw, and the model's thinking when
    // the endpoint exposes it (Ollama reasoning / reasoning_content fields).
    transcript: String(transcript || '').slice(0, 60000) || null,
    reasoning: String(reasoning || '').slice(0, 10000) || null,
  };
}

/** Prepend an entry to one session's judge history, newest first, capped. */
function pushHistory(store, key, entry) {
  const existing = Array.isArray(store.history[key]) ? store.history[key] : [];
  store.history[key] = [entry, ...existing].slice(0, MAX_JUDGE_HISTORY);
}

async function setJudgement(platform, sessionId, judgement) {
  const store = await loadEvalStore();
  const key = evalKey(platform, sessionId);
  store.judgements[key] = judgement;
  // History keeps the score shape without the transcript/reasoning bulk —
  // the full audit trail stays on the latest judgement in `judgements`.
  const { transcript, reasoning, ...scoreFields } = judgement;
  pushHistory(store, key, { ...scoreFields, ok: true });
  await saveEvalStore(store);
  return judgement;
}

/**
 * Record a judge attempt whose output could not be parsed into the score
 * shape. Goes to history only — `judgements[key]` keeps the last successful
 * score so the UI never shows a failure as a rating.
 */
async function setJudgementFailure(platform, sessionId, { raw, model, backend, contentHash } = {}) {
  const store = await loadEvalStore();
  const entry = {
    ok: false,
    raw: String(raw || '').slice(0, 4000),
    model: String(model || '').slice(0, 120),
    backend: String(backend || '').slice(0, 40),
    contentHash: String(contentHash || '').slice(0, 16),
    judgedAt: new Date().toISOString(),
  };
  pushHistory(store, evalKey(platform, sessionId), entry);
  await saveEvalStore(store);
  return entry;
}

/** Upsert one regression case (one case per platform+session). */
async function addRegression({ platform, sessionId, tags, note, source } = {}) {
  const store = await loadEvalStore();
  const key = evalKey(platform, sessionId);
  const existing = findCase(store, platform, sessionId);
  if (existing) {
    if (Array.isArray(tags)) existing.tags = sanitizeTags(tags);
    if (note !== undefined) existing.note = String(note || '').slice(0, 2000);
    if (source && existing.source === 'thumb-down') existing.source = String(source).slice(0, 24);
    await saveEvalStore(store);
    return existing;
  }
  const entry = {
    id: newCaseId(key),
    platform,
    sessionId,
    source: String(source || 'manual').slice(0, 24),
    tags: sanitizeTags(tags),
    note: String(note || '').slice(0, 2000),
    createdAt: new Date().toISOString(),
  };
  store.regression.push(entry);
  await saveEvalStore(store);
  return entry;
}

async function removeRegressionById(id) {
  const store = await loadEvalStore();
  const before = store.regression.length;
  store.regression = store.regression.filter((c) => c && c.id !== id);
  if (store.regression.length === before) return false;
  await saveEvalStore(store);
  return true;
}

module.exports = {
  EVALS_FILE,
  MAX_JUDGE_HISTORY,
  evalKey,
  clampScore,
  sanitizeThumb,
  sanitizeTags,
  sanitizeJudgement,
  loadEvalStore,
  saveEvalStore,
  setAnnotation,
  setJudgement,
  setJudgementFailure,
  addRegression,
  removeRegressionById,
};
