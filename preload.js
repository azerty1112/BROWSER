const { contextBridge, ipcRenderer } = require('electron');

// ─── بيانات التزوير الحالية ───
let spoofState = {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  canvasNoise: 0.15,
  webglVendor: 'Intel Inc.',
  webglRenderer: 'Intel Iris OpenGL Engine',
  fonts: ['Arial', 'Verdana', 'Times New Roman'],
  hardwareConcurrency: 8,
  deviceMemory: 8,
  screenWidth: 1920,
  screenHeight: 1080,
  timezone: 'UTC',
  language: 'en-US',
  tlsVersion: 'TLSv1.3',
  tlsCipher: 'TLS_AES_256_GCM_SHA384'
};

contextBridge.exposeInMainWorld('api', {
  startBrowser:      ()       => ipcRenderer.send('start-browser'),
  refreshGeo:        ()       => ipcRenderer.send('refresh-geo'),
  navigate:          (url)    => ipcRenderer.send('navigate', url),
  goBack:            ()       => ipcRenderer.send('go-back'),
  goForward:         ()       => ipcRenderer.send('go-forward'),
  reload:            ()       => ipcRenderer.send('reload'),
  setProxy:          (cfg)    => ipcRenderer.send('set-proxy', cfg),
  generateSpoof:     (config) => ipcRenderer.send('generate-spoof', config),
  clearData:         ()       => ipcRenderer.send('clear-data'),
  updateSpoofState:  (state)  => { spoofState = { ...spoofState, ...state }; applySpoof(); },
  onGeoUpdate:       (cb)     => ipcRenderer.on('geo-update', (_, data) => cb(data)),
  onSpoofUpdate:     (cb)     => ipcRenderer.on('spoof-update', (_, data) => cb(data)),
  onLogUpdate:       (cb)     => ipcRenderer.on('log-update', (_, data) => cb(data))
});

// ─── تطبيق التزوير ───
function applySpoof() {
  // تحديث User Agent
  Object.defineProperty(navigator, 'userAgent', {
    get: () => spoofState.ua,
    configurable: true
  });

  // تزوير Timezone و Language
  Object.defineProperty(Intl, 'DateTimeFormat', {
    value: new Proxy(Intl.DateTimeFormat, {
      construct(target, args) {
        return new target(spoofState.language, args[1]);
      }
    }),
    configurable: true
  });

  // تزوير Hardware
  Object.defineProperty(navigator, 'hardwareConcurrency', { 
    get: () => spoofState.hardwareConcurrency,
    configurable: true
  });
  
  Object.defineProperty(navigator, 'deviceMemory', { 
    get: () => spoofState.deviceMemory,
    configurable: true
  });

  // تزوير Screen
  Object.defineProperty(screen, 'width', { 
    get: () => spoofState.screenWidth,
    configurable: true
  });
  
  Object.defineProperty(screen, 'height', { 
    get: () => spoofState.screenHeight,
    configurable: true
  });
}

// ─── تزوير Canvas مع ضوضاء عشوائية ───
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(type) {
  if (type === 'image/png') {
    const ctx = this.getContext('2d');
    for (let x = 0; x < this.width; x += Math.floor(this.width / 10)) {
      for (let y = 0; y < this.height; y += Math.floor(this.height / 10)) {
        const imgData = ctx.getImageData(x, y, 1, 1);
        const data = imgData.data;
        const noise = spoofState.canvasNoise;
        data[0] += (Math.random() - 0.5) * 255 * noise;
        data[1] += (Math.random() - 0.5) * 255 * noise;
        data[2] += (Math.random() - 0.5) * 255 * noise;
        ctx.putImageData(imgData, x, y);
      }
    }
  }
  return originalToDataURL.call(this, type);
};

// ─── تزوير WebGL ───
const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(pname) {
  if (pname === 37445) return spoofState.webglVendor; // UNMASKED_VENDOR_WEBGL
  if (pname === 37446) return spoofState.webglRenderer; // UNMASKED_RENDERER_WEBGL
  return originalGetParameter.call(this, pname);
};

const originalGetParameterWG2 = WebGL2RenderingContext.prototype?.getParameter;
if (originalGetParameterWG2) {
  WebGL2RenderingContext.prototype.getParameter = function(pname) {
    if (pname === 37445) return spoofState.webglVendor;
    if (pname === 37446) return spoofState.webglRenderer;
    return originalGetParameterWG2.call(this, pname);
  };
}

// ─── تزوير TLS Fingerprint ───
ipcRenderer.on('apply-spoof', (event, state) => {
  spoofState = { ...spoofState, ...state };
  applySpoof();
});

// تطبيق التزوير الأولي
applySpoof();