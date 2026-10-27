# AgentXRay Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore CI health and fix the highest-priority, non-semantic review findings before asking for product or security decisions.

**Architecture:** Keep route modules thin, put behavior in `lib/usage.js` and `lib/open-session.js`, and cover every behavior with focused Node tests. The first batch fixes formatting, API error semantics, locate allowlisting, and usage platform-window filtering without changing the product interface.

**Tech Stack:** Node.js 22, Express, Biome, Node test runner, React/TypeScript frontend.

---

## Batch 1: autonomous engineering fixes

### Task 1: Repair Biome blocking errors

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `desktop/renderer/pet.js`
- Modify: `lib/pet-aggregator.js`

**Step 1: Format only the files with errors**

Run:

```bash
npx biome format --write desktop/main.js desktop/preload.js desktop/renderer/pet.js lib/pet-aggregator.js
```

Expected: the four formatting errors disappear.

**Step 2: Verify blocking lint state**

Run:

```bash
npx biome check --diagnostic-level=error desktop/main.js desktop/preload.js desktop/renderer/pet.js lib/pet-aggregator.js
```

Expected: no formatter errors.

---

### Task 2: Return JSON 404 for unknown APIs

**Files:**
- Modify: `server.js`
- Test: `test/api.test.js`

**Step 1: Write a failing test**

Add a test that requests `/api/definitely-missing` and expects:

```js
assert.equal(response.status, 404);
assert.deepEqual(json, { error: 'Not Found' });
```

**Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test test/api.test.js
```

Expected: the new test fails because the SPA fallback currently returns `200 text/html`.

**Step 3: Implement the API 404 branch**

Immediately before the SPA fallback in `server.js`, add:

```js
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not Found' });
});
```

**Step 4: Verify the focused test passes**

Run:

```bash
node --test test/api.test.js
```

Expected: all tests in the file pass.

---

### Task 3: Allow WorkBuddy and Trae session logs to be located

**Files:**
- Modify: `lib/open-session.js`
- Test: `test/open.test.js`

**Step 1: Add a focused allowlist test**

Assert both paths are accepted:

```js
assert.equal(checkAllowedLogPath(path.join(WORKBUDDY_DIR, 'session.jsonl')).ok, true);
assert.equal(checkAllowedLogPath(path.join(TRAE_DIR, 'session.jsonl')).ok, true);
```

**Step 2: Run and verify failure**

Run:

```bash
node --test test/open.test.js
```

Expected: the new assertions fail.

**Step 3: Add the roots**

Import `WORKBUDDY_DIR` and `TRAE_DIR` from `./config`, then append them to `ALLOWED_LOG_ROOTS`.

**Step 4: Verify the focused test**

Run:

```bash
node --test test/open.test.js
```

Expected: all tests pass.

---

### Task 4: Restrict usage platforms to the requested window

**Files:**
- Modify: `lib/usage.js`
- Test: `test/usage.test.js`

**Step 1: Write a regression test**

Create a `filesByPlatform` fixture with one platform that has usage and another that has usage outside the requested trailing window. Assert the outside platform is absent from `response.platforms`.

**Step 2: Run and verify failure**

Run:

```bash
node --test test/usage.test.js
```

Expected: the new test fails because `platforms` is currently collected before the window is applied.

**Step 3: Compute `platforms` from the final series**

Replace the pre-window platform collection with a set built from `series[i].byPlatform` after zero-filled days are generated.

**Step 4: Verify the focused test**

Run:

```bash
node --test test/usage.test.js
```

Expected: all tests pass.

---

### Task 5: Run the complete verification batch

**Files:**
- No additional files.

**Step 1: Run all tests**

Run:

```bash
npm test
```

Expected: every test passes.

**Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: no errors. Existing warnings and infos may remain for later cleanup.

**Step 3: Build the frontend**

Run:

```bash
npm run build:ui
```

Expected: TypeScript and Vite build pass.

---

## Gates before Batch 2

- Product owner confirms whether the usage page should follow the selected platform and custom directories.
- Product owner confirms the display meaning of “会话数”.
- Security owner confirms whether non-localhost binding should be allowed and whether a local token must be enforced.

## Later batches

1. **Accuracy batch:** Codex snapshot deltas, Doubao timestamp fallback, Gemini and DSH reasoning tokens, Hermes SQLite usage.
2. **Interaction batch:** platform and directory filtering for usage.
3. **Performance batch:** unified rollup, file mtime/size incrementality, bounded concurrency.
4. **Security batch:** Host and Origin validation, CSP, realpath checks, token enforcement for non-local binds.
5. **Documentation and hygiene batch:** README, package description, historical SPEC, injectable clock, frontend lint coverage.
