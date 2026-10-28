const { spawn } = require('node:child_process');
const electron = require('electron');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
require('esbuild').build({ entryPoints: [path.join(__dirname, '../src/simulation/gpuHardwareWorker.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', outfile: path.join(__dirname, '../dist-electron/gpu-hardware-worker.js') }).then(() => {
  const child = spawn(electron, [path.join(__dirname, 'gpu-hardware.cjs')], { stdio: 'inherit', env });
  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
}).catch(error => { console.error(error); process.exitCode = 1; });
