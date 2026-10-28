/** Independent GPU/CPU comparison for the experimental Cartesian enthalpy model.
 * This is not an orbital coupling or a resolved Stefan interface.
 */
import { createInteriorState, interiorDiagnostics, maximumInteriorTimeStep, phaseFromEnthalpy, stepInterior,
  type InteriorForcing, type InteriorState } from './interior';

export interface ThermalErrors {
  maxTemperatureKelvin: number;
  maxLiquidFraction: number;
  normalizedEnergy: number;
}

export const THERMAL_LIMITS = { maxTemperatureKelvin: 0.05, maxLiquidFraction: 0.002, normalizedEnergy: 0.0001 } as const;

/** JSON-serializable continuation data. Imported files must be treated as unverified. */
export interface GpuThermalSnapshot {
  version: 1;
  grid: InteriorState['grid'];
  material: InteriorState['material'];
  time: number;
  dt: number;
  forcing: { volumetricHeating: number | number[]; bottomOutwardFlux: number; topOutwardFlux: number };
  gpuEnthalpy: number[];
  referenceEnthalpy: number[];
  initialEnergy: number;
  cumulativeHeat: number;
  errors: ThermalErrors;
}

export interface GpuThermalConfig { state: InteriorState; dt: number; forcing?: InteriorForcing }
export interface GpuThermalSession {
  advance(): Promise<GpuThermalSnapshot>;
  snapshot(): GpuThermalSnapshot;
  destroy(): void;
}

/** Synthetic demonstration inputs, not estimates of Europa's interior. */
export function defaultGpuThermalConfig(): GpuThermalConfig {
  const grid = { nx: 16, ny: 16, nz: 16, dx: 1, dy: 1, dz: 1 };
  const material = { density: 1, iceHeatCapacity: 1, waterHeatCapacity: 1, iceConductivity: 1, waterConductivity: 1, latentHeat: 10, meltingTemperature: 273 };
  return { state: createInteriorState(grid, material, 270), dt: maximumInteriorTimeStep(grid, material) * 0.5,
    forcing: { volumetricHeating: 0.5, topOutwardFlux: 2, bottomOutwardFlux: -0.5 } };
}

function requireFinite(n: number, name: string): void {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
}

/** Shared scale that cannot be inflated by cancelling accounting metadata. */
function thermalEnergyScale(reference: InteriorState): number {
  const { dx, dy, dz } = reference.grid;
  const cellVolume = dx * dy * dz;
  const volume = cellVolume * reference.enthalpy.length;
  const latentEnergy = reference.material.density * reference.material.latentHeat * volume;
  requireFinite(cellVolume, 'cell volume');
  requireFinite(volume, 'thermal volume');
  requireFinite(latentEnergy, 'latent energy');
  let absoluteEnthalpyDensity = 0;
  for (const enthalpy of reference.enthalpy) {
    requireFinite(enthalpy, 'reference enthalpy');
    absoluteEnthalpyDensity += Math.abs(enthalpy);
  }
  requireFinite(absoluteEnthalpyDensity, 'absolute enthalpy density sum');
  const absoluteEnthalpy = absoluteEnthalpyDensity * cellVolume;
  requireFinite(absoluteEnthalpy, 'absolute enthalpy');
  return Math.max(latentEnergy, absoluteEnthalpy, 1);
}

/** Compare every cell and the integrated energy in SI units. */
export function compareThermalStates(reference: InteriorState, gpuEnthalpy: ArrayLike<number>, initialEnergy: number, cumulativeHeat: number): ThermalErrors {
  if (gpuEnthalpy.length !== reference.enthalpy.length) throw new RangeError('GPU field length does not match the reference');
  requireFinite(initialEnergy, 'initialEnergy');
  requireFinite(cumulativeHeat, 'cumulativeHeat');
  const energyScale = thermalEnergyScale(reference);
  let maxTemperatureKelvin = 0;
  let maxLiquidFraction = 0;
  let gpuEnergyDensity = 0;
  for (let i = 0; i < reference.enthalpy.length; i++) {
    const value = gpuEnthalpy[i];
    requireFinite(value, 'GPU enthalpy');
    const gpu = phaseFromEnthalpy(value, reference.material);
    const cpu = phaseFromEnthalpy(reference.enthalpy[i], reference.material);
    if (!Number.isFinite(gpu.temperature) || gpu.temperature < 0) throw new RangeError('GPU field contains a nonphysical temperature');
    maxTemperatureKelvin = Math.max(maxTemperatureKelvin, Math.abs(gpu.temperature - cpu.temperature));
    maxLiquidFraction = Math.max(maxLiquidFraction, Math.abs(gpu.liquidFraction - cpu.liquidFraction));
    gpuEnergyDensity += value;
  }
  const { dx, dy, dz } = reference.grid;
  const cellVolume = dx * dy * dz;
  const referenceEnergy = interiorDiagnostics(reference).energy;
  requireFinite(gpuEnergyDensity, 'GPU enthalpy density sum');
  requireFinite(referenceEnergy, 'reference energy');
  const gpuEnergy = gpuEnergyDensity * cellVolume;
  requireFinite(gpuEnergy, 'GPU energy');
  const energyDifference = Math.abs(gpuEnergy - referenceEnergy);
  requireFinite(energyDifference, 'energy difference');
  const normalizedEnergy = energyDifference / energyScale;
  return { maxTemperatureKelvin, maxLiquidFraction, normalizedEnergy };
}

