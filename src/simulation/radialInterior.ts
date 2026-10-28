/** Independent spherical, one-dimensional ice/water enthalpy experiment.
 * All quantities use SI units. The rocky interior is a prescribed boundary.
 */
import { enthalpyFromPhase, phaseFromEnthalpy, type InteriorMaterial } from './interior';

export interface RadialConfig {
  radiusM: number;
  iceThicknessM: number;
  oceanDepthM: number;
  cells: number;
  surfaceTemperatureK: number;
  /** Positive heat flux enters the water/ice layer from below. */
  basalHeatFluxWm2: number;
  dtSeconds: number;
  material: InteriorMaterial;
}
export interface RadialState {
  config: RadialConfig;
  timeSeconds: number;
  enthalpy: number[];
  initialEnergyJ: number;
  cumulativeHeatJ: number;
}
export interface RadialGeometry {
  innerRadiusM: number;
  outerRadiusM: number;
  centerRadiusM: number;
  volumeM3: number;
  innerAreaM2: number;
  outerAreaM2: number;
}
export interface RadialDiagnostics {
  energyJ: number;
  energyErrorJ: number;
  minTemperatureK: number;
  maxTemperatureK: number;
  meanLiquidFraction: number;
  /** Depth of a unique half-liquid transition below the surface; null if absent or ambiguous. */
  iceThicknessM: number | null;
}
export interface RadialFieldProfile {
  cells: Array<{ radiusM: number; temperatureK: number; liquidFraction: number }>;
  iceThicknessM: number | null;
}

function finite(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}
function positive(value: number, name: string): void {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}
function validateConfig(config: RadialConfig, checkDt = true): void {
  if (!config || typeof config !== 'object' || !config.material || typeof config.material !== 'object') throw new RangeError('Invalid radial configuration');
  for (const name of ['radiusM', 'iceThicknessM', 'oceanDepthM'] as const) positive(config[name], name);
  finite(config.surfaceTemperatureK, 'surfaceTemperatureK');
  finite(config.basalHeatFluxWm2, 'basalHeatFluxWm2');
  if (config.surfaceTemperatureK < 0) throw new RangeError('Surface temperature must not be below absolute zero');
  if (!(config.iceThicknessM + config.oceanDepthM < config.radiusM)) throw new RangeError('The water layer must lie above a positive rocky radius');
  if (!Number.isSafeInteger(config.cells) || config.cells < 4 || config.cells > 1024) throw new RangeError('Radial cells must be an integer between 4 and 1024');
  for (const name of ['density', 'iceHeatCapacity', 'waterHeatCapacity', 'iceConductivity', 'waterConductivity', 'latentHeat', 'meltingTemperature'] as const) positive(config.material[name], name);
  if (![config.material.density * config.material.iceHeatCapacity, config.material.density * config.material.waterHeatCapacity,
    config.material.density * config.material.latentHeat].every(Number.isFinite)) throw new RangeError('Non-finite radial material scaling');
  if (config.surfaceTemperatureK > config.material.meltingTemperature) throw new RangeError('Initial surface temperature must not exceed melting temperature');
  if (checkDt) positive(config.dtSeconds, 'dtSeconds');
}

export function radialCellGeometry(config: RadialConfig, index: number): RadialGeometry {
  validateConfig(config, false);
  if (!Number.isSafeInteger(index) || index < 0 || index >= config.cells) throw new RangeError('Invalid radial cell index');
  const width = (config.iceThicknessM + config.oceanDepthM) / config.cells;
  const innerRadiusM = config.radiusM - (config.iceThicknessM + config.oceanDepthM) + index * width;
  const outerRadiusM = innerRadiusM + width;
  if (!(outerRadiusM > innerRadiusM)) throw new RangeError('Radial cell width is too small for its radius');
  const centerRadiusM = (innerRadiusM + outerRadiusM) / 2;
  const innerAreaM2 = 4 * Math.PI * innerRadiusM ** 2;
  const outerAreaM2 = 4 * Math.PI * outerRadiusM ** 2;
  // Factored difference avoids cancellation in thin spherical shells.
  const volumeM3 = (4 * Math.PI / 3) * width * (innerRadiusM ** 2 + innerRadiusM * outerRadiusM + outerRadiusM ** 2);
  if (![innerRadiusM, outerRadiusM, centerRadiusM, volumeM3, innerAreaM2, outerAreaM2].every(Number.isFinite)) throw new RangeError('Non-finite radial geometry');
  return { innerRadiusM, outerRadiusM, centerRadiusM, volumeM3, innerAreaM2, outerAreaM2 };
}

