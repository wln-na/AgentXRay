#!/usr/bin/env node

// Generates public/js/pure.js from frontend/src/lib/{pure,markdown}.ts so the
// pure helpers and the markdown/escape pipeline have exactly one definition
// site (the TypeScript sources). The React app imports the TS sources directly;
// the generated bundle is the test-facing artifact — `node --test` require()s it
// (see test/unit.test.js, test/context-versions.test.js). No browser UI loads it
// since the legacy vanilla UI was retired.
//
// Run automatically as part of `npm run build:ui`; run directly with
// `node scripts/build-legacy-pure.mjs` (npm run build:pure) after editing the TS sources.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// esbuild is a transitive dependency of vite inside frontend/. Resolve it from
// there instead of hardcoding node_modules layout, which breaks when hoisting changes.
const { buildSync } = createRequire(path.join(root, 'frontend', 'package.json'))('esbuild');
const entry = path.join(root, 'frontend', 'src', 'lib', 'legacy-pure.ts');
const outfile = path.join(root, 'public', 'js', 'pure.js');

const result = buildSync({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__axrPure',
  target: 'es2021',
  charset: 'utf8',
  alias: { '@': path.join(root, 'frontend', 'src') },
});

const banner = `// GENERATED FILE — do not edit.
// Source of truth: frontend/src/lib/pure.ts + frontend/src/lib/markdown.ts.
// Regenerate with \`node scripts/build-legacy-pure.mjs\` (also runs in build:ui).
// Node: require('public/js/pure.js') returns the same functions (the test suite).
// Browser: functions also land on window.*, but no bundled UI loads this file
// anymore — the React app imports the TS sources and the legacy UI is retired.
`;

const footer = `
(function (root, api) {
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    for (var key in api) root[key] = api[key];
  }
})(typeof window !== 'undefined' ? window : globalThis, __axrPure);
`;

writeFileSync(outfile, banner + result.outputFiles[0].text + footer);
console.log(`wrote ${path.relative(root, outfile)}`);
