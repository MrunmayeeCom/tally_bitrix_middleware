const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const logger = (() => { try { return require('../src/utils/logger'); } catch { return console; } })();

let mainWindow = null;
let tray = null;
let serviceRunning = false;
let userStoppedService = false;
let serverProcess = null;
let _licenseValid = false;
let _licensePlan  = 'Validating…';

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
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    logger.error('Config save failed: ' + e.message);
  }
}

function isConfigured() {
  const cfg = loadConfig();
  const hasCompany = cfg?.tallyCompanies?.length > 0 || cfg?.tallyCompany;
  const hasBitrix = cfg?.bitrixDomain || cfg?.bitrixUrl;
  return !!(cfg && hasBitrix && cfg.tallyHost && cfg.tallyPort && hasCompany);
}

function getCompanies(cfg) {
  if (!cfg) return [];
  // Support both old single company and new array format
  if (cfg.tallyCompanies && cfg.tallyCompanies.length > 0) return cfg.tallyCompanies;
  if (cfg.tallyCompany) return [cfg.tallyCompany];
  return [];
}

function getActiveCompany(cfg) {
  const companies = getCompanies(cfg);
  // Use selected company or default to first
  if (cfg.activeCompany && companies.includes(cfg.activeCompany)) return cfg.activeCompany;
  return companies[0] || '';
}

function getServiceScript() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'middleware', 'src', 'server.js');
  }
  return path.join(__dirname, '..', 'src', 'server.js');
}

