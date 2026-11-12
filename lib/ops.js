// Transport / operations middleware (architecture items 1–3).
//
// The sandbox cannot `npm install` (EPERM on the npm cache), so the usual
// `compression` / `morgan` / `on-finished` stack is not available. Everything
// here is built on Node built-ins (`node:zlib` + the http response object) and
// kept in one small module so `server.js` stays a composition root:
//
//   compressionMiddleware()   negotiate br/gzip, buffer compressible bodies,
//                             never buffer streaming (SSE) responses
//   requestLogger()           one line per slow request (all with
//                             AXR_LOG_REQUESTS=1), static assets excluded
//   cachePolicy()             Cache-Control for /api: storable but revalidated
//                             (Express ETag → 304), no-store for probes + SSE
//   buildHealth()             payload for GET /health (no disk access)
//   installGracefulShutdown() SIGTERM/SIGINT drain with a hard grace cap

const zlib = require('node:zlib');

const DEFAULT_MIN_BYTES = 1024;
const DEFAULT_SLOW_MS = 500;
const DEFAULT_SHUTDOWN_MS = 3000;

// Only these media types are worth compressing. JSON/JS/CSS/HTML/SVG are the
// payloads that dominate this app (multi-MB session dumps, hashed JS bundles);
// images/fonts are already compressed and would just burn CPU.
const COMPRESSIBLE_TYPE_RE =
  /^(?:application\/(?:json|[a-z0-9.+-]+\+json|javascript|x-javascript)|text\/(?:javascript|css|html)|image\/svg\+xml)$/i;

// Static responses are excluded from request logging: they are the quiet
// majority and their transfer size is visible in devtools anyway.
const STATIC_EXT_RE = /\.(?:avif|css|eot|gif|ico|jpe?g|js|json|map|mjs|otf|png|svg|ttf|webp|woff2?)$/i;

// Boot-id probe (detects server restarts), the watch SSE and the pet SSE must
// never be stored by the browser/proxy — a replayed value would be wrong.
const NO_STORE_PATHS = new Set(['/api/version', '/api/watch', '/api/pet/state']);

function mediaType(value) {
  if (typeof value !== 'string') return '';
  return value.split(';', 1)[0].trim().toLowerCase();
}

function isCompressibleType(value) {
  return COMPRESSIBLE_TYPE_RE.test(mediaType(value));
}

// Quality advertised for one coding in an Accept-Encoding header. An explicit
// `br;q=0` disables brotli; `*` is only a fallback when the coding is absent.
function encodingQuality(header, name) {
  let wildcard = 0;
  for (const raw of String(header || '').split(',')) {
    const [token, ...params] = raw.trim().toLowerCase().split(';');
    const coding = token.trim();
    if (!coding) continue;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key === 'q') {
        const parsed = Number(value);
        quality = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (coding === name) return quality;
    if (coding === '*' && quality > wildcard) wildcard = quality;
  }
  return wildcard;
}

// Prefer brotli on ties (smaller wire size), fall back to gzip. Returns null
// when the client accepts neither — the response then goes out as identity.
function pickEncoding(header) {
  const brotli = encodingQuality(header, 'br');
  const gzip = encodingQuality(header, 'gzip');
  if (brotli > 0 && brotli >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

// Append a token to Vary without duplicating an existing one.
function appendVary(res, token) {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', token);
    return;
  }
  const values = String(current)
    .split(',')
    .map((value) => value.trim().toLowerCase());
  if (!values.includes(token.toLowerCase())) res.setHeader('Vary', `${current}, ${token}`);
}

// Keep `Vary: Accept-Encoding` on the response even if a route sets its own
// Vary later (middleware runs before route handlers, so a plain setHeader in
// the handler would otherwise drop the compression dimension).
function lockVary(res, token) {
  const originalSetHeader = res.setHeader;
  res.setHeader = function setHeaderVary(name, value) {
    if (String(name).toLowerCase() === 'vary') {
      const tokens = String(value)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const present = tokens.some((part) => part.toLowerCase() === token.toLowerCase());
      value = present ? tokens.join(', ') : [...tokens, token].join(', ');
    }
    return originalSetHeader.call(this, name, value);
  };
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk));
}

// Brotli quality 5 instead of the default 11: ~90% of the ratio at a fraction
// of the CPU, which matters for 3–15 MB JSON payloads on every cold request.
function compressBody(buffer, encoding) {
  return new Promise((resolve, reject) => {
    const callback = (error, result) => (error ? reject(error) : resolve(result));
    if (encoding === 'br') {
      zlib.brotliCompress(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }, callback);
      return;
    }
    zlib.gzip(buffer, callback);
  });
}

