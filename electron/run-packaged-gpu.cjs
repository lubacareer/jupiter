const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

// The preceding electron-builder --dir step must run on the target OS.
const release = join(process.cwd(), 'release');
let candidates;
if (process.platform === 'win32') {
  candidates = [join(release, 'win-unpacked', 'Europa Engine.exe')];
} else if (process.platform === 'linux') {
  candidates = [join(release, 'linux-unpacked', 'europa-engine')];
} else if (process.platform === 'darwin') {
  const archDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  candidates = [join(release, archDir, 'Europa Engine.app', 'Contents', 'MacOS', 'Europa Engine')];
} else {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}
const executable = candidates.find(existsSync);
if (!executable) {
  console.error(`Packaged executable not found; checked: ${candidates.join(', ')}`);
  process.exit(1);
}
console.log(`Validating packaged app: ${executable}`);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const result = spawnSync(executable, ['--gpu-hardware-test'], { stdio: 'inherit', cwd: process.cwd(), env: environment });
if (result.error) console.error(result.error);
if (result.signal) console.error(`Packaged app terminated by signal: ${result.signal}`);
process.exit(result.status === 0 ? 0 : 1);