function getNodeExecutable() {
  if (!app.isPackaged) return 'node';

  const nodePaths = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    path.join(process.env.APPDATA || '', '..', 'Local', 'Programs', 'node', 'node.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
  ];

  for (const p of nodePaths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  // Bundled node fallback — if you ship node.exe inside extraResources
  const bundled = path.join(process.resourcesPath, 'node', 'node.exe');
  try {
    if (fs.existsSync(bundled)) return bundled;
  } catch {}

  return 'node';
}

function checkServiceStatus(cb) {
  if (userStoppedService) { serviceRunning = false; cb(false); return; }
  // Primary check — is port 5050 actually responding?
  const http = require('http');
  const req = http.request({
    hostname: 'localhost', port: 5050, path: '/health', method: 'GET', timeout: 2000
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

  // Load license features from cache to pass to Node.js process
  let licenseFeatures = '{}';
  let licensePlan = '';
  try {
    const { loadLicenseCache } = require('../src/services/lmsService');
    const cache = loadLicenseCache();
    if (cache && cache.features) {
      licenseFeatures = JSON.stringify(cache.features);
      licensePlan = cache.plan || '';
    }
  } catch {}

  logger.info('[spawnServer] LICENSE_FEATURES length: ' + licenseFeatures.length + ' | LICENSE_PLAN: "' + licensePlan + '" | CUSTOMER_EMAIL: "' + (cfg.customerEmail || '') + '"');

  const env = Object.assign({}, process.env, {
    NODE_ENV:            'production',
    PORT:                '5050',
    BITRIX_WEBHOOK_URL:  cfg.bitrixUrl || '',
    BITRIX_DOMAIN:       cfg.bitrixDomain || '',
    BITRIX_CLIENT_ID:    cfg.bitrixClientId || '',
    TALLY_HOST:          cfg.tallyHost,
    TALLY_PORT:          String(cfg.tallyPort),
    TALLY_COMPANY:       getActiveCompany(cfg),
    TALLY_COMPANIES:     getCompanies(cfg).join(','),
    CUSTOMER_EMAIL:      cfg.customerEmail || '',
    RENDER_SERVER_URL:   'https://tally-bitrix-middleware.onrender.com',
    // CLIENT_ID must be the canonical bx-{memberId} format.
    // Never fall back to hostname-based IDs — they cause clientId mismatch in event poller.
    CLIENT_ID:           (/^bx-[0-9a-f]{20,}$/.test(cfg.bitrixClientId || '') ? cfg.bitrixClientId : ''),
    LICENSE_FEATURES:    licenseFeatures,
    LICENSE_PLAN:        licensePlan,
    BITRIX_CLIENT_SECRET: process.env.BITRIX_CLIENT_SECRET || '',
  });

  console.log('[SPAWN DEBUG] env.CLIENT_ID=', env.CLIENT_ID);
  console.log('[SPAWN DEBUG] env.LICENSE_FEATURES=', env.LICENSE_FEATURES ? env.LICENSE_FEATURES.substring(0, 80) + '...' : '(empty)');
  console.log('[SPAWN DEBUG] env.LICENSE_PLAN=', env.LICENSE_PLAN);

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
    const iconName = running ? 'icon-green.png' : 'icon-red.png';
    const iconPath = path.join(
      app.isPackaged ? process.resourcesPath : __dirname,
      'assets',
      iconName
    );
    const icon = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray.setImage(icon);
    tray.setToolTip(`TallyBitrixSync — ${running ? 'Running ✅' : 'Stopped ❌'}`);

    const menu = Menu.buildFromTemplate([
      { label: `TallyBitrixSync`,                                          enabled: false },
      { label: running ? '● Running' : '○ Stopped',                        enabled: false },
      { label: `Plan: ${_licensePlan}`,                                    enabled: false },
      { type:  'separator'                                                                },
      { label: 'Sync Outstanding',      click: triggerSync,        enabled: running      },
      { label: 'Sync Ledgers',          click: triggerLedgerSync,  enabled: running      },
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

function triggerLedgerSync() {
  const http = require('http');
  const cfg = loadConfig() || {};
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

  const probe = http.request(
    { hostname: 'localhost', port: 5050, path: '/health', method: 'GET', timeout: 3000 },
    (res) => {
      res.resume();
      if (res.statusCode !== 200) {
        dialog.showErrorBox('Service Not Running', 'The sync service is not responding.');
        return;
      }
      try {
        const req = http.request({
          hostname: 'localhost', port: 5050,
          path: '/sync/tally-to-bitrix', method: 'POST', headers
        }, (res) => { res.resume(); });
        req.on('error', () => {});
        req.setTimeout(5000, () => req.destroy());
        req.end();
      } catch {}
    }
  );
  probe.on('error', () => dialog.showErrorBox('Service Not Running', 'Could not reach the sync service on port 5050.'));
  probe.on('timeout', () => { probe.destroy(); dialog.showErrorBox('Timeout', 'Sync service timed out.'); });
  probe.end();
}

function triggerSync() {
  const http = require('http');
  const cfg = loadConfig() || {};
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

  function fireRequest(path) {
    try {
      const req = http.request({
        hostname: 'localhost', port: 5050,
        path, method: 'POST', headers
      }, (res) => { res.resume(); });
      req.on('error', () => {});
      req.setTimeout(5000, () => req.destroy());
      req.end();
    } catch {}
  }

  const probe = http.request(
    { hostname: 'localhost', port: 5050, path: '/health', method: 'GET', timeout: 3000 },
    (res) => {
      res.resume();
      if (res.statusCode !== 200) {
        dialog.showErrorBox('Service Not Running', 'The sync service is not responding.');
        return;
      }
      fireRequest('/sync/outstanding');
    }
  );
  probe.on('error', () => dialog.showErrorBox('Service Not Running', 'Could not reach the sync service on port 5050.'));
  probe.on('timeout', () => { probe.destroy(); dialog.showErrorBox('Timeout', 'Sync service timed out.'); });
  probe.end();
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
  try {
    const { isLicenseActive } = require('../src/services/featureGate');
    if (!isLicenseActive()) {
      dialog.showErrorBox('No Active License', 'Cannot start service — no active license found.\nPlease purchase or renew a license.');
      return;
    }
  } catch {}
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
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5050\') do taskkill /F /PID %a', () => {});
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

  const winIconPath = path.join(
    app.isPackaged ? process.resourcesPath : __dirname,
    'assets',
    'icon-green.png'
  );

  mainWindow = new BrowserWindow({
    width:           520,
    height:          680,
    resizable:       false,
    frame:           false,
    transparent:     true,
    webPreferences:  { nodeIntegration: true, contextIsolation: false },
    icon:            fs.existsSync(winIconPath) ? winIconPath : undefined,
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
  const iconPath = path.join(
    app.isPackaged ? process.resourcesPath : __dirname,
    'assets',
    'icon-red.png'
  );
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('TallyBitrixSync');
  tray.on('double-click', openDashboard);
  updateTray();
  setInterval(updateTray, 30000);
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
  exec('netstat -aon | findstr :5050', (err, stdout) => {
    if (stdout && stdout.includes('LISTENING')) {
      results.portWarning = 'Port 5050 is in use — existing service will be restarted';
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
          if (d.includes('<ENVELOPE>') || d.includes('<TALLYMESSAGE>') || d.includes('<COMPANY>') || d.includes('TallyPrime') || d.includes('<LINEERROR>')) {
            results.tally = true;
            resolve();
          } else {
            reject(new Error('Response received but not from Tally — is Tally open?'));
          }
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
  const savedCfg = loadConfig() || cfg; // reload from disk after save

  // Validate license and write cache BEFORE spawning, so child process
  // receives populated LICENSE_FEATURES / LICENSE_PLAN env vars
  try {
    const { validateLicense, saveLicenseCache } = require('../src/services/lmsService');
    const { setFeatures } = require('../src/services/featureGate');
    const result = await validateLicense(savedCfg.customerEmail);
    if (result.valid) {
      setFeatures(result.features, result.plan, result.valid);
      _licensePlan = result.plan || '';
      _licenseValid = true;
      saveLicenseCache({
        valid:         result.valid,
        plan:          result.plan,
        status:        'active',
        features:      result.features,
        customerEmail: savedCfg.customerEmail,
        licenseId:     result.licenseId,
      });
      process.env.CUSTOMER_EMAIL = savedCfg.customerEmail || '';
      logger.info('[Install] License validated — plan: ' + result.plan);
    } else {
      logger.warn('[Install] License invalid — server will start without license features: ' + (result.reason || 'unknown'));
    }
  } catch(e) {
    logger.warn('[Install] License validation error (non-fatal): ' + e.message);
  }

  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5050\') do taskkill /F /PID %a', () => {});

  await new Promise(r => setTimeout(r, 1500));
  spawnServer(savedCfg);

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const alive = await new Promise(r => checkServiceStatus(r));
    if (alive) return { success: true };
  }
  // Service did not respond after 10 seconds — report failure
  return { success: false, error: 'Service did not start in time — check Node.js is installed and Tally is running' };
});

ipcMain.handle('uninstall-service', async () => {
  userStoppedService = true;

  // Step 1 — Kill the spawned server process
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }

  // Step 2 — Force kill anything still on port 5050
  await new Promise(r => exec(
    'for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5050\') do taskkill /F /PID %a',
    () => r()
  ));

  // Step 3 — Wait for process to fully die
  await new Promise(r => setTimeout(r, 1500));

  // Step 4 — Remove config
  try { fs.unlinkSync(CONFIG_PATH); } catch {}

  // Step 5 — Remove all cache files
  const logsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'middleware', 'logs')
    : path.join(__dirname, '..', 'logs');

  const cacheFiles = [
    path.join(logsDir, 'license-cache.json'),
    path.join(logsDir, 'feature-registry-cache.json'),
    path.join(logsDir, 'usage-cache.json'),
    path.join(logsDir, 'pipeline-cache.json'),
    path.join(logsDir, 'tally-snapshot.json'),
    path.join(logsDir, 'sync-history.json'),
    path.join(logsDir, 'escalation-cooldown.json'),
    path.join(logsDir, 'voucher-masterid-cache.json'),
    path.join(logsDir, 'invoice-cache.json'),
  ];
  for (const f of cacheFiles) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }

  // Step 6 — Disable Windows auto-start
  try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}

  serviceRunning = false;
  updateTray();

  // Step 7 — Show confirmation and quit
  await dialog.showMessageBox(null, {
    type: 'info',
    title: 'Uninstalled',
    message: 'TallyBitrixSync has been uninstalled.',
    detail: 'Service stopped and all data cleared.\nYou can now delete the application folder.',
    buttons: ['OK']
  });

  app.quit();
  return { success: true };
});
 
ipcMain.handle('get-status', async () => {
  return new Promise((resolve) => {
    checkServiceStatus((running) => {
      // Include license cache so Electron dashboard has same data as Bitrix dashboard
      let license = null;
      try {
        const { loadLicenseCache } = require('../src/services/lmsService');
        const cache = loadLicenseCache();
        if (cache) {
          license = {
            plan    : cache.plan,
            status  : cache.status,
            endDate : cache.endDate,
            features: cache.features || {},
          };
        }
      } catch {}
      resolve({ running, config: loadConfig(), license });
    });
  });
});

ipcMain.handle('trigger-sync', async () => {
  triggerSync();
  return { triggered: true };
});

ipcMain.handle('trigger-ledger-sync', async () => {
  const http = require('http');
  const cfg = loadConfig() || {};
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

  const alive = await new Promise(r => checkServiceStatus(r));
  if (!alive) return { triggered: false, error: 'Service not running' };

  try {
    const req = http.request({
      hostname: 'localhost', port: 5050,
      path: '/sync/tally-to-bitrix', method: 'POST', headers
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
    req.end();
  } catch {}
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
  try {
    const { isLicenseActive } = require('../src/services/featureGate');
    if (!isLicenseActive()) {
      return { success: false, error: 'No active license — cannot start service' };
    }
  } catch {}
  const cfg = loadConfig();
  if (cfg) spawnServer(cfg);
  updateTray();
  return { success: true };
});

ipcMain.handle('stop-service', async () => {
  userStoppedService = true;
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5050\') do taskkill /F /PID %a', () => {});
  serviceRunning = false;
  updateTray();
  return { success: true };
});

ipcMain.handle('save-and-restart', async (_, cfg) => {
  saveConfig(cfg);

  const savedCfg = loadConfig() || cfg;

  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5050\') do taskkill /F /PID %a', () => {});
  await new Promise(r => setTimeout(r, 1500));
  spawnServer(savedCfg);
  updateTray();

  // Re-validate license after settings change — email may have changed,
  // or service was previously stopped for no-license and now needs reactivation
  setTimeout(() => bootstrapLicense(savedCfg), 3000);

  logger.info(`[Config] Service restarted with companies: [${getCompanies(savedCfg).join(', ')}]`);
  return { success: true };
});

ipcMain.handle('get-companies', async () => {
  const cfg = loadConfig();
  const companies = getCompanies(cfg);
  const active    = getActiveCompany(cfg);
  return { companies, active };
});

ipcMain.handle('switch-company', async (_, company) => {
  try {
    const http = require('http');
    const cfg  = loadConfig() || {};
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

    const alive = await new Promise(r => checkServiceStatus(r));
    if (!alive) return { success: false, error: 'Service not running' };

    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ company });
      const req = http.request({
        hostname: 'localhost', port: 5050,
        path: '/api/companies/switch', method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve({ success: false }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy());
      req.write(body);
      req.end();
    });

    // Also update the saved config so it persists across restarts
    if (result.success) {
      const currentCfg = loadConfig() || {};
      currentCfg.activeCompany = company;
      currentCfg.tallyCompany  = company;
      saveConfig(currentCfg);
    }

    return result;
  } catch(e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('update-company-usage', async (_, count) => {
  try {
    const { updateCompanyUsage } = require('../src/services/lmsService');
    await updateCompanyUsage(Number(count));
    return { success: true };
  } catch(e) {
    return { success: false, message: e.message };
  }
});

ipcMain.handle('scan-tally-companies', async (_, cfg = {}) => {
  try {
    // Use host/port from payload if provided (setup wizard sends them)
    const host = cfg.tallyHost || 'localhost';
    const port = cfg.tallyPort || 9000;

    // Temporarily override env so tallyConnector uses the right host/port
    const prevHost = process.env.TALLY_HOST;
    const prevPort = process.env.TALLY_PORT;
    process.env.TALLY_HOST = String(host);
    process.env.TALLY_PORT = String(port);

    const { getCompanyList } = require('../src/connectors/tallyConnector');
    const result = await getCompanyList();

    // Restore
    process.env.TALLY_HOST = prevHost || 'localhost';
    process.env.TALLY_PORT = prevPort || '9000';

    return result;
  } catch(e) {
    return { success: false, error: e.message, companies: [] };
  }
});

ipcMain.on('close-window',    () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setAppUserModelId('com.rajlaxmi.tallybitrixsync');

  // Only enable auto-launch in packaged production build
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
    });
  }

  createTray();

  // Kill any leftover process on port 5050 before starting fresh
  exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5050\') do taskkill /F /PID %a', () => {});

  if (!isConfigured()) {
    createMainWindow('setup');
  } else {
    const cfg = loadConfig();
    if (cfg) {
      userStoppedService = true;
      // Push a "connecting" status immediately so dashboard shows agent is alive
      setTimeout(pushStatusToRender, 2000);
      setTimeout(pushStatusToRender, 6000);
      setTimeout(() => bootstrapLicense(cfg), 1000);
    }
    createMainWindow('dashboard');
  }
});

