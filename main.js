const { 
  app, 
  BrowserWindow, 
  BrowserView, 
  ipcMain, 
  session 
} = require('electron');

const path    = require('path');
const fetch   = require('node-fetch');
const maxmind = require('maxmind');
const fs      = require('fs');
const csv     = require('csv-parser');

let controlWin = null;
let mainWin = null;
let mainView = null;

// مسارات
const GEO_DB   = path.join(__dirname, 'db/GeoLite2-City.mmdb');
const CSV_FILE = path.join(__dirname, 'countries-data.csv');

// ─── جلب بيانات الموقع ───
async function fetchGeoData() {
  try {
    const res = await fetch('https://api.myip.com');
    const data = await res.json();
    geoData.ip = data.ip || 'غير معروف';
    geoData.country = data.country || '?';

    const reader = await maxmind.open(GEO_DB);
    const record = reader.get(geoData.ip) || {};
    geoData.city = record.city?.names?.en || '?';
    geoData.lat  = record.location?.latitude  || 0;
    geoData.lon  = record.location?.longitude || 0;

    // Nominatim reverse (اختياري - بطيء نسبياً)
    if (geoData.lat && geoData.lon) {
      const nom = await fetch(
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

  // جلب البيانات عند الفتح
  fetchGeoData();
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

  // إغلاق نافذة التحكم
  controlWin?.close();
}

// ─── عند التشغيل ───
// ثم في النهاية:
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