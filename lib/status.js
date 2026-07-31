// lib/status.js — Relay status collector
// Provides a comprehensive snapshot of relay, opencode serve, and database health.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { RELAY_DB_PATH, OPCODE_PORT } = require('./opener');
const { ENDPOINTS } = require('./api-config');
const auth = require('./auth');

const RELAY_START_TIME = Date.now();

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function getRelayInfo() {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    started: new Date(RELAY_START_TIME).toISOString(),
    uptime: formatDuration(Date.now() - RELAY_START_TIME),
    uptimeMs: Date.now() - RELAY_START_TIME,
    version: '2.0.0',
    node: process.version,
    platform: os.platform(),
    memory: {
      rssMB: +(mem.rss / 1024 / 1024).toFixed(1),
      heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
    },
  };
}

function getProcessInfo(proc) {
  if (!proc || proc.killed) {
    return { running: false, pid: null };
  }
  return { running: true, pid: proc.pid };
}

function getDBInfo() {
  const results = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const p = RELAY_DB_PATH + suffix;
    try {
      const stat = fs.statSync(p);
      results[suffix || 'main'] = {
        exists: true,
        sizeMB: +(stat.size / 1024 / 1024).toFixed(2),
        mtime: stat.mtime.toISOString(),
      };
    } catch {
      results[suffix || 'main'] = { exists: false };
    }
  }
  return results;
}

async function checkOpencodeHealth(password) {
  const authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  try {
    const res = await fetch(`http://127.0.0.1:${OPCODE_PORT}${ENDPOINTS.HEALTH}`, {
      headers: { 'Authorization': authHeader },
      signal: AbortSignal.timeout(3000),
    });
    return { reachable: true, ok: res.ok, status: res.status };
  } catch (err) {
    return { reachable: false, error: err.code || err.message };
  }
}

async function getSessionCount() {
  try {
    const res = await fetch(`http://127.0.0.1:${OPCODE_PORT}${ENDPOINTS.LIST_SESSIONS}`, {
      headers: { 'Authorization': auth.getBasicAuthHeader() },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const sessions = await res.json();
      return Array.isArray(sessions) ? sessions.length : null;
    }
    return null;
  } catch {
    return null;
  }
}

function getNetworkInfo(port) {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({
          name,
          address: net.address,
          url: `http://${net.address}:${port}?token=${auth.TOKEN}`,
        });
      }
    }
  }
  return addresses;
}

// Collect a full status snapshot
async function collectStatus(opencodeProc) {
  const relayPort = parseInt(process.env.PORT || '3456', 10);
  const [opencodeHealth, sessionCount] = await Promise.all([
    checkOpencodeHealth(auth.OPCODE_PASSWORD),
    getSessionCount(),
  ]);

  const configPassword = (process.env.OC_RELAY_PASSWORD || (() => {
    try { return require('./config').loadConfig().password; } catch { return null; }
  })());

  return {
    timestamp: new Date().toISOString(),
    relay: getRelayInfo(),
    opencode: {
      ...getProcessInfo(opencodeProc),
      health: opencodeHealth,
      sessions: sessionCount,
    },
    database: getDBInfo(),
    network: {
      port: relayPort,
      addresses: getNetworkInfo(relayPort),
    },
    auth: {
      configured: !!configPassword,
      hasToken: true,
    },
  };
}

module.exports = { collectStatus };
