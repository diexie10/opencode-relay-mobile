// lib/auth.js — Token-based authentication module
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── Relay token (user-visible, in URL) ────────────────────────────────────
// Mode 1: OC_RELAY_PASSWORD set → derive deterministic token via SHA-256.
// Mode 2: relay-data/config.json password → derive deterministic token.
// Mode 3: no password → read from relay-data/logs/token.txt if exists,
//          otherwise generate random and persist it.
const { loadConfig } = require('./config');
const USER_PASSWORD = process.env.OC_RELAY_PASSWORD || loadConfig().password || null;
let TOKEN;
if (USER_PASSWORD) {
  TOKEN = deriveToken(USER_PASSWORD);
} else {
  const tokenDir = path.resolve(__dirname, '..', 'relay-data', 'logs');
  fs.mkdirSync(tokenDir, { recursive: true });
  const tokenFile = path.join(tokenDir, 'token.txt');
  if (fs.existsSync(tokenFile)) {
    TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
  } else {
    TOKEN = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, TOKEN + '\n');
  }
}

// ─── OpenCode serve password (internal, random always) ─────────────────────
const OPCODE_PASSWORD = crypto.randomBytes(16).toString('hex');

// Verify incoming request token (constant-time comparison with length pre-check)
function authenticate(req) {
  const token = req.headers['x-auth-token'] ||
                new URL(req.url, 'http://x').searchParams.get('token');
  if (!token) return false;

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(TOKEN);

  // P2 fix: length pre-check to avoid crash on different-length buffers
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

// Get Basic Auth header for proxy-to-opencode-serve requests
// opencode serve requires username 'opencode' (not empty)
function getBasicAuthHeader() {
  return 'Basic ' + Buffer.from('opencode:' + OPCODE_PASSWORD).toString('base64');
}

// Compute a deterministic token from a password (SHA-256 hex, 64 chars)
function deriveToken(password) {
  return crypto.createHash('sha256').update(password).digest('hex').slice(0, 64);
}

module.exports = { TOKEN, OPCODE_PASSWORD, authenticate, getBasicAuthHeader, deriveToken };
