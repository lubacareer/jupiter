import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { MAX_REPORT_BYTES, validateSubmission } = require('../scripts/gpu-report-ingest.cjs');
const { makeSubmission } = require('../scripts/run-cloud-gpu.cjs');
const sha = 'a'.repeat(40);
const info = { platform: 'linux', architecture: 'x64', osRelease: '6.8', electron: '39.8.10', chromium: '142.0.7444.265' };
const pass = { ...info, passed: true, adapter: 'nvidia / test',
  orbit: { passed: true, samples: 853, steps: 10232, maxSteps: 10232, maxErrorKm: 0.7, lastTimeSeconds: 3069600 },
  thermal: { passed: true, samples: 100, maxTemperatureKelvin: 0.001, maxLiquidFraction: 0.0001, normalizedEnergy: 0.00001 } };
const encode = (submission: unknown) => Buffer.from(JSON.stringify(submission)).toString('base64');
const validate = (submission: unknown, extra: Record<string, string> = {}) => validateSubmission({
  encoded: encode(submission), commitSha: sha, platform: 'Linux', provider: 'Scaleway L4', ...extra,
});

describe('self-reported GPU evidence', () => {
  it('accepts a complete pass and preserves unverified content and digest', () => {
    const input = { commitSha: sha, kind: 'hardware-report', report: pass };
    const result = validate(input);
    expect(result.submission).toEqual(input);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(result.bytes.toString('utf8'))).toEqual(input);
  });

  it('retains device failures and pre-hardware infrastructure failures', () => {
    const deviceFailure = { commitSha: sha, kind: 'hardware-report', report: { ...info, passed: false, error: 'No WebGPU adapter is available' } };
    expect(validate(deviceFailure).submission.report.passed).toBe(false);
    const infrastructure = makeSubmission(sha, undefined, 'package', info);
    expect(infrastructure.kind).toBe('infrastructure-failure');
    expect(infrastructure.report.error).toMatch(/No GPU pass/);
    expect(validate(infrastructure).submission).toEqual(infrastructure);
    const hardwareFailure = makeSubmission(sha, deviceFailure.report, 'hardware', info);
    expect(hardwareFailure.kind).toBe('hardware-report');
    expect(validate(hardwareFailure).submission).toEqual(hardwareFailure);
    const multiline = makeSubmission(sha, { ...info, passed: false, error: `shader error\n${'x'.repeat(5000)}\n192.168.1.4` }, 'hardware', info);
    expect(multiline.redacted).toBe(true);
    expect(multiline.report.error).toContain('shader error\n');
    expect(multiline.report.error).not.toContain('192.168.1.4');
    expect(validate(multiline).submission.report.passed).toBe(false);
  });

  it('rejects malformed, oversized, mismatched, or misleading reports', () => {
    const good = { commitSha: sha, kind: 'hardware-report', report: pass };
    expect(() => validateSubmission({ encoded: 'not-base64!', commitSha: sha, platform: 'Linux', provider: 'x' })).toThrow();
    expect(() => validateSubmission({ encoded: Buffer.alloc(MAX_REPORT_BYTES + 1).toString('base64'), commitSha: sha, platform: 'Linux', provider: 'x' })).toThrow(/oversized/);
    expect(() => validate({ ...good, commitSha: 'b'.repeat(40) })).toThrow(/commit/i);
    expect(() => validate(good, { platform: 'macOS' })).toThrow(/platform/i);
    expect(() => validate(good, { provider: 'bad\ncommand' })).toThrow(/provider/i);
    expect(() => validate({ ...good, report: { ...pass, orbit: { ...pass.orbit, maxErrorKm: 10.01 } } })).toThrow(/orbit error/i);
    expect(() => validate({ ...good, report: { ...pass, orbit: { ...pass.orbit, steps: 1, maxSteps: 1, samples: 1, lastTimeSeconds: 300 } } })).toThrow(/incomplete orbit/i);
    expect(() => validate({ ...good, report: { ...pass, orbit: { ...pass.orbit, lastTimeSeconds: 300 } } })).toThrow(/orbital time/i);
    expect(() => validate({ ...good, report: { ...pass, thermal: { ...pass.thermal, samples: 99 } } })).toThrow(/thermal/i);
    expect(() => validate({ ...good, report: { ...pass, adapter: 'SwiftShader' } })).toThrow(/software/i);
    expect(() => validate({ ...good, report: { ...pass, passed: false } })).toThrow(/error/i);
    expect(() => validate({ ...good, kind: 'infrastructure-failure' })).toThrow(/cannot pass/i);
    expect(() => validate({ ...good, report: { ...pass, orbit: { ...pass.orbit, maxErrorKm: Number.POSITIVE_INFINITY } } })).toThrow();
    expect(() => validate(good, { provider: '192.168.10.1' })).toThrow(/provider/i);
    expect(() => validate({ commitSha: sha, kind: 'hardware-report', report: { ...info, passed: false, error: 'GPU failed at 192.168.1.4' } })).toThrow(/error/i);
  });

  it('uses GitHub-hosted runners without publishing secrets and retains artifacts for 90 days', () => {
    const yaml = require('js-yaml').load(readFileSync('.github/workflows/gpu-report-ingest.yml', 'utf8'));
    expect(yaml.jobs.ingest['runs-on']).toBe('ubuntu-latest');
    expect(yaml.jobs.ingest.if).toContain("github.ref == 'refs/heads/main'");
    expect(JSON.stringify(yaml)).not.toMatch(/self-hosted|DOCKERHUB_TOKEN/);
    const upload = yaml.jobs.ingest.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.with['retention-days']).toBe(90);
    expect(upload.with.name).toContain('self-reported-unverified');
  });
});

