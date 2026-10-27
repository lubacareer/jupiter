/**
 * A conservative, fixed-grid 3D enthalpy diffusion experiment.
 * This is not the coupled Europa interior solver described in the product plan.
 * All inputs and outputs use SI units. See docs/interior.md for the model limits.
 */

export interface InteriorMaterial {
  density: number; // kg m^-3; constant in both phases
  iceHeatCapacity: number; // J kg^-1 K^-1
  waterHeatCapacity: number; // J kg^-1 K^-1
  iceConductivity: number; // W m^-1 K^-1
  waterConductivity: number; // W m^-1 K^-1
  latentHeat: number; // J kg^-1
  meltingTemperature: number; // K
}

export interface InteriorGrid {
  nx: number;
  ny: number;
  nz: number;
  dx: number; // m
  dy: number; // m
  dz: number; // m
}

export interface InteriorState {
  grid: InteriorGrid;
  material: InteriorMaterial;
  /** Volumetric enthalpy in J m^-3, referenced to solid ice at melting temperature. */
  enthalpy: Float64Array;
  time: number; // s
}

export interface InteriorForcing {
  /** Constant or per-cell volumetric heat source in W m^-3; negative values remove heat. */
  volumetricHeating?: number | Float64Array;
  /** Outward heat flux in W m^-2 at z = 0; positive removes heat. */
  bottomOutwardFlux?: number;
  /** Outward heat flux in W m^-2 at z = nz * dz; positive removes heat. */
  topOutwardFlux?: number;
}

