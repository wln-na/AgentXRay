// Shared SSE plumbing for route modules.
//
// Every streaming endpoint used to define its own copy of these two helpers;
// they live here once. sseInit writes the standard Server-Sent Events headers
// (X-Accel-Buffering off so nginx does not buffer the stream) and returns a
// send() bound to the response. numOr is the tolerant query-param number
// parser used alongside the SSE clamps.

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  return function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { sseInit, numOr };
