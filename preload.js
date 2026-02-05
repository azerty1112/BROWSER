const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startBrowser:  ()     => ipcRenderer.send('start-browser'),
  refreshGeo:    ()     => ipcRenderer.send('refresh-geo'),
  navigate:      (url)  => ipcRenderer.send('navigate', url),
  goBack:        ()     => ipcRenderer.send('go-back'),
  goForward:     ()     => ipcRenderer.send('go-forward'),
  reload:        ()     => ipcRenderer.send('reload'),
  onGeoUpdate:   (cb)   => ipcRenderer.on('geo-update', (_, data) => cb(data))
});