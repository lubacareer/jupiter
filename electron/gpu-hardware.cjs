// Run the exact browser WebGPU kernels on an identified hardware adapter.
// A loopback secure context allows a sandboxed dedicated worker without changing
// Chromium's GPU blocklist or enabling software adapters.
const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('node:http');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const os = require('node:os');

let server, window, finished = false;
function finish(data) {
  if (finished) return;
  finished = true;
  const report = { ...data, platform: process.platform, architecture: process.arch, osRelease: os.release(), electron: process.versions.electron, chromium: process.versions.chrome };
  try { writeFileSync(resolve('gpu-validation-report.json'), `${JSON.stringify(report, null, 2)}\n`); }
  catch (error) { console.error('Could not write GPU report:', error); report.passed = false; }
  console.log(JSON.stringify(report, null, 2));
  if (server) server.close();
  app.exit(report.passed ? 0 : 1);
}
app.whenReady().then(async () => {
  const workerBundle = readFileSync(join(__dirname, '../dist-electron/gpu-hardware-worker.js'));
  const html = '<!doctype html><meta charset="utf-8"><title>GPU hardware validation</title><script src="/main.js"></script>';
  const main = "const worker = new Worker('/worker.js'); worker.onmessage = event => window.gpuHardware.complete(event.data); worker.onerror = event => window.gpuHardware.complete({passed:false,error:event.message});";
  server = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; worker-src 'self'");
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); }
    else if (req.url === '/main.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(main); }
    else if (req.url === '/worker.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(workerBundle); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, 'gpu-hardware-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  ipcMain.on('gpu-hardware:complete', (event, result) => { if (event.sender === window.webContents) finish(result); });
  window.webContents.on('render-process-gone', (_event, details) => finish({ passed: false, error: `Renderer exited: ${details.reason}` }));
  setTimeout(() => finish({ passed: false, error: 'GPU hardware validation timed out' }), 10 * 60 * 1000).unref();
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
}).catch(error => finish({ passed: false, error: error instanceof Error ? error.message : String(error) }));
