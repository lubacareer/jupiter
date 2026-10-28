import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialOrbit, orbitDiagnostics } from '../src/simulation/orbit';
import { checkpointDigest } from '../src/simulation/checkpointIntegrity';
import { createRequire } from 'node:module';

const { makeExport } = createRequire(import.meta.url)('../electron/files.cjs');
it('matches an independently known SHA-256 canonical JSON vector', () => {
  expect(checkpointDigest({ b: 2, a: 1 })).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
});
function legacyV2<T extends { version?: number; checksum?: unknown; model?: unknown }>(checkpoint: T) {
  const { checksum: _checksum, model: _model, ...payload } = checkpoint;
  return { ...payload, version: 2 };
}

type Message = { type: string; [key: string]: unknown };
describe('simulation process', () => {
  let receive: (event: { data: Message }) => void;
  let sent: Message[];
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    sent = [];
    Object.defineProperty(process, 'parentPort', { configurable: true, value: {
      on: (_name: string, callback: typeof receive) => { receive = event => callback(structuredClone(event)); },
      postMessage: (message: Message) => sent.push(structuredClone(message)),
    } });
    await import('../src/simulation/worker');
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (process as unknown as { parentPort?: unknown }).parentPort;
  });
  it('runs, pauses, saves and restores a checkpoint without advancing while paused', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.01, semiMajorAxisKm: 671000 } } });
    vi.advanceTimersByTime(300);
    receive({ data: { type: 'pause' } });
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as { state: { timeSeconds: number }; samples: unknown[] };
    expect(saved.state.timeSeconds).toBe(10800);
    expect(saved.samples).toHaveLength(4);
    vi.advanceTimersByTime(500);
    receive({ data: { type: 'getCheckpoint' } });
    expect((sent.at(-1)?.checkpoint as typeof saved).state.timeSeconds).toBe(saved.state.timeSeconds);
    receive({ data: { type: 'reset' } });
    receive({ data: { type: 'load', checkpoint: saved } });
    const snapshot = sent.at(-1)?.snapshot as { status: string; timeSeconds: number };
    expect(snapshot.status).toBe('paused');
    expect(snapshot.timeSeconds).toBe(saved.state.timeSeconds);
    receive({ data: { type: 'pause' } });
    vi.advanceTimersByTime(100);
    receive({ data: { type: 'getCheckpoint' } });
    expect((sent.at(-1)?.checkpoint as typeof saved).state.timeSeconds).toBe(saved.state.timeSeconds + 3600);
  });
  it('rejects invalid starts and checkpoints without corrupting the existing state', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.01, semiMajorAxisKm: 671000 } } });
    receive({ data: { type: 'pause' } });
    receive({ data: { type: 'start', parameters: { eccentricity: 2, semiMajorAxisKm: 671000 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as { parameters: { eccentricity: number }; state: { timeSeconds: number } };
    expect(saved.parameters.eccentricity).toBe(0.01);
    receive({ data: { type: 'load', checkpoint: { version: 1 } } });
    receive({ data: { type: 'getCheckpoint' } });
    expect(sent.at(-1)?.checkpoint).toEqual(saved);
  });
  it('uses the exact epoch state without overrides and preserves omitted elements for a single-field edit', () => {
    receive({ data: { type: 'start', parameters: {} } });
    receive({ data: { type: 'getCheckpoint' } });
    const original = sent.at(-1)?.checkpoint as { version: number; state: ReturnType<typeof createInitialOrbit>; parameters: { eccentricity: number; semiMajorAxisKm: number }; initialOverrides: Record<string, number>; provenance: string };
    expect(original.version).toBe(4);
    expect(original.state).toEqual(createInitialOrbit());
    expect(original.initialOverrides).toEqual({});
    expect(original.provenance).toBe('local');
    const epoch = orbitDiagnostics(createInitialOrbit());
    expect(original.parameters).toEqual({ eccentricity: epoch.eccentricity, semiMajorAxisKm: epoch.semiMajorAxisKm });
    receive({ data: { type: 'start', parameters: { eccentricity: 0.03 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const edited = sent.at(-1)?.checkpoint as typeof original;
    expect(edited.initialOverrides).toEqual({ eccentricity: 0.03 });
    expect(edited.parameters.semiMajorAxisKm).toBe(epoch.semiMajorAxisKm);
    expect(edited.state).toEqual(createInitialOrbit({ eccentricity: 0.03 }));
    receive({ data: { type: 'start', parameters: { semiMajorAxisKm: 700000 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const editedAxis = sent.at(-1)?.checkpoint as typeof original;
    expect(editedAxis.parameters.eccentricity).toBe(epoch.eccentricity);
    expect(editedAxis.state).toEqual(createInitialOrbit({ semiMajorAxisKm: 700000 }));
  });
  it('restores v1 data as unverified and emits one load revision, preserving values beyond UI defaults', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.2, semiMajorAxisKm: 900000 } } });
    vi.advanceTimersByTime(200);
    receive({ data: { type: 'pause' } });
    receive({ data: { type: 'getCheckpoint' } });
    const latest = sent.at(-1)?.checkpoint as { state: unknown; parameters: { eccentricity: number; semiMajorAxisKm: number }; samples: unknown[] };
    const legacy = { version: 1, state: latest.state, parameters: latest.parameters, samples: latest.samples };
    receive({ data: { type: 'load', checkpoint: legacy } });
    const loaded = sent.at(-1)?.snapshot as { restoreRevision: number; restoredParameters: unknown; restoredOverrides: unknown; provenance: string; status: string };
    expect(loaded.status).toBe('paused');
    expect(loaded.restoreRevision).toBe(1);
    expect(loaded.restoredParameters).toEqual({ eccentricity: 0.2, semiMajorAxisKm: 900000 });
    expect(loaded.restoredOverrides).toEqual(loaded.restoredParameters);
    expect(loaded.provenance).toBe('imported-unverified');
    receive({ data: { type: 'getExport' } });
    const output = sent.at(-1)?.checkpoint as { version: number; provenance: string; initialOverrides: unknown };
    expect(output.version).toBe(4);
    expect(output.provenance).toBe('imported-unverified');
    expect(output.initialOverrides).toEqual(loaded.restoredParameters);
    receive({ data: { type: 'pause' } });
    vi.advanceTimersByTime(100);
    expect((sent.at(-1)?.snapshot as typeof loaded).restoreRevision).toBe(1);
    receive({ data: { type: 'pause' } });
    receive({ data: { type: 'load', checkpoint: legacy } });
    expect((sent.at(-1)?.snapshot as typeof loaded).restoreRevision).toBe(2);
  });
  it('normalizes extra checkpoint parameter fields so a legacy file can restart and round-trip', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.02 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const original = sent.at(-1)?.checkpoint as {
      version: number; state: unknown; samples: unknown[];
      parameters: { eccentricity: number; semiMajorAxisKm: number }; initialOverrides: unknown;
    };
    const legacy = { version: 1, state: original.state, samples: original.samples, parameters: { ...original.parameters, extra: 'legacy metadata' } };
    receive({ data: { type: 'load', checkpoint: legacy } });
    const loaded = sent.at(-1)?.snapshot as { status: string; provenance: string; restoredParameters: unknown; restoredOverrides: unknown };
    expect(loaded.status).toBe('paused');
    expect(loaded.provenance).toBe('imported-unverified');
    expect(loaded.restoredParameters).toEqual(original.parameters);
    expect(loaded.restoredOverrides).toEqual({ eccentricity: 0.02 });
    receive({ data: { type: 'getCheckpoint' } });
    const normalized = sent.at(-1)?.checkpoint as { version: number; parameters: unknown; initialOverrides: unknown };
    expect(normalized.version).toBe(4);
    expect(normalized.parameters).toEqual(original.parameters);
    expect(normalized.initialOverrides).toEqual({ eccentricity: 0.02 });
    receive({ data: { type: 'load', checkpoint: { ...legacyV2(normalized), parameters: { ...original.parameters, extra: true } } } });
    const reloaded = sent.at(-1)?.snapshot as typeof loaded;
    expect(reloaded.status).toBe('paused');
    expect(reloaded.restoredParameters).toEqual(original.parameters);
    expect(reloaded.provenance).toBe('imported-unverified');
    receive({ data: { type: 'getCheckpoint' } });
    expect((sent.at(-1)?.checkpoint as typeof normalized).parameters).toEqual(original.parameters);
    receive({ data: { type: 'start', parameters: reloaded.restoredOverrides } });
    expect((sent.at(-1)?.snapshot as typeof loaded).status).toBe('running');
    receive({ data: { type: 'getCheckpoint' } });
    const afterRestart = sent.at(-1)?.checkpoint;
    receive({ data: { type: 'load', checkpoint: afterRestart } });
    const restoredAgain = sent.at(-1)?.snapshot as typeof loaded;
    expect(restoredAgain.status).toBe('paused');
    expect(restoredAgain.provenance).toBe('imported-unverified');
    expect(restoredAgain.restoredOverrides).toEqual({ eccentricity: 0.02 });
  });
  it.each([1, 2, 3, 4])('discards unknown state, body and sample fields from v%i imports', (version) => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.02 } } });
    vi.advanceTimersByTime(100);
    receive({ data: { type: 'getCheckpoint' } });
    const original = sent.at(-1)?.checkpoint as any;
    const incoming = structuredClone(version === 1
      ? { version: 1, state: original.state, parameters: original.parameters, samples: original.samples }
      : version === 2 ? legacyV2(original) : version === 3 ? { ...original, version: 3 } : original);
    incoming.state.extra = 'unknown state field';
    for (const body of incoming.state.bodies) body.extra = 'unknown body field';
    for (const sample of incoming.samples) sample.extra = 'unknown sample field';
    if (version === 3 || version === 4) {
      const { checksum: _checksum, ...payload } = incoming;
      incoming.checksum.digest = checkpointDigest(payload);
    }

    receive({ data: { type: 'load', checkpoint: incoming } });
    expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: version >= 3 ? 'verified' : 'unavailable' });
    receive({ data: { type: 'getCheckpoint' } });
    const normalized = sent.at(-1)?.checkpoint as any;
    expect(normalized.state).toEqual(original.state);
    expect(normalized.samples.map(({ timeSeconds, eccentricity, semiMajorAxisKm, resonanceAngleDeg }: any) => ({ timeSeconds, eccentricity, semiMajorAxisKm, resonanceAngleDeg }))).toEqual(
      original.samples.map(({ timeSeconds, eccentricity, semiMajorAxisKm, resonanceAngleDeg }: any) => ({ timeSeconds, eccentricity, semiMajorAxisKm, resonanceAngleDeg })));
    if (version < 4) {
      expect(normalized.samples[0].positionsKm).toBeUndefined();
      expect(normalized.samples.at(-1).energyDrift).toBe(0);
      expect(normalized.baseline.kind).toBe('restored');
    } else expect(normalized.samples).toEqual(original.samples);
    expect(normalized.provenance).toBe('imported-unverified');
    const { checksum, ...payload } = normalized;
    expect(checksum).toEqual({ algorithm: 'sha256', digest: checkpointDigest(payload) });
    receive({ data: { type: 'getExport' } });
    const exported = makeExport(sent.at(-1)?.checkpoint);
    expect(exported.state).toEqual(original.state);
    expect(exported.samples).toEqual(normalized.samples);
    expect(exported.provenance).toBe('imported-unverified');
    receive({ data: { type: 'load', checkpoint: normalized } });
    expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'verified' });
  });
  it('infers version-1 overrides only for values differing exactly from the epoch defaults', () => {
    const epoch = orbitDiagnostics(createInitialOrbit());
    const cases = [
      {},
      { eccentricity: 0.02 },
      { semiMajorAxisKm: 700000 },
      { eccentricity: epoch.eccentricity + 1e-12, semiMajorAxisKm: epoch.semiMajorAxisKm + 1e-6 },
      // These are the earlier UI defaults, which differ from the exact epoch.
      { eccentricity: 0.0094, semiMajorAxisKm: 671000 },
    ];
    for (const expectedOverrides of cases) {
      receive({ data: { type: 'start', parameters: expectedOverrides } });
      receive({ data: { type: 'getCheckpoint' } });
      const original = sent.at(-1)?.checkpoint as {
        state: ReturnType<typeof createInitialOrbit>;
        parameters: { eccentricity: number; semiMajorAxisKm: number };
        samples: unknown[];
      };
      const legacy = { version: 1, state: original.state, parameters: original.parameters, samples: original.samples };
      receive({ data: { type: 'load', checkpoint: legacy } });
      const loaded = sent.at(-1)?.snapshot as { status: string; restoredParameters: unknown; restoredOverrides: unknown; provenance: string; checksumStatus: string };
      expect(loaded).toMatchObject({ status: 'paused', restoredParameters: original.parameters, restoredOverrides: expectedOverrides, provenance: 'imported-unverified', checksumStatus: 'unavailable' });
      receive({ data: { type: 'getCheckpoint' } });
      const migrated = sent.at(-1)?.checkpoint as { version: number; initialOverrides: unknown };
      expect(migrated.version).toBe(4);
      expect(migrated.initialOverrides).toEqual(expectedOverrides);
      receive({ data: { type: 'load', checkpoint: migrated } });
      expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused', restoredOverrides: expectedOverrides, provenance: 'imported-unverified', checksumStatus: 'verified' });
      receive({ data: { type: 'start', parameters: loaded.restoredOverrides } });
      receive({ data: { type: 'getCheckpoint' } });
      expect((sent.at(-1)?.checkpoint as { state: unknown }).state).toEqual(createInitialOrbit(expectedOverrides));
    }
  });
  it('preserves the active run after invalid checkpoints and reports persistent errors', () => {
    receive({ data: { type: 'start', parameters: {} } });
    vi.advanceTimersByTime(100);
    receive({ data: { type: 'getCheckpoint' } });
    const saved = legacyV2(sent.at(-1)?.checkpoint as { version: number; state: { timeSeconds: number; bodies: Array<{ gm: number }> }; samples: Array<{ eccentricity: number }> });
    const badGM = structuredClone(saved);
    badGM.state.bodies[0].gm += 1;
    receive({ data: { type: 'load', checkpoint: badGM } });
    const error = sent.at(-1)?.snapshot as { status: string; timeSeconds: number; message: string };
    expect(error.status).toBe('running');
    expect(error.message).toMatch(/model constants/);
    vi.advanceTimersByTime(100);
    const next = sent.at(-1)?.snapshot as typeof error;
    expect(next.status).toBe('running');
    expect(next.timeSeconds).toBe(error.timeSeconds + 3600);
    expect(next.message).toMatch(/model constants/);
    const badSample = structuredClone(saved);
    badSample.samples.at(-1)!.eccentricity += 0.1;
    receive({ data: { type: 'load', checkpoint: badSample } });
    expect((sent.at(-1)?.snapshot as typeof error).message).toMatch(/does not match/);
    expect((sent.at(-1)?.snapshot as typeof error).status).toBe('running');
  });
  it('reports errors without a loaded state and preserves paused status on invalid commands', () => {
    receive({ data: { type: 'load', checkpoint: { version: 1 } } });
    const idleError = sent.at(-1)?.snapshot as { status: string; message: string };
    expect(idleError.status).toBe('error');
    expect(idleError.message).toMatch(/Invalid or unsupported checkpoint/);
    receive({ data: { type: 'start', parameters: {} } });
    receive({ data: { type: 'pause' } });
    receive({ data: { type: 'load', checkpoint: { version: 1 } } });
    const pausedError = sent.at(-1)?.snapshot as { status: string; message: string };
    expect(pausedError.status).toBe('paused');
    expect(pausedError.message).toMatch(/Invalid or unsupported checkpoint/);
  });
  it('keeps original v2 override provenance when loading and flags the data unverified', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.03 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const saved = legacyV2(sent.at(-1)?.checkpoint as { version: number });
    receive({ data: { type: 'load', checkpoint: saved } });
    const snapshot = sent.at(-1)?.snapshot as { restoredOverrides: unknown; provenance: string };
    expect(snapshot.restoredOverrides).toEqual({ eccentricity: 0.03 });
    expect(snapshot.provenance).toBe('imported-unverified');
  });
  it('accepts equivalent resonance angles across the -180/180 degree boundary', () => {
    receive({ data: { type: 'start', parameters: {} } });
    receive({ data: { type: 'getCheckpoint' } });
    const saved = structuredClone(sent.at(-1)?.checkpoint) as {
      version: number;
      state: ReturnType<typeof createInitialOrbit>;
      samples: Array<{ eccentricity: number; semiMajorAxisKm: number; resonanceAngleDeg: number }>;
    };
    const jupiter = saved.state.bodies.find(body => body.name === 'Jupiter')!;
    const ganymede = saved.state.bodies.find(body => body.name === 'Ganymede')!;
    const original = orbitDiagnostics(saved.state).laplaceAngleDeg;
    const deltaDegrees = (((180 - 1e-9 - original + 180) % 360) + 360) % 360 - 180;
    const rotation = deltaDegrees * Math.PI / 360;
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    for (const field of ['position', 'velocity'] as const) {
      const x = ganymede[field][0] - jupiter[field][0];
      const y = ganymede[field][1] - jupiter[field][1];
      ganymede[field][0] = jupiter[field][0] + x * cos - y * sin;
      ganymede[field][1] = jupiter[field][1] + x * sin + y * cos;
    }
    const diagnostic = orbitDiagnostics(saved.state);
    expect(diagnostic.laplaceAngleDeg).toBeGreaterThan(179.9999999);
    saved.samples[0].eccentricity = diagnostic.eccentricity;
    saved.samples[0].semiMajorAxisKm = diagnostic.semiMajorAxisKm;
    saved.samples[0].resonanceAngleDeg = -180;
    receive({ data: { type: 'load', checkpoint: legacyV2(saved) } });
    const snapshot = sent.at(-1)?.snapshot as { status: string; provenance: string };
    expect(snapshot.status).toBe('paused');
    expect(snapshot.provenance).toBe('imported-unverified');
  });
  it('verifies v3 checksums after JSON formatting and key order changes, then rechecks a re-saved import', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.02 } } });
    vi.advanceTimersByTime(100);
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as Record<string, unknown>;
    const { checksum, ...payload } = saved;
    expect(checksum).toEqual({ algorithm: 'sha256', digest: checkpointDigest(payload) });
    const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeys(entry)])) : value;
    const reformatted = JSON.parse(JSON.stringify(reverseKeys(saved), null, 4));
    receive({ data: { type: 'load', checkpoint: reformatted } });
    const loaded = sent.at(-1)?.snapshot as { status: string; provenance: string; checksumStatus: string };
    expect(loaded).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'verified' });
    receive({ data: { type: 'getCheckpoint' } });
    const resaved = sent.at(-1)?.checkpoint as Record<string, unknown>;
    const { checksum: nextChecksum, ...nextPayload } = resaved;
    expect(nextChecksum).toEqual({ algorithm: 'sha256', digest: checkpointDigest(nextPayload) });
    expect(nextChecksum).not.toEqual(checksum); // provenance changed on import
    receive({ data: { type: 'load', checkpoint: JSON.parse(JSON.stringify(resaved)) } });
    expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'verified' });
  });
  it('rejects checksum corruption across the full v3 payload without interrupting the current run', () => {
    receive({ data: { type: 'start', parameters: {} } });
    vi.advanceTimersByTime(200);
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as any;
    const mutations: Array<(value: any) => void> = [
      value => { value.state.bodies[2].position[0] += 1; },
      value => { value.samples[0].eccentricity += 0.001; },
      value => { value.parameters.eccentricity += 0.001; },
      value => { value.model.epoch = 'different epoch'; },
      value => { value.model.solver = 'different solver'; },
      value => { value.checksum.digest = '0'.repeat(64); },
      value => { delete value.checksum; },
      value => { value.extra = 'not covered by the original checksum'; },
    ];
    for (const mutate of mutations) {
      const corrupted = structuredClone(saved);
      mutate(corrupted);
      receive({ data: { type: 'load', checkpoint: corrupted } });
      expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'running', timeSeconds: saved.state.timeSeconds, provenance: 'local' });
      expect((sent.at(-1)?.snapshot as { message: string }).message).toMatch(/checksum/i);
    }
    // Recomputing the public digest cannot make an unsupported model acceptable.
    const wrongModel = structuredClone(saved);
    wrongModel.model.solver = 'different solver';
    const { checksum: _checksum, ...payload } = wrongModel;
    wrongModel.checksum.digest = checkpointDigest(payload);
    receive({ data: { type: 'load', checkpoint: wrongModel } });
    expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'running', timeSeconds: saved.state.timeSeconds });
    expect((sent.at(-1)?.snapshot as { message: string }).message).toMatch(/model metadata/);
    vi.advanceTimersByTime(100);
    expect((sent.at(-1)?.snapshot as { timeSeconds: number }).timeSeconds).toBe(saved.state.timeSeconds + 3600);
  });
  it('continues to mark imported data unverified when an edited file has a recomputed checksum', () => {
    receive({ data: { type: 'start', parameters: {} } });
    vi.advanceTimersByTime(200);
    receive({ data: { type: 'getCheckpoint' } });
    const edited = sent.at(-1)?.checkpoint as any;
    edited.samples[0].eccentricity += 0.001;
    const { checksum: _checksum, ...payload } = edited;
    edited.checksum.digest = checkpointDigest(payload);
    receive({ data: { type: 'load', checkpoint: edited } });
    expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'verified' });
  });
  it('loads both legacy formats and exports without misrepresenting a checkpoint digest as export integrity', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.02 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const fresh = sent.at(-1)?.checkpoint as { version: number; state: unknown; parameters: unknown; samples: unknown[] };
    const v2 = legacyV2(fresh);
    const v1 = { version: 1, state: fresh.state, parameters: fresh.parameters, samples: fresh.samples };
    for (const legacy of [v1, v2]) {
      receive({ data: { type: 'load', checkpoint: legacy } });
      expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'unavailable' });
    }
    receive({ data: { type: 'getExport' } });
    const exported = makeExport(sent.at(-1)?.checkpoint);
    expect(exported.checksum).toBeUndefined();
    expect(exported.schema).toBe('europa-orbit-export-v3');
    expect(exported.units.positionsKm).toBe('km');
    expect(exported.units.energyDrift).toBe('dimensionless');
    expect(exported.baseline.kind).toBe('restored');
    expect(exported.provenance).toBe('imported-unverified');
    receive({ data: { type: 'load', checkpoint: exported } });
    expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'unavailable' });
  });
  it('rejects inconsistent v4 analysis after checksum recomputation without interrupting a running simulation', () => {
    receive({ data: { type: 'start', parameters: {} } });
    vi.advanceTimersByTime(200);
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as any;
    const changes: Array<(data: any) => void> = [
      data => { data.baseline.energy = 0; },
      data => { data.baseline.angularMomentum = [0, 0, 0]; },
      data => { data.samples.at(-1).positionsKm.Europa[0] += 100; },
      data => { data.samples.at(-1).energyDrift = -1; },
      data => { data.samples.at(-1).energyDrift = 1; },
    ];
    for (const change of changes) {
      const modified = structuredClone(saved);
      change(modified);
      const { checksum: _checksum, ...payload } = modified;
      modified.checksum.digest = checkpointDigest(payload);
      receive({ data: { type: 'load', checkpoint: modified } });
      expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'running', timeSeconds: saved.state.timeSeconds });
      expect((sent.at(-1)?.snapshot as { message: string }).message).toMatch(/baseline|analysis/);
    }
    vi.advanceTimersByTime(100);
    expect((sent.at(-1)?.snapshot as { timeSeconds: number }).timeSeconds).toBe(saved.state.timeSeconds + 3600);
  });
  it('retains at most 2,000 analysis samples while keeping the initial baseline', () => {
    receive({ data: { type: 'start', parameters: {} } });
    vi.advanceTimersByTime(100);
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as any;
    const { timeSeconds: _time, positionsKm: _positions, energyDrift: _energy, angularMomentumDrift: _momentum, ...core } = saved.samples[0];
    saved.samples = [...Array.from({ length: 1999 }, (_, i) => ({ ...core, timeSeconds: i })), saved.samples.at(-1)];
    const { checksum: _checksum, ...payload } = saved;
    saved.checksum.digest = checkpointDigest(payload);
    receive({ data: { type: 'load', checkpoint: saved } });
    expect(sent.at(-1)?.snapshot).toMatchObject({ status: 'paused' });
    receive({ data: { type: 'pause' } });
    vi.advanceTimersByTime(100);
    receive({ data: { type: 'getCheckpoint' } });
    const advanced = sent.at(-1)?.checkpoint as any;
    expect(advanced.samples).toHaveLength(2000);
    expect(advanced.samples[0].timeSeconds).toBe(1);
    expect(advanced.samples.at(-1)?.positionsKm).toBeDefined();
    expect(advanced.baseline).toMatchObject({ timeSeconds: 0, kind: 'initial' });
  });
  it('publishes current controls for remount after a new start, and clears them on reset', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.02 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const old = sent.at(-1)?.checkpoint;
    receive({ data: { type: 'load', checkpoint: old } });
    const loaded = sent.at(-1)?.snapshot as { restoreRevision: number };
    receive({ data: { type: 'start', parameters: { semiMajorAxisKm: 700000 } } });
    const started = sent.at(-1)?.snapshot as { restoreRevision: number; restoredParameters: { eccentricity: number; semiMajorAxisKm: number }; restoredOverrides: Record<string, number> };
    expect(started.restoreRevision).toBe(loaded.restoreRevision);
    expect(started.restoredParameters.eccentricity).toBe(orbitDiagnostics(createInitialOrbit()).eccentricity);
    expect(started.restoredParameters.semiMajorAxisKm).toBe(700000);
    expect(started.restoredOverrides).toEqual({ semiMajorAxisKm: 700000 });
    receive({ data: { type: 'reset' } });
    const reset = sent.at(-1)?.snapshot as { restoredParameters?: unknown; restoredOverrides?: unknown; restoreRevision: number };
    expect(reset.restoreRevision).toBe(loaded.restoreRevision);
    expect(reset.restoredParameters).toBeUndefined();
    expect(reset.restoredOverrides).toBeUndefined();
  });
});
