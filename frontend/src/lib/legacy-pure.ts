// Re-export surface for the generated legacy bundle (public/js/pure.js).
// scripts/build-legacy-pure.mjs bundles this file with esbuild; the footer
// exposes every export as a window/global function for the frozen vanilla UI
// and as module.exports for the node tests.

export { escapeHtml, renderMarkdown, renderMarkdownHtml } from './markdown';
export {
  buildTraceTurns,
  clusterPrefillContent,
  detectPatch,
  diffLineSegments,
  extractEmbeddedPatch,
  firstInformativeLine,
  flattenSpans,
  formatBytes,
  formatCost,
  formatDurationCompact,
  getTextContent,
  parseTimestampMs,
  parseToolArguments,
  pickAutoPlatform,
} from './pure';