// ── Plan transition handler ───────────────────────────────────────────────────
// Called when re-validation detects a plan change (expiry → new purchase, upgrade, downgrade)
async function handlePlanTransition(newResult) {
  try {
    const newCompanyLimit = Number(newResult.features['company-limit']) || 1;
    const currentCfg      = loadConfig() || {};
    const currentCompanies = getCompanies(currentCfg);

    if (currentCompanies.length > newCompanyLimit) {
      // New plan allows fewer companies — trim excess automatically
      const trimmed = currentCompanies.slice(0, newCompanyLimit);
      const removed = currentCompanies.slice(newCompanyLimit);

      currentCfg.tallyCompanies = trimmed;
      currentCfg.tallyCompany   = trimmed[0] || '';
      currentCfg.activeCompany  = trimmed[0] || '';
      saveConfig(currentCfg);

      // Sync corrected count to LMS
      try {
        const { updateCompanyUsage } = require('../src/services/lmsService');
        await updateCompanyUsage(trimmed.length);
      } catch(e) {
        logger.warn('[LMS] Company usage sync after plan transition failed: ' + e.message);
      }

      // Restart server with trimmed company list
      spawnServer(currentCfg);

      logger.info(`[LMS] Plan transition — companies trimmed: ${currentCompanies.length} → ${trimmed.length}`, {
        kept: trimmed, removed
      });

      dialog.showMessageBox(null, {
        type: 'warning',
        title: 'Companies Adjusted',
        message: `Your new plan (${newResult.plan}) supports up to ${newCompanyLimit} ${newCompanyLimit === 1 ? 'company' : 'companies'}.`,
        detail: `Kept: ${trimmed.join(', ')}\nRemoved: ${removed.join(', ')}\n\nYou can update this in Settings.`,
        buttons: ['OK']
      });

    } else {
      // New plan allows same or more — just restart with existing config
      spawnServer(currentCfg);
      logger.info(`[LMS] Plan transition — no company trim needed (${currentCompanies.length} companies within new limit of ${newCompanyLimit})`);
    }

    // Reset usage cache to match actual company count
    try {
      const { saveUsageCache } = require('../src/services/lmsService');
      saveUsageCache({ companyCount: Math.min(currentCompanies.length, newCompanyLimit) });
    } catch(e) {
      logger.warn('[LMS] Usage cache reset after plan transition failed: ' + e.message);
    }

  } catch(e) {
    logger.error('[LMS] handlePlanTransition failed: ' + e.message);
  }
}

