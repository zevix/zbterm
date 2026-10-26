const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron')

contextBridge.exposeInMainWorld('bridge', {
  logToFile: (msg) => {
    ipcRenderer.send('renderer:fileLog', msg)
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // Whole-app zoom (Ctrl -/+ when that setting is on).
  setZoomLevel: (level) => webFrame.setZoomLevel(level),
  log: (level, msg) => ipcRenderer.send('renderer:log', level, msg),
  pkg() {
    return ipcRenderer.sendSync('pkg')
  },

  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
  onPearReady: (listener) => {
    const wrap = (evt, data) => listener(data)
    ipcRenderer.on('pear:ready', wrap)
    return () => ipcRenderer.removeListener('pear:ready', wrap)
  },
  onPearError: (listener) => {
    const wrap = (evt, message) => listener(message)
    ipcRenderer.on('pear:error', wrap)
    return () => ipcRenderer.removeListener('pear:error', wrap)
  }
})

// App-level settings the main process applies itself.
contextBridge.exposeInMainWorld('app', {
  // D-11: the "STUN/TURN servers" field; '' hands the choice back to
  // --ice-servers, ZBTERM_ICE_SERVERS or the default list.
  setIceServers: (list) => ipcRenderer.invoke('app:setIceServers', String(list || ''))
})

contextBridge.exposeInMainWorld('zbterm', {
  async invoke(method, args = {}) {
    const result = await ipcRenderer.invoke('zbterm:invoke', method, args)
    if (result && result.error) {
      const err = new Error(result.error.message)
      err.name = result.error.name
      err.code = result.error.code
      err.details = result.error.details
      throw err
    }
    return result
  },
  on(eventName, listener) {
    const wrap = (evt, event) => {
      if (event.name === eventName) listener(event.data)
    }
    ipcRenderer.on('zbterm:event', wrap)
    return () => ipcRenderer.removeListener('zbterm:event', wrap)
  }
})
