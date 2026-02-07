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
  battery: { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 },
  userAgentData: {
    brands: [
      { brand: 'Chromium', version: '120' },
      { brand: 'Not(A:Brand', version: '24' },
      { brand: 'Google Chrome', version: '120' }
    ],
    mobile: false,
    platform: 'Windows',
    architecture: 'x86',
    bitness: '64',
    model: ''
  },
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

const privacyState = {
  blockWebgl: false,
  blockWebrtc: true
};

const sessionSeed = (() => {
  try {
    const buffer = new Uint32Array(4);
    crypto.getRandomValues(buffer);
    return Array.from(buffer).reduce((acc, val) => acc ^ val, 0) || Date.now();
  } catch (err) {
    return Math.floor(Math.random() * 0xffffffff);
  }
})();

function hashNoise(seed, x, y, channel = 0) {
  let n = seed ^ (x * 374761393) ^ (y * 668265263) ^ (channel * 362437);
  n = (n ^ (n >>> 13)) * 1274126177;
  n = (n ^ (n >>> 16)) >>> 0;
  return (n / 4294967296) - 0.5;
}

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

  if (navigator.userAgentData) {
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => {
        const base = spoofState.userAgentData || {};
        return {
          brands: base.brands || [],
          mobile: !!base.mobile,
          platform: base.platform || 'Windows',
          getHighEntropyValues: async (hints) => {
            const values = {
              architecture: base.architecture || 'x86',
              bitness: base.bitness || '64',
              model: base.model || '',
              platform: base.platform || 'Windows',
              platformVersion: '10.0.0',
              uaFullVersion: (base.brands?.find(b => b.brand === 'Google Chrome')?.version || '120') + '.0.0.0',
              fullVersionList: base.brands || []
            };
            if (!Array.isArray(hints)) return values;
            return hints.reduce((acc, key) => {
              if (key in values) acc[key] = values[key];
              return acc;
            }, {});
          }
        };
      },
      configurable: true
    });
  }

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

  if (navigator.getBattery) {
    const batteryState = spoofState.battery || {};
    navigator.getBattery = () =>
      Promise.resolve({
        charging: batteryState.charging ?? true,
        chargingTime: batteryState.chargingTime ?? 0,
        dischargingTime: batteryState.dischargingTime ?? Infinity,
        level: batteryState.level ?? 1,
        onchargingchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        onlevelchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false
      });
  }
}

// ─── تزوير Canvas مع ضوضاء عشوائية ───
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;

function applyCanvasNoise(ctx, width, height) {
  if (!ctx || width <= 0 || height <= 0) return () => {};
  const stepX = Math.max(1, Math.floor(width / 10));
  const stepY = Math.max(1, Math.floor(height / 10));
  const restorePixels = [];
  const noise = spoofState.canvasNoise;
  const seed = sessionSeed ^ (width * 8191) ^ (height * 131071);
  for (let x = 0; x < width; x += stepX) {
    for (let y = 0; y < height; y += stepY) {
      const imgData = ctx.getImageData(x, y, 1, 1);
      const original = new Uint8ClampedArray(imgData.data);
      const data = imgData.data;
      data[0] = Math.max(0, Math.min(255, data[0] + hashNoise(seed, x, y, 0) * 255 * noise));
      data[1] = Math.max(0, Math.min(255, data[1] + hashNoise(seed, x, y, 1) * 255 * noise));
      data[2] = Math.max(0, Math.min(255, data[2] + hashNoise(seed, x, y, 2) * 255 * noise));
      ctx.putImageData(imgData, x, y);
      restorePixels.push({ x, y, data: original });
    }
  }
  return () => {
    restorePixels.forEach(pixel => {
      const imgData = ctx.createImageData(1, 1);
      imgData.data.set(pixel.data);
      ctx.putImageData(imgData, pixel.x, pixel.y);
    });
  };
}

HTMLCanvasElement.prototype.toDataURL = function(type, ...args) {
  let restore = null;
  if (!type || type === 'image/png') {
    const ctx = this.getContext('2d');
    restore = applyCanvasNoise(ctx, this.width, this.height);
  }
  const result = originalToDataURL.call(this, type, ...args);
  if (restore) restore();
  return result;
};

if (originalToBlob) {
  HTMLCanvasElement.prototype.toBlob = function(callback, type, ...args) {
    let restore = null;
    if (!type || type === 'image/png') {
      const ctx = this.getContext('2d');
      restore = applyCanvasNoise(ctx, this.width, this.height);
    }
    return originalToBlob.call(this, blob => {
      if (restore) restore();
      callback(blob);
    }, type, ...args);
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(type, ...args) {
  if (privacyState.blockWebgl && (type === 'webgl' || type === 'webgl2')) {
    return null;
  }
  return originalGetContext.call(this, type, ...args);
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

// ─── تزوير AudioContext ───
const originalGetChannelData = AudioBuffer.prototype.getChannelData;
AudioBuffer.prototype.getChannelData = function(channel) {
  const data = originalGetChannelData.call(this, channel);
  const copy = new Float32Array(data.length);
  copy.set(data);
  const noiseSeed = sessionSeed ^ (channel + 1) * 2654435761;
  let idx = 0;
  for (let i = 0; i < copy.length; i += 1) {
    if (idx >= 1024) idx = 0;
    const noise = hashNoise(noiseSeed, i, idx, channel) * 1e-5;
    copy[i] += noise;
    idx += 1;
  }
  return copy;
};

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

ipcRenderer.on('privacy-update', (event, settings) => {
  privacyState.blockWebgl = !!settings?.blockWebgl;
  privacyState.blockWebrtc = settings?.blockWebrtc !== false;
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
      if (privacyState.blockWebrtc) {
        const error = typeof DOMException === 'function'
          ? new DOMException('WebRTC is blocked', 'NotAllowedError')
          : new Error('WebRTC is blocked');
        throw error;
      }
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

if (navigator.mediaDevices) {
  const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices?.bind(navigator.mediaDevices);
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = (...args) => {
    if (privacyState.blockWebrtc) {
      return Promise.resolve([]);
    }
    return originalEnumerateDevices ? originalEnumerateDevices(...args) : Promise.resolve([]);
  };
  navigator.mediaDevices.getUserMedia = (...args) => {
    if (privacyState.blockWebrtc) {
      return Promise.reject(new DOMException('WebRTC is blocked', 'NotAllowedError'));
    }
    return originalGetUserMedia
      ? originalGetUserMedia(...args)
      : Promise.reject(new DOMException('WebRTC is blocked', 'NotAllowedError'));
  };
}