async function bootstrapLicense(cfg) {
  // ── Clear stale bundled cache on first run ──────────────────────────
  try {
    const { loadLicenseCache, clearRegistryCache } = require('../src/services/lmsService');
    const cache = loadLicenseCache();
    // If cached email doesn't match configured email → wipe cache
    if (cache && cache.customerEmail && cfg.customerEmail &&
        cache.customerEmail !== cfg.customerEmail) {
      logger.info('[LMS] Different email detected — clearing stale license cache');
      clearRegistryCache();
    }
    // Immediately apply cached license so dashboard shows correct plan
    // even before network validation completes
    if (cache && cache.valid && cache.features) {
      const { setFeatures } = require('../src/services/featureGate');
      setFeatures(cache.features, cache.plan, cache.valid);
      _licensePlan = cache.plan || 'Cached';
      logger.info('[LMS] Applied cached license on startup — plan: ' + _licensePlan);
      // Trigger a push immediately so dashboard shows LIVE without waiting for full validation
      setTimeout(pushStatusToRender, 1000);
    }
  } catch {}
  // ───────────────────────────────────────────────────────────────────

  try {
    const { validateLicense, startHeartbeat, startRevalidation } = require('../src/services/lmsService');
    const { setFeatures, applyStarterFallback, getPlan } = require('../src/services/featureGate');

    const result = await validateLicense(cfg.customerEmail);
    _licenseValid = result.valid;
    _licensePlan  = result.plan || 'Unknown';

    if (result.valid) {
      // Bake email into env so child process (src/server.js) can use it immediately
      process.env.CUSTOMER_EMAIL = cfg.customerEmail || '';
      let previousPlan = getPlan();
      setFeatures(result.features, result.plan, result.valid);
      // Push status immediately after license validates — don't wait for 30s interval
      setTimeout(pushStatusToRender, 2000);
      setTimeout(pushStatusToRender, 8000);   // second push after server has fully started
      setTimeout(pushStatusToRender, 20000);  // third push to ensure dashboard sees LIVE

      // Kill any existing server before spawning fresh with correct license env
      if (serverProcess) {
        try { serverProcess.kill(); } catch {}
        serverProcess = null;
        await new Promise(r => setTimeout(r, 1500));
      }
      exec('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5050\') do taskkill /F /PID %a', () => {});
      await new Promise(r => setTimeout(r, 500));

      // Persist validated features to cache so spawnServer can read them from disk
      try {
        const { saveLicenseCache } = require('../src/services/lmsService');
        saveLicenseCache({
          valid:         result.valid,
          plan:          result.plan,
          status:        'active',
          features:      result.features,
          customerEmail: cfg.customerEmail,
          licenseId:     result.licenseId,
        });
        logger.info('[Bootstrap] License cache written before spawnServer — plan: ' + result.plan);
      } catch(e) {
        logger.warn('[Bootstrap] Could not write license cache before spawn: ' + e.message);
      }

      // License confirmed — spawn server NOW with features baked into env
      userStoppedService = false;

      // Re-read fresh config from disk — cfg param may be stale (bitrixClientId may
      // have been resolved by _resolveAndCacheClientId after bootstrapLicense started)
      const bootCfg = loadConfig() || cfg;
      console.log('[SPAWN DEBUG] cfg.bitrixClientId=', bootCfg.bitrixClientId);
      console.log('[SPAWN DEBUG] cfg.bitrixDomain=', bootCfg.bitrixDomain);
      console.log('[SPAWN DEBUG] cfg.customerEmail=', bootCfg.customerEmail);
      spawnServer(bootCfg);

      startHeartbeat(result.licenseId);
      logger.info(`[LMS] Heartbeat started for licenseId: ${result.licenseId}`);

      // On startup: always read fresh config from disk — cfg param may be stale
      // if settings were saved and service restarted before bootstrapLicense ran
      try {
        const { loadUsageCache, saveUsageCache, updateCompanyUsage } = require('../src/services/lmsService');
        const freshCfg    = loadConfig() || cfg;           // always read from disk
        const companies   = getCompanies(freshCfg);
        const usageCache  = loadUsageCache();
        const cachedCount = usageCache.companyCount || 0;

        logger.info(`[LMS] Startup company check — disk: ${companies.length}, cache: ${cachedCount}, companies: [${companies.join(', ')}]`);

        if (companies.length > cachedCount) {
          logger.info(`[LMS] Startup: local count (${companies.length}) > cache (${cachedCount}) — syncing delta to LMS`);
          await updateCompanyUsage(companies.length);
        } else if (companies.length < cachedCount) {
          logger.info(`[LMS] Startup: local count (${companies.length}) < cache (${cachedCount}) — updating local cache only`);
          saveUsageCache({ companyCount: companies.length });
        } else {
          logger.info(`[LMS] Startup: company count in sync (${companies.length}) — no correction needed`);
        }
      } catch(e) {
        logger.warn('[LMS] Startup usage cache sync failed: ' + e.message);
      }

      // Start periodic re-validation every 6 hours
      startRevalidation(cfg.customerEmail, async (newResult) => {

        // ── Case 1: License expired / no longer valid ────────────────────
        if (!newResult.valid) {
          applyStarterFallback(); // locks all features
          _licenseValid = false;
          _licensePlan  = 'Expired';
          userStoppedService = true; // prevents spawnServer auto-restart on exit
          if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
          serviceRunning = false;
          const { restartScheduler } = require('../src/scheduler');
          restartScheduler();
          dialog.showMessageBox(null, {
            type: 'warning', title: 'License Expired',
            message: 'Your license has expired. All sync has been stopped.',
            detail: 'Purchase or renew a license (Enterprise) to resume.',
            buttons: ['OK']
          });
          updateTray();
          return;
        }

        // ── Case 2: New license purchased after expiry OR plan changed ───
        if (newResult.plan !== previousPlan) {
          logger.info(`[LMS] Plan transition: ${previousPlan} → ${newResult.plan}`);

          setFeatures(newResult.features, newResult.plan, newResult.valid);
          _licenseValid = true;
          _licensePlan  = newResult.plan;
          previousPlan  = newResult.plan; // prevent repeat dialog on next revalidation cycle

          // Auto-enforce company limit — trim excess if new plan allows fewer
          await handlePlanTransition(newResult);

          const { restartScheduler } = require('../src/scheduler');
          restartScheduler();

          dialog.showMessageBox(null, {
            type: 'info', title: 'Plan Updated',
            message: `Your plan has been updated to ${newResult.plan}.`,
            detail: 'Sync schedule and features have been updated automatically.',
            buttons: ['OK']
          });
        }

        updateTray();
      });
      // Log registry info if available
      if (result.registry?.features) {
        logger.info && logger.info(`[LMS] Registry has ${result.registry.features.length} features for product`);
      }
      if (result.fromCache) {
        dialog.showMessageBox(null, {
          type: 'info', title: 'Offline Mode',
          message: 'Running on cached license (48h grace). Check your internet connection.',
          buttons: ['OK']
        });
      }
    } else {
      // No valid license — lock featureGate and kill server completely
      applyStarterFallback(); // sets _isActive = false, blocks all sync
      _licenseValid = false;
      _licensePlan  = 'No License';
      userStoppedService = true; // prevents spawnServer auto-restart on exit
      if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
      serviceRunning = false;
      updateTray();
      dialog.showMessageBox(null, {
        type: 'warning', title: 'No Active License',
        message: `No active license found for ${cfg.customerEmail}.`,
        detail: 'Please purchase or renew a license (Enterprise).\n\nReason: ' + result.reason,
        buttons: ['OK']
      });
    }
    updateTray();
  } catch(e) {
    logger.error('[Bootstrap] FATAL uncaught exception: ' + e.message + '\n' + e.stack);
    try {
      const { applyStarterFallback } = require('../src/services/featureGate');
      applyStarterFallback(); // locks all features on unexpected error
    } catch(e2) {
      logger.error('[Bootstrap] applyStarterFallback also failed: ' + e2.message);
    }
    _licenseValid      = false;
    _licensePlan       = 'No License';
    userStoppedService = true; // prevent auto-restart loop
    if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
    serviceRunning = false;
    updateTray();
  }
}

