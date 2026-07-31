// server.js — OpenCode Relay v2 main entry point
// Manages DB lifecycle, opencode serve lifecycle, HTTP routing, and graceful shutdown
// Plan A: independent persistent DB + project import/export

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// --- 1. Module-level refs for signal handler ---
let procRef = null;
let serverRef = null;

process.on('SIGINT', async () => {
  console.log('\n[relay] Shutting down...');
  if (serverRef) serverRef.close();
  if (procRef) await opener.stopOpencode(procRef).catch(() => {});
  opener.removeRelayDB();
  opener.removeTokenFile();
  console.log('[relay] Goodbye');
  process.exit(0);
});
process.on('SIGTERM', () => process.emit('SIGINT'));

// --- 2. Banner ---
console.log('');
console.log('  OpenCode Relay v2');
console.log('  ──────────────────────────────────');

// --- 3. Modules ---
const auth = require('./lib/auth');
const { proxyRequest } = require('./lib/proxy');
const { handleSSE } = require('./lib/sse-tunnel');
const { serveStatic } = require('./lib/static');
const opener = require('./lib/opener');

const PORT = process.env.PORT || 3456;

// --- Project import helpers ---

// Directories to exclude when importing a project
const IMPORT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  'target', '__pycache__', '.cache', '.vscode', '.idea',
  '.gradle', 'vendor', 'Pods', '.swiftpm', 'relay-data',
]);
const IMPORT_EXCLUDE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.npmrc', '.env.local',
]);

// Filter function for fs.cpSync — excludes heavy/unnecessary dirs and files
function importFilter(src) {
  const basename = path.basename(src);
  // Exclude by directory name (checked against path segments)
  if (IMPORT_EXCLUDE_DIRS.has(basename)) return false;
  // Exclude by file name
  if (IMPORT_EXCLUDE_FILES.has(basename)) return false;
  // Exclude log files
  if (basename.endsWith('.log')) return false;
  // Exclude .pyc files
  if (basename.endsWith('.pyc')) return false;
  return true;
}

// Measure directory size and file count (applies same exclusions as importFilter)
// Safety limits prevent scanning absurdly large dirs forever
const MAX_SCAN_FILES = 200000;
const MAX_SCAN_SIZE  = 10 * 1024 * 1024 * 1024; // 10 GB safety cap

function measureDirSize(dir) {
  let totalSize = 0;
  let fileCount = 0;
  let truncated = false;

  function walk(d) {
    if (truncated) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (truncated) return;
        // Apply same exclusions as importFilter
        if (IMPORT_EXCLUDE_DIRS.has(e.name)) continue;
        if (IMPORT_EXCLUDE_FILES.has(e.name)) continue;
        if (e.name.endsWith('.log') || e.name.endsWith('.pyc')) continue;

        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          try {
            const stat = fs.statSync(full);
            totalSize += stat.size;
            fileCount++;
          } catch {}
          if (fileCount > MAX_SCAN_FILES || totalSize > MAX_SCAN_SIZE) {
            truncated = true;
            return;
          }
        }
      }
    } catch {}
  }

  walk(dir);
  return { size: totalSize, fileCount, truncated };
}

// Human-readable file size
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// System directories that should never be imported
const SYSTEM_DIRS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  'C:\\ProgramData', 'C:\\System Volume Information',
];

// Validate that a path is safe to import
function validateImportPath(srcPath) {
  // Must be absolute
  if (!path.isAbsolute(srcPath)) {
    return { ok: false, error: '路径必须是绝对路径' };
  }
  // Must exist and be a directory
  try {
    const stat = fs.statSync(srcPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: '路径不是目录' };
    }
  } catch {
    return { ok: false, error: '路径不存在' };
  }
  // Must not be a system directory or inside one
  const resolved = path.resolve(srcPath);
  for (const sysDir of SYSTEM_DIRS) {
    if (resolved === sysDir || resolved.startsWith(sysDir + path.sep)) {
      return { ok: false, error: '不能导入系统目录' };
    }
  }
  // Must not be inside relay-data (prevent self-import)
  const relayDataDir = path.resolve(opener.RELAY_DATA_DIR);
  if (resolved === relayDataDir || resolved.startsWith(relayDataDir + path.sep)) {
    return { ok: false, error: '不能导入 relay-data 目录' };
  }
  return { ok: true };
}