// Gzip/brotli response compression without external dependencies.
//
// Bodies are buffered until `res.end` so the size can be checked against the
// threshold and the compressed Content-Length can be set. Anything streaming is
// passed through untouched once headers have been flushed — in particular the
// SSE endpoints (`/api/watch`, `/api/pet/state`), which `sseInit()` starts with
// `flushHeaders()`. A response that already has a Content-Encoding, a bodyless
// status (204/304), a partial response (206) or a non-compressible media type is
// forwarded verbatim; HEAD responses are never touched.
function compressionMiddleware(options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_MIN_BYTES;
  return function compression(req, res, next) {
    lockVary(res, 'Accept-Encoding');
    appendVary(res, 'Accept-Encoding');
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding || req.method === 'HEAD') return next();

    const originalWrite = res.write;
    const originalEnd = res.end;
    let buffered = [];
    let bufferedLength = 0;
    let streaming = false;
    let ended = false;

    function canBuffer() {
      if (streaming || ended || res.headersSent) return false;
      if (res.getHeader('Content-Encoding') || res.getHeader('Content-Range')) return false;
      if (res.statusCode === 204 || res.statusCode === 206 || res.statusCode === 304) return false;
      return isCompressibleType(res.getHeader('Content-Type'));
    }

    function flushBuffered() {
      if (bufferedLength === 0) return;
      const body = buffered.length === 1 ? buffered[0] : Buffer.concat(buffered);
      buffered = [];
      bufferedLength = 0;
      originalWrite.call(res, body);
    }

    function passThrough() {
      streaming = true;
      flushBuffered();
    }

    res.write = function write(chunk, chunkEncoding, callback) {
      if (ended) return false;
      if (!canBuffer()) {
        passThrough();
        return originalWrite.call(res, chunk, chunkEncoding, callback);
      }
      const buffer = toBuffer(chunk, chunkEncoding);
      buffered.push(buffer);
      bufferedLength += buffer.length;
      const done = typeof chunkEncoding === 'function' ? chunkEncoding : callback;
      if (typeof done === 'function') process.nextTick(done);
      return true;
    };

    res.end = function end(chunk, chunkEncoding, callback) {
      if (ended) return res;
      let done = callback;
      if (typeof chunk === 'function') {
        done = chunk;
        chunk = undefined;
        chunkEncoding = undefined;
      } else if (typeof chunkEncoding === 'function') {
        done = chunkEncoding;
        chunkEncoding = undefined;
      }
      // Decide eligibility while `ended` is still false — canBuffer() refuses to
      // buffer once a response is marked finished.
      const canBufferChunk = canBuffer();
      ended = true;
      if (chunk != null && chunk !== '') {
        if (!canBufferChunk) {
          passThrough();
          return originalEnd.call(res, chunk, chunkEncoding, done);
        }
        const buffer = toBuffer(chunk, chunkEncoding);
        buffered.push(buffer);
        bufferedLength += buffer.length;
      }
      const body = bufferedLength === 0 ? null : buffered.length === 1 ? buffered[0] : Buffer.concat(buffered);
      buffered = [];
      bufferedLength = 0;
      const bodyless = res.statusCode === 204 || res.statusCode === 304 || res.statusCode === 206;
      const blocked = res.getHeader('Content-Encoding') || res.getHeader('Content-Range');
      if (
        !body ||
        body.length < threshold ||
        bodyless ||
        blocked ||
        !isCompressibleType(res.getHeader('Content-Type'))
      ) {
        return body ? originalEnd.call(res, body, done) : originalEnd.call(res, done);
      }
      compressBody(body, encoding).then(
        (compressed) => {
          if (res.destroyed || res.writableEnded) return;
          // Never make a body larger: tiny/high-entropy payloads go out raw.
          if (compressed.length >= body.length) {
            originalEnd.call(res, body, done);
            return;
          }
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Content-Length', String(compressed.length));
          originalEnd.call(res, compressed, done);
        },
        () => {
          if (res.destroyed || res.writableEnded) return;
          originalEnd.call(res, body, done);
        }
      );
      return res;
    };

    next();
  };
}

function isStaticRequest(req) {
  const requestPath = req.path || '';
  if (requestPath.startsWith('/assets/')) return true;
  return STATIC_EXT_RE.test(requestPath);
}

