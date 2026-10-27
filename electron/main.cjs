const { app, BrowserWindow, dialog, ipcMain, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWorkerManager } = require('./worker-manager.cjs');
const { writeJsonAtomically, makeExport } = require('./files.cjs');

let window;
let manager;
let latest;

function createWindow() {
  const currentWindow = new BrowserWindow({ width: 1500, height: 1000, minWidth: 800, minHeight: 600, backgroundColor: '#09121b', title: 'Europa Engine', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window = currentWindow;
  latest = undefined;
  currentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  currentWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  if (app.isPackaged) currentWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else currentWindow.loadURL('http://127.0.0.1:41837');
  currentWindow.webContents.on('did-finish-load', () => { if (latest && !currentWindow.isDestroyed()) currentWindow.webContents.send('simulation:snapshot', latest); });

  manager = createWorkerManager({
    spawn: () => utilityProcess.fork(path.join(__dirname, '..', 'dist-electron', 'worker.cjs')),
    publish: (snapshot) => {
      if (window !== currentWindow || currentWindow.isDestroyed()) return;
      latest = snapshot;
      currentWindow.webContents.send('simulation:snapshot', snapshot);
    },
    onData: async (message) => {
      if (!message || !['checkpoint', 'export'].includes(message.type) || currentWindow.isDestroyed()) return;
      try {
        const result = await dialog.showSaveDialog(currentWindow, { defaultPath: message.type === 'checkpoint' ? 'europa-checkpoint.json' : 'europa-orbit.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!result.canceled && result.filePath) {
          const data = message.type === 'checkpoint' ? message.checkpoint : makeExport(message.checkpoint);
          await writeJsonAtomically(result.filePath, data);
        }
      } catch (error) {
        if (!currentWindow.isDestroyed()) await dialog.showMessageBox(currentWindow, { type: 'error', message: `Could not save file: ${error.message}` });
      }
    },
  });
  manager.startWorker();
}

app.whenReady().then(() => {
  const allowed = (event) => event.sender === window?.webContents && !window.isDestroyed();
  ipcMain.on('simulation:subscribe', (event) => { if (allowed(event) && latest) event.sender.send('simulation:snapshot', latest); });
  ipcMain.on('simulation:command', (event, command) => {
    if (allowed(event) && ['start', 'pause', 'reset'].includes(command?.type)) manager?.send(command, { restart: command.type === 'start' });
  });
  ipcMain.on('simulation:save', (event) => { if (allowed(event)) manager?.send({ type: 'getCheckpoint' }); });
  ipcMain.on('simulation:export', (event) => { if (allowed(event)) manager?.send({ type: 'getExport' }); });
  ipcMain.on('simulation:load', async (event) => {
    if (!allowed(event)) return;
    const currentWindow = window;
    const currentManager = manager;
    try {
      const result = await dialog.showOpenDialog(currentWindow, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return;
      const stat = await fs.stat(result.filePaths[0]);
      if (stat.size > 5_000_000) throw new Error('Checkpoint exceeds 5 MB');
      const checkpoint = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
      if (window === currentWindow && manager === currentManager && !currentWindow.isDestroyed()) currentManager?.send({ type: 'load', checkpoint }, { restart: true });
    } catch (error) {
      if (!currentWindow.isDestroyed()) await dialog.showMessageBox(currentWindow, { type: 'error', message: `Could not open checkpoint: ${error.message}` });
    }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { manager?.stop(); manager = undefined; latest = undefined; if (process.platform !== 'darwin') app.quit(); });
