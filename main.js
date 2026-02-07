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
const net     = require('net');

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
async function fetchGeoData(options = {}) {
  try {
    const { sessionRef, applyToSpoof = false } = options;
    const fetcher = sessionRef?.fetch ? (url, opts) => sessionRef.fetch(url, opts) : fetchFn;
    if (!fetcher) throw new Error('fetch is not available');
    await loadCountries();
    let res;
    try {
      res = await fetcher('https://api.myip.com');
    } catch (err) {
      if (sessionRef && fetchFn && fetcher !== fetchFn) {
        res = await fetchFn('https://api.myip.com');
      } else {
        throw err;
      }
    }
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
      if (fs.existsSync(GEO_DB) && net.isIP(geoData.ip)) {
        const reader = await maxmind.open(GEO_DB);
        record = reader.get(geoData.ip) || {};
      }
    } catch (e) {
      console.warn('MaxMind lookup failed:', e.message);
    }
    geoData.city = record.city?.names?.en || '?';
    geoData.lat  = record.location?.latitude  || 0;
    geoData.lon  = record.location?.longitude || 0;
    geoData.timezone = record.location?.time_zone || '';
    geoData.street = '';
    geoData.postcode = '';

    // Nominatim reverse (اختياري - بطيء نسبياً)
    if (fetcher && geoData.lat && geoData.lon) {
      const nom = await fetcher(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${geoData.lat}&lon=${geoData.lon}&zoom=16`
      ).then(r => r.json());
      geoData.details = nom.address || {};
      geoData.street = geoData.details.road || geoData.details.neighbourhood || '';
      geoData.postcode = geoData.details.postcode || '';
    }

    if (applyToSpoof) {
      applyGeoToSpoof(geoData);
    }

    if (geoData.ip) {
      controlWin?.webContents.send('webrtc-ip-update', geoData.ip);
      mainWin?.webContents.send('webrtc-ip-update', geoData.ip);
    }

    // إرسال البيانات إلى النوافذ
    controlWin?.webContents.send('geo-update', geoData);
    mainWin?.webContents.send('geo-update', geoData);

  } catch (err) {
    console.error('خطأ في جلب Geo:', err.message);
    geoData = { error: err.message };
  }
  return geoData;
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
      webRTC: { enabled: false },
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      enableRemoteModule: false
    }
  });

  controlWin.loadFile('control.html');
  controlWin.removeMenu();
  registerPermissionHandlers(controlWin.webContents.session);

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
async function startBrowser() {
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
      webRTC: { enabled: false },
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
    updateBrowserViewBounds();
  });

  mainView = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webRTC: { enabled: false },
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
  registerPermissionHandlers(sessionRef);

  mainWin.setBrowserView(mainView);
  updateBrowserViewBounds();

  mainWin.on('resize', () => {
    updateBrowserViewBounds();
  });

  registerNetworkHandlers(mainView.webContents.session);
  await applyProxyConfig(proxyConfig);
  if (activeProxyProfileId) {
    await selectProxyProfile(activeProxyProfileId);
  } else {
    await waitForProxyAndSyncGeo();
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
ipcMain.on('refresh-geo', () => {
  if (mainView) {
    fetchGeoData({ sessionRef: mainView.webContents.session, applyToSpoof: true });
    return;
  }
  fetchGeoData({ applyToSpoof: true });
});

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
  blockThirdPartyCookies: true,
  blockWebgl: false,
  aiRequestGuard: true
};

async function updateBrowserViewBounds() {
  if (!mainWin || !mainView) return;
  const bounds = mainWin.getContentBounds();
  let layout = { top: 0, bottom: 0 };
  try {
    layout = await mainWin.webContents.executeJavaScript(
      `(() => {
        const toolbar = document.getElementById('browser-toolbar');
        const footer = document.getElementById('browser-status');
        return {
          top: toolbar ? toolbar.offsetHeight : 0,
          bottom: footer ? footer.offsetHeight : 0
        };
      })()`,
      true
    );
  } catch (err) {
    console.warn('Failed to measure layout:', err.message);
  }
  const top = Math.max(0, layout?.top || 0);
  const bottom = Math.max(0, layout?.bottom || 0);
  const height = Math.max(0, bounds.height - top - bottom);
  mainView.setBounds({ x: 0, y: top, width: bounds.width, height });
}

function registerPermissionHandlers(sessionRef) {
  if (!sessionRef) return;
  sessionRef.setPermissionRequestHandler((_, permission, callback) => {
    if (
      permission === 'media' ||
      permission === 'audioCapture' ||
      permission === 'videoCapture' ||
      permission === 'display-capture'
    ) {
      return callback(false);
    }
    return callback(true);
  });
  if (sessionRef.setPermissionCheckHandler) {
    sessionRef.setPermissionCheckHandler((_, permission) => {
      if (
        permission === 'media' ||
        permission === 'audioCapture' ||
        permission === 'videoCapture' ||
        permission === 'display-capture'
      ) {
        return false;
      }
      return true;
    });
  }
}

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
const LANGUAGE_SETS = [
  ['en-US', 'en'],
  ['en-GB', 'en'],
  ['fr-FR', 'fr'],
  ['de-DE', 'de'],
  ['es-ES', 'es'],
  ['ar-SA', 'ar']
];

const TIMEZONES = [
  'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 
  'Australia/Sydney', 'America/Los_Angeles'
];

const DO_NOT_TRACK_VALUES = ['1', '0', 'unspecified'];
const TOUCH_POINTS = [0, 1, 2, 5];
const DEVICE_PIXEL_RATIOS = [1, 1.25, 1.5, 2];
const COLOR_DEPTHS = [24, 30, 32];

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
  screenAvailWidth: 1920,
  screenAvailHeight: 1040,
  colorDepth: 24,
  devicePixelRatio: 1,
  timezone: 'UTC',
  language: 'en-US',
  languages: ['en-US', 'en'],
  platform: 'Win32',
  vendor: 'Google Inc.',
  deviceModel: 'PC',
  connection: NETWORK_PROFILES[0],
  doNotTrack: '1',
  maxTouchPoints: 0,
  webdriver: false,
  tlsVersion: 'TLSv1.3',
  tlsCipher: 'TLS_AES_256_GCM_SHA384'
};

const COUNTRY_LANGUAGE_MAP = {
  SA: 'ar-SA',
  AE: 'ar-AE',
  EG: 'ar-EG',
  MA: 'ar-MA',
  DZ: 'ar-DZ',
  QA: 'ar-QA',
  KW: 'ar-KW',
  TR: 'tr-TR',
  FR: 'fr-FR',
  DE: 'de-DE',
  ES: 'es-ES',
  IT: 'it-IT',
  GB: 'en-GB',
  US: 'en-US',
  CA: 'en-CA',
  AU: 'en-AU'
};

function generateRandomSpoof() {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const webgl = WEBGL_VENDORS[Math.floor(Math.random() * WEBGL_VENDORS.length)];
  const fonts = FONTS_LIST[Math.floor(Math.random() * FONTS_LIST.length)];
  const resolution = SCREEN_RESOLUTIONS[Math.floor(Math.random() * SCREEN_RESOLUTIONS.length)];
  const language = LANGUAGES[Math.floor(Math.random() * LANGUAGES.length)];
  const languageSet = LANGUAGE_SETS[Math.floor(Math.random() * LANGUAGE_SETS.length)];
  const timezone = TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)];
  const cores = Math.random() > 0.5 ? 4 : 8;
  const memory = Math.random() > 0.5 ? 4 : 8;
  const connection = NETWORK_PROFILES[Math.floor(Math.random() * NETWORK_PROFILES.length)];
  const isMac = ua.includes('Macintosh');
  const platform = isMac ? 'MacIntel' : (ua.includes('Win') ? 'Win32' : 'Linux x86_64');
  const vendor = isMac ? 'Apple Computer, Inc.' : 'Google Inc.';
  const deviceModel = isMac ? DEVICE_MODELS[Math.floor(Math.random() * DEVICE_MODELS.length)] : 'PC';
  const dpr = DEVICE_PIXEL_RATIOS[Math.floor(Math.random() * DEVICE_PIXEL_RATIOS.length)];
  const colorDepth = COLOR_DEPTHS[Math.floor(Math.random() * COLOR_DEPTHS.length)];
  const doNotTrack = DO_NOT_TRACK_VALUES[Math.floor(Math.random() * DO_NOT_TRACK_VALUES.length)];
  const maxTouchPoints = TOUCH_POINTS[Math.floor(Math.random() * TOUCH_POINTS.length)];
  const availHeight = Math.max(0, resolution.height - Math.floor(40 + Math.random() * 80));

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
    screenAvailWidth: resolution.width,
    screenAvailHeight: availHeight,
    colorDepth,
    devicePixelRatio: dpr,
    timezone,
    language,
    languages: languageSet,
    platform,
    vendor,
    deviceModel,
    connection,
    doNotTrack,
    maxTouchPoints,
    webdriver: false,
    tlsVersion: 'TLSv1.3',
    tlsCipher: 'TLS_AES_256_GCM_SHA384'
  };
}

function applyGeoToSpoof(currentGeo) {
  if (!currentGeo || currentGeo.error) return;
  const updates = {};
  if (currentGeo.timezone) {
    updates.timezone = currentGeo.timezone;
  }
  const lang = COUNTRY_LANGUAGE_MAP[currentGeo.countryCode];
  if (lang) {
    updates.language = lang;
    updates.languages = [lang, lang.split('-')[0]];
  }
  if (Object.keys(updates).length === 0) return;
  spoofData = { ...spoofData, ...updates };
  sendSpoofUpdate();
  addLog('تم تحديث بيانات التزوير بناءً على الموقع الجغرافي', false);
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

function buildProxyConfig(input) {
  if (!input || !input.host) return null;
  const host = String(input.host).trim();
  if (!host || host.includes(' ')) return null;
  const parsedPort = parseInt(input.port, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return null;
  }
  return {
    type: input.type || 'http',
    host,
    port: parsedPort,
    username: input.username || '',
    password: input.password || '',
    authEnabled: !!(input.authEnabled || input.username || input.password),
    bypassLocal: input.bypassLocal !== false,
    bypassRules: input.bypassRules || ''
  };
}

function buildProxyRules(config) {
  if (!config) return '';
  const hostPort = `${config.host}:${config.port}`;
  if (config.type === 'socks5' || config.type === 'socks4' || config.type === 'socks') {
    return `${config.type}://${hostPort}`;
  }
  return `http=${hostPort};https=${hostPort}`;
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

async function waitForProxyAndSyncGeo() {
  if (!mainView) return;
  const sessionRef = mainView.webContents.session;
  if (!proxyConfig) {
    await fetchGeoData({ sessionRef, applyToSpoof: true });
    return;
  }
  addLog('جاري انتظار تشغيل البروكسي...', false);
  const attempts = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await fetchGeoData({ sessionRef, applyToSpoof: true });
    if (result && !result.error) {
      addLog('✓ تم التحقق من البروكسي وتحديث الموقع', false);
      return;
    }
    lastError = result?.error || '';
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  addLog('فشل التحقق من البروكسي بعد عدة محاولات', true);
  if (proxyConfig && /ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/i.test(lastError)) {
    addLog('تم تعطيل البروكسي مؤقتاً بسبب فشل الاتصال', true);
    proxyConfig = null;
    activeProxyProfileId = null;
    await applyProxyConfig(null);
    sendProxyUpdate();
    sendProxyProfilesUpdate();
  }
}

async function selectProxyProfile(profileId) {
  const profile = proxyProfiles.find(item => item.id === profileId);
  if (!profile) return;
  activeProxyProfileId = profileId;
  proxyConfig = { ...profile.config };
  await applyProxyConfig(proxyConfig);
  sendProxyUpdate();
  sendProxyProfilesUpdate();
  saveProxyProfiles();
  addLog(`تم تفعيل بروكسي محفوظ: ${profile.name}`, false);
  await waitForProxyAndSyncGeo();
}

async function applyProxyConfig(config) {
  if (!mainView) return;
  const sessionRef = mainView.webContents.session;
  if (!config) {
    try {
      await sessionRef.setProxy({ proxyRules: '' });
    } catch (err) {
      addLog(`خطأ في تعطيل البروكسي: ${err.message}`, true);
    }
    return;
  }
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
  try {
    await sessionRef.setProxy({
      proxyRules: buildProxyRules(config),
      proxyBypassRules: bypassEntries.join(';')
    });
  } catch (err) {
    addLog(`خطأ في تطبيق البروكسي: ${err.message}`, true);
  }
}

async function testProxyConnection(config) {
  const sessionRef = session.fromPartition('persist:proxy-test');
  await sessionRef.setProxy({ proxyRules: '' });
  if (!config) {
    return { ok: false, error: 'بيانات البروكسي غير مكتملة' };
  }
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
  await sessionRef.setProxy({
    proxyRules: buildProxyRules(config),
    proxyBypassRules: bypassEntries.join(';')
  });

  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), 8000);
    const response = await sessionRef.fetch('https://api.myip.com', {
      signal: controller?.signal
    });
    clearTimeout(timeout);
    const data = await response.json();
    return {
      ok: true,
      ip: data.ip || '',
      country: data.country || ''
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

function getHeaderValue(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).find(key => key.toLowerCase() === target);
}

function matchesPattern(url, patterns) {
  return patterns.some(pattern => url.includes(pattern));
}

const AI_SENSITIVE_PARAMS = ['fbclid', 'gclid', 'utm_', 'mc_cid', 'mc_eid', 'yclid'];
const AI_TRACKING_PATHS = ['/collect', '/pixel', '/beacon', '/track', '/analytics'];

function aiRequestGuard(details) {
  const { url, resourceType } = details;
  const lowered = url.toLowerCase();
  const suspiciousParams = AI_SENSITIVE_PARAMS.some(param => lowered.includes(param));
  const suspiciousPath = AI_TRACKING_PATHS.some(path => lowered.includes(path));
  const isBeacon = resourceType === 'beacon' || resourceType === 'ping';
  if (suspiciousParams || suspiciousPath || isBeacon) {
    return {
      block: true,
      reason: 'حظر بالذكاء الاصطناعي (طلب تتبع)'
    };
  }
  return { block: false, reason: '' };
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

function buildSmartHeaders(url, incoming = {}) {
  const headers = { ...incoming };
  const langKey = getHeaderValue(headers, 'accept-language') || 'Accept-Language';
  const uaKey = getHeaderValue(headers, 'user-agent') || 'User-Agent';
  const dntKey = getHeaderValue(headers, 'dnt') || 'DNT';
  const chUaKey = getHeaderValue(headers, 'sec-ch-ua') || 'sec-ch-ua';
  const chMobileKey = getHeaderValue(headers, 'sec-ch-ua-mobile') || 'sec-ch-ua-mobile';
  const chPlatformKey = getHeaderValue(headers, 'sec-ch-ua-platform') || 'sec-ch-ua-platform';

  const primaryLang = spoofData.language || 'en-US';
  const secondaryLang = spoofData.languages?.[1] || primaryLang.split('-')[0] || 'en';
  headers[langKey] = `${primaryLang},${secondaryLang};q=0.9`;
  headers[uaKey] = spoofData.ua || headers[uaKey];
  headers[dntKey] = spoofData.doNotTrack === '1' ? '1' : '0';

  const isMac = (spoofData.platform || '').toLowerCase().includes('mac');
  const isWin = (spoofData.platform || '').toLowerCase().includes('win');
  const platformName = isMac ? 'macOS' : (isWin ? 'Windows' : 'Linux');
  headers[chUaKey] = `"Chromium";v="120", "Not(A:Brand";v="24", "Google Chrome";v="120"`;
  headers[chMobileKey] = '?0';
  headers[chPlatformKey] = `"${platformName}"`;

  try {
    const urlRef = new URL(url);
    const refererKey = getHeaderValue(headers, 'referer') || 'Referer';
    if (!headers[refererKey]) {
      headers[refererKey] = `${urlRef.origin}/`;
    }
  } catch (err) {
    // ignore bad URLs
  }

  return headers;
}

function registerNetworkHandlers(sessionRef) {
  if (networkHandlersRegistered) return;
  networkHandlersRegistered = true;

  sessionRef.webRequest.onBeforeRequest((details, callback) => {
    if (privacySettings.aiRequestGuard) {
      const aiDecision = aiRequestGuard(details);
      if (aiDecision.block) {
        addNetworkLog({
          time: new Date().toLocaleTimeString('ar-EG'),
          url: details.url,
          type: details.resourceType,
          status: 'blocked',
          reason: aiDecision.reason
        });
        return callback({ cancel: true });
      }
    }
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

  sessionRef.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!details.requestHeaders) {
      return callback({ requestHeaders: details.requestHeaders });
    }
    const requestHeaders = buildSmartHeaders(details.url, details.requestHeaders);
    return callback({ requestHeaders });
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
ipcMain.on('set-proxy', async (event, config) => {
  if (!config || !config.host) {
    proxyConfig = null;
    activeProxyProfileId = null;
    addLog('تم إزالة إعدادات البروكسي', false);
    await applyProxyConfig(null);
    sendProxyUpdate();
    await waitForProxyAndSyncGeo();
    return;
  }

  proxyConfig = buildProxyConfig(config);
  if (!proxyConfig) {
    addLog('بيانات البروكسي غير صالحة', true);
    return;
  }

  await applyProxyConfig(proxyConfig);

  const displayUrl = `${config.type}://${config.host}:${config.port}`;
  addLog(`✓ تم تعيين البروكسي: ${displayUrl}`, false);
  sendProxyUpdate();
  await waitForProxyAndSyncGeo();
});

ipcMain.on('save-proxy-profile', async (event, payload) => {
  if (!payload || !payload.name || !payload.config) return;
  const normalized = buildProxyConfig(payload.config);
  if (!normalized) return;
  const profile = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: payload.name.trim(),
    config: normalized
  };
  proxyProfiles.unshift(profile);
  activeProxyProfileId = profile.id;
  proxyConfig = { ...profile.config };
  await applyProxyConfig(proxyConfig);
  saveProxyProfiles();
  sendProxyProfilesUpdate();
  sendProxyUpdate();
  addLog(`تم حفظ بروكسي جديد: ${profile.name}`, false);
  await waitForProxyAndSyncGeo();
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

ipcMain.on('select-proxy-profile', async (event, profileId) => {
  if (!profileId) return;
  await selectProxyProfile(profileId);
});

ipcMain.handle('test-proxy', async (event, config) => {
  const normalized = buildProxyConfig(config);
  return testProxyConnection(normalized);
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
    proxyConfig = parsed.proxy ? buildProxyConfig(parsed.proxy) : null;
    await applyProxyConfig(proxyConfig);
    sendProxyUpdate();
    await waitForProxyAndSyncGeo();
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
