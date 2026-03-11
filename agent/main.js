const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const Service = require('node-windows').Service;

let mainWindow = null;
let tray = null;
let serviceRunning = false;
let userStoppedService = false;

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const LOG_PATH    = path.join(__dirname, '..', 'logs', 'combined.log');

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
  // points to the middleware src/server.js relative to the agent
  return path.join(__dirname, '..', 'src', 'server.js');
}

function createService() {
  const cfg = loadConfig();
  const svc = new Service({
    name:        'TallyBitrixSync',
    description: 'TallyBitrixSync — Tally ↔ Bitrix24 Middleware',
    script:      getServiceScript(),
    env: [
      { name: 'NODE_ENV',           value: 'production'         },
      { name: 'PORT',               value: '3000'               },
      { name: 'BITRIX_WEBHOOK_URL', value: cfg.bitrixUrl        },
      { name: 'TALLY_HOST',         value: cfg.tallyHost        },
      { name: 'TALLY_PORT',         value: String(cfg.tallyPort)},
      { name: 'TALLY_COMPANY',      value: cfg.tallyCompany     },
    ]
  });
  return svc;
}

function checkServiceStatus(cb) {
  if (userStoppedService) {
    serviceRunning = false;
    cb(false);
    return;
  }
  exec('sc query TallyBitrixSync', (err, stdout) => {
    if (!err && stdout.includes('RUNNING')) {
      serviceRunning = true;
      cb(true);
      return;
    }
    const http = require('http');
    const req = http.request({ hostname: 'localhost', port: 3000, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
      serviceRunning = res.statusCode === 200;
      cb(serviceRunning);
    });
    req.on('error', () => { serviceRunning = false; cb(false); });
    req.on('timeout', () => { serviceRunning = false; cb(false); req.destroy(); });
    req.end();
  });
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
  const req = http.request({ hostname: 'localhost', port: 3000, path: '/sync/outstanding', method: 'POST' }, (res) => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      dialog.showMessageBox({ type: 'info', title: 'Sync Complete', message: `Sync triggered!\n${data}` });
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
  const svc = createService();
  svc.on('start', () => { serviceRunning = true; updateTray(); });
  svc.start();
}

function stopService() {
  const svc = createService();
  svc.on('stop', () => { serviceRunning = false; updateTray(); });
  svc.stop();
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
  const results = { bitrix: false, tally: false, bitrixError: '', tallyError: '' };

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
  return new Promise((resolve) => {
    const svc = createService();
    svc.on('install', () => { svc.start(); });
    svc.on('start',   () => { serviceRunning = true; updateTray(); resolve({ success: true }); });
    svc.on('error',   (e) => resolve({ success: false, error: String(e) }));
    svc.install();
  });
});

ipcMain.handle('uninstall-service', async () => {
  return new Promise((resolve) => {
    const svc = createService();
    svc.on('uninstall', () => { serviceRunning = false; updateTray(); resolve({ success: true }); });
    svc.on('error',     (e) => resolve({ success: false, error: String(e) }));
    svc.uninstall();
  });
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
  userStoppedService = false;
  exec('sc start TallyBitrixSync', () => {});
  serviceRunning = true;
  updateTray();
  return { success: true };
});

ipcMain.handle('stop-service', async () => {
  userStoppedService = true;
  exec('sc stop TallyBitrixSync', () => {});
  serviceRunning = false;
  updateTray();
  return { success: true };
});

ipcMain.on('close-window',    () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.tallybитрикс.sync');
  createTray();

  if (!isConfigured()) {
    createMainWindow('setup');
  } else {
    createMainWindow('dashboard');
  }
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in tray
app.on('activate', openDashboard);