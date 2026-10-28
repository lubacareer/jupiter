import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInitialOrbit } from '../src/simulation/orbit';
import { makeOrbitalBaseline, makeOrbitalSample } from '../src/simulation/orbitAnalysis';
import { createGpuCheckpoint, exportGpuResult, parseGpuCheckpoint } from '../src/simulation/gpuCheckpoint';
import type { GpuWorkerCheckpoint } from '../src/simulation/gpuProtocol';

const canonical = (value: any): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};

function fixture(): Extract<GpuWorkerCheckpoint, { mode: 'orbit' }> {
  const state = createInitialOrbit(), baseline = makeOrbitalBaseline(state, 'initial');
  return { mode: 'orbit', data: { version: 1, initialState: state, reference: state, packedState: [], steps: 0, maxSteps: 1 },
    history: [{ timeSeconds: 0, error: 0 }], orbitAnalysisBaseline: baseline, orbitAnalysisSamples: [makeOrbitalSample(state, baseline)] };
}
const provenance = { origin: 'local', input: 'new', checksum: 'unavailable' } as const;

describe('GPU orbital analysis checkpoint formats', () => {
  it('round-trips version 5 analysis, exports its units, and detects tampering', async () => {
    const saved = await createGpuCheckpoint('orbit', fixture(), { description: 'test' }, provenance);
    expect(saved.version).toBe(5);
    const loaded = await parseGpuCheckpoint(JSON.parse(JSON.stringify(saved, null, 4)));
    expect(loaded.provenance.origin).toBe('unverified');
    expect(loaded.checkpoint.data).toEqual(saved.data);
    const exported = exportGpuResult('orbit', loaded.checkpoint.data, saved.adapter, loaded.provenance) as any;
    expect(exported.format).toBe('europa-gpu-export-v2');
    expect(exported.units).toMatchObject({ position: 'km', time: 's', resonanceAngleDeg: 'degrees', energyDrift: 'dimensionless', baselineEnergy: 'km^5/s^4', baselineAngularMomentum: 'km^5/s^3' });
    expect(exported.data.orbitAnalysisBaseline).toEqual(fixture().orbitAnalysisBaseline);
    expect(exported).not.toHaveProperty('checksum');
    const altered = structuredClone(saved);
    if (altered.data.mode === 'orbit') altered.data.orbitAnalysisSamples![0].positionsKm!.Europa[0] += 1;
    await expect(parseGpuCheckpoint(altered)).rejects.toThrow(/checksum mismatch/);
  });

  it('accepts version 4 and ignores extension fields only after checksum verification', async () => {
    const saved = await createGpuCheckpoint('orbit', fixture(), {}, provenance);
    const { checksum: _checksum, ...payload } = saved;
    payload.version = 4;
    const legacy = { ...payload, checksum: { algorithm: 'sha256', digest: createHash('sha256').update(canonical(payload)).digest('hex') } };
    const loaded = await parseGpuCheckpoint(legacy);
    expect(loaded.checkpoint.data.mode).toBe('orbit');
    if (loaded.checkpoint.data.mode === 'orbit') {
      expect(loaded.checkpoint.data.orbitAnalysisSamples).toBeUndefined();
      expect(loaded.checkpoint.data.orbitAnalysisBaseline).toBeUndefined();
    }
    expect(loaded.provenance.origin).toBe('unverified');
    legacy.data.history[0].error = 1;
    await expect(parseGpuCheckpoint(legacy)).rejects.toThrow(/checksum mismatch/);
  });
});