// List imported/created projects in relay-data/projects/
function listImportedProjects() {
  const projectsDir = opener.PROJECTS_DIR;
  const result = [];
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const fullPath = path.join(projectsDir, e.name);
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(path.join(fullPath, '.relay-meta.json'), 'utf8'));
        } catch {}
        result.push({ name: e.name, path: fullPath, type: meta.type || 'imported' });
      }
    }
  } catch {}
  return result;
}

// --- Sync (回并) helpers ---

// Compute MD5 hash of a file's content
function md5File(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch { return null; }
}

// Convert an absolute path to human-readable location description
function pathToHumanLabel(p) {
  const home = os.homedir();
  const desktop = path.join(home, 'Desktop');
  const documents = path.join(home, 'Documents');
  const downloads = path.join(home, 'Downloads');
  const resolved = path.resolve(p);
  const name = path.basename(resolved);

  if (resolved === desktop || resolved.startsWith(desktop + path.sep)) {
    const sub = resolved.slice(desktop.length + 1);
    return sub ? '桌面上的「' + sub.replace(/\\/g, '」/「') + '」文件夹' : '桌面';
  }
  if (resolved === documents || resolved.startsWith(documents + path.sep)) {
    const sub = resolved.slice(documents.length + 1);
    return sub ? '文档里的「' + sub.replace(/\\/g, '」/「') + '」文件夹' : '文档';
  }
  if (resolved === downloads || resolved.startsWith(downloads + path.sep)) {
    const sub = resolved.slice(downloads.length + 1);
    return sub ? '下载里的「' + sub.replace(/\\/g, '」/「') + '」文件夹' : '下载';
  }
  // Generic: show drive + parent + name
  const parent = path.dirname(resolved);
  const parentName = path.basename(parent);
  return '「' + name + '」文件夹（在 ' + parentName + ' 下面）';
}

// Check if a directory is a git repo and git is available
function checkGitAvailable(dirPath) {
  try {
    // Check if git command works
    execSync('git --version', { stdio: 'pipe', timeout: 5000 });
    // Check if dir has .git
    const gitDir = path.join(dirPath, '.git');
    return fs.existsSync(gitDir);
  } catch {
    return false;
  }
}

// Get git status (are there uncommitted changes?)
function gitHasUncommitted(dirPath) {
  try {
    const out = execSync('git status --porcelain', { cwd: dirPath, stdio: 'pipe', timeout: 5000 });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

// Create a zip backup of a directory using PowerShell
function createZipBackup(srcDir, zipPath) {
  try {
    // Use PowerShell Compress-Archive
    const psCmd = 'Compress-Archive -Path "' + srcDir + '\\*" -DestinationPath "' + zipPath + '" -Force';
    execSync('powershell -NoProfile -Command "' + psCmd + '"', { stdio: 'pipe', timeout: 120000 });
    return true;
  } catch (e) {
    console.error('[sync] ZIP backup failed:', e.message);
    return false;
  }
}

// Extract a zip backup using PowerShell
function extractZipBackup(zipPath, destDir) {
  try {
    // Remove existing dest contents first
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
    fs.mkdirSync(destDir, { recursive: true });
    const psCmd = 'Expand-Archive -Path "' + zipPath + '" -DestinationPath "' + destDir + '" -Force';
    execSync('powershell -NoProfile -Command "' + psCmd + '"', { stdio: 'pipe', timeout: 120000 });
    return true;
  } catch (e) {
    console.error('[sync] ZIP extract failed:', e.message);
    return false;
  }
}

// Walk a directory and collect all file paths (relative to root)
function walkFiles(dir, baseDir) {
  const result = [];
  const root = baseDir || dir;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      // Skip .relay-meta.json, .relay-sync.json, .git, node_modules
      if (e.name === '.relay-meta.json' || e.name === '.relay-sync.json') continue;
      if (IMPORT_EXCLUDE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        result.push(...walkFiles(full, root));
      } else if (e.isFile()) {
        result.push(path.relative(root, full));
      }
    }
  } catch {}
  return result;
}