function checkErrors(errors: ThermalErrors): void {
  for (const key of Object.keys(THERMAL_LIMITS) as (keyof ThermalErrors)[]) {
    if (!Number.isFinite(errors[key]) || errors[key] > THERMAL_LIMITS[key]) {
      throw new Error(`GPU thermal accuracy limit exceeded: ${key} = ${errors[key]} (limit ${THERMAL_LIMITS[key]})`);
    }
  }
}

const shader = /* wgsl */ `
@group(0) @binding(0) var<storage, read> oldH: array<f32>;
@group(0) @binding(1) var<storage, read_write> newH: array<f32>;
@group(0) @binding(2) var<storage, read> heating: array<f32>;
@group(0) @binding(3) var<storage, read> p: array<f32>;
fn phase(h: f32) -> vec2<f32> {
  let rho = p[6]; let latent = rho * p[11]; let melt = p[12];
  if (h < 0.0) { return vec2<f32>(melt + h / (rho * p[7]), 0.0); }
  if (h <= latent) { return vec2<f32>(melt, h / latent); }
  return vec2<f32>(melt + (h - latent) / (rho * p[8]), 1.0);
}
fn conduct(a: u32, b: u32, distance: f32) -> f32 {
  let pa = phase(oldH[a]); let pb = phase(oldH[b]);
  let ka = mix(p[9], p[10], pa.y); let kb = mix(p[9], p[10], pb.y);
  return (2.0 * ka * kb / (ka + kb)) * (pb.x - pa.x) / (distance * distance);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let nx = u32(p[0]); let ny = u32(p[1]); let nz = u32(p[2]);
  let i = id.x; if (i >= nx * ny * nz) { return; }
  let x = i % nx; let y = (i / nx) % ny; let z = i / (nx * ny);
  var flux = heating[i];
  if (x > 0u) { flux += conduct(i, i - 1u, p[3]); }
  if (x + 1u < nx) { flux += conduct(i, i + 1u, p[3]); }
  if (y > 0u) { flux += conduct(i, i - nx, p[4]); }
  if (y + 1u < ny) { flux += conduct(i, i + nx, p[4]); }
  if (z > 0u) { flux += conduct(i, i - nx * ny, p[5]); }
  if (z + 1u < nz) { flux += conduct(i, i + nx * ny, p[5]); }
  if (z == 0u) { flux -= p[14] / p[5]; }
  if (z + 1u == nz) { flux -= p[15] / p[5]; }
  newH[i] = oldH[i] + p[13] * flux;
}`;

