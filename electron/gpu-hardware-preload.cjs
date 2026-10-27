const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gpuHardware', { complete: result => ipcRenderer.send('gpu-hardware:complete', result) });
