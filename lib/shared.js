// Generic (non-platform) shared helpers.
//
// These are cross-cutting utilities used by routes, insights/usage caches and
// platform adapters alike. Platform-specific skeleton helpers stay in
// platforms/shared.js, which re-exports from here so existing imports keep
// working.

// Short-lived in-flight promise dedup. Concurrent calls with the same key
// share one execution; calls with different keys run independently. The
// promise is removed from the map on both success and failure so that later
// calls re-execute. Pass an existing `inFlight` map to share/inspect the
// in-flight state from outside (tests and route layers do this); omit it to
// get a private map, as the platform parsers do.
function withInFlightDedup(keyFn, fn, inFlight = new Map()) {
  return async function deduped(...args) {
    const key = keyFn(...args);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = fn.apply(this, args);
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  };
}

module.exports = { withInFlightDedup };