/** Start or resume the experiment on an already-selected WebGPU device. */
export async function createGpuThermal(device: GPUDevice, input: GpuThermalConfig | GpuThermalSnapshot): Promise<GpuThermalSession> {
  const restored = 'version' in input;
  if (restored && input.version !== 1) throw new Error('Unsupported thermal snapshot');
  const state = restored ? {
    grid: { ...input.grid }, material: { ...input.material }, time: input.time,
    enthalpy: Float64Array.from(input.referenceEnthalpy),
  } : { ...input.state, grid: { ...input.state.grid }, material: { ...input.state.material }, enthalpy: new Float64Array(input.state.enthalpy) };
  const dt = input.dt;
  const inputForcing = input.forcing ?? {};
  const heatingInput = inputForcing.volumetricHeating ?? 0;
  const forcing: InteriorForcing = {
    volumetricHeating: typeof heatingInput === 'number' ? heatingInput : Float64Array.from(heatingInput),
    bottomOutwardFlux: inputForcing.bottomOutwardFlux ?? 0,
    topOutwardFlux: inputForcing.topOutwardFlux ?? 0,
  };
  const { grid, material } = state;
  if (grid.nx > 32 || grid.ny > 32 || grid.nz > 32) throw new RangeError('Thermal grid dimensions must not exceed 32');
  if (!Number.isFinite(dt) || dt <= 0 || dt > maximumInteriorTimeStep(grid, material)) throw new RangeError('Invalid thermal timestep');
  if (!Number.isFinite(state.time) || state.time < 0 || state.time + dt === state.time) throw new RangeError('Invalid thermal simulation time');
  // The CPU implementation validates grid, forcing and state; discard the candidate.
  stepInterior(state, dt, forcing);
  const count = state.enthalpy.length;
  const heating = typeof forcing.volumetricHeating === 'number' ? new Float32Array(count).fill(forcing.volumetricHeating) : Float32Array.from(forcing.volumetricHeating!);
  const gpuInitial = restored ? Float32Array.from(input.gpuEnthalpy) : Float32Array.from(state.enthalpy);
  if (gpuInitial.length !== count) throw new RangeError('GPU field length does not match grid');
  for (const n of heating) requireFinite(n, 'GPU heating');
  const referenceEnergy = interiorDiagnostics(state).energy;
  requireFinite(referenceEnergy, 'reference energy');
  const initialEnergy = restored ? input.initialEnergy : referenceEnergy;
  let cumulativeHeat = restored ? input.cumulativeHeat : 0;
  requireFinite(initialEnergy, 'initialEnergy');
  requireFinite(cumulativeHeat, 'cumulativeHeat');
  const energyScale = thermalEnergyScale(state);
  const expectedEnergy = initialEnergy + cumulativeHeat;
  requireFinite(expectedEnergy, 'expected energy');
  const energyDifference = Math.abs(referenceEnergy - expectedEnergy);
  requireFinite(energyDifference, 'energy difference');
  if (energyDifference / energyScale > THERMAL_LIMITS.normalizedEnergy) throw new RangeError('Thermal energy accounting does not match the reference state');
  let reference: InteriorState = state;
  let acceptedGpu = gpuInitial;
  let errors = compareThermalStates(reference, acceptedGpu, initialEnergy, cumulativeHeat);
  checkErrors(errors);
  const bytes = count * 4;
  if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize) throw new RangeError('Thermal grid exceeds GPU buffer limits');
  const params = new Float32Array([grid.nx, grid.ny, grid.nz, grid.dx, grid.dy, grid.dz,
    material.density, material.iceHeatCapacity, material.waterHeatCapacity, material.iceConductivity,
    material.waterConductivity, material.latentHeat, material.meltingTemperature, dt,
    forcing.bottomOutwardFlux!, forcing.topOutwardFlux!]);
  for (const n of params) requireFinite(n, 'GPU parameter');
  for (const n of params.slice(3, 14)) if (n <= 0) throw new RangeError('Thermal parameter is outside GPU float32 range');
  const buffers: GPUBuffer[] = [];
  const makeBuffer = (size: number, usage: GPUBufferUsageFlags) => {
    const buffer = device.createBuffer({ size, usage }); buffers.push(buffer); return buffer;
  };
  try {
    let src = makeBuffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    let dst = makeBuffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    const q = makeBuffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const settings = makeBuffer(params.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const readback = makeBuffer(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(src, 0, acceptedGpu);
    device.queue.writeBuffer(q, 0, heating);
    device.queue.writeBuffer(settings, 0, params);
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' } });
    let stopped = false;
    let deviceLost = false;
    void device.lost.then(() => { deviceLost = true; });
    let inFlight = false;
    const heatingRate = (typeof forcing.volumetricHeating === 'number'
      ? forcing.volumetricHeating * count : Array.from(forcing.volumetricHeating!).reduce((a, b) => a + b, 0)) * grid.dx * grid.dy * grid.dz;
    const boundaryRate = (forcing.bottomOutwardFlux! + forcing.topOutwardFlux!) * grid.nx * grid.ny * grid.dx * grid.dy;
    const snapshot = (): GpuThermalSnapshot => ({
      version: 1, grid: { ...grid }, material: { ...material }, time: reference.time, dt,
      forcing: { volumetricHeating: typeof forcing.volumetricHeating === 'number' ? forcing.volumetricHeating : Array.from(forcing.volumetricHeating!),
        bottomOutwardFlux: forcing.bottomOutwardFlux!, topOutwardFlux: forcing.topOutwardFlux! },
      gpuEnthalpy: Array.from(acceptedGpu), referenceEnthalpy: Array.from(reference.enthalpy), initialEnergy, cumulativeHeat, errors: { ...errors },
    });
    return {
      snapshot,
      async advance() {
        if (stopped) throw new Error('Thermal experiment has stopped');
        if (deviceLost) { stopped = true; throw new Error('GPU device was lost'); }
        if (inFlight) throw new Error('Thermal step is already in progress');
        inFlight = true;
        try {
          const candidate = stepInterior(reference, dt, forcing);
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } },
            { binding: 2, resource: { buffer: q } }, { binding: 3, resource: { buffer: settings } },
          ] }));
          pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
          encoder.copyBufferToBuffer(dst, 0, readback, 0, bytes);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const candidateGpu = new Float32Array(readback.getMappedRange().slice(0));
          readback.unmap();
          const candidateHeat = cumulativeHeat + (heatingRate - boundaryRate) * dt;
          if (stopped || deviceLost) throw new Error(deviceLost ? 'GPU device was lost' : 'Thermal experiment was cancelled');
          const candidateErrors = compareThermalStates(candidate, candidateGpu, initialEnergy, candidateHeat);
          checkErrors(candidateErrors);
          reference = candidate; acceptedGpu = candidateGpu; cumulativeHeat = candidateHeat; errors = candidateErrors;
          [src, dst] = [dst, src];
          return snapshot();
        } catch (error) {
          stopped = true;
          throw error;
        } finally { inFlight = false; }
      },
      destroy() { stopped = true; for (const buffer of buffers) buffer.destroy(); },
    };
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    throw error;
  }
}