app.on('before-quit', () => {
  if (serverProcess) { try { serverProcess.kill(); } catch {} }
  try {
    const { clearHeartbeatInterval } = require('../src/services/lmsService');
    clearHeartbeatInterval();
  } catch {}
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in tray
app.on('activate', openDashboard);

// ── Push agent status to Render every 30s ────────────────────────────────────
function fetchLocalJson(path, timeout = 3000) {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.request(
      { hostname: 'localhost', port: 5050, path, method: 'GET', timeout },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function postLocalJson(path, body = {}, timeout = 8000) {
  return new Promise((resolve) => {
    const http = require('http');
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost', port: 5050, path, method: 'POST', timeout,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
      },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(bodyStr);
    req.end();
  });
}

async function pushStatusToRender() {
  try {
    const cfg = loadConfig();
    if (!cfg) {
      logger.warn('[Push] Skipped — no config found at: ' + CONFIG_PATH);
      return;
    }
    const clientId = getAgentClientId();

    logger.info('[Push] ===== PUSH DIAGNOSTIC =====');
    logger.info('[Push] config.bitrixClientId: "' + (cfg.bitrixClientId || 'EMPTY') + '"');
    logger.info('[Push] config.bitrixDomain:   "' + (cfg.bitrixDomain || 'EMPTY') + '"');
    logger.info('[Push] getAgentClientId() returned: "' + (clientId || 'NULL') + '"');

    if (!clientId) {
      logger.warn('[Push] Skipped — getAgentClientId() returned null. bitrixClientId=' + (cfg.bitrixClientId || 'EMPTY') + ' bitrixDomain=' + (cfg.bitrixDomain || 'EMPTY'));
      return;
    }

    logger.info('[Push] Attempting push — clientId: ' + clientId);
    const https = require('https');

    // Fetch all data in parallel from local service
    logger.info('[Push] Fetching local service data from http://localhost:5050');
    const [history, overdueRaw, statusRaw, companiesRaw, lastSyncRaw] = await Promise.all([
      fetchLocalJson('/api/history'),
      fetchLocalJson('/api/overdue'),
      fetchLocalJson('/api/status'),
      fetchLocalJson('/api/companies'),
      fetchLocalJson('/api/lastsync'),
    ]);
    logger.info('[Push] Local fetch complete — history: ' + (history ? history.length + ' records' : 'null') + ' | status: ' + (statusRaw ? 'ok' : 'null'));

    if (!history) {
      // Service not running locally — still push agent heartbeat so dashboard shows LIVE
      const minPayload = {
        agentLive: true,
        clientId,
        domain:        cfg.bitrixDomain  || '',
        customerEmail: cfg.customerEmail || '',
        licenseStatus: '',
        licensePlan:   '',
        history: [], lastSync: null, overdue: [], status: {}, companies: { companies: [], active: '' },
        stats: { total: 0, today: 0, failed: 0, runs: 0 },
      };
      try {
        const { loadLicenseCache } = require('../src/services/lmsService');
        const cache = loadLicenseCache();
        if (cache) {
          minPayload.licenseStatus = cache.status  || (cache.valid ? 'active' : 'inactive');
          minPayload.licensePlan   = cache.plan    || '';
        }
      } catch {}
      const body2    = JSON.stringify(minPayload);
      logger.info('[Push] Sending heartbeat-only push (local service offline) — clientId: ' + clientId);
      const pushReq2 = https.request({
        hostname: 'tally-bitrix-middleware.onrender.com',
        path:     `/dashboard/push?clientId=${encodeURIComponent(clientId)}`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body2) },
        timeout:  8000,
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => logger.info('[Push] Heartbeat response ' + r.statusCode + ': ' + d.slice(0, 200)));
      });
      pushReq2.on('error', (e) => logger.error('[Push] Heartbeat HTTP error: ' + e.message + ' | code: ' + e.code));
      pushReq2.on('timeout', () => { logger.error('[Push] Heartbeat timeout after 8s'); pushReq2.destroy(); });
      pushReq2.write(body2);
      pushReq2.end();
      return;
    }

    const today = new Date().toDateString();
     let licenseStatus = statusRaw?.license?.status || '';
    let licensePlan   = statusRaw?.license?.plan   || '';
    try {
      if (!licenseStatus || !licensePlan) {
        const { loadLicenseCache } = require('../src/services/lmsService');
        const cache = loadLicenseCache();
        if (cache) {
        licenseStatus = licenseStatus || cache.status || (cache.valid ? 'active' : 'inactive');
        licensePlan   = licensePlan   || cache.plan   || '';
      }
      }
    } catch {}

    const payload = {
      stats: {
        total:  history.reduce((s, r) => s + (r.processed || 0), 0),
        today:  history.filter(r => new Date(r.timestamp).toDateString() === today).reduce((s, r) => s + (r.processed || 0), 0),
        failed: history.reduce((s, r) => s + (r.failed || 0), 0),
        runs:   history.length,
      },
      history:   history.slice(0, 30),
      lastSync:  lastSyncRaw || history[0] || null,
      overdue:   overdueRaw  || [],
      status:    statusRaw   || {},
      companies: companiesRaw || { companies: [], active: '' },
      agentLive: true,
      clientId,
      domain:        cfg.bitrixDomain   || '',
      customerEmail: cfg.customerEmail  || '',
      licenseStatus,
      licensePlan,
    };

    const body    = JSON.stringify(payload);
    const pushUrl = `https://tally-bitrix-middleware.onrender.com/dashboard/push?clientId=${encodeURIComponent(clientId)}`;
    logger.info('[Push] POST ' + pushUrl + ' — payload size: ' + Buffer.byteLength(body) + ' bytes');
    logger.info('[Push] Payload agentLive: ' + payload.agentLive + ' | customerEmail: ' + (payload.customerEmail || 'none') + ' | domain: ' + (payload.domain || 'none'));
    const pushReq = https.request({
      hostname: 'tally-bitrix-middleware.onrender.com',
      path:     `/dashboard/push?clientId=${encodeURIComponent(clientId)}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  8000,
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        logger.info('[Push] Response HTTP ' + r.statusCode + ': ' + d.slice(0, 200));
        if (r.statusCode !== 200) {
          logger.error('[Push] NON-200 response — push may have failed');
        } else {
          logger.info('[Push] SUCCESS — dashboard store updated for clientId: ' + clientId);
        }
      });
    });
    pushReq.on('error', (e) => logger.error('[Push] HTTP error: ' + e.message + ' | code: ' + e.code));
    pushReq.on('timeout', () => { logger.error('[Push] Timeout after 8s'); pushReq.destroy(); });
    pushReq.write(body);
    pushReq.end();
  } catch(e) {
    logger.error('[Push] Uncaught exception in pushStatusToRender: ' + e.message + '\n' + e.stack);
  }
}

// Poll Render server for triggers queued by the dashboard and execute them locally
async function pollTriggersFromRender() {
  try {
    const cfg = loadConfig();
    if (!cfg) return;
    const clientId = getAgentClientId();
    if (!clientId) return;

    const https = require('https');
    const data  = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'tally-bitrix-middleware.onrender.com',
        path:     `/dashboard/triggers?clientId=${encodeURIComponent(clientId)}`,
        method:   'GET',
        timeout:  5000,
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.end();
    });

    if (!data || !data.triggers || data.triggers.length === 0) return;

    logger.info(`[TriggerPoll] ${data.triggers.length} trigger(s) received from dashboard`);

    for (const item of data.triggers) {
      const triggerPath = item.trigger;
      if (!triggerPath) continue;
      logger.info(`[TriggerPoll] Executing trigger: ${triggerPath}`);
      // Fire to local service — best-effort, don't let one failure block others
      try {
        await postLocalJson(triggerPath, {});
      } catch (e) {
        logger.info(`[TriggerPoll] Trigger ${triggerPath} returned error (non-fatal): ${e.message}`);
      }
    }
  } catch {}
}

function getAgentClientId() {
  const cfg = loadConfig();
  if (!cfg) return null;

  logger.info('[ClientId] Reading from config — bitrixClientId: "' + (cfg.bitrixClientId || '') + '" | bitrixDomain: "' + (cfg.bitrixDomain || '') + '"');

  // Valid canonical format is bx-{20+ hex chars}
  const isMemberIdFormat = cfg.bitrixClientId && /^bx-[0-9a-f]{20,}$/.test(cfg.bitrixClientId);

  if (isMemberIdFormat) {
    return cfg.bitrixClientId;
  }

  // Not yet canonical — trigger async resolution, then push immediately after
  _resolveAndCacheClientId(cfg).then(() => {
    const fresh = loadConfig();
    if (fresh && fresh.bitrixClientId && /^bx-[0-9a-f]{20,}$/.test(fresh.bitrixClientId)) {
      logger.info('[Agent] Canonical clientId now resolved — firing immediate push: ' + fresh.bitrixClientId);
      pushStatusToRender();
    }
  }).catch(() => {});

  // Use domain as temporary push key so dashboard receives heartbeats immediately
  if (cfg.bitrixDomain) {
    logger.warn('[Agent] Canonical clientId not yet resolved — pushing under domain key: ' + cfg.bitrixDomain);
    return cfg.bitrixDomain;
  }

  return null;
}

let _resolvingClientId = false;
let _resolvePromise = null;
async function _resolveAndCacheClientId(cfg) {
  if (_resolvingClientId && _resolvePromise) return _resolvePromise;
  _resolvingClientId = true;
  _resolvePromise = (async () => {
  try {
    const https = require('https');
    const domain = cfg.bitrixDomain || '';
    if (!domain) {
      logger.warn('[Agent] Cannot resolve clientId — bitrixDomain not set in config');
      _resolvingClientId = false;
      return;
    }

    logger.info('[Agent] Resolving canonical clientId from server — domain: ' + domain + ' | url: https://tally-bitrix-middleware.onrender.com/api/license/status?bitrixDomain=' + encodeURIComponent(domain));

    const resolveUrl = 'https://tally-bitrix-middleware.onrender.com/api/license/status?bitrixDomain=' + encodeURIComponent(domain);
    logger.info('[Agent] Resolving canonical clientId — GET ' + resolveUrl);

    const data = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'tally-bitrix-middleware.onrender.com',
        path: `/api/license/status?bitrixDomain=${encodeURIComponent(domain)}`,
        method: 'GET', timeout: 8000,
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          logger.info('[Agent] Resolution response HTTP ' + res.statusCode + ': ' + d.slice(0, 300));
          try { resolve(JSON.parse(d)); } catch(e) { logger.error('[Agent] Resolution JSON parse failed: ' + e.message + ' | raw: ' + d.slice(0, 100)); resolve(null); }
        });
      });
      req.on('error', (e) => { logger.error('[Agent] Resolution HTTP error: ' + e.message + ' | code: ' + e.code); resolve(null); });
      req.on('timeout', () => { logger.error('[Agent] Resolution request timed out after 8s'); req.destroy(); resolve(null); });
      req.end();
    });

    // Validate: only accept bx-{memberId} format (32-char hex after bx-)
    const resolvedId = data?.clientId;
    const isCanonical = resolvedId && /^bx-[0-9a-f]{20,}$/.test(resolvedId);

    if (isCanonical && resolvedId !== cfg.bitrixClientId) {
      logger.info('[Agent] Canonical clientId resolved', {
        resolved: resolvedId,
        was: cfg.bitrixClientId || '(none)',
      });
      const updatedCfg = loadConfig() || cfg;
      updatedCfg.bitrixClientId = resolvedId;
      // Also update customerEmail from server if we don't have it locally
      if (!updatedCfg.customerEmail && data.customerEmail) {
        updatedCfg.customerEmail = data.customerEmail;
        process.env.CUSTOMER_EMAIL = data.customerEmail;
        logger.info('[Agent] customerEmail synced from server', { email: data.customerEmail });
      }
      saveConfig(updatedCfg);
      // Push immediately under the correct clientId
      setTimeout(pushStatusToRender, 1000);
    } else if (!isCanonical && resolvedId) {
      logger.warn('[Agent] Server returned non-canonical clientId — ignoring', { returned: resolvedId });
    } else if (!data?.clientId) {
      logger.warn('[Agent] Server has no clientId for domain — OAuth may not have completed', { domain });
    }
  } catch(e) {
    logger.error('[Agent] clientId resolve failed:', e.message);
  }
  _resolvingClientId = false;
  })();
  return _resolvePromise;
}

logger.info('[Agent] Scheduling push interval every 30s and trigger poll every 8s');
setInterval(pushStatusToRender, 30000);
setInterval(pollTriggersFromRender, 8000);
// Run immediately on startup
logger.info('[Agent] Scheduling startup push in 5s and trigger poll in 10s');
setTimeout(() => { logger.info('[Agent] Startup push firing now'); pushStatusToRender(); }, 5000);
setTimeout(() => { logger.info('[Agent] Startup trigger poll firing now'); pollTriggersFromRender(); }, 10000);