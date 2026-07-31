// lib/sse-tunnel.js — SSE tunnel for /sse/* routes
const { getBasicAuthHeader } = require('./auth');
const { OPCODE_PORT } = require('./opener');

const KEEPALIVE_INTERVAL = 30_000; // 30s keepalive

// Tunnel SSE from opencode serve to the client, injecting Basic Auth
function handleSSE(req, res) {
  // Set SSE response headers (no CORS, same-origin deployment)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Strip /sse prefix to get target path
  const targetPath = req.url.replace(/^\/sse/, '');
  const targetUrl = `http://127.0.0.1:${OPCODE_PORT}${targetPath}`;

  // AbortController for upstream request cancellation
  const upstreamController = new AbortController();

  // Keepalive timer — send SSE comment line every 30s to prevent proxy timeout
  const keepaliveTimer = setInterval(() => {
    res.write(': keepalive\n\n');
  }, KEEPALIVE_INTERVAL);

  // Connect to upstream SSE endpoint (timeout if upstream hangs)
  const timeoutSignal = AbortSignal.timeout(15_000);
  const combinedSignal = AbortSignal.any ? AbortSignal.any([upstreamController.signal, timeoutSignal]) : upstreamController.signal;
  fetch(targetUrl, {
    headers: {
      'Authorization': getBasicAuthHeader(),
      'Accept': 'text/event-stream'
    },
    signal: combinedSignal
  }).then(async (response) => {
    if (!response.ok) {
      clearInterval(keepaliveTimer);
      res.end(`event: error\ndata: ${JSON.stringify({ error: 'upstream_error', status: response.status })}\n\n`);
      return;
    }

    // Pipe upstream response body (ReadableStream) to client response
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        res.write(value);
      }
    } catch (err) {
      // Stream read error — client probably disconnected, graceful close
    }
  }).catch(err => {
    clearInterval(keepaliveTimer);
    if (err.name !== 'AbortError') {
      res.end(`event: error\ndata: ${JSON.stringify({ error: 'upstream_unavailable' })}\n\n`);
    }
  });

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(keepaliveTimer);
    upstreamController.abort();
  });

  // Double cleanup on response close
  res.on('close', () => {
    clearInterval(keepaliveTimer);
    upstreamController.abort();
  });
}

module.exports = { handleSSE };