describe('cloud validation source integrity', () => {
  it.each(['before start', 'after package'])('does not claim a GPU result when the source tree becomes dirty %s', (when) => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'europa-cloud-test-'));
    const repository = path.join(parent, 'repo'), binaries = path.join(parent, 'bin');
    mkdirSync(repository); mkdirSync(binaries);
    const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'europa-test@example.invalid']);
      git(['config', 'user.name', 'Europa Test']);
      writeFileSync(path.join(repository, '.gitignore'), 'gpu-validation-report.json\ngpu-report-submission.json\ngpu-report-submission.txt\n');
      writeFileSync(path.join(repository, 'tracked.txt'), 'source');
      git(['add', '.']); git(['commit', '-q', '-m', 'fixture']);
      const commit = git(['rev-parse', 'HEAD']);
      if (when === 'before start') writeFileSync(path.join(repository, 'untracked.txt'), 'modified source');
      const windows = process.platform === 'win32';
      const npm = path.join(binaries, windows ? 'npm.cmd' : 'npm');
      const npx = path.join(binaries, windows ? 'npx.cmd' : 'npx');
      writeFileSync(npm, windows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
      writeFileSync(npx, windows ? '@echo off\r\necho changed > postbuild.txt\r\nexit /b 0\r\n' : '#!/bin/sh\nprintf changed > postbuild.txt\nexit 0\n');
      if (!windows) { chmodSync(npm, 0o755); chmodSync(npx, 0o755); }
      const result = spawnSync(process.execPath, [path.resolve('scripts/run-cloud-gpu.cjs'), commit], {
        cwd: repository, encoding: 'utf8', env: { ...process.env, PATH: `${binaries}${path.delimiter}${process.env.PATH || ''}` },
      });
      expect(result.status).toBe(1);
      const submission = JSON.parse(readFileSync(path.join(repository, 'gpu-report-submission.json'), 'utf8'));
      expect(submission.kind).toBe('infrastructure-failure');
      expect(submission.report.passed).toBe(false);
      expect(submission.report.error).toContain(when === 'before start' ? 'source-check' : 'post-build-source-check');
    } finally {
      if (!path.resolve(parent).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error('Unexpected test directory');
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('does not overwrite tracked validation outputs', () => {
    const repository = mkdtempSync(path.join(os.tmpdir(), 'europa-cloud-test-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'europa-test@example.invalid']);
      git(['config', 'user.name', 'Europa Test']);
      writeFileSync(path.join(repository, 'gpu-report-submission.json'), 'previous');
      git(['add', '.']); git(['commit', '-q', '-m', 'fixture']);
      const result = spawnSync(process.execPath, [path.resolve('scripts/run-cloud-gpu.cjs'), git(['rev-parse', 'HEAD'])], { cwd: repository, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/tracked/);
      expect(readFileSync(path.join(repository, 'gpu-report-submission.json'), 'utf8')).toBe('previous');
    } finally {
      if (!path.resolve(repository).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) throw new Error('Unexpected test directory');
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
