import { describe, expect, it } from 'vitest';
import { enthalpyFromPhase } from '../src/simulation/interior';
import { createRadialState, defaultRadialConfig, maximumRadialTimeStep, radialCellGeometry, radialDiagnostics, radialFieldProfile, stepRadial, validateRadialState, type RadialConfig, type RadialState } from '../src/simulation/radialInterior';

function withField(config: RadialConfig, field: (radius: number) => number): RadialState {
  const initial = createRadialState(config);
  initial.enthalpy = initial.enthalpy.map((_, i) => field(radialCellGeometry(config, i).centerRadiusM));
  initial.initialEnergyJ = initial.enthalpy.reduce((sum, h, i) => sum + h * radialCellGeometry(config, i).volumeM3, 0);
  return initial;
}
function runTo(state: RadialState, timeSeconds: number): RadialState {
  const count = Math.ceil(timeSeconds / state.config.dtSeconds);
  state.config.dtSeconds = timeSeconds / count;
  for (let i = 0; i < count; i++) state = stepRadial(state);
  return state;
}

describe('spherical enthalpy experiment', () => {
  it('initializes a plausible layered, entirely radial model with a stable timestep', () => {
    const config = defaultRadialConfig(), state = createRadialState(config), diag = radialDiagnostics(state);
    expect(config.radiusM).toBe(1560800);
    expect(config.dtSeconds).toBeLessThan(maximumRadialTimeStep(config));
    expect(state.enthalpy).toHaveLength(config.cells);
    expect(diag.iceThicknessM).toBeCloseTo(20000, -2);
    expect(diag.energyErrorJ).toBe(0);
    expect(diag.minTemperatureK).toBeGreaterThan(config.surfaceTemperatureK);
    expect(diag.maxTemperatureK).toBe(config.material.meltingTemperature);
  });

  it('conserves integrated enthalpy including basal and surface fluxes', () => {
    let state = createRadialState(defaultRadialConfig());
    for (let i = 0; i < 30; i++) state = stepRadial(state);
    const diag = radialDiagnostics(state);
    expect(state.timeSeconds).toBeGreaterThan(0);
    expect(Math.abs(diag.energyErrorJ) / Math.abs(state.initialEnergyJ)).toBeLessThan(1e-12);
    expect(diag.minTemperatureK).toBeGreaterThan(0);
  });

  it('rejects invalid timesteps, non-finite fields and inconsistent accounting', () => {
    const config = defaultRadialConfig();
    expect(() => createRadialState({ ...config, dtSeconds: maximumRadialTimeStep(config) * 1.01 })).toThrow(/stability/i);
    const state = createRadialState(config);
    expect(() => validateRadialState({ ...state, enthalpy: state.enthalpy.map((h, i) => i ? h : NaN) })).toThrow();
    expect(() => validateRadialState({ ...state, initialEnergyJ: state.initialEnergyJ * 10 })).toThrow(/accounting/i);
    expect(() => validateRadialState({ ...state, config: { ...config, oceanDepthM: config.radiusM } })).toThrow();
    expect(() => stepRadial({ ...state, timeSeconds: Number.MAX_VALUE })).toThrow(/advance physical time/i);
    expect(() => maximumRadialTimeStep({ ...config, radiusM: 1e20, iceThicknessM: 1, oceanDepthM: 1 })).toThrow(/width/i);
  });

  it('recognizes that fully frozen or liquid fields have no identifiable transition', () => {
    const c = defaultRadialConfig();
    const solid = withField(c, () => enthalpyFromPhase(260, 0, c.material));
    const liquid = withField(c, () => enthalpyFromPhase(c.material.meltingTemperature, 1, c.material));
    expect(radialDiagnostics(solid).iceThicknessM).toBeNull();
    expect(radialDiagnostics(liquid).iceThicknessM).toBeNull();
  });

  it('converts accepted display fields independently of reference accounting', () => {
    const state = createRadialState(defaultRadialConfig());
    const field = state.enthalpy.map(h => h + 1_000_000);
    expect(() => validateRadialState({ ...state, enthalpy: field })).toThrow(/accounting/i);
    expect(radialFieldProfile(state.config, field).cells).toHaveLength(state.config.cells);
    expect(() => radialFieldProfile(state.config, field.slice(1))).toThrow();
  });

  it('converges towards steady spherical conduction as the grid is refined', () => {
    const errors = [30, 60, 120].map(cells => {
      const config = { ...defaultRadialConfig(), cells, surfaceTemperatureK: 150, basalHeatFluxWm2: 0.001, dtSeconds: 1 };
      config.dtSeconds = maximumRadialTimeStep(config) * 0.4;
      const inner = config.radiusM - config.iceThicknessM - config.oceanDepthM;
      const analytical = (radius: number) => config.surfaceTemperatureK + config.basalHeatFluxWm2 * inner ** 2 / config.material.iceConductivity * (1 / radius - 1 / config.radiusM);
      const initial = withField(config, radius => enthalpyFromPhase(analytical(radius), 0, config.material));
      const advanced = stepRadial(initial);
      // An analytical steady state has equal incoming and outgoing total heat.
      const basalHeat = config.dtSeconds * config.basalHeatFluxWm2 * radialCellGeometry(config, 0).innerAreaM2;
      return Math.abs(advanced.cumulativeHeatJ) / basalHeat;
    });
    expect(errors[1]).toBeLessThan(errors[0]);
    expect(errors[2]).toBeLessThan(errors[1]);
    expect(errors[2]).toBeLessThan(0.0004);
  });

  it('approaches the analytical one-phase Stefan freezing front in the locally planar limit', () => {
    const erf = (x: number) => {
      let sum = 0, power = x, factorial = 1;
      for (let n = 0; n < 18; n++) { if (n) { factorial *= n; power *= -x * x; } sum += power / (factorial * (2 * n + 1)); }
      return 2 * sum / Math.sqrt(Math.PI);
    };
    const material = defaultRadialConfig().material, undercooling = 10;
    const ste = material.iceHeatCapacity * undercooling / material.latentHeat;
    let lo = 0, hi = 1;
    for (let i = 0; i < 70; i++) { const middle = (lo + hi) / 2; if (middle * Math.exp(middle ** 2) * erf(middle) < ste / Math.sqrt(Math.PI)) lo = middle; else hi = middle; }
    const lambda = (lo + hi) / 2, alpha = material.iceConductivity / (material.density * material.iceHeatCapacity), targetDepth = 2;
    const targetTime = (targetDepth / (2 * lambda)) ** 2 / alpha;
    const errors = [32, 64, 128].map(cells => {
      const config = { ...defaultRadialConfig(), radiusM: 1_000_000_000, iceThicknessM: 2, oceanDepthM: 18, cells,
        surfaceTemperatureK: material.meltingTemperature - undercooling, basalHeatFluxWm2: 0, dtSeconds: 1 };
      config.dtSeconds = maximumRadialTimeStep(config) * 0.8;
      const initial = withField(config, () => enthalpyFromPhase(material.meltingTemperature, 1, material));
      const actual = radialDiagnostics(runTo(initial, targetTime)).iceThicknessM;
      expect(actual).not.toBeNull();
      return Math.abs(actual! - targetDepth);
    });
    expect(errors[1]).toBeLessThan(errors[0]);
    expect(errors[2]).toBeLessThan(errors[1]);
    expect(errors[2] / targetDepth).toBeLessThan(0.08);
  }, 30000);
});
