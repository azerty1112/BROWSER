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
  connection: { effectiveType: '4g', downlink: 10, rtt: 120, saveData: false },
  doNotTrack: '1',
  maxTouchPoints: 0,
  webdriver: false,
  tlsVersion: 'TLSv1.3',
  tlsCipher: 'TLS_AES_256_GCM_SHA384'
};

const webrtcState = {
  publicIp: '',
  errorInjected: false,
  initialized: false
};

contextBridge.exposeInMainWorld('api', {
  startBrowser:      ()       => ipcRenderer.send('start-browser'),
  refreshGeo:        ()       => ipcRenderer.send('refresh-geo'),
  navigate:          (url)    => ipcRenderer.send('navigate', url),
  goBack:            ()       => ipcRenderer.send('go-back'),
  goForward:         ()       => ipcRenderer.send('go-forward'),
  reload:            ()       => ipcRenderer.send('reload'),
  setProxy:          (cfg)    => ipcRenderer.send('set-proxy', cfg),
  setPrivacy:        (cfg)    => ipcRenderer.send('set-privacy', cfg),
  generateSpoof:     (config) => ipcRenderer.send('generate-spoof', config),
  clearData:         ()       => ipcRenderer.send('clear-data'),
  exportSettings:    ()       => ipcRenderer.invoke('export-settings'),
  importSettings:    ()       => ipcRenderer.invoke('import-settings'),
  testProxy:         (cfg)    => ipcRenderer.invoke('test-proxy', cfg),
  updateSpoofState:  (state)  => { spoofState = { ...spoofState, ...state }; applySpoof(); },
  onGeoUpdate:       (cb)     => ipcRenderer.on('geo-update', (_, data) => cb(data)),
  onSpoofUpdate:     (cb)     => ipcRenderer.on('spoof-update', (_, data) => cb(data)),
  onLogUpdate:       (cb)     => ipcRenderer.on('log-update', (_, data) => cb(data)),
  onProxyUpdate:     (cb)     => ipcRenderer.on('proxy-update', (_, data) => cb(data)),
  onProxyProfilesUpdate: (cb) => ipcRenderer.on('proxy-profiles-update', (_, data) => cb(data)),
  onPrivacyUpdate:   (cb)     => ipcRenderer.on('privacy-update', (_, data) => cb(data)),
  onNetworkUpdate:   (cb)     => ipcRenderer.on('network-update', (_, data) => cb(data)),
  saveProxyProfile:  (payload) => ipcRenderer.send('save-proxy-profile', payload),
  deleteProxyProfile: (id) => ipcRenderer.send('delete-proxy-profile', id),
  selectProxyProfile: (id) => ipcRenderer.send('select-proxy-profile', id)
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
        const options = { ...(args?.[1] || {}), timeZone: spoofState.timezone };
        return new target(spoofState.language, options);
      },
      get(target, prop) {
        if (prop === 'resolvedOptions') {
          return () => ({
            locale: spoofState.language,
            timeZone: spoofState.timezone
          });
        }
        return target[prop];
      }
    }),
    configurable: true
  });

  Object.defineProperty(navigator, 'language', {
    get: () => spoofState.language,
    configurable: true
  });

  Object.defineProperty(navigator, 'languages', {
    get: () => spoofState.languages || [spoofState.language],
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

  Object.defineProperty(navigator, 'platform', {
    get: () => spoofState.platform,
    configurable: true
  });

  Object.defineProperty(navigator, 'vendor', {
    get: () => spoofState.vendor,
    configurable: true
  });

  Object.defineProperty(navigator, 'doNotTrack', {
    get: () => spoofState.doNotTrack,
    configurable: true
  });

  Object.defineProperty(navigator, 'maxTouchPoints', {
    get: () => spoofState.maxTouchPoints,
    configurable: true
  });

  Object.defineProperty(navigator, 'webdriver', {
    get: () => spoofState.webdriver,
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

  Object.defineProperty(screen, 'availWidth', {
    get: () => spoofState.screenAvailWidth,
    configurable: true
  });

  Object.defineProperty(screen, 'availHeight', {
    get: () => spoofState.screenAvailHeight,
    configurable: true
  });

  Object.defineProperty(screen, 'colorDepth', {
    get: () => spoofState.colorDepth,
    configurable: true
  });

  Object.defineProperty(window, 'devicePixelRatio', {
    get: () => spoofState.devicePixelRatio,
    configurable: true
  });

  const fakePlugins = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
  ];

  const fakeMimeTypes = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
    { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' }
  ];

  const pluginArray = Object.assign([], fakePlugins);
  const mimeTypeArray = Object.assign([], fakeMimeTypes);
  Object.defineProperty(pluginArray, 'length', { value: fakePlugins.length });
  Object.defineProperty(mimeTypeArray, 'length', { value: fakeMimeTypes.length });
  Object.defineProperty(navigator, 'plugins', {
    get: () => pluginArray,
    configurable: true
  });
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => mimeTypeArray,
    configurable: true
  });

  Object.defineProperty(navigator, 'connection', {
    get: () => ({
      effectiveType: spoofState.connection?.effectiveType || '4g',
      downlink: spoofState.connection?.downlink || 10,
      rtt: spoofState.connection?.rtt || 120,
      saveData: !!spoofState.connection?.saveData
    }),
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

ipcRenderer.on('webrtc-ip-update', (event, ip) => {
  if (ip && typeof ip === 'string') {
    webrtcState.publicIp = ip;
  }
});

// تطبيق التزوير الأولي
applySpoof();

// ─── تزوير WebRTC ───
function rewriteSdp(sdp) {
  if (!webrtcState.publicIp || !sdp) return sdp;
  const ipPattern = /(\d{1,3}\.){3}\d{1,3}/g;
  return sdp.replace(ipPattern, webrtcState.publicIp);
}

function wrapCandidate(candidate) {
  if (!candidate || !webrtcState.publicIp) return candidate;
  return candidate.replace(/(\d{1,3}\.){3}\d{1,3}/g, webrtcState.publicIp);
}

function createWebRTCProxy(RTCPeerConnectionClass) {
  if (!RTCPeerConnectionClass) return null;
  return new Proxy(RTCPeerConnectionClass, {
    construct(target, args) {
      if (!webrtcState.initialized) {
        webrtcState.initialized = true;
        webrtcState.errorInjected = true;
      }
      const pc = new target(...args);

      const originalCreateOffer = pc.createOffer?.bind(pc);
      if (originalCreateOffer) {
        pc.createOffer = (...offerArgs) => {
          if (webrtcState.errorInjected) {
            webrtcState.errorInjected = false;
            return Promise.reject(new Error('WebRTC temporarily unavailable'));
          }
          return originalCreateOffer(...offerArgs);
        };
      }

      const originalSetLocalDescription = pc.setLocalDescription?.bind(pc);
      if (originalSetLocalDescription) {
        pc.setLocalDescription = async (desc) => {
          if (desc?.sdp) {
            const rewritten = rewriteSdp(desc.sdp);
            const patchedDesc = new RTCSessionDescription({
              type: desc.type,
              sdp: rewritten
            });
            return originalSetLocalDescription(patchedDesc);
          }
          return originalSetLocalDescription(desc);
        };
      }

      const originalAddEventListener = pc.addEventListener.bind(pc);
      pc.addEventListener = (type, listener, ...rest) => {
        if (type !== 'icecandidate' || typeof listener !== 'function') {
          return originalAddEventListener(type, listener, ...rest);
        }
        const wrapped = (event) => {
          if (event?.candidate?.candidate) {
            const patchedCandidate = new RTCIceCandidate({
              ...event.candidate,
              candidate: wrapCandidate(event.candidate.candidate)
            });
            const patchedEvent = new Event('icecandidate');
            Object.defineProperty(patchedEvent, 'candidate', { value: patchedCandidate });
            return listener(patchedEvent);
          }
          return listener(event);
        };
        return originalAddEventListener(type, wrapped, ...rest);
      };

      Object.defineProperty(pc, 'onicecandidate', {
        set(handler) {
          if (typeof handler !== 'function') return;
          const wrapped = (event) => {
            if (event?.candidate?.candidate) {
              const patchedCandidate = new RTCIceCandidate({
                ...event.candidate,
                candidate: wrapCandidate(event.candidate.candidate)
              });
              const patchedEvent = new Event('icecandidate');
              Object.defineProperty(patchedEvent, 'candidate', { value: patchedCandidate });
              return handler(patchedEvent);
            }
            return handler(event);
          };
          originalAddEventListener('icecandidate', wrapped);
        }
      });

      return pc;
    }
  });
}

const OriginalRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
const WebRTCProxy = createWebRTCProxy(OriginalRTCPeerConnection);
if (WebRTCProxy) {
  window.RTCPeerConnection = WebRTCProxy;
  window.webkitRTCPeerConnection = WebRTCProxy;
}
