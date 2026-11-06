const { contextBridge, ipcRenderer } = require('electron');
const argument = name => process.argv.find(value => value.startsWith(`--cove-${name}=`))?.split('=')[1];
contextBridge.exposeInMainWorld('coveLanguage', Object.freeze({
  preference: argument('language'),
  systemLanguages: [argument('locale')],
  save: value => ipcRenderer.invoke('language:save', value)
}));
contextBridge.exposeInMainWorld('covePlatform', process.platform);
contextBridge.exposeInMainWorld('coveFolders', Object.freeze({
  openAutoImport: () => ipcRenderer.invoke('auto-import:open-folder'),
  chooseAutoImport: () => ipcRenderer.invoke('auto-import:choose-folder'),
  openLibrary: () => ipcRenderer.invoke('library:open-folder')
}));
contextBridge.exposeInMainWorld('coveAlarm', Object.freeze({
  get: () => ipcRenderer.invoke('alarm:get'),
  save: value => ipcRenderer.invoke('alarm:save', value),
  preview: value => ipcRenderer.invoke('alarm:preview', value),
  stop: token => ipcRenderer.invoke('alarm:stop', token),
  ready: () => ipcRenderer.invoke('alarm:ready'),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('alarm:event', listener);
    return () => ipcRenderer.removeListener('alarm:event', listener);
  }
}));

if (process.platform === 'darwin') contextBridge.exposeInMainWorld('coveMedia', Object.freeze({
  ready: () => ipcRenderer.invoke('media:ready'),
  status: () => ipcRenderer.invoke('media:status'),
  update: state => ipcRenderer.send('media:state', state),
  onAction: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('media:action', listener);
    return () => ipcRenderer.removeListener('media:action', listener);
  }
}));
