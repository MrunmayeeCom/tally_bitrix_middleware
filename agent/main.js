const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let serviceRunning = false;
let userStoppedService = false;
let serverProcess = null;

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const LOG_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'middleware', 'logs', 'combined.log')
  : path.join(__dirname, '..', 'logs', 'combined.log');

// ── helpers ──────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return null;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function isConfigured() {
  const cfg = loadConfig();
  return !!(cfg && cfg.bitrixUrl && cfg.tallyHost && cfg.tallyPort && cfg.tallyCompany);
}

function getServiceScript() {
  // In production (packaged .exe), resources are in process.resourcesPath
  // In development, use relative path
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'middleware', 'src', 'server.js');
  }
  return path.join(__dirname, '..', 'src', 'server.js');
}

function getNodeExecutable() {
  if (!app.isPackaged) return 'node';
  
  // Try common Node.js install paths on Windows
  const nodePaths = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(process.env.APPDATA, '..', 'Local', 'Programs', 'node', 'node.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
  ];
  
  for (const p of nodePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  
  // Fallback to PATH
  return 'node';
}

function checkServiceStatus(cb) {
  if (userStoppedService) { serviceRunning = false; cb(false); return; }
  // Primary check — is port 3000 actually responding?
  const http = require('http');
  const req = http.request({
    hostname: 'localhost', port: 3000, path: '/health', method: 'GET', timeout: 2000
  }, (res) => {
    serviceRunning = res.statusCode === 200;
    cb(serviceRunning);
  });
  req.on('error',   () => { serviceRunning = false; cb(false); });
  req.on('timeout', () => { serviceRunning = false; cb(false); req.destroy(); });
  req.end();
}

function spawnServer(cfg) {
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }

  const nodePath   = getNodeExecutable();
  const scriptPath = getServiceScript();

  const env = Object.assign({}, process.env, {
    NODE_ENV:           'production',
    PORT:               '3000',
    BITRIX_WEBHOOK_URL: cfg.bitrixUrl,
    TALLY_HOST:         cfg.tallyHost,
    TALLY_PORT:         String(cfg.tallyPort),
    TALLY_COMPANY:      cfg.tallyCompany,
  });

  serverProcess = spawn(nodePath, [scriptPath], {
    env,
    detached: false,
    stdio:    'ignore',
  });

  serverProcess.on('exit', (code) => {
    serviceRunning = false;
    serverProcess  = null;
    if (!userStoppedService) {
      // Auto-restart after 5s if it crashed
      setTimeout(() => {
        const cfg = loadConfig();
        if (cfg && !userStoppedService) spawnServer(cfg);
      }, 5000);
    }
    updateTray();
  });

  serviceRunning     = true;
  userStoppedService = false;
}

function updateTray() {
  if (!tray) return;
  checkServiceStatus((running) => {
    const icon = nativeImage.createFromPath(
      path.join(__dirname, 'assets', running ? 'icon-green.png' : 'icon-red.png')
    );
    tray.setImage(icon);
    tray.setToolTip(`TallyBitrixSync — ${running ? 'Running ✅' : 'Stopped ❌'}`);

    const menu = Menu.buildFromTemplate([
      { label: `TallyBitrixSync`,       enabled: false                                   },
      { label: running ? '● Running' : '○ Stopped', enabled: false                       },
      { type:  'separator'                                                                },
      { label: 'Sync Now',              click: triggerSync, enabled: running             },
      { label: 'View Logs',             click: openLogs                                  },
      { label: 'Open Dashboard',        click: openDashboard                             },
      { type:  'separator'                                                                },
      { label: running ? 'Stop Service' : 'Start Service',
        click: running ? stopService : startService                                       },
      { label: 'Settings',              click: openSettings                              },
      { type:  'separator'                                                                },
      { label: 'Quit',                  click: () => app.quit()                          },
    ]);
    tray.setContextMenu(menu);
  });
}

function triggerSync() {
  const http = require('http');
  const cfg = loadConfig() || {};
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

  const req = http.request({
    hostname: 'localhost', port: 3000,
    path: '/sync/outstanding', method: 'POST',
    timeout: 10000,
    headers
  }, (res) => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      if (res.statusCode === 401) {
        dialog.showErrorBox('Auth Error', 'API key mismatch. Check settings.');
        return;
      }
      dialog.showMessageBox({ type: 'info', title: 'Sync Complete', message: `Sync triggered successfully!` });
    });
  });
  req.on('error', () => dialog.showErrorBox('Sync Failed', 'Could not reach the sync service. Is it running?'));
  req.end();
}

function openLogs() {
  shell.openPath(LOG_PATH).catch(() => {
    shell.openPath(app.getPath('userData'));
  });
}

function openDashboard() {
  createMainWindow('dashboard');
}

function openSettings() {
  createMainWindow('settings');
}

function startService() {
  userStoppedService = false;
  const cfg = loadConfig();
  if (cfg) spawnServer(cfg);
  updateTray();
}

function stopService() {
  userStoppedService = true;
  if (serverProcess) {
    try { serverProcess.kill(); } catch {}
    serverProcess = null;
  }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3000\') do taskkill /F /PID %a', () => {});
  serviceRunning = false;
  updateTray();
}

// ── windows ───────────────────────────────────────────────────────────────────