export interface PhaseState {
  temperature: number; // K
  liquidFraction: number;
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function validate(grid: InteriorGrid, material: InteriorMaterial): void {
  for (const [name, n] of Object.entries({ nx: grid.nx, ny: grid.ny, nz: grid.nz })) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  for (const [name, value] of Object.entries({ dx: grid.dx, dy: grid.dy, dz: grid.dz, ...material })) {
    positive(value, name);
  }
}

/** Construct enthalpy for a pure phase or a phase mixture at the melting point. */
export function enthalpyFromPhase(temperature: number, liquidFraction: number, material: InteriorMaterial): number {
  finite(temperature, 'temperature');
  finite(liquidFraction, 'liquidFraction');
  if (temperature < 0 || liquidFraction < 0 || liquidFraction > 1) throw new RangeError('Invalid temperature or liquid fraction');
  const tm = material.meltingTemperature;
  if (temperature < tm && liquidFraction === 0) return material.density * material.iceHeatCapacity * (temperature - tm);
  if (temperature === tm) return material.density * material.latentHeat * liquidFraction;
  if (temperature > tm && liquidFraction === 1) {
    return material.density * (material.latentHeat + material.waterHeatCapacity * (temperature - tm));
  }
  throw new RangeError('A phase mixture must be at the melting temperature');
}

/** Recover temperature and liquid fraction from volumetric enthalpy. */
export function phaseFromEnthalpy(enthalpy: number, material: InteriorMaterial): PhaseState {
  const latentPerVolume = material.density * material.latentHeat;
  if (enthalpy < 0) {
    return { temperature: material.meltingTemperature + enthalpy / (material.density * material.iceHeatCapacity), liquidFraction: 0 };
  }
  if (enthalpy <= latentPerVolume) {
    return { temperature: material.meltingTemperature, liquidFraction: enthalpy / latentPerVolume };
  }
  return {
    temperature: material.meltingTemperature + (enthalpy - latentPerVolume) / (material.density * material.waterHeatCapacity),
    liquidFraction: 1,
  };
}

export function createInteriorState(grid: InteriorGrid, material: InteriorMaterial, initialTemperature: number, initialLiquidFraction = 0): InteriorState {
  validate(grid, material);
  const initial = enthalpyFromPhase(initialTemperature, initialLiquidFraction, material);
  const count = grid.nx * grid.ny * grid.nz;
  if (!Number.isSafeInteger(count) || count > 10_000_000) throw new RangeError('Grid exceeds the supported cell count');
  return { grid: { ...grid }, material: { ...material }, enthalpy: new Float64Array(count).fill(initial), time: 0 };
}

/** Conservative explicit time-step limit for the linear diffusion part. */
export function maximumInteriorTimeStep(grid: InteriorGrid, material: InteriorMaterial): number {
  validate(grid, material);
  const alpha = Math.max(material.iceConductivity, material.waterConductivity) /
    (material.density * Math.min(material.iceHeatCapacity, material.waterHeatCapacity));
  return 1 / (2 * alpha * (1 / grid.dx ** 2 + 1 / grid.dy ** 2 + 1 / grid.dz ** 2));
}

/**
 * Return the next state. Each shared face is evaluated once with harmonic-mean
 * conductivity; the equal and opposite fluxes conserve internal energy.
 */
export function stepInterior(state: InteriorState, dt: number, forcing: InteriorForcing = {}): InteriorState {
  const { grid, material, enthalpy } = state;
  validate(grid, material);
  positive(dt, 'dt');
  if (dt > maximumInteriorTimeStep(grid, material)) throw new RangeError('dt exceeds the explicit diffusion stability limit');
  finite(state.time, 'time');
  const count = grid.nx * grid.ny * grid.nz;
  if (enthalpy.length !== count) throw new RangeError('Enthalpy length does not match grid');
  const q = forcing.volumetricHeating ?? 0;
  const bottom = forcing.bottomOutwardFlux ?? 0;
  const top = forcing.topOutwardFlux ?? 0;
  finite(bottom, 'bottomOutwardFlux');
  finite(top, 'topOutwardFlux');
  if (typeof q === 'number') finite(q, 'volumetricHeating');
  else if (q.length !== count) throw new RangeError('Heating length does not match grid');

  const temperature = new Float64Array(count);
  const conductivity = new Float64Array(count);
  const next = new Float64Array(enthalpy);
  for (let i = 0; i < count; i++) {
    finite(enthalpy[i], 'enthalpy');
    const cellHeating = typeof q === 'number' ? q : q[i];
    finite(cellHeating, 'volumetricHeating');
    const phase = phaseFromEnthalpy(enthalpy[i], material);
    if (phase.temperature < 0) throw new RangeError('Cell temperature is below absolute zero');
    temperature[i] = phase.temperature;
    conductivity[i] = material.iceConductivity * (1 - phase.liquidFraction) + material.waterConductivity * phase.liquidFraction;
    next[i] += dt * cellHeating;
  }

  function exchange(a: number, b: number, distance: number): void {
    const ka = conductivity[a];
    const kb = conductivity[b];
    const kFace = 2 * ka * kb / (ka + kb);
    const transfer = dt * kFace * (temperature[b] - temperature[a]) / distance ** 2;
    next[a] += transfer;
    next[b] -= transfer;
  }

  const { nx, ny, nz, dx, dy, dz } = grid;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z);
    if (x + 1 < nx) exchange(i, i + 1, dx);
    if (y + 1 < ny) exchange(i, i + nx, dy);
    if (z + 1 < nz) exchange(i, i + nx * ny, dz);
    if (z === 0) next[i] -= dt * bottom / dz;
    if (z === nz - 1) next[i] -= dt * top / dz;
  }
  for (const h of next) {
    if (!Number.isFinite(h) || phaseFromEnthalpy(h, material).temperature < 0) {
      throw new RangeError('Step would produce a nonphysical state; reduce the timestep or forcing');
    }
  }
  return { grid, material, enthalpy: next, time: state.time + dt };
}

export function interiorDiagnostics(state: InteriorState): { energy: number; meanLiquidFraction: number; minTemperature: number; maxTemperature: number } {
  const { grid, material, enthalpy } = state;
  let energyDensitySum = 0;
  let liquidSum = 0;
  let minTemperature = Infinity;
  let maxTemperature = -Infinity;
  for (const h of enthalpy) {
    const phase = phaseFromEnthalpy(h, material);
    energyDensitySum += h;
    liquidSum += phase.liquidFraction;
    minTemperature = Math.min(minTemperature, phase.temperature);
    maxTemperature = Math.max(maxTemperature, phase.temperature);
  }
  return { energy: energyDensitySum * grid.dx * grid.dy * grid.dz, meanLiquidFraction: liquidSum / enthalpy.length, minTemperature, maxTemperature };
}
