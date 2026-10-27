import { describe, expect, it } from 'vitest';
import { createInitialOrbit, orbitDiagnostics, stepOrbit, type OrbitState } from '../src/simulation/orbit';

const mag = (v: number[]) => Math.hypot(...v);

describe('four-body orbit', () => {
  it('loads same-epoch initial conditions and finite elements', () => {
    const state = createInitialOrbit();
    const d = orbitDiagnostics(state);
    expect(state.bodies.map(b => b.name)).toEqual(['Jupiter', 'Io', 'Europa', 'Ganymede']);
    expect(d.eccentricity).toBeGreaterThan(0);
    expect(d.eccentricity).toBeLessThan(0.03);
    expect(d.semiMajorAxisKm).toBeGreaterThan(650000);
    expect(d.semiMajorAxisKm).toBeLessThan(690000);
    expect(d.laplaceAngleDeg).toBeGreaterThanOrEqual(-180);
    expect(d.laplaceAngleDeg).toBeLessThanOrEqual(180);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(state.bodies.reduce((sum, b) => sum + b.gm * b.position[i], 0))).toBeLessThan(0.01);
      expect(Math.abs(state.bodies.reduce((sum, b) => sum + b.gm * b.velocity[i], 0))).toBeLessThan(1e-7);
    }
  });

  it('reconstructs an edited Europa ellipse and resets time', () => {
    const state = createInitialOrbit({ eccentricity: 0.03, semiMajorAxisKm: 700000 });
    const d = orbitDiagnostics(state);
    expect(d.eccentricity).toBeCloseTo(0.03, 10);
    expect(d.semiMajorAxisKm).toBeCloseTo(700000, 5);
    expect(state.timeSeconds).toBe(0);
    expect(() => createInitialOrbit({ eccentricity: 1 })).toThrow();
    expect(() => createInitialOrbit({ semiMajorAxisKm: 0 })).toThrow();
  });

  it('has a continuous resonance angle as an inclined Europa orbit becomes circular', () => {
    const circular = orbitDiagnostics(createInitialOrbit({ eccentricity: 0, semiMajorAxisKm: 671000 }));
    const nearlyCircular = orbitDiagnostics(createInitialOrbit({ eccentricity: 1e-7, semiMajorAxisKm: 671000 }));
    const delta = (circular.laplaceAngleDeg - nearlyCircular.laplaceAngleDeg) * Math.PI / 180;
    expect(Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)))).toBeLessThan(1e-5);
  });

  it('conserves energy and angular momentum over ten days at a fine timestep', () => {
    let state = createInitialOrbit();
    const initial = orbitDiagnostics(state);
    for (let i = 0; i < 1440; i++) state = stepOrbit(state, 600);
    const final = orbitDiagnostics(state);
    expect(Math.abs((final.energy - initial.energy) / initial.energy)).toBeLessThan(1e-6);
    expect(mag(final.angularMomentum.map((x, i) => x - initial.angularMomentum[i])) / mag(initial.angularMomentum)).toBeLessThan(1e-12);
  });

  it('improves with timestep refinement', () => {
    const run = (dt: number) => { let s = createInitialOrbit(); for (let t = 0; t < 86400; t += dt) s = stepOrbit(s, dt); return s.bodies[2].position; };
    const coarse = run(1200), fine = run(600), reference = run(150);
    expect(mag(fine.map((x, i) => x - reference[i]))).toBeLessThan(mag(coarse.map((x, i) => x - reference[i])) / 3);
  });

  it('reproduces a circular two-body orbit and is reversible', () => {
    const mu = 398600.436, radius = 7000, period = 2 * Math.PI * Math.sqrt(radius ** 3 / mu);
    const initial: OrbitState = { timeSeconds: 0, bodies: [
      { name: 'Jupiter', gm: mu, position: [0, 0, 0], velocity: [0, 0, 0] },
      { name: 'Europa', gm: 0, position: [radius, 0, 0], velocity: [0, Math.sqrt(mu / radius), 0] },
    ] };
    let state = initial;
    for (let i = 0; i < 4000; i++) state = stepOrbit(state, period / 4000);
    expect(mag(state.bodies[1].position.map((x, i) => x - initial.bodies[1].position[i]))).toBeLessThan(0.1);
    for (let i = 0; i < 4000; i++) state = stepOrbit(state, -period / 4000);
    expect(mag(state.bodies[1].position.map((x, i) => x - initial.bodies[1].position[i]))).toBeLessThan(1e-6);
  });
});