function createMainWindow(page = 'setup') {
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('navigate', page);
    return;
  }

  mainWindow = new BrowserWindow({
    width:           520,
    height:          680,
    resizable:       false,
    frame:           false,
    transparent:     true,
    webPreferences:  { nodeIntegration: true, contextIsolation: false },
    icon:            path.join(__dirname, 'assets', 'icon-green.png'),
    titleBarStyle:   'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'installer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('navigate', page);
    mainWindow.webContents.send('config', loadConfig());
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon-red.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('TallyBitrixSync');
  tray.on('double-click', openDashboard);
  updateTray();
  setInterval(updateTray, 10000); // refresh every 10s
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('test-connections', async (_, cfg) => {
  const results = { bitrix: false, tally: false, bitrixError: '', tallyError: '', nodeError: '' };

  // Check Node.js is available
  try {
    await new Promise((resolve, reject) => {
      exec('node --version', (err, stdout) => {
        if (err) reject(new Error('Node.js not found'));
        else resolve(stdout.trim());
      });
    });
  } catch (e) {
    results.nodeError = 'Node.js is not installed. Download from nodejs.org';
    return results;
  }
  exec('netstat -aon | findstr :3000', (err, stdout) => {
    if (stdout && stdout.includes('LISTENING')) {
      results.portWarning = 'Port 3000 is in use — existing service will be restarted';
    }
  });
  // Test Bitrix24
  try {
    const https = require('https');
    await new Promise((resolve, reject) => {
      const url = cfg.bitrixUrl.replace(/\/$/, '') + '/crm.category.list?entityTypeId=2';
      https.get(url, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(d);
            if (json.result) { results.bitrix = true; resolve(); }
            else reject(new Error('Invalid response'));
          } catch { reject(new Error('Invalid JSON')); }
        });
      }).on('error', reject);
    });
  } catch (e) { results.bitrixError = e.message; }

  // Test Tally
  try {
    const http = require('http');
    const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: cfg.tallyHost, port: parseInt(cfg.tallyPort),
        path: '/', method: 'POST',
        headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          // Any HTTP response from Tally = it is running
          results.tally = true;
          resolve();
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => reject(new Error('Timeout')));
      req.write(xml);
      req.end();
    });
  } catch (e) { results.tallyError = e.message; }

  return results;
});

ipcMain.handle('install-service', async (_, cfg) => {
  saveConfig(cfg);
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3000\') do taskkill /F /PID %a', () => {});

  await new Promise(r => setTimeout(r, 1500));
  spawnServer(cfg);

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const alive = await new Promise(r => checkServiceStatus(r));
    if (alive) return { success: true };
  }
  return { success: true };
});

ipcMain.handle('uninstall-service', async () => {
  userStoppedService = true;
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3000\') do taskkill /F /PID %a', () => {});
  try { fs.unlinkSync(CONFIG_PATH); } catch {}
  serviceRunning = false;
  updateTray();
  return { success: true };
});
 
ipcMain.handle('get-status', async () => {
  return new Promise((resolve) => {
    checkServiceStatus((running) => {
      resolve({ running, config: loadConfig() });
    });
  });
});

ipcMain.handle('trigger-sync', async () => {
  triggerSync();
  return { triggered: true };
});

ipcMain.handle('get-sync-history', async () => {
  try {
    const historyPaths = [
      path.join(__dirname, '..', 'logs', 'sync-history.json'),
      app.isPackaged
        ? path.join(process.resourcesPath, 'middleware', 'logs', 'sync-history.json')
        : path.join(__dirname, '..', 'logs', 'sync-history.json')
    ];
    for (const p of historyPaths) {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    }
    return [];
  } catch { return []; }
});

ipcMain.handle('get-logs', async () => {
  try {
    const logPaths = [
      LOG_PATH,
      path.join(__dirname, '..', 'logs', 'combined.log'),
      path.join(app.getPath('userData'), 'sync.log')
    ];
    for (const p of logPaths) {
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf8').split('\n').slice(-100);
        return lines.join('\n');
      }
    }
    return 'No logs yet.';
  } catch { return 'Could not read logs.'; }
});

ipcMain.handle('start-service', async () => {
  const cfg = loadConfig();
  if (cfg) spawnServer(cfg);
  updateTray();
  return { success: true };
});

ipcMain.handle('stop-service', async () => {
  userStoppedService = true;
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3000\') do taskkill /F /PID %a', () => {});
  serviceRunning = false;
  updateTray();
  return { success: true };
});

ipcMain.handle('save-and-restart', async (_, cfg) => {
  saveConfig(cfg);
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3000\') do taskkill /F /PID %a', () => {});
  await new Promise(r => setTimeout(r, 1500));
  spawnServer(cfg);
  updateTray();
  return { success: true };
});

ipcMain.on('close-window',    () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.rajlaxmi.tallybitrixsync');
  app.setLoginItemSettings({ openAtLogin: true });
  createTray();

  if (!isConfigured()) {
    createMainWindow('setup');
  } else {
    // Auto-start server on app launch
    const cfg = loadConfig();
    if (cfg) spawnServer(cfg);
    createMainWindow('dashboard');
  }
});

app.on('before-quit', () => {
  if (serverProcess) { try { serverProcess.kill(); } catch {} }
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in tray
app.on('activate', openDashboard);