// Compute file hashes for all files in a directory
function hashDirFiles(dir) {
  const hashes = {};
  const files = walkFiles(dir);
  for (const relPath of files) {
    const hash = md5File(path.join(dir, relPath));
    if (hash) hashes[relPath.replace(/\\/g, '/')] = hash;
  }
  return hashes;
}

// Get the backups directory for a project
function getBackupDir(projectName) {
  const backupDir = path.join(opener.RELAY_DATA_DIR, 'backups', projectName);
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

// Clean old backups, keep only the most recent N
function cleanOldBackups(projectName, keepCount) {
  const backupDir = getBackupDir(projectName);
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        mtime: fs.statSync(path.join(backupDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = keepCount; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path); } catch {}
    }
  } catch {}
}

// Read .relay-sync.json (sync history) for a project
function readSyncHistory(projectName) {
  const syncFile = path.join(opener.PROJECTS_DIR, projectName, '.relay-sync.json');
  try {
    if (fs.existsSync(syncFile)) {
      return JSON.parse(fs.readFileSync(syncFile, 'utf8'));
    }
  } catch {}
  return { history: [] };
}

// Write .relay-sync.json
function writeSyncHistory(projectName, data) {
  const syncFile = path.join(opener.PROJECTS_DIR, projectName, '.relay-sync.json');
  try {
    fs.writeFileSync(syncFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[sync] Failed to write sync history:', e.message);
  }
}


// --- 4-6. Startup sequence ---
async function startup() {
  // 4. Ensure relay-data/ exists (includes projects/ subdir)
  opener.ensureRelayDataDir();
  opener.cleanupOldDB();
  opener.copyDesktopDB();

  // 5. Start opencode serve subprocess
  console.log('[relay] Starting opencode serve on 127.0.0.1:' + opener.OPCODE_PORT + '...');
  let opencodeProc;
  try {
    opencodeProc = opener.startOpencode(auth.OPCODE_PASSWORD);
    procRef = opencodeProc;
  } catch (err) {
    console.error('[relay] Failed to spawn opencode serve:', err.message);
    process.exit(1);
  }

  // 6. Wait for health check
  try {
    await opener.waitForReady(auth.OPCODE_PASSWORD);
  } catch (err) {
    console.error('[relay] opencode serve health check failed:', err.message);
    if (opencodeProc) opener.stopOpencode(opencodeProc).catch(() => {});
    process.exit(1);
  }

  // --- Auth middleware ---
  function authMiddleware(req, res) {
    if (!auth.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return false;
    }
    return true;
  }

  // --- Helper: read JSON body from request ---
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('invalid_json')); }
      });
      req.on('error', reject);
    });
  }

  // --- 7. HTTP server ---
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = req.url.split('?')[0];

      // Health check — no auth required
      if (urlPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, opencode: 'healthy' }));
        return;
      }

      // Setup API — set password via web UI (no auth required, only once)
      if (urlPath === '/api/setup/status' && req.method === 'GET') {
        const { loadConfig } = require('./lib/config');
        const configured = !!(process.env.OC_RELAY_PASSWORD || loadConfig().password);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured }));
        return;
      }

      if (urlPath === '/api/setup' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { password } = JSON.parse(body);
            if (!password || password.length < 4) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'password_min_length' }));
              return;
            }
            const { saveConfig } = require('./lib/config');
            saveConfig({ password });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: '密码已保存，请重启 Relay' }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
          }
        });
        return;
      }

      // Login API — validate password, return token (no auth required)
      if (urlPath === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { password } = JSON.parse(body);
            if (!password) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'password_required' }));
              return;
            }
            const { loadConfig } = require('./lib/config');
            const { deriveToken } = require('./lib/auth');
            const expectedPassword = process.env.OC_RELAY_PASSWORD || loadConfig().password;
            if (!expectedPassword) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'not_configured' }));
              return;
            }
            if (password !== expectedPassword) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_password' }));
              return;
            }
            const token = deriveToken(password);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, token }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
          }
        });
        return;
      }

      // Models config endpoint — auth required
      if (urlPath === '/api/models' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const { getCapabilities } = require('./lib/models');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await getCapabilities()));
        return;
      }

      // Relay status — auth required, comprehensive health snapshot
      if (urlPath === '/api/relay/status' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const { collectStatus } = require('./lib/status');
        const status = await collectStatus(procRef);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
      }

      // Workspace — returns the fixed mobile workspace path
      if (urlPath === '/api/workspace' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: opener.PROJECTS_DIR }));
        return;
      }

      // Directory scan — auth required, scans Desktop for import candidates only
      // (does NOT include the mobile workspace or imported projects)
      if (urlPath === '/api/scan-directories' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const scanned = [];
        // Scan Desktop: find directories that ARE projects (have opencode.jsonc)
        // or directories that CONTAIN projects (backup containers like opencode还原点)
        function scanDir(dir, depth) {
          if (depth > 3) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              if (e.name.startsWith('.')) continue;
              if (e.name === 'node_modules' || e.name === 'relay-data' || e.name === '.git') continue;
              const full = path.join(dir, e.name);
              // Direct project: has opencode.jsonc
              if (fs.existsSync(path.join(full, 'opencode.jsonc')) || fs.existsSync(path.join(full, '.opencode.jsonc'))) {
                scanned.push(full);
                continue;
              }
              // Container: check if any immediate child is a project
              try {
                const children = fs.readdirSync(full, { withFileTypes: true });
                const hasProjectChild = children.some(c =>
                  c.isDirectory() && (
                    fs.existsSync(path.join(full, c.name, 'opencode.jsonc')) ||
                    fs.existsSync(path.join(full, c.name, '.opencode.jsonc'))
                  )
                );
                if (hasProjectChild) {
                  scanned.push(full);
                  continue;
                }
              } catch {}
              // Otherwise recurse deeper
              scanDir(full, depth + 1);
            }
          } catch {}
        }
        scanDir(path.join(os.homedir(), 'Desktop'), 0);
        // Also add Desktop itself if it's a project
        const desktopPath = path.join(os.homedir(), 'Desktop');
        if (!scanned.includes(desktopPath)) {
          scanned.push(desktopPath);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(scanned));
        return;
      }

      // --- Project import endpoints (Plan A) ---

      // List imported projects
      if (urlPath === '/api/project/imported' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const projects = listImportedProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(projects));
        return;
      }

      // Import a project: two-phase — pre-scan size, then copy
      // Phase 1 (no confirm): pre-scan, return size info or proceed if small
      // Phase 2 (confirm=true): skip pre-scan, execute copy
      if (urlPath === '/api/project/import' && req.method === 'POST') {
        if (!authMiddleware(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const srcPath = body.path;
          const confirm = body.confirm === true;
          // Client-configurable size limits (in MB), with sane bounds
          const softMB = Math.max(1, Math.min(10240, body.softMB || 100));
          const hardMB = Math.max(softMB + 1, Math.min(10240, body.hardMB || 2048));

          if (!srcPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '缺少 path 参数' }));
            return;
          }
          // Validate path
          const validation = validateImportPath(srcPath);
          if (!validation.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: validation.error }));
            return;
          }
          // Determine target directory name
          const projectName = path.basename(path.resolve(srcPath));
          const safeName = projectName.replace(/[<>:"/\|?*]/g, '_');
          if (!safeName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '无效的项目名称' }));
            return;
          }
          const targetPath = path.join(opener.PROJECTS_DIR, safeName);
          // Check if target already exists
          if (fs.existsSync(targetPath)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '项目已存在: ' + safeName, name: safeName, path: targetPath }));
            return;
          }

          // ── Phase 1: Pre-scan (skip if confirm=true) ──
          if (!confirm) {
            const sizeInfo = measureDirSize(srcPath);
            const HARD_SIZE_LIMIT  = hardMB * 1024 * 1024;         // client-configured — reject
            const SOFT_SIZE_LIMIT  = softMB * 1024 * 1024;         // client-configured — need confirm
            const HARD_FILE_LIMIT  = 100000;                      // 100k files — reject
            const SOFT_FILE_LIMIT  = 10000;                       // 10k files — need confirm

            // Hard limit: reject outright
            if (sizeInfo.size > HARD_SIZE_LIMIT || sizeInfo.fileCount > HARD_FILE_LIMIT || sizeInfo.truncated) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: sizeInfo.truncated
                  ? '项目过大（扫描超限），已阻止导入'
                  : '项目过大，已阻止导入',
                size: sizeInfo.size,
                sizeReadable: formatSize(sizeInfo.size),
                fileCount: sizeInfo.fileCount,
                truncated: sizeInfo.truncated,
                hardLimit: true,
              }));
              return;
            }

            // Soft limit: return warning, need client confirmation
            if (sizeInfo.size > SOFT_SIZE_LIMIT || sizeInfo.fileCount > SOFT_FILE_LIMIT) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                warning: true,
                message: '项目较大，导入可能耗时较长或占用较多磁盘空间',
                size: sizeInfo.size,
                sizeReadable: formatSize(sizeInfo.size),
                fileCount: sizeInfo.fileCount,
                name: safeName,
                path: srcPath,
              }));
              return;
            }

            // Small enough — fall through to actual copy
          }

          // ── Phase 2: Actual copy ──
          console.log('[import] Copying ' + srcPath + ' -> ' + targetPath);
          const startTime = Date.now();
          try {
            fs.cpSync(srcPath, targetPath, {
              recursive: true,
              filter: importFilter,
            });
          } catch (copyErr) {
            // Cleanup partial copy on failure
            console.error('[import] Copy failed, cleaning up:', copyErr.message);
            try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch {}
            throw copyErr;
          }
          const elapsed = Date.now() - startTime;
          // Count files copied
          let fileCount = 0;
          function countFiles(dir) {
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const e of entries) {
                if (e.isDirectory()) countFiles(path.join(dir, e.name));
                else fileCount++;
              }
            } catch {}
          }
          countFiles(targetPath);
          console.log('[import] Done: ' + fileCount + ' files in ' + elapsed + 'ms');

          // Write .relay-meta.json with source path and file hashes
          try {
            const meta = {
              type: 'imported',
              sourcePath: path.resolve(srcPath),
              sourceLabel: pathToHumanLabel(path.resolve(srcPath)),
              importedAt: new Date().toISOString(),
              importedFiles: fileCount,
            };
            fs.writeFileSync(
              path.join(targetPath, '.relay-meta.json'),
              JSON.stringify(meta, null, 2)
            );
          } catch (e) {
            console.warn('[import] Failed to write .relay-meta.json:', e.message);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            name: safeName,
            path: targetPath,
            files: fileCount,
            elapsed_ms: elapsed,
          }));
        } catch (err) {
          console.error('[import] Error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '导入失败: ' + err.message }));
        }
        return;
      }


      // Create an empty workspace (no source import)
      // POST /api/project/create  body: { name }
      if (urlPath === '/api/project/create' && req.method === 'POST') {
        if (!authMiddleware(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const rawName = (body.name || '').trim();
          // Sanitize: strip path separators, control chars, and illegal Windows chars
          const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
          if (!safeName || safeName === '.' || safeName === '..') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '工作区名称无效' }));
            return;
          }
          const targetPath = path.join(opener.PROJECTS_DIR, safeName);
          if (fs.existsSync(targetPath)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '已存在同名工作区: ' + safeName, name: safeName, path: targetPath }));
            return;
          }
          fs.mkdirSync(targetPath, { recursive: true });
          // Write .relay-meta.json — type 'created' means no source to sync back to
          try {
            const meta = {
              type: 'created',
              sourcePath: '',
              sourceLabel: '',
              createdAt: new Date().toISOString(),
            };
            fs.writeFileSync(
              path.join(targetPath, '.relay-meta.json'),
              JSON.stringify(meta, null, 2)
            );
          } catch (e) {
            console.warn('[create] Failed to write .relay-meta.json:', e.message);
          }
          console.log('[create] Created empty workspace: ' + safeName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: safeName, path: targetPath }));
        } catch (err) {
          console.error('[create] Error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '创建工作区失败: ' + err.message }));
        }
        return;
      }

      // Delete an imported project
      // URL pattern: /api/project/imported/:name
      if (urlPath.startsWith('/api/project/imported/') && req.method === 'DELETE') {
        if (!authMiddleware(req, res)) return;
        const projectName = decodeURIComponent(urlPath.slice('/api/project/imported/'.length));
        // Validate name: no path separators, no ".."
        if (!projectName || projectName.includes('/') || projectName.includes('\\') || projectName.includes('..')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无效的项目名称' }));
          return;
        }
        const targetPath = path.join(opener.PROJECTS_DIR, projectName);
        // Security: ensure target is inside projects dir
        const projectsDir = path.resolve(opener.PROJECTS_DIR);
        const resolved = path.resolve(targetPath);
        if (!resolved.startsWith(projectsDir + path.sep) && resolved !== projectsDir) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '禁止访问' }));
          return;
        }
        if (!fs.existsSync(targetPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '项目不存在' }));
          return;
        }
        try {
          fs.rmSync(targetPath, { recursive: true, force: true });
          console.log('[import] Deleted project: ' + projectName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: projectName }));
        } catch (err) {
          console.error('[import] Delete error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '删除失败: ' + err.message }));
        }
        return;
      }


      // --- Sync (回并) endpoints ---

      // GET /api/project/sync/status?name=xxx — check sync preconditions
      if (urlPath === '/api/project/sync/status' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const projectName = new URL(req.url, 'http://x').searchParams.get('name');
        if (!projectName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 name 参数' }));
          return;
        }
        const projectPath = path.join(opener.PROJECTS_DIR, projectName);
        if (!fs.existsSync(projectPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '项目不存在' }));
          return;
        }
        // Read .relay-meta.json
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(path.join(projectPath, '.relay-meta.json'), 'utf8'));
        } catch {}
        const sourcePath = meta.sourcePath || '';
        const sourceExists = sourcePath && fs.existsSync(sourcePath);
        const hasGit = sourceExists ? checkGitAvailable(sourcePath) : false;
        const gitDirty = hasGit ? gitHasUncommitted(sourcePath) : false;
        const syncHistory = readSyncHistory(projectName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: projectName,
          sourcePath: sourcePath,
          sourceLabel: meta.sourceLabel || (sourcePath ? pathToHumanLabel(sourcePath) : '未知'),
          sourceExists: sourceExists,
          hasGit: hasGit,
          gitDirty: gitDirty,
          history: syncHistory.history || [],
        }));
        return;
      }

      // POST /api/project/sync — sync relay project back to source
      if (urlPath === '/api/project/sync' && req.method === 'POST') {
        if (!authMiddleware(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const projectName = body.name;
          const backupChoice = body.backupChoice || 'backup'; // 'backup' | 'direct' | 'cancel'
          const conflictResolutions = body.conflicts || {}; // { "rel/path": "relay" | "source" }

          if (!projectName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '缺少 name 参数' }));
            return;
          }

          const projectPath = path.join(opener.PROJECTS_DIR, projectName);
          if (!fs.existsSync(projectPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '项目不存在' }));
            return;
          }

          // Read .relay-meta.json
          let meta = {};
          try {
            meta = JSON.parse(fs.readFileSync(path.join(projectPath, '.relay-meta.json'), 'utf8'));
          } catch {}
          const sourcePath = meta.sourcePath || '';

          if (!sourcePath || !fs.existsSync(sourcePath)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '找不到原始项目路径' }));
            return;
          }

          const now = new Date();
          const timestamp = now.toISOString();
          const timeLabel = now.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          const shortTime = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

          // --- Backup ---
          let backupFile = null;
          let backupLabel = null;
          if (backupChoice === 'backup') {
            const backupDir = getBackupDir(projectName);
            backupFile = '回并前备份_' + shortTime + '.zip';
            const backupPath = path.join(backupDir, backupFile);
            console.log('[sync] Creating backup:', backupPath);
            const ok = createZipBackup(sourcePath, backupPath);
            if (!ok) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: '备份失败，已中止回并' }));
              return;
            }
            backupLabel = pathToHumanLabel(sourcePath) + '（' + timeLabel + ' 回并前备份）';
            // Clean old backups, keep 5
            cleanOldBackups(projectName, 5);
          }

          // --- Hash comparison ---
          // 1. Import-time hashes (from .relay-meta.json)
          const importHashes = meta.files || {};
          // If meta doesn't have files, compute current relay hashes as baseline
          const baselineHashes = Object.keys(importHashes).length > 0 ? importHashes : hashDirFiles(projectPath);

          // 2. Current relay hashes
          const relayHashes = hashDirFiles(projectPath);

          // 3. Current source hashes
          const sourceHashes = hashDirFiles(sourcePath);

          // --- Compare and classify files ---
          const toOverwrite = []; // relay changed, source didn't
          const toCreate = [];    // new in relay, not in source
          const toDelete = [];    // deleted in relay, exists in source
          const conflicts = [];   // both changed
          const skipped = [];     // source changed, relay didn't

          const allPaths = new Set([...Object.keys(relayHashes), ...Object.keys(sourceHashes), ...Object.keys(baselineHashes)]);

          for (const relPath of allPaths) {
            const relayHash = relayHashes[relPath];
            const sourceHash = sourceHashes[relPath];
            const baseHash = baselineHashes[relPath];

            if (relayHash && !sourceHash) {
              // New file in relay
              toCreate.push(relPath);
            } else if (!relayHash && sourceHash) {
              // Deleted in relay (or was in source but not relay)
              if (baseHash) {
                // Was there at import time, AI deleted it
                toDelete.push(relPath);
              }
              // else: source has a file that was never imported, skip
            } else if (relayHash && sourceHash) {
              const relayChanged = !baseHash || relayHash !== baseHash;
              const sourceChanged = !baseHash || sourceHash !== baseHash;

              if (relayChanged && !sourceChanged) {
                toOverwrite.push(relPath);
              } else if (!relayChanged && sourceChanged) {
                skipped.push(relPath);
              } else if (relayChanged && sourceChanged) {
                if (relayHash === sourceHash) {
                  // Both changed to same content, skip
                } else {
                  conflicts.push(relPath);
                }
              }
              // else: neither changed, skip
            }
          }

          // --- Resolve conflicts ---
          const conflictOverwrites = [];
          const conflictSkipped = [];
          for (const relPath of conflicts) {
            const choice = conflictResolutions[relPath] || 'source'; // default: keep source
            if (choice === 'relay') {
              conflictOverwrites.push(relPath);
            } else {
              conflictSkipped.push(relPath);
            }
          }

          // --- Execute sync ---
          const allOverwrite = [...toOverwrite, ...conflictOverwrites];
          let copiedCount = 0;
          let createdCount = 0;
          let deletedCount = 0;

          // Copy changed/new files from relay to source
          for (const relPath of [...allOverwrite, ...toCreate]) {
            const srcFile = path.join(projectPath, relPath);
            const dstFile = path.join(sourcePath, relPath);
            try {
              fs.mkdirSync(path.dirname(dstFile), { recursive: true });
              fs.copyFileSync(srcFile, dstFile);
              if (toCreate.includes(relPath)) {
                createdCount++;
              } else {
                copiedCount++;
              }
            } catch (e) {
              console.error('[sync] Failed to copy ' + relPath + ':', e.message);
            }
          }

          // Delete files that AI removed
          for (const relPath of toDelete) {
            const dstFile = path.join(sourcePath, relPath);
            try {
              fs.unlinkSync(dstFile);
              deletedCount++;
            } catch {}
          }

          // --- Record sync history ---
          const syncRecord = {
            timestamp: timestamp,
            timeLabel: timeLabel,
            backupFile: backupFile,
            backupLabel: backupLabel,
            backupChoice: backupChoice,
            sourcePath: sourcePath,
            sourceLabel: meta.sourceLabel || pathToHumanLabel(sourcePath),
            stats: {
              overwritten: copiedCount,
              created: createdCount,
              deleted: deletedCount,
              skipped: skipped.length + conflictSkipped.length,
              conflicts: conflicts.length,
            },
            conflictDetails: {
              resolved: conflictOverwrites.length,
              kept: conflictSkipped.length,
            },
          };

          const syncData = readSyncHistory(projectName);
          syncData.history = syncData.history || [];
          syncData.history.unshift(syncRecord);
          // Keep last 20 sync records
          if (syncData.history.length > 20) {
            syncData.history = syncData.history.slice(0, 20);
          }
          writeSyncHistory(projectName, syncData);

          console.log('[sync] Done: ' + copiedCount + ' overwritten, ' + createdCount + ' created, ' + deletedCount + ' deleted, ' + conflicts.length + ' conflicts');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            stats: syncRecord.stats,
            conflictDetails: syncRecord.conflictDetails,
            conflicts: conflicts,
            backupFile: backupFile,
            backupLabel: backupLabel,
            timestamp: timestamp,
          }));
        } catch (err) {
          console.error('[sync] Error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '回并失败: ' + err.message }));
        }
        return;
      }

      // POST /api/project/sync/undo — undo last sync by restoring backup
      if (urlPath === '/api/project/sync/undo' && req.method === 'POST') {
        if (!authMiddleware(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const projectName = body.name;
          const syncTimestamp = body.timestamp;

          if (!projectName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '缺少 name 参数' }));
            return;
          }

          const syncData = readSyncHistory(projectName);
          const record = (syncData.history || []).find(h => h.timestamp === syncTimestamp);
          if (!record || !record.backupFile) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '找不到备份记录或该次回并没有备份' }));
            return;
          }

          const backupDir = getBackupDir(projectName);
          const backupPath = path.join(backupDir, record.backupFile);
          if (!fs.existsSync(backupPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '备份文件已不存在' }));
            return;
          }

          // Extract backup to source path
          const ok = extractZipBackup(backupPath, record.sourcePath);
          if (!ok) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '撤销失败：无法恢复备份' }));
            return;
          }

          console.log('[sync] Undo completed for', projectName, 'at', syncTimestamp);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: '已恢复到回并前状态' }));
        } catch (err) {
          console.error('[sync] Undo error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '撤销失败: ' + err.message }));
        }
        return;
      }

      // GET /api/project/sync/history?name=xxx — get sync history
      if (urlPath === '/api/project/sync/history' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const projectName = new URL(req.url, 'http://x').searchParams.get('name');
        if (!projectName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '缺少 name 参数' }));
          return;
        }
        const syncData = readSyncHistory(projectName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(syncData));
        return;
      }

      // API proxy — auth required
      if (req.url.startsWith('/api/')) {
        if (!authMiddleware(req, res)) return;
        await proxyRequest(req, res);
        return;
      }

      // SSE tunnel — auth required
      if (req.url.startsWith('/sse/')) {
        if (!authMiddleware(req, res)) return;
        handleSSE(req, res);
        return;
      }

      // Static files (SPA fallback handled inside)
      serveStatic(req, res);
    } catch (err) {
      console.error('[relay] Request error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  });
  serverRef = server;

  // --- 8. Listen ---
  server.listen(PORT, '0.0.0.0', () => {
    console.log('  Server:    http://0.0.0.0:' + PORT);
    console.log('  Token:     ' + auth.TOKEN);
    console.log('');

    // Detect network interfaces and print URLs
    const nets = os.networkInterfaces();
    const addresses = [];

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push({ name, address: net.address });
          const tokenUrl = 'http://' + net.address + ':' + PORT + '?token=' + auth.TOKEN;
          console.log('  ' + name.padEnd(14) + ' ' + tokenUrl);
        }
      }
    }

    console.log('  ──────────────────────────────────');
    console.log('  Open this URL on your mobile device');
    console.log('');

    // QR code
    try {
      const qrcode = require('qrcode-terminal');
      const primaryIP = addresses.length > 0
        ? addresses.find(a => a.address.startsWith('100.'))
          || addresses[0].address
        : '127.0.0.1';
      const qrUrl = 'http://' + primaryIP + ':' + PORT + '?token=' + auth.TOKEN;
      qrcode.generate(qrUrl, { small: true });
      console.log('');
    } catch {
      // qrcode-terminal not available
    }
  });
}

// --- Boot ---
startup().catch(err => {
  console.error('[relay] Fatal startup error:', err.message);
  process.exit(1);
});
