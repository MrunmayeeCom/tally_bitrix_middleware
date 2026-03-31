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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function isConfigured() {
  const cfg = loadConfig();
  const hasCompany = cfg?.tallyCompanies?.length > 0 || cfg?.tallyCompany;
  return !!(cfg && cfg.bitrixUrl && cfg.tallyHost && cfg.tallyPort && hasCompany);
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

  const env = Object.assign({}, process.env, {
    NODE_ENV:            'production',
    PORT:                '5050',
    BITRIX_WEBHOOK_URL:  cfg.bitrixUrl,
    TALLY_HOST:          cfg.tallyHost,
    TALLY_PORT:          String(cfg.tallyPort),
    TALLY_COMPANY:       getActiveCompany(cfg),
    TALLY_COMPANIES:     getCompanies(cfg).join(','),
    CUSTOMER_EMAIL:      cfg.customerEmail || '',
    RENDER_SERVER_URL:   'https://tally-bitrix-middleware.onrender.com',
    CLIENT_ID:           require('os').hostname() + '-' + (cfg.customerEmail || '').split('@')[0],
    LICENSE_FEATURES:    licenseFeatures,
    LICENSE_PLAN:        licensePlan,
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
  setInterval(updateTray, 30000); // refresh every 30s
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
  const cacheFiles = [
    path.join(__dirname, '..', 'logs', 'license-cache.json'),
    path.join(__dirname, '..', 'logs', 'feature-registry-cache.json'),
    path.join(__dirname, '..', 'logs', 'usage-cache.json'),
    path.join(__dirname, '..', 'logs', 'pipeline-cache.json'),
    path.join(__dirname, '..', 'logs', 'tally-snapshot.json'),
    path.join(__dirname, '..', 'logs', 'sync-history.json'),
    path.join(__dirname, '..', 'logs', 'escalation-cooldown.json'),
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

ipcMain.handle('scan-tally-companies', async () => {
  try {
    const { getCompanyList } = require('../src/connectors/tallyConnector');
    return await getCompanyList();
  } catch(e) {
    return { success: false, error: e.message, companies: [] };
  }
});

ipcMain.on('close-window',    () => { if (mainWindow) mainWindow.hide(); });
ipcMain.on('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });

// ── app lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setAppUserModelId('com.rajlaxmi.tallybitrixsync');
  app.setLoginItemSettings({ openAtLogin: true });
  createTray();

  if (!isConfigured()) {
    createMainWindow('setup');
  } else {
    const cfg = loadConfig();
    if (cfg) {
      // Hold auto-restart until license is confirmed — bootstrapLicense
      // will clear userStoppedService and spawn the server if valid
      userStoppedService = true;
      setTimeout(() => bootstrapLicense(cfg), 500);
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
  } catch {}
  // ───────────────────────────────────────────────────────────────────

  try {
    const { validateLicense, startHeartbeat, startRevalidation } = require('../src/services/lmsService');
    const { setFeatures, applyStarterFallback, getPlan } = require('../src/services/featureGate');

    const result = await validateLicense(cfg.customerEmail);
    _licenseValid = result.valid;
    _licensePlan  = result.plan || 'Unknown';

    if (result.valid) {
      let previousPlan = getPlan();
      setFeatures(result.features, result.plan, result.valid);

      // License confirmed — allow server to run and (re)spawn if needed
      userStoppedService = false;
      if (!serverProcess) spawnServer(cfg);

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
            detail: 'Purchase or renew a license (Starter, Professional, Business or Enterprise) to resume.',
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
        detail: 'Please purchase or renew a license (Starter, Professional, Business or Enterprise).\n\nReason: ' + result.reason,
        buttons: ['OK']
      });
    }
    updateTray();
  } catch(e) {
    try {
      const { applyStarterFallback } = require('../src/services/featureGate');
      applyStarterFallback(); // locks all features on unexpected error
    } catch {}
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