/** Conservative explicit diffusion bound, using the largest conductivity and smallest heat capacity. */
export function maximumRadialTimeStep(config: RadialConfig): number {
  validateConfig(config, false);
  const width = (config.iceThicknessM + config.oceanDepthM) / config.cells;
  const k = Math.max(config.material.iceConductivity, config.material.waterConductivity);
  const heatCapacity = config.material.density * Math.min(config.material.iceHeatCapacity, config.material.waterHeatCapacity);
  let limit = Infinity;
  for (let i = 0; i < config.cells; i++) {
    const cell = radialCellGeometry(config, i);
    const conductance = k / width * ((i > 0 ? cell.innerAreaM2 : 0) + (i < config.cells - 1 ? cell.outerAreaM2 : 2 * cell.outerAreaM2));
    limit = Math.min(limit, heatCapacity * cell.volumeM3 / conductance);
  }
  positive(limit, 'maximum radial timestep');
  return limit;
}

/** Source values are documented starting assumptions, not a model fit to Europa observations. */
export function defaultRadialConfig(): RadialConfig {
  const config: RadialConfig = {
    radiusM: 1_560_800, iceThicknessM: 20_000, oceanDepthM: 100_000, cells: 120,
    surfaceTemperatureK: 100, basalHeatFluxWm2: 0.05, dtSeconds: 1,
    material: { density: 921, iceHeatCapacity: 2040, waterHeatCapacity: 4180, iceConductivity: 2.2, waterConductivity: 0.57, latentHeat: 333800, meltingTemperature: 273.15 },
  };
  config.dtSeconds = maximumRadialTimeStep(config) * 0.45;
  return config;
}

function copyConfig(config: RadialConfig): RadialConfig {
  return { radiusM: config.radiusM, iceThicknessM: config.iceThicknessM, oceanDepthM: config.oceanDepthM, cells: config.cells,
    surfaceTemperatureK: config.surfaceTemperatureK, basalHeatFluxWm2: config.basalHeatFluxWm2, dtSeconds: config.dtSeconds,
    material: { density: config.material.density, iceHeatCapacity: config.material.iceHeatCapacity, waterHeatCapacity: config.material.waterHeatCapacity,
      iceConductivity: config.material.iceConductivity, waterConductivity: config.material.waterConductivity, latentHeat: config.material.latentHeat, meltingTemperature: config.material.meltingTemperature } };
}

export function createRadialState(config: RadialConfig): RadialState {
  validateConfig(config);
  if (config.dtSeconds > maximumRadialTimeStep(config)) throw new RangeError('dtSeconds exceeds the radial diffusion stability limit');
  const immutableConfig = copyConfig(config);
  const enthalpy = Array.from({ length: config.cells }, (_, i) => {
    const depth = config.radiusM - radialCellGeometry(config, i).centerRadiusM;
    if (depth >= config.iceThicknessM) return enthalpyFromPhase(config.material.meltingTemperature, 1, config.material);
    const temperature = config.surfaceTemperatureK + (config.material.meltingTemperature - config.surfaceTemperatureK) * depth / config.iceThicknessM;
    return enthalpyFromPhase(temperature, 0, config.material);
  });
  const initialEnergyJ = enthalpy.reduce((sum, h, i) => sum + h * radialCellGeometry(config, i).volumeM3, 0);
  finite(initialEnergyJ, 'initialEnergyJ');
  return { config: immutableConfig, timeSeconds: 0, enthalpy, initialEnergyJ, cumulativeHeatJ: 0 };
}

export function validateRadialState(state: RadialState): void {
  if (!state || typeof state !== 'object') throw new RangeError('Invalid radial state');
  validateConfig(state.config);
  if (state.config.dtSeconds > maximumRadialTimeStep(state.config)) throw new RangeError('dtSeconds exceeds the radial diffusion stability limit');
  finite(state.timeSeconds, 'timeSeconds'); finite(state.initialEnergyJ, 'initialEnergyJ'); finite(state.cumulativeHeatJ, 'cumulativeHeatJ');
  if (state.timeSeconds < 0 || !Array.isArray(state.enthalpy) || state.enthalpy.length !== state.config.cells) throw new RangeError('Invalid radial state field');
  let energy = 0, absoluteEnergy = 0, volume = 0;
  for (let i = 0; i < state.enthalpy.length; i++) {
    const h = state.enthalpy[i];
    finite(h, 'enthalpy');
    const phase = phaseFromEnthalpy(h, state.config.material);
    if (!Number.isFinite(phase.temperature) || phase.temperature < 0 || !Number.isFinite(phase.liquidFraction)) throw new RangeError('Invalid radial phase state');
    const cellVolume = radialCellGeometry(state.config, i).volumeM3;
    energy += h * cellVolume; absoluteEnergy += Math.abs(h) * cellVolume; volume += cellVolume;
  }
  const expected = state.initialEnergyJ + state.cumulativeHeatJ;
  const scale = Math.max(1, absoluteEnergy, state.config.material.density * state.config.material.latentHeat * volume);
  if (![energy, expected, scale].every(Number.isFinite) || Math.abs(energy - expected) / scale > 1e-4) throw new RangeError('Inconsistent radial energy accounting');
}

/** Convert an accepted field without applying historical accounting to it. */
export function radialFieldProfile(config: RadialConfig, enthalpy: readonly number[]): RadialFieldProfile {
  validateConfig(config);
  if (!Array.isArray(enthalpy) || enthalpy.length !== config.cells) throw new RangeError('Invalid radial field');
  const cells = enthalpy.map((h, i) => {
    finite(h, 'enthalpy');
    const phase = phaseFromEnthalpy(h, config.material);
    if (!Number.isFinite(phase.temperature) || phase.temperature < 0 || !Number.isFinite(phase.liquidFraction)) throw new RangeError('Invalid radial phase state');
    return { radiusM: radialCellGeometry(config, i).centerRadiusM, temperatureK: phase.temperature, liquidFraction: phase.liquidFraction };
  });
  let transition: number | null = null, crossings = 0;
  for (let i = 0; i < cells.length - 1; i++) {
    const a = cells[i], b = cells[i + 1];
    if ((a.liquidFraction >= 0.5) !== (b.liquidFraction >= 0.5)) {
      crossings++;
      const fraction = (0.5 - a.liquidFraction) / (b.liquidFraction - a.liquidFraction);
      transition = config.radiusM - (a.radiusM + fraction * (b.radiusM - a.radiusM));
    }
  }
  if (crossings !== 1 || cells[cells.length - 1].liquidFraction >= 0.5 || cells[0].liquidFraction < 0.5) transition = null;
  return { cells, iceThicknessM: transition };
}

export function radialDiagnostics(state: RadialState): RadialDiagnostics {
  validateRadialState(state);
  const { config, enthalpy } = state;
  let energyJ = 0, volume = 0, liquidVolume = 0, minTemperatureK = Infinity, maxTemperatureK = -Infinity;
  const profile = radialFieldProfile(config, enthalpy);
  enthalpy.forEach((h, i) => {
    const cell = radialCellGeometry(config, i), phase = profile.cells[i];
    energyJ += h * cell.volumeM3; volume += cell.volumeM3; liquidVolume += phase.liquidFraction * cell.volumeM3;
    minTemperatureK = Math.min(minTemperatureK, phase.temperatureK); maxTemperatureK = Math.max(maxTemperatureK, phase.temperatureK);
  });
  const energyErrorJ = energyJ - (state.initialEnergyJ + state.cumulativeHeatJ);
  for (const n of [energyJ, energyErrorJ, volume, liquidVolume]) finite(n, 'radial diagnostic');
  return { energyJ, energyErrorJ, minTemperatureK, maxTemperatureK, meanLiquidFraction: liquidVolume / volume, iceThicknessM: profile.iceThicknessM };
}

/** Explicit finite-volume step. Shared face transfers are equal and opposite. */
export function stepRadial(state: RadialState): RadialState {
  validateRadialState(state);
  const { config } = state, dt = config.dtSeconds, width = (config.iceThicknessM + config.oceanDepthM) / config.cells;
  const nextTime = state.timeSeconds + dt;
  if (!Number.isFinite(nextTime) || nextTime <= state.timeSeconds) throw new RangeError('Radial timestep cannot advance physical time');
  const temperature: number[] = [], conductivity: number[] = [];
  for (const h of state.enthalpy) {
    const phase = phaseFromEnthalpy(h, config.material);
    temperature.push(phase.temperature);
    conductivity.push(config.material.iceConductivity * (1 - phase.liquidFraction) + config.material.waterConductivity * phase.liquidFraction);
  }
  const energyDelta = Array(config.cells).fill(0) as number[];
  for (let i = 0; i < config.cells - 1; i++) {
    const k = 2 * conductivity[i] * conductivity[i + 1] / (conductivity[i] + conductivity[i + 1]);
    const heat = dt * k * radialCellGeometry(config, i).outerAreaM2 * (temperature[i + 1] - temperature[i]) / width;
    energyDelta[i] += heat; energyDelta[i + 1] -= heat;
  }
  const bottom = dt * config.basalHeatFluxWm2 * radialCellGeometry(config, 0).innerAreaM2;
  const top = dt * conductivity[config.cells - 1] * radialCellGeometry(config, config.cells - 1).outerAreaM2 * (config.surfaceTemperatureK - temperature[config.cells - 1]) / (width / 2);
  energyDelta[0] += bottom; energyDelta[config.cells - 1] += top;
  const next: RadialState = { config: copyConfig(config), timeSeconds: nextTime,
    enthalpy: state.enthalpy.map((h, i) => h + energyDelta[i] / radialCellGeometry(config, i).volumeM3),
    initialEnergyJ: state.initialEnergyJ, cumulativeHeatJ: state.cumulativeHeatJ + bottom + top };
  validateRadialState(next);
  return next;
}
