'use strict';

// These are structural checks, not authentication of a report or its author.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_REPORT_BYTES = 16 * 1024;
const platforms = { Windows: 'win32', Linux: 'linux', macOS: 'darwin' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
function assert(condition, message) { if (!condition) throw new Error(message); }
function string(value, name, max = 256) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), `Invalid ${name}`);
}
function keys(value, allowed, name) { assert(Object.keys(value).every(key => allowed.includes(key)), `Unexpected ${name} field`); }
function containsIp(value) {
  return /(?:^|[^0-9.])(?:\d{1,3}\.){3}\d{1,3}(?:$|[^0-9.])/.test(value) || /(?:[a-f0-9]{0,4}:){2,}[a-f0-9]{0,4}/i.test(value);
}
function errorText(value, name) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !containsIp(value), `Invalid ${name}`);
}
function count(value, name) { assert(Number.isSafeInteger(value) && value > 0, `Invalid ${name}`); }
function bounded(value, limit, name) { assert(finite(value) && value >= 0 && value <= limit, `Invalid ${name}`); }

function validateSection(section, name) {
  assert(object(section) && typeof section.passed === 'boolean', `Invalid ${name} result`);
  keys(section, name === 'orbit' ? ['passed', 'error', 'samples', 'steps', 'maxSteps', 'maxErrorKm', 'lastTimeSeconds'] :
    ['passed', 'error', 'samples', 'maxTemperatureKelvin', 'maxLiquidFraction', 'normalizedEnergy'], name);
  for (const key of Object.keys(section).filter(key => !['passed', 'error'].includes(key))) {
    assert(finite(section[key]) && section[key] >= 0, `Invalid ${name} ${key}`);
  }
  if (!section.passed) { errorText(section.error, `${name} error`); return; }
  count(section.samples, `${name} samples`);
  if (name === 'orbit') {
    count(section.steps, 'orbit steps');
    assert(section.steps === 10232 && section.maxSteps === 10232 && section.samples === Math.ceil(section.steps / 12), 'Incomplete orbit run');
    bounded(section.maxErrorKm, 10, 'orbit error');
    assert(section.lastTimeSeconds === section.steps * 300, 'Invalid orbital time');
  } else {
    assert(section.samples === 100, 'Incomplete thermal run');
    bounded(section.maxTemperatureKelvin, 0.05, 'temperature error');
    bounded(section.maxLiquidFraction, 0.002, 'liquid fraction error');
    bounded(section.normalizedEnergy, 0.0001, 'normalized energy error');
  }
}

function validateSubmission({ encoded, commitSha, platform, provider }) {
  assert(typeof commitSha === 'string' && /^[0-9a-f]{40}$/.test(commitSha), 'Invalid commit SHA');
  assert(Object.hasOwn(platforms, platform), 'Invalid platform');
  assert(typeof provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(provider) && !containsIp(provider), 'Invalid provider');
  assert(typeof encoded === 'string' && encoded.length <= Math.ceil(MAX_REPORT_BYTES / 3) * 4 && encoded.length > 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), 'Invalid or oversized base64 report');
  const bytes = Buffer.from(encoded, 'base64');
  assert(bytes.length <= MAX_REPORT_BYTES && bytes.toString('base64') === encoded, 'Invalid or oversized report');
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Report must be valid UTF-8 JSON'); }
  assert(object(input) && input.commitSha === commitSha && ['hardware-report', 'infrastructure-failure'].includes(input.kind), 'Commit SHA or report kind does not match');
  keys(input, ['commitSha', 'kind', 'report', 'redacted'], 'submission');
  if (input.redacted !== undefined) assert(typeof input.redacted === 'boolean', 'Invalid redaction marker');
  const report = input.report;
  assert(object(report) && typeof report.passed === 'boolean' && report.platform === platforms[platform], 'Report platform or status does not match');
  keys(report, ['passed', 'adapter', 'orbit', 'thermal', 'error', 'platform', 'architecture', 'osRelease', 'electron', 'chromium'], 'report');
  for (const key of ['architecture', 'osRelease', 'electron', 'chromium']) string(report[key], key);
  if (input.kind === 'infrastructure-failure') assert(report.passed === false, 'Infrastructure failure cannot pass');
  if (report.adapter !== undefined) { string(report.adapter, 'adapter'); assert(!containsIp(report.adapter), 'Invalid adapter'); }
  if (report.orbit !== undefined) validateSection(report.orbit, 'orbit');
  if (report.thermal !== undefined) validateSection(report.thermal, 'thermal');
  if (report.passed) {
    assert(input.kind === 'hardware-report' && report.adapter && report.orbit?.passed === true && report.thermal?.passed === true,
      'Passing report requires adapter and both completed tests');
    assert(!/swiftshader|llvmpipe|lavapipe|software|microsoft basic/i.test(report.adapter), 'Software adapter cannot pass');
  } else {
    const hasSectionFailure = report.orbit?.passed === false || report.thermal?.passed === false;
    assert(typeof report.error === 'string' || hasSectionFailure, 'Failed report must identify an error');
    if (report.error !== undefined) errorText(report.error, 'error');
  }
  return { bytes, submission: input, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function main() {
  const commitSha = process.env.INPUT_COMMIT_SHA;
  const platform = process.env.INPUT_PLATFORM;
  const provider = process.env.INPUT_PROVIDER;
  const validated = validateSubmission({ encoded: process.env.INPUT_REPORT_BASE64, commitSha, platform, provider });
  const directory = path.join(process.cwd(), 'gpu-report-artifact');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.json'), validated.bytes);
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({
    format: 'europa-gpu-report-v1', provenance: 'self-reported-unverified',
    note: 'The report and commit association are user supplied and not independently authenticated.',
    receivedAtUtc: new Date().toISOString(), commitSha, platform, provider,
    kind: validated.submission.kind, passed: validated.submission.report.passed,
    redacted: validated.submission.redacted === true,
    reportSha256: validated.digest,
  }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const outcome = validated.submission.report.passed ? 'pass' : 'failure';
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Self-reported, unverified GPU result\n\nThe submitted report claims **${outcome}**. A successful upload does not verify the test, device, or source commit.\n`);
  }
  console.log('Structurally valid self-reported, unverified GPU report prepared for artifact upload.');
}

module.exports = { MAX_REPORT_BYTES, validateSubmission };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Invalid GPU report'); process.exitCode = 1; }
}