// One line per request: `METHOD path status durationms bytes`. Defaults to slow
// requests only (SLOW_REQ_MS, 500 ms); AXR_LOG_REQUESTS=1 logs everything.
// Static assets stay out of the log unless full logging is enabled.
function requestLogger(options = {}) {
  const slowMs = Number.isFinite(options.slowMs) ? options.slowMs : DEFAULT_SLOW_MS;
  const logAll = options.logAll === true;
  return function logRequest(req, res, next) {
    const startedAt = process.hrtime.bigint();
    let wireBytes = 0;
    let reported = false;

    function sizeOf(chunk) {
      if (chunk == null) return 0;
      if (typeof chunk === 'string') return Buffer.byteLength(chunk);
      if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.byteLength;
      return 0;
    }

    // Count what actually leaves the process (post-compression): the logger
    // runs before the compression middleware, so it sees the final buffers.
    const originalWrite = res.write;
    const originalEnd = res.end;
    res.write = function write(chunk, chunkEncoding, callback) {
      wireBytes += sizeOf(chunk);
      return originalWrite.call(this, chunk, chunkEncoding, callback);
    };
    res.end = function end(chunk, chunkEncoding, callback) {
      if (typeof chunk !== 'function') wireBytes += sizeOf(chunk);
      return originalEnd.call(this, chunk, chunkEncoding, callback);
    };

    function report() {
      if (reported) return;
      reported = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (!logAll) {
        if (isStaticRequest(req)) return;
        if (durationMs < slowMs) return;
      }
      const bytes = wireBytes > 0 ? wireBytes : Number(res.getHeader('Content-Length') || 0);
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms ${bytes}B`);
    }

    // `finish` for completed responses, `close` for aborted/streamed ones.
    res.once('finish', report);
    res.once('close', report);
    next();
  };
}

// Re-stamp every Cache-Control write on the current response as no-store. Used
// for paths whose own route module sets a header (sseInit sets `no-cache`);
// wrapping setHeader is the only way to override a later handler from middleware.
function forceNoStore(res) {
  const originalSetHeader = res.setHeader;
  res.setHeader = function setHeaderNoStore(name, value) {
    if (String(name).toLowerCase() === 'cache-control') value = 'no-store';
    return originalSetHeader.call(this, name, value);
  };
  res.setHeader('Cache-Control', 'no-store');
}

// API cache policy: storable but always revalidated (`no-cache`) so Express'
// default weak ETag can answer 304. /api/version, /api/watch and /api/pet/state
// keep the stricter no-store. Non-/api paths (static, /health) are untouched.
function cachePolicy() {
  return function applyCachePolicy(req, res, next) {
    const requestPath = req.path || '';
    if (!requestPath.startsWith('/api')) return next();
    if (NO_STORE_PATHS.has(requestPath)) {
      forceNoStore(res);
      return next();
    }
    res.setHeader('Cache-Control', 'no-cache');
    next();
  };
}

// GET /health payload. Deliberately cheap: process counters only, no disk scan.
function buildHealth({ version, platforms } = {}) {
  const memory = process.memoryUsage();
  return {
    ok: true,
    uptimeMs: Math.round(process.uptime() * 1000),
    version: version || process.version,
    platforms: Number.isFinite(platforms) ? platforms : 0,
    memory: { rss: memory.rss, heapUsed: memory.heapUsed },
  };
}

// SIGTERM/SIGINT: stop accepting connections, give in-flight responses up to the
// grace window to finish, then force exit. `close()` alone would hang on an
// idle keep-alive socket, so idle connections are dropped immediately.
function installGracefulShutdown(server, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : DEFAULT_SHUTDOWN_MS;
  const log = typeof options.log === 'function' ? options.log : (line) => console.log(line);
  let closing = false;
  return function shutdown(signal) {
    if (closing) return;
    closing = true;
    log(`[axr] ${signal} received: draining connections (max ${graceMs}ms)`);
    const timer = setTimeout(() => {
      log('[axr] shutdown grace period expired, exiting');
      process.exit(0);
    }, graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      log('[axr] server closed cleanly');
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  };
}

module.exports = {
  buildHealth,
  cachePolicy,
  compressBody,
  compressionMiddleware,
  installGracefulShutdown,
  isCompressibleType,
  isStaticRequest,
  pickEncoding,
  requestLogger,
};
