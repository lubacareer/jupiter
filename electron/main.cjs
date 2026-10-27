const { app, BrowserWindow, dialog, ipcMain, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

let window;
let worker;
let latest;
function createWindow() {
  window = new BrowserWindow({ width: 1500, height: 1000, minWidth: 800, minHeight: 600, backgroundColor: '#09121b', title: 'Europa Engine', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (app.isPackaged) window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  else window.loadURL('http://127.0.0.1:41837');
  window.webContents.on('did-finish-load', () => { if (latest) window.webContents.send('simulation:snapshot', latest); });
  worker = utilityProcess.fork(path.join(__dirname, '..', 'dist-electron', 'worker.cjs'));
  worker.on('message', async (message) => {
    if (message.type === 'snapshot') {
      latest = message.snapshot;
      if (!window.isDestroyed()) window.webContents.send('simulation:snapshot', latest);
    } else if (message.type === 'checkpoint' || message.type === 'export') {
      try {
        const result = await dialog.showSaveDialog(window, { defaultPath: message.type === 'checkpoint' ? 'europa-checkpoint.json' : 'europa-orbit.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (!result.canceled && result.filePath) {
          const data = message.type === 'checkpoint' ? message.checkpoint : { schema: 'europa-orbit-export-v1', solver: 'point-mass velocity-Verlet, dt=300 s', epoch: '2025-01-01 TDB', units: { timeSeconds: 's', semiMajorAxisKm: 'km', resonanceAngleDeg: 'degrees' }, assumptions: ['Four point masses', 'No tidal feedback or interior dynamics', 'Not mission-validated', 'Rolling history: latest 2,000 samples'], ...message.checkpoint };
          await fs.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8');
        }
      } catch (error) { await dialog.showMessageBox(window, { type: 'error', message: `Could not save file: ${error.message}` }); }
    }
  });
  worker.on('exit', (code) => { if (window && !window.isDestroyed() && code !== 0) window.webContents.send('simulation:snapshot', { status: 'error', timeSeconds: 0, samples: [], message: `Simulation process exited (${code}).` }); });
}
app.whenReady().then(() => {
  ipcMain.on('simulation:subscribe', (event) => { if (event.sender === window?.webContents && latest) event.sender.send('simulation:snapshot', latest); });
  ipcMain.on('simulation:command', (event, command) => { if (event.sender === window?.webContents && ['start', 'pause', 'reset'].includes(command?.type)) worker?.postMessage(command); });
  ipcMain.on('simulation:save', (event) => { if (event.sender === window?.webContents) worker?.postMessage({ type: 'getCheckpoint' }); });
  ipcMain.on('simulation:export', (event) => { if (event.sender === window?.webContents) worker?.postMessage({ type: 'getExport' }); });
  ipcMain.on('simulation:load', async (event) => {
    if (event.sender !== window?.webContents) return;
    try {
      const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return;
      const stat = await fs.stat(result.filePaths[0]);
      if (stat.size > 5_000_000) throw new Error('Checkpoint exceeds 5 MB');
      worker?.postMessage({ type: 'load', checkpoint: JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')) });
    } catch (error) { await dialog.showMessageBox(window, { type: 'error', message: `Could not open checkpoint: ${error.message}` }); }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { worker?.kill(); if (process.platform !== 'darwin') app.quit(); });
