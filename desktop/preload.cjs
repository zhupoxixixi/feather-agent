const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, value) => ipcRenderer.invoke('feather:' + method, value);
contextBridge.exposeInMainWorld('feather', Object.freeze({
  getState: () => invoke('state'),
  chooseWorkspace: () => invoke('workspace'),
  saveSettings: (value) => invoke('settings', value),
  start: (value) => invoke('start', value),
  cancel: () => invoke('cancel'),
  inspectSession: (id) => invoke('session', id),
  demo: () => invoke('demo'),
  onEvent(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('feather:event', listener);
    return () => ipcRenderer.removeListener('feather:event', listener);
  },
}));
