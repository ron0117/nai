const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nai', {
  getState: () => ipcRenderer.invoke('state:get'),
  dispatch: (action, payload) => ipcRenderer.invoke('state:dispatch', { action, payload }),
  onState: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot)
    ipcRenderer.on('state', listener)
    return () => ipcRenderer.removeListener('state', listener)
  },
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('overlay:ignore-mouse', ignore),
  pickOverlay: () => ipcRenderer.invoke('overlay:focus'),
  resizeBy: (dw, dh) => ipcRenderer.invoke('overlay:resize-by', { dw, dh }),
})
