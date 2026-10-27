const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('europa', {
  command: (command) => ipcRenderer.send('simulation:command', command),
  subscribe: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('simulation:snapshot', listener);
    ipcRenderer.send('simulation:subscribe');
    return () => ipcRenderer.removeListener('simulation:snapshot', listener);
  },
  saveCheckpoint: () => ipcRenderer.send('simulation:save'),
  loadCheckpoint: () => ipcRenderer.send('simulation:load'),
  exportData: () => ipcRenderer.send('simulation:export')
});
