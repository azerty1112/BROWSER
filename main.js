const { 
  app, 
  BrowserWindow, 
  BrowserView, 
  ipcMain, 
  session 
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

let controlWin = null;
let mainWin = null;
let mainView = null;
let geoData = {};

const countries = new Map();
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
        if (iso2) countries.set(iso2, name);
        if (iso3) countries.set(iso3, name);
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
    geoData.country = data.country || '?';
    // try to map country code to full name
    const cc = (geoData.country || '').toUpperCase();
    if (countries.has(cc)) geoData.countryName = countries.get(cc);

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

    // Nominatim reverse (اختياري - بطيء نسبياً)
    if (fetchFn && geoData.lat && geoData.lon) {
      const nom = await fetchFn(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${geoData.lat}&lon=${geoData.lon}&zoom=10`
      ).then(r => r.json());
      geoData.details = nom.address || {};
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
    width:  800,
    height: 600,
    center: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
      sandbox: true
    }
  });

  mainWin.loadFile('index.html');
  mainWin.removeMenu();

  mainWin.webContents.on('did-finish-load', () => {
    fetchGeoData();
    sendSpoofUpdate();
  });

  mainView = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true
    }
  });

  mainWin.setBrowserView(mainView);
  mainView.setBounds({ x: 0, y: 140, width: 1400, height: 760 });
  mainView.setAutoResize({ width: true, height: true });

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

function addLog(msg, isError = false) {
  const time = new Date().toLocaleTimeString('ar-EG');
  logs.unshift({ time, msg, isError });
  if (logs.length > MAX_LOGS) logs.pop();
  controlWin?.webContents.send('log-update', logs);
  mainWin?.webContents.send('log-update', logs);
}

// ─── بيانات التزوير والبروكسي ───
let proxyConfig = null;

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
    addLog('تم إزالة إعدادات البروكسي', false);
    return;
  }

  proxyConfig = {
    type: config.type || 'http',
    host: config.host,
    port: parseInt(config.port) || 80,
    username: config.username || '',
    password: config.password || ''
  };

  // تطبيق البروكسي على الجلسة
  if (mainView) {
    const proxyUrl = `${proxyConfig.type}://${proxyConfig.host}:${proxyConfig.port}`;
    mainView.webContents.session.setProxy({
      proxyRules: proxyUrl,
      proxyBypassRules: 'localhost'
    }).catch(err => {
      addLog(`خطأ في تطبيق البروكسي: ${err.message}`, true);
    });
  }

  const displayUrl = `${config.type}://${config.host}:${config.port}`;
  addLog(`✓ تم تعيين البروكسي: ${displayUrl}`, false);
  controlWin?.webContents.send('proxy-update', proxyConfig);
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
