// relay-start.js — Clean restart helper for OpenCode Relay
// Usage: node relay-start.js
//        node relay-start.js --reset   # also delete relay.db (fresh slate)
//        node relay-start.js --verbose # print more debug info

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RELAY_DIR    = __dirname;
const RELAY_DATA   = path.join(RELAY_DIR, 'relay-data');
const RELAY_DB     = path.join(RELAY_DATA, 'relay.db');
const RELAY_PORT   = 3456;
const OPCODE_PORT  = 4098;

const args = process.argv.slice(2);
const RESET  = args.includes('--reset');
const VERBOSE = args.includes('--verbose');

function log(msg) { console.log('[start] ' + msg); }
function vlog(msg) { if (VERBOSE) console.log('[debug] ' + msg); }

// ─── 1. Kill anything on relay port ────────────────────────────────────────
log('Checking for existing processes...');

function findPidByPort(port) {
  try {
    // netstat -ano shows LISTENING lines; parse PID from end
    const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(pid)) return pid;
    }
  } catch {}
  return null;
}

function killProcess(pid, label) {
  if (!pid) return false;
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 3000 });
    log(`Killed ${label} (PID ${pid})`);
    return true;
  } catch {
    vlog(`Could not kill ${label} (PID ${pid}) — already dead?`);
    return false;
  }
}

// Kill relay on 3456
const relayPid = findPidByPort(RELAY_PORT);
if (relayPid) {
  killProcess(relayPid, 'relay on :3456');
  // Give OS a moment to release the port
  execSync('ping 127.0.0.1 -n 2 > nul', { stdio: 'ignore' });
}

// Kill opencode on 4098
const opPid = findPidByPort(OPCODE_PORT);
if (opPid) {
  killProcess(opPid, 'opencode serve on :4098');
  execSync('ping 127.0.0.1 -n 2 > nul', { stdio: 'ignore' });
}

// Also find any stray opencode processes that might hold relay.db
try {
  const out = execSync('tasklist /FI "IMAGENAME eq opencode.exe" /FO CSV /NH', {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.trim().split(',');
    const pid = parseInt(parts[1], 10);
    if (!isNaN(pid) && pid !== opPid) {
      killProcess(pid, 'stray opencode.exe');
    }
  }
} catch {}

// ─── 2. Clean up stale WAL/SHM ─────────────────────────────────────────────
log('Cleaning stale WAL/SHM files...');
['-wal', '-shm'].forEach(suffix => {
  const p = RELAY_DB + suffix;
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      vlog(`Removed ${path.basename(p)}`);
    }
  } catch (err) {
    log(`Warning: could not remove ${path.basename(p)} (${err.code})`);
  }
});

// ─── 3. Optionally reset the DB ────────────────────────────────────────────
if (RESET) {
  log('--reset: removing relay.db for clean slate...');
  try {
    if (fs.existsSync(RELAY_DB)) {
      fs.unlinkSync(RELAY_DB);
      log('relay.db removed');
    }
  } catch (err) {
    log(`Warning: could not remove relay.db (${err.code})`);
  }
}

// ─── 4. Ensure directories exist ──────────────────────────────────────────
fs.mkdirSync(RELAY_DATA, { recursive: true });
fs.mkdirSync(path.join(RELAY_DATA, 'logs'), { recursive: true });
fs.mkdirSync(path.join(RELAY_DATA, 'projects'), { recursive: true });

// ─── 5. Start relay (detached so it survives this script's exit) ───────────
log('Starting relay...');
const relayProcess = spawn('node', ['server.js'], {
  cwd: RELAY_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,       // survive parent exit
  windowsHide: false,
  shell: true,
});
relayProcess.unref();   // don't keep parent alive for this child

relayProcess.stdout.on('data', d => process.stdout.write(d));
relayProcess.stderr.on('data', d => process.stderr.write(d));

// ─── 6. Wait for health check ──────────────────────────────────────────────
log('Waiting for relay to be healthy...');
const MAX_WAIT = 30000;
const POLL_INTERVAL = 1000;
const start = Date.now();

async function waitForHealthy() {
  while (Date.now() - start < MAX_WAIT) {
    try {
      const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.opencode === 'healthy') {
          log('Relay is UP and healthy!');
          log(`  http://127.0.0.1:${RELAY_PORT}/health`);
          return true;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  console.error('[start] Timed out waiting for relay to become healthy');
  process.exit(1);
}

waitForHealthy()
  .then(() => { console.log('[start] Done — relay is running in background'); process.exit(0); })
  .catch(() => process.exit(1));
