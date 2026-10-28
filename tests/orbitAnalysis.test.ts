import { describe, expect, it } from 'vitest';
import { createInitialOrbit, stepOrbit } from '../src/simulation/orbit';
import { makeOrbitalBaseline, makeOrbitalSample, parseOrbitalBaseline, parseOrbitalSample } from '../src/simulation/orbitAnalysis';

describe('orbital analysis', () => {
  it('derives Jupiter-relative positions and finite conservation drifts', () => {
    const state = createInitialOrbit();
    const baseline = makeOrbitalBaseline(state, 'initial');
    const first = makeOrbitalSample(state, baseline);
    const jupiter = state.bodies.find(body => body.name === 'Jupiter')!;
    const europa = state.bodies.find(body => body.name === 'Europa')!;
    expect(first.positionsKm?.Europa).toEqual(europa.position.map((n, i) => n - jupiter.position[i]));
    expect(first.energyDrift).toBe(0);
    expect(first.angularMomentumDrift).toBe(0);
    const next = makeOrbitalSample(stepOrbit(state, 300), baseline);
    expect(next.energyDrift).toBeGreaterThanOrEqual(0);
    expect(next.energyDrift).toBeLessThan(1e-6);
    expect(next.angularMomentumDrift).toBeLessThan(1e-12);
  });
  it('rejects invalid baselines and malformed analysis fields', () => {
    const state = createInitialOrbit();
    const baseline = makeOrbitalBaseline(state, 'initial');
    const sample = makeOrbitalSample(state, baseline);
    expect(() => parseOrbitalBaseline({ ...baseline, energy: 0 }, 0)).toThrow();
    expect(() => parseOrbitalBaseline({ ...baseline, angularMomentum: [0, 0, 0] }, 0)).toThrow();
    expect(() => parseOrbitalSample({ ...sample, positionsKm: { ...sample.positionsKm, Io: [0, 1] } }, 0)).toThrow();
    expect(() => parseOrbitalSample({ ...sample, energyDrift: -1 }, 0)).toThrow();
    expect(parseOrbitalSample({ ...sample, extra: 1 }, 0)).toEqual(sample);
  });
});
