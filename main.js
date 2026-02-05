const { 
  app, 
  BrowserWindow, 
  BrowserView, 
  ipcMain, 
  session,
  dialog
} = require('electron');

const path    = require('path');
let fetchFn;
try {
  fetchFn = global.fetch;
} catch (e) {
  fetchFn = undefined;
}
if (!fetchFn) {
  try {
    const nf = require('node-fetch');
    fetchFn = nf && (nf.default || nf);
  } catch (e) {
    fetchFn = null;
  }
}

const maxmind = require('maxmind');
const fs      = require('fs');
const csv     = require('csv-parser');

app.enableSandbox();
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('webrtc.ip_handling_policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('enable-features', 'WebRtcHideLocalIpsWithMdns');

let controlWin = null;
let mainWin = null;
let mainView = null;
let geoData = {};
let networkHandlersRegistered = false;

const countries = new Map();
const countriesByName = new Map();
let countriesLoaded = false;

function loadCountries() {
  return new Promise((resolve, reject) => {
    if (countriesLoaded) return resolve();
    if (!fs.existsSync(CSV_FILE)) {
      countriesLoaded = true;
      return resolve();
    }
    fs.createReadStream(CSV_FILE)
      .pipe(csv())
      .on('data', (row) => {
        const iso2 = (row.iso2 || '').toUpperCase();
        const iso3 = (row.iso3 || '').toUpperCase();
        const name = row.name || '';
        const normalizedName = name.trim().toLowerCase();
        if (iso2) countries.set(iso2, name);
        if (iso3) countries.set(iso3, name);
        if (normalizedName && iso2) countriesByName.set(normalizedName, iso2);
      })
      .on('end', () => {
        countriesLoaded = true;
        resolve();
      })
      .on('error', (err) => reject(err));
  });
}

// مسارات
const GEO_DB   = path.join(__dirname, 'db/GeoLite2-City.mmdb');
const CSV_FILE = path.join(__dirname, 'countries-data.csv');

// ─── جلب بيانات الموقع ───
async function fetchGeoData() {
  try {
    if (!fetchFn) throw new Error('fetch is not available');
    await loadCountries();
    const res = await fetchFn('https://api.myip.com');
    const data = await res.json();
    geoData.ip = data.ip || 'غير معروف';
    const rawCountry = data.country || '?';
    const upperCountry = rawCountry.toUpperCase();
    const normalizedCountry = rawCountry.trim().toLowerCase();
    let resolvedCode = '';
    let resolvedName = '';
    if (countries.has(upperCountry)) {
      resolvedCode = upperCountry;
      resolvedName = countries.get(upperCountry);
    } else if (countriesByName.has(normalizedCountry)) {
      resolvedCode = countriesByName.get(normalizedCountry);
      resolvedName = countries.get(resolvedCode) || rawCountry;
    } else {
      resolvedName = rawCountry;
    }
    geoData.country = rawCountry;
    geoData.countryCode = resolvedCode || upperCountry || '?';
    geoData.countryName = resolvedName || rawCountry;

    let record = {};
    try {
      if (fs.existsSync(GEO_DB)) {
        const reader = await maxmind.open(GEO_DB);
        record = reader.get(geoData.ip) || {};
      }
    } catch (e) {
      console.warn('MaxMind lookup failed:', e.message);
    }
    geoData.city = record.city?.names?.en || '?';
    geoData.lat  = record.location?.latitude  || 0;
    geoData.lon  = record.location?.longitude || 0;
    geoData.street = '';
    geoData.postcode = '';

    // Nominatim reverse (اختياري - بطيء نسبياً)
    if (fetchFn && geoData.lat && geoData.lon) {
      const nom = await fetchFn(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${geoData.lat}&lon=${geoData.lon}&zoom=16`
      ).then(r => r.json());
      geoData.details = nom.address || {};
      geoData.street = geoData.details.road || geoData.details.neighbourhood || '';
      geoData.postcode = geoData.details.postcode || '';
    }

    // إرسال البيانات إلى النوافذ
    controlWin?.webContents.send('geo-update', geoData);
    mainWin?.webContents.send('geo-update', geoData);

  } catch (err) {
    console.error('خطأ في جلب Geo:', err.message);
    geoData = { error: err.message };
  }
}

// ─── نافذة التحكم (تظهر أولاً) ───
function createControlWindow() {
  controlWin = new BrowserWindow({
    width:  980,
    height: 760,
    center: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      enableRemoteModule: false
    }
  });

  controlWin.loadFile('control.html');
  controlWin.removeMenu();

  controlWin.on('closed', () => {
    controlWin = null;
    if (!mainWin) app.quit();
  });

  // Wait for window to be ready then send data
  controlWin.webContents.on('did-finish-load', () => {
    fetchGeoData();
    sendSpoofUpdate();
    sendProxyUpdate();
    sendProxyProfilesUpdate();
    sendPrivacyUpdate();
    sendNetworkUpdate();
  });
}

// ─── بدء النافذة الرئيسية + تبويب واحد ───
function startBrowser() {
  if (mainWin) return;

  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      enableRemoteModule: false
    }
  });

  mainWin.loadFile('index.html');
  mainWin.removeMenu();

  mainWin.webContents.on('did-finish-load', () => {
    fetchGeoData();
    sendSpoofUpdate();
    sendProxyUpdate();
    sendPrivacyUpdate();
  });

  mainView = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      enableRemoteModule: false
    }
  });

  mainView.webContents.on('login', (event, authInfo, callback) => {
    if (!authInfo.isProxy || !proxyConfig || !proxyConfig.authEnabled) return;
    event.preventDefault();
    callback(proxyConfig.username || '', proxyConfig.password || '');
  });

  const sessionRef = mainView.webContents.session;
  sessionRef.setPermissionRequestHandler((_, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      return callback(false);
    }
    return callback(true);
  });

  mainWin.setBrowserView(mainView);
  mainView.setBounds({ x: 0, y: 140, width: 1400, height: 760 });
  mainView.setAutoResize({ width: true, height: true });

  registerNetworkHandlers(mainView.webContents.session);
  applyProxyConfig(proxyConfig);
  if (activeProxyProfileId) {
    selectProxyProfile(activeProxyProfileId);
  }

  mainView.webContents.loadURL('https://www.google.com');
  addLog('تم بدء المتصفح الرئيسي', false);

  // إغلاق نافذة التحكم
  controlWin?.close();
}

// ─── عند التشغيل ───
// ثم في النهاية:
if (!app || typeof app.whenReady !== 'function') {
  console.error('This program must be run with Electron (use `npm start` or `electron .`).');
  process.exit(1);
}
app.whenReady().then(() => {
  loadProxyProfiles();
  createControlWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ثم كل ipcMain.on تأتي بعد ذلك
ipcMain.on('start-browser', startBrowser);
// ...
ipcMain.on('refresh-geo', fetchGeoData);

ipcMain.on('navigate', (event, url) => {
  if (mainView) {
    const target = url.startsWith('http') ? url : 'https://' + url;
    mainView.webContents.loadURL(target);
  }
});

ipcMain.on('go-back',    () => mainView?.webContents.goBack());
ipcMain.on('go-forward', () => mainView?.webContents.goForward());
ipcMain.on('reload',     () => mainView?.webContents.reload());

// ─── إدارة السجلات ───
let logs = [];
const MAX_LOGS = 20;
const networkLogs = [];
const MAX_NETWORK_LOGS = 30;

function addLog(msg, isError = false) {
  const time = new Date().toLocaleTimeString('ar-EG');
  logs.unshift({ time, msg, isError });
  if (logs.length > MAX_LOGS) logs.pop();
  controlWin?.webContents.send('log-update', logs);
  mainWin?.webContents.send('log-update', logs);
}

function addNetworkLog(entry) {
  networkLogs.unshift(entry);
  if (networkLogs.length > MAX_NETWORK_LOGS) networkLogs.pop();
  controlWin?.webContents.send('network-update', networkLogs);
}

function sendNetworkUpdate() {
  controlWin?.webContents.send('network-update', networkLogs);
}

// ─── بيانات التزوير والبروكسي ───
let proxyConfig = null;
let proxyProfiles = [];
let activeProxyProfileId = null;
let privacySettings = {
  blockTrackers: true,
  blockAds: true,
  blockThirdPartyCookies: true
};

const WEBGL_VENDORS = [
  { vendor: 'Intel Inc.', renderer: 'Intel Iris OpenGL Engine' },
  { vendor: 'NVIDIA Corporation', renderer: 'ANGLE (NVIDIA)' },
  { vendor: 'Google Inc.', renderer: 'ANGLE (Google)' },
  { vendor: 'AMD', renderer: 'AMD Radeon' }
];

const FONTS_LIST = [
  ['Arial', 'Verdana', 'Times New Roman'],
  ['Courier New', 'Georgia', 'Garamond'],
  ['Trebuchet MS', 'Liberation Sans', 'DejaVu Sans']
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

const DEVICE_MODELS = [
  'MacBookPro15,2',
  'MacBookAir10,1',
  'Macmini9,1',
  'MacPro7,1',
  'iMac19,2'
];

const NETWORK_PROFILES = [
  { effectiveType: '4g', downlink: 18, rtt: 70, saveData: false },
  { effectiveType: '4g', downlink: 10, rtt: 120, saveData: false },
  { effectiveType: '3g', downlink: 2.5, rtt: 300, saveData: true }
];

const SCREEN_RESOLUTIONS = [
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 }
];

const LANGUAGES = ['en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES', 'ar-SA'];

const TIMEZONES = [
  'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 
  'Australia/Sydney', 'America/Los_Angeles'
];

let spoofData = {
  ua: USER_AGENTS[0],
  canvasNoise: 0.15,
  webglVendor: 'Intel Inc.',
  webglRenderer: 'Intel Iris OpenGL Engine',
  fonts: FONTS_LIST[0],
  hardwareConcurrency: 8,
  deviceMemory: 8,
  screenWidth: 1920,
  screenHeight: 1080,
  timezone: 'UTC',
  language: 'en-US',
  platform: 'Win32',
  vendor: 'Google Inc.',
  deviceModel: 'PC',
  connection: NETWORK_PROFILES[0],
  tlsVersion: 'TLSv1.3',
  tlsCipher: 'TLS_AES_256_GCM_SHA384'
};

function generateRandomSpoof() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const webgl = WEBGL_VENDORS[Math.floor(Math.random() * WEBGL_VENDORS.length)];
  const fonts = FONTS_LIST[Math.floor(Math.random() * FONTS_LIST.length)];
  const resolution = SCREEN_RESOLUTIONS[Math.floor(Math.random() * SCREEN_RESOLUTIONS.length)];
  const language = LANGUAGES[Math.floor(Math.random() * LANGUAGES.length)];
  const timezone = TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)];
  const cores = Math.random() > 0.5 ? 4 : 8;
  const memory = Math.random() > 0.5 ? 4 : 8;
  const connection = NETWORK_PROFILES[Math.floor(Math.random() * NETWORK_PROFILES.length)];
  const isMac = ua.includes('Macintosh');
  const platform = isMac ? 'MacIntel' : (ua.includes('Win') ? 'Win32' : 'Linux x86_64');
  const vendor = isMac ? 'Apple Computer, Inc.' : 'Google Inc.';
  const deviceModel = isMac ? DEVICE_MODELS[Math.floor(Math.random() * DEVICE_MODELS.length)] : 'PC';

  return {
    ua,
    canvasNoise: (Math.random() * 0.3 + 0.1),
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    fonts,
    hardwareConcurrency: cores,
    deviceMemory: memory,
    screenWidth: resolution.width,
    screenHeight: resolution.height,
    timezone,
    language,
    platform,
    vendor,
    deviceModel,
    connection,
    tlsVersion: 'TLSv1.3',
    tlsCipher: 'TLS_AES_256_GCM_SHA384'
  };
}

function sendSpoofUpdate() {
  controlWin?.webContents.send('spoof-update', spoofData);
  mainWin?.webContents.send('spoof-update', spoofData);
  // تطبيق التزوير على preload جميع النوافذ
  [controlWin, mainWin].forEach(win => {
    if (win && win.webContents) {
      win.webContents.send('apply-spoof', spoofData);
    }
  });
}

function sendProxyUpdate() {
  controlWin?.webContents.send('proxy-update', proxyConfig);
  mainWin?.webContents.send('proxy-update', proxyConfig);
}

function sendProxyProfilesUpdate() {
  controlWin?.webContents.send('proxy-profiles-update', {
    profiles: proxyProfiles,
    activeId: activeProxyProfileId
  });
}

function sendPrivacyUpdate() {
  controlWin?.webContents.send('privacy-update', privacySettings);
  mainWin?.webContents.send('privacy-update', privacySettings);
}

function getCurrentSettings() {
  return {
    spoof: spoofData,
    proxy: proxyConfig,
    privacy: privacySettings
  };
}

function updatePrivacySettings(partial) {
  privacySettings = { ...privacySettings, ...partial };
  sendPrivacyUpdate();
}

const PROXY_STORE = path.join(app.getPath('userData'), 'proxy-profiles.json');

function loadProxyProfiles() {
  try {
    if (!fs.existsSync(PROXY_STORE)) return;
    const raw = fs.readFileSync(PROXY_STORE, 'utf-8');
    const parsed = JSON.parse(raw);
    proxyProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    activeProxyProfileId = parsed.activeId || null;
  } catch (err) {
    console.warn('Failed to load proxy profiles:', err.message);
  }
}

function saveProxyProfiles() {
  try {
    const payload = JSON.stringify({ profiles: proxyProfiles, activeId: activeProxyProfileId }, null, 2);
    fs.writeFileSync(PROXY_STORE, payload, 'utf-8');
  } catch (err) {
    console.warn('Failed to save proxy profiles:', err.message);
  }
}

function selectProxyProfile(profileId) {
  const profile = proxyProfiles.find(item => item.id === profileId);
  if (!profile) return;
  activeProxyProfileId = profileId;
  proxyConfig = { ...profile.config };
  applyProxyConfig(proxyConfig);
  sendProxyUpdate();
  sendProxyProfilesUpdate();
  saveProxyProfiles();
  addLog(`تم تفعيل بروكسي محفوظ: ${profile.name}`, false);
}

function applyProxyConfig(config) {
  if (!mainView) return;
  const sessionRef = mainView.webContents.session;
  if (!config) {
    sessionRef.setProxy({ proxyRules: '' }).catch(err => {
      addLog(`خطأ في تعطيل البروكسي: ${err.message}`, true);
    });
    return;
  }
  const proxyUrl = `${config.type}://${config.host}:${config.port}`;
  const bypassEntries = [];
  if (config.bypassLocal) {
    bypassEntries.push('<local>', 'localhost', '127.0.0.1', '[::1]', '*.local', '*.internal');
  }
  if (config.bypassRules) {
    config.bypassRules
      .split(/[;,]+/)
      .map(entry => entry.trim())
      .filter(Boolean)
      .forEach(entry => bypassEntries.push(entry));
  }
  sessionRef.setProxy({
    proxyRules: proxyUrl,
    proxyBypassRules: bypassEntries.join(';')
  }).catch(err => {
    addLog(`خطأ في تطبيق البروكسي: ${err.message}`, true);
  });
}

const TRACKER_PATTERNS = [
  'google-analytics.com',
  'doubleclick.net',
  'googletagmanager.com',
  'facebook.com/tr',
  'pixel',
  'metrics',
  'analytics'
];

const AD_PATTERNS = [
  'adsystem',
  'adservice',
  'googlesyndication',
  '/ads?',
  'adserver',
  'banner'
];

function matchesPattern(url, patterns) {
  return patterns.some(pattern => url.includes(pattern));
}

function shouldBlockRequest(url) {
  if (privacySettings.blockTrackers && matchesPattern(url, TRACKER_PATTERNS)) {
    return 'حظر المتتبعات';
  }
  if (privacySettings.blockAds && matchesPattern(url, AD_PATTERNS)) {
    return 'حظر الإعلانات';
  }
  return '';
}

function isThirdPartyCookie(details) {
  if (!details.firstPartyURL) return false;
  try {
    const requestHost = new URL(details.url).hostname;
    const firstPartyHost = new URL(details.firstPartyURL).hostname;
    return requestHost && firstPartyHost && requestHost !== firstPartyHost;
  } catch (e) {
    return false;
  }
}

function registerNetworkHandlers(sessionRef) {
  if (networkHandlersRegistered) return;
  networkHandlersRegistered = true;

  sessionRef.webRequest.onBeforeRequest((details, callback) => {
    const reason = shouldBlockRequest(details.url);
    if (reason) {
      addNetworkLog({
        time: new Date().toLocaleTimeString('ar-EG'),
        url: details.url,
        type: details.resourceType,
        status: 'blocked',
        reason
      });
      return callback({ cancel: true });
    }
    return callback({ cancel: false });
  });

  sessionRef.webRequest.onCompleted(details => {
    addNetworkLog({
      time: new Date().toLocaleTimeString('ar-EG'),
      url: details.url,
      type: details.resourceType,
      status: details.statusCode
    });
  });

  sessionRef.webRequest.onErrorOccurred(details => {
    addNetworkLog({
      time: new Date().toLocaleTimeString('ar-EG'),
      url: details.url,
      type: details.resourceType,
      status: 'error',
      reason: details.error
    });
  });

  sessionRef.webRequest.onHeadersReceived((details, callback) => {
    if (!privacySettings.blockThirdPartyCookies || !details.responseHeaders) {
      return callback({ responseHeaders: details.responseHeaders });
    }
    if (!isThirdPartyCookie(details)) {
      return callback({ responseHeaders: details.responseHeaders });
    }
    const responseHeaders = { ...details.responseHeaders };
    Object.keys(responseHeaders).forEach(key => {
      if (key.toLowerCase() === 'set-cookie') {
        delete responseHeaders[key];
      }
    });
    return callback({ responseHeaders });
  });
}

// ─── معالج التزوير ───
ipcMain.on('generate-spoof', (event, config) => {
  if (config && config.random) {
    spoofData = generateRandomSpoof();
    addLog('تم توليد بيانات تزوير عشوائية', false);
  } else if (config && config.ua) {
    spoofData.ua = config.ua;
    addLog('تم تحديث User Agent', false);
  } else {
    spoofData = generateRandomSpoof();
    addLog('تم توليد بيانات تزوير جديدة', false);
  }
  sendSpoofUpdate();
});

// ─── معالج البروكسي ───
ipcMain.on('set-proxy', (event, config) => {
  if (!config || !config.host) {
    proxyConfig = null;
    activeProxyProfileId = null;
    addLog('تم إزالة إعدادات البروكسي', false);
    applyProxyConfig(null);
    sendProxyUpdate();
    return;
  }

  proxyConfig = {
    type: config.type || 'http',
    host: config.host,
    port: parseInt(config.port) || 80,
    username: config.username || '',
    password: config.password || '',
    authEnabled: !!config.authEnabled,
    bypassLocal: config.bypassLocal !== false,
    bypassRules: config.bypassRules || ''
  };

  applyProxyConfig(proxyConfig);

  const displayUrl = `${config.type}://${config.host}:${config.port}`;
  addLog(`✓ تم تعيين البروكسي: ${displayUrl}`, false);
  sendProxyUpdate();
});

ipcMain.on('save-proxy-profile', (event, payload) => {
  if (!payload || !payload.name || !payload.config) return;
  const profile = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: payload.name.trim(),
    config: payload.config
  };
  proxyProfiles.unshift(profile);
  activeProxyProfileId = profile.id;
  proxyConfig = { ...profile.config };
  applyProxyConfig(proxyConfig);
  saveProxyProfiles();
  sendProxyProfilesUpdate();
  sendProxyUpdate();
  addLog(`تم حفظ بروكسي جديد: ${profile.name}`, false);
});

ipcMain.on('delete-proxy-profile', (event, profileId) => {
  if (!profileId) return;
  const before = proxyProfiles.length;
  proxyProfiles = proxyProfiles.filter(item => item.id !== profileId);
  if (activeProxyProfileId === profileId) {
    activeProxyProfileId = null;
  }
  if (proxyProfiles.length !== before) {
    saveProxyProfiles();
    sendProxyProfilesUpdate();
    addLog('تم حذف بروكسي محفوظ', false);
  }
});

ipcMain.on('select-proxy-profile', (event, profileId) => {
  if (!profileId) return;
  selectProxyProfile(profileId);
});

// ─── إعدادات الخصوصية ───
ipcMain.on('set-privacy', (event, config) => {
  if (!config) return;
  updatePrivacySettings(config);
  addLog('تم تحديث إعدادات الخصوصية', false);
});

ipcMain.handle('export-settings', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'تصدير الإعدادات',
    defaultPath: 'super-private-settings.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, JSON.stringify(getCurrentSettings(), null, 2), 'utf-8');
  addLog(`تم تصدير الإعدادات إلى ${filePath}`, false);
  return { canceled: false, path: filePath };
});

ipcMain.handle('import-settings', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'استيراد الإعدادات',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePaths || !filePaths.length) return { canceled: true };
  const filePath = filePaths[0];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed.spoof) {
    spoofData = { ...spoofData, ...parsed.spoof };
    sendSpoofUpdate();
  }
  if (parsed.proxy !== undefined) {
    proxyConfig = parsed.proxy;
    applyProxyConfig(proxyConfig);
    sendProxyUpdate();
  }
  if (parsed.privacy) {
    updatePrivacySettings(parsed.privacy);
  }
  addLog(`تم استيراد الإعدادات من ${filePath}`, false);
  return { canceled: false, path: filePath };
});

// ─── حذف البيانات ───
ipcMain.on('clear-data', (event) => {
  if (mainWin && mainView) {
    const session = mainView.webContents.session;
    
    session.clearCache();
    session.clearStorageData({
      origins: ['*']
    });
    session.clearAuthCache();
    session.clearCodecCache?.();
    
    addLog('✓ تم حذف جميع البيانات (الكعكات، التخزين، الكاش)', false);
    controlWin?.webContents.send('clear-data-confirm', true);
  }
});
