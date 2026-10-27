import { describe, expect, it } from 'vitest';
import {
  createInteriorState, enthalpyFromPhase, interiorDiagnostics, maximumInteriorTimeStep,
  phaseFromEnthalpy, stepInterior,
  type InteriorGrid, type InteriorMaterial,
} from '../src/simulation/interior';

const material: InteriorMaterial = {
  density: 1, iceHeatCapacity: 1, waterHeatCapacity: 1,
  iceConductivity: 1, waterConductivity: 1, latentHeat: 10, meltingTemperature: 273,
};
const grid: InteriorGrid = { nx: 2, ny: 2, nz: 2, dx: 2, dy: 3, dz: 4 };

describe('3D enthalpy experiment', () => {
  it('converts cold ice, phase mixture and warm liquid reversibly', () => {
    for (const [temperature, fraction] of [[263, 0], [273, 0], [273, 0.4], [273, 1], [283, 1]]) {
      const phase = phaseFromEnthalpy(enthalpyFromPhase(temperature, fraction, material), material);
      expect(phase.temperature).toBeCloseTo(temperature, 10);
      expect(phase.liquidFraction).toBeCloseTo(fraction, 10);
    }
    expect(() => enthalpyFromPhase(280, 0.5, material)).toThrow();
  });

  it('melts isothermally using exactly the specified latent energy', () => {
    const one: InteriorGrid = { nx: 1, ny: 1, nz: 1, dx: 1, dy: 1, dz: 1 };
    let state = createInteriorState(one, material, 273);
    for (let i = 0; i < 10; i++) state = stepInterior(state, 0.1, { volumetricHeating: 10 });
    const result = phaseFromEnthalpy(state.enthalpy[0], material);
    expect(result.temperature).toBeCloseTo(273, 10);
    expect(result.liquidFraction).toBeCloseTo(1, 10);
    expect(interiorDiagnostics(state).energy).toBeCloseTo(10, 10);
  });

  it('conserves energy for closed-domain diffusion and smooths a temperature contrast', () => {
    const state = createInteriorState(grid, material, 260);
    state.enthalpy[0] = enthalpyFromPhase(270, 0, material);
    const before = interiorDiagnostics(state);
    const result = stepInterior(state, maximumInteriorTimeStep(grid, material) * 0.5);
    const after = interiorDiagnostics(result);
    expect(after.energy).toBeCloseTo(before.energy, 9);
    expect(after.maxTemperature).toBeLessThan(before.maxTemperature);
    expect(after.minTemperature).toBeGreaterThanOrEqual(before.minTemperature);
    expect(state.time).toBe(0);
  });

  it('accounts for volumetric heating and the sign of both boundary fluxes', () => {
    const state = createInteriorState(grid, material, 270);
    const dt = 0.25;
    const result = stepInterior(state, dt, { volumetricHeating: 0.5, topOutwardFlux: 2, bottomOutwardFlux: -0.5 });
    // Volume = 192 m^3; each exposed z face = 24 m^2. Net input = 60 W.
    const energyDifference = interiorDiagnostics(result).energy - interiorDiagnostics(state).energy;
    expect(energyDifference).toBeCloseTo(60 * dt, 9);
  });

  it('preserves a linear steady conductive profile with matching boundary fluxes', () => {
    const column = { nx: 1, ny: 1, nz: 3, dx: 1, dy: 1, dz: 1 };
    const state = createInteriorState(column, material, 270);
    state.enthalpy[1] = enthalpyFromPhase(271, 0, material);
    state.enthalpy[2] = enthalpyFromPhase(272, 0, material);
    const result = stepInterior(state, 0.1, { bottomOutwardFlux: 1, topOutwardFlux: -1 });
    for (let i = 0; i < 3; i++) expect(result.enthalpy[i]).toBeCloseTo(state.enthalpy[i], 10);
  });

  it('converges toward the analytical insulated heat-equation eigenmode as the grid is refined', () => {
    // T(z,t) = 250 + 10 cos(pi z) exp(-pi² t), 0 <= z <= 1.
    function error(n: number): number {
      const column = { nx: 1, ny: 1, nz: n, dx: 1, dy: 1, dz: 1 / n };
      let state = createInteriorState(column, material, 250);
      for (let z = 0; z < n; z++) {
        const temperature = 250 + 10 * Math.cos(Math.PI * (z + 0.5) / n);
        state.enthalpy[z] = enthalpyFromPhase(temperature, 0, material);
      }
      const dt = 0.2 / n ** 2;
      const steps = Math.round(0.1 / dt);
      for (let step = 0; step < steps; step++) state = stepInterior(state, dt);
      let squaredError = 0;
      for (let z = 0; z < n; z++) {
        const actual = phaseFromEnthalpy(state.enthalpy[z], material).temperature;
        const expected = 250 + 10 * Math.cos(Math.PI * (z + 0.5) / n) * Math.exp(-(Math.PI ** 2) * 0.1);
        squaredError += (actual - expected) ** 2;
      }
      return Math.sqrt(squaredError / n);
    }
    const coarseError = error(10);
    const fineError = error(20);
    expect(fineError).toBeLessThan(coarseError / 3);
    expect(fineError).toBeLessThan(0.01);
  });

  it('rejects invalid grids, unstable timesteps, bad sources and temperatures below absolute zero', () => {
    expect(() => createInteriorState({ ...grid, nx: 0 }, material, 260)).toThrow();
    const state = createInteriorState(grid, material, 260);
    expect(() => stepInterior(state, maximumInteriorTimeStep(grid, material) * 1.01)).toThrow(/stability/);
    expect(() => stepInterior(state, 0.1, { volumetricHeating: new Float64Array(2) })).toThrow(/length/);
    expect(() => stepInterior(state, 0.1, { volumetricHeating: Number.NaN })).toThrow();
    expect(() => stepInterior(state, 0.1, { volumetricHeating: -10000 })).toThrow(/nonphysical/);
  });
});
