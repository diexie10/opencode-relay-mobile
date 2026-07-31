// lib/static.js — Static file server with path traversal protection and SPA fallback
const path = require('path');
const fs = require('fs');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.woff2':'font/woff2',
};

// Serve static files with SPA fallback and path traversal protection
function serveStatic(req, res) {
  // Default to index.html for root
  let urlPath = req.url === '/' ? '/index.html' : req.url;

  // Decode URL (e.g. %20 → space)
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(urlPath));

  // P2 fix: path normalization to prevent directory traversal (../)
  filePath = path.resolve(filePath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Check if file exists (and is not a directory)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback: unknown paths serve index.html (client-side routing)
    filePath = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

module.exports = { serveStatic };
