'use strict';

// Run on an isolated cloud machine, never on a GitHub self-hosted runner.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSubmission } = require('./gpu-report-ingest.cjs');

function hardwareSubmission(commitSha, original) {
  const report = JSON.parse(JSON.stringify(original));
  let redacted = false;
  const scrub = (item, key, limit) => {
    if (!item || typeof item[key] !== 'string') return;
    const originalText = item[key];
    let safe = originalText.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '[control]')
      .replace(/(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9.])/g, '[address]')
      .replace(/(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}/gi, '[address]');
    if (safe.length > limit) safe = `${safe.slice(0, limit - 14)}...[truncated]`;
    if (safe !== originalText) redacted = true;
    item[key] = safe;
  };
  scrub(report, 'adapter', 256);
  scrub(report, 'error', 4096);
  scrub(report.orbit, 'error', 4096);
  scrub(report.thermal, 'error', 4096);
  return { commitSha, kind: 'hardware-report', report, redacted };
}

function makeSubmission(commitSha, report, stage, info) {
  const validHardwareReport = stage === 'hardware' && report && typeof report === 'object' &&
    report.passed === false && report.platform === info.platform;
  if (validHardwareReport) return hardwareSubmission(commitSha, report);
  return { commitSha, kind: 'infrastructure-failure', report: {
    passed: false, platform: info.platform, architecture: info.architecture, osRelease: info.osRelease,
    electron: 'unavailable', chromium: 'unavailable',
    error: `Validation did not complete; failing stage: ${stage}. No GPU pass was established.`,
  } };
}

function run(expectedSha) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha || '')) throw new Error('Provide the exact reviewed 40-character lowercase commit SHA');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (path.resolve(root) !== path.resolve(process.cwd())) throw new Error('Run this command from the repository root');
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actualSha !== expectedSha) throw new Error('Checked-out commit does not match the expected SHA');
  const cleanSource = () => !execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim();
  const initiallyClean = cleanSource();
  const trackedReports = execFileSync('git', ['ls-files', '--', 'gpu-validation-report.json', 'gpu-report-submission.json', 'gpu-report-submission.txt'], { cwd: root, encoding: 'utf8' }).trim();
  if (trackedReports) throw new Error('A validation output path is tracked; refusing to overwrite it');
  if (!initiallyClean && ['gpu-report-submission.json', 'gpu-report-submission.txt'].some(name => fs.existsSync(path.join(root, name)))) {
    throw new Error('Source tree is dirty and a submission output exists; refusing to overwrite it');
  }
  // The previous benchmark report must not be mistaken for the current run.
  const reportPath = path.join(root, 'gpu-validation-report.json');
  if (initiallyClean) {
    fs.rmSync(reportPath, { force: true });
  }
  const executable = name => process.platform === 'win32' ? `${name}.cmd` : name;
  const commands = [
    ['dependencies', executable('npm'), ['ci']],
    ['tests', executable('npm'), ['test']],
    ['build', executable('npm'), ['run', 'build']],
    ['package', executable('npx'), ['--no-install', 'electron-builder', '--dir', '--publish', 'never']],
    ['hardware', process.execPath, ['electron/run-packaged-gpu.cjs']],
  ];
  let failedStage = initiallyClean ? undefined : 'source-check';
  if (!failedStage) for (const [stage, command, args] of commands) {
    if (stage === 'hardware' && !cleanSource()) { failedStage = 'post-build-source-check'; break; }
    console.log(`Running validation stage: ${stage}`);
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd') });
    if (result.error || result.status !== 0) { failedStage = stage; break; }
  }
  if ((!failedStage || failedStage === 'hardware') && !cleanSource()) failedStage = 'post-hardware-source-check';
  let report;
  if (fs.existsSync(reportPath)) {
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* Treat incomplete report as infrastructure failure. */ }
  }
  const info = { platform: process.platform, architecture: process.arch, osRelease: os.release() };
  let submission;
  if (!failedStage && report?.passed === true && report.platform === process.platform) submission = hardwareSubmission(actualSha, report);
  else submission = makeSubmission(actualSha, report, failedStage || 'hardware', info);
  let json = JSON.stringify(submission);
  try {
    const platform = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[process.platform];
    validateSubmission({ encoded: Buffer.from(json, 'utf8').toString('base64'), commitSha: actualSha, platform, provider: 'Unspecified' });
  } catch {
    // Retain a truthful failure even when the original harness report is malformed.
    submission = makeSubmission(actualSha, undefined, 'report-validation', info);
    json = JSON.stringify(submission);
  }
  fs.writeFileSync(path.join(root, 'gpu-report-submission.json'), `${json}\n`);
  fs.writeFileSync(path.join(root, 'gpu-report-submission.txt'), Buffer.from(json, 'utf8').toString('base64'));
  console.log('Submission saved to gpu-report-submission.json and gpu-report-submission.txt. Inspect for private data before upload.');
  if (!submission.report.passed) process.exitCode = 1;
}

module.exports = { makeSubmission };
if (require.main === module) {
  try { run(process.argv[2]); } catch (error) { console.error(error instanceof Error ? error.message : 'Validation could not start'); process.exitCode = 1; }
}
