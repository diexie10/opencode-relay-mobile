// lib/proxy.js — REST API proxy for /api/* routes
const { getBasicAuthHeader } = require('./auth');
const { OPCODE_PORT } = require('./opener');

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT = 30_000;         // 30 seconds

// Forward HTTP request to opencode serve, injecting Basic Auth
async function proxyRequest(req, res) {
  // 1. Strip /api prefix to get target path
  const targetPath = req.url.replace(/^\/api/, '');
  const targetUrl = `http://127.0.0.1:${OPCODE_PORT}${targetPath}`;

  // 2. Read request body with size limit (P1 fix: Buffer.concat, avoid OOM)
  const chunks = [];
  let bodySize = 0;

  try {
    for await (const chunk of req) {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }
      chunks.push(chunk);
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'body_read_error' }));
    return;
  }

  const bodyBuffer = Buffer.concat(chunks);
  const body = bodyBuffer.length > 0 ? bodyBuffer : undefined;

  // 3. Forward request with connection timeout (P2 fix: AbortController)
  //    Timeout only protects the initial connection — once headers arrive,
  //    SSE streams are allowed to flow for as long as needed.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  // Cancel upstream read if client disconnects (no lingering reads)
  req.on('close', () => controller.abort());

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Authorization': getBasicAuthHeader(),
        'Content-Type': req.headers['content-type'] || 'application/json'
      },
      body: body,
      signal: controller.signal
    });

    // Clear the connection timeout — response headers received.
    // For SSE streams the body may flow for minutes; only client disconnect
    // (req 'close' → controller.abort) should terminate it.
    clearTimeout(timeoutId);

    // 4. Stream upstream response body directly to client.
    //    Using pipe (not response.text()) so SSE streams flow in real-time.
    const ct = response.headers.get('content-type') || 'application/octet-stream';
    res.writeHead(response.status, { 'Content-Type': ct });

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
    } catch (streamErr) {
      // Stream aborted or broken — client probably disconnected, fine to end
      if (!res.writableEnded) res.end();
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('[proxy]', err.message);
    if (!res.headersSent) {
      if (err.name === 'AbortError') {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'timeout' }));
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'opencode_unavailable' }));
      }
    }
  }
}

module.exports = { proxyRequest };
