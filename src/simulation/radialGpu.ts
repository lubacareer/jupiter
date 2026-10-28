/** Independent WebGPU radial enthalpy integration with a double-precision reference. */
import { phaseFromEnthalpy } from './interior';
import { radialCellGeometry, stepRadial, validateRadialState, type RadialState } from './radialInterior';

export type RadialGpuErrors = { maxTemperatureKelvin: number; maxLiquidFraction: number; normalizedEnergy: number };
export const RADIAL_GPU_LIMITS: RadialGpuErrors = { maxTemperatureKelvin: 0.05, maxLiquidFraction: 0.002, normalizedEnergy: 0.0001 };
export interface RadialGpuResult { state: RadialState; gpuEnthalpy: number[]; errors: RadialGpuErrors }
export interface RadialGpuSession { snapshot(): RadialGpuResult; advance(): Promise<RadialGpuResult>; destroy(): void }

/** Integrate differences with spherical shell volumes, scaled independently of historical accounting. */
export function compareRadialFields(state: RadialState, gpu: ArrayLike<number>): RadialGpuErrors {
  const { config, enthalpy } = state, { material } = config;
  if (gpu.length !== enthalpy.length) throw new RangeError('GPU radial field length does not match grid');
  let maxTemperatureKelvin = 0, maxLiquidFraction = 0, gpuEnergy = 0, referenceEnergy = 0, absoluteEnergy = 0, volume = 0;
  for (let i = 0; i < enthalpy.length; i++) {
    const reference = enthalpy[i], candidate = gpu[i], cell = radialCellGeometry(config, i);
    if (!Number.isFinite(reference) || !Number.isFinite(candidate)) throw new RangeError('Non-finite radial field');
    const cpuPhase = phaseFromEnthalpy(reference, material), gpuPhase = phaseFromEnthalpy(candidate, material);
    if (!Number.isFinite(gpuPhase.temperature) || gpuPhase.temperature < 0) throw new RangeError('Nonphysical GPU radial temperature');
    maxTemperatureKelvin = Math.max(maxTemperatureKelvin, Math.abs(cpuPhase.temperature - gpuPhase.temperature));
    maxLiquidFraction = Math.max(maxLiquidFraction, Math.abs(cpuPhase.liquidFraction - gpuPhase.liquidFraction));
    gpuEnergy += candidate * cell.volumeM3; referenceEnergy += reference * cell.volumeM3;
    absoluteEnergy += Math.abs(reference) * cell.volumeM3; volume += cell.volumeM3;
  }
  const scale = Math.max(material.density * material.latentHeat * volume, absoluteEnergy, 1);
  const normalizedEnergy = Math.abs(gpuEnergy - referenceEnergy) / scale;
  if (![maxTemperatureKelvin, maxLiquidFraction, normalizedEnergy, scale, gpuEnergy, referenceEnergy].every(Number.isFinite)) throw new RangeError('Non-finite radial energy comparison');
  return { maxTemperatureKelvin, maxLiquidFraction, normalizedEnergy };
}
function checkErrors(errors: RadialGpuErrors): void {
  for (const key of Object.keys(RADIAL_GPU_LIMITS) as (keyof RadialGpuErrors)[]) {
    if (!Number.isFinite(errors[key]) || errors[key] > RADIAL_GPU_LIMITS[key]) throw new Error(`GPU radial accuracy limit exceeded: ${key} = ${errors[key]} (limit ${RADIAL_GPU_LIMITS[key]})`);
  }
}

// Geometry multipliers include dt and avoid squaring planetary-scale distances in f32.
const shader = /* wgsl */ `
@group(0) @binding(0) var<storage, read> oldH: array<f32>;
@group(0) @binding(1) var<storage, read_write> nextH: array<f32>;
@group(0) @binding(2) var<storage, read> geometry: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> p: array<f32>;
fn phase(h: f32) -> vec2<f32> {
  let latent = p[1] * p[4];
  if (h < 0.0) { return vec2<f32>(p[5] + h / (p[1] * p[2]), 0.0); }
  if (h <= latent) { return vec2<f32>(p[5], h / latent); }
  return vec2<f32>(p[5] + (h - latent) / (p[1] * p[3]), 1.0);
}
fn conductivity(f: f32) -> f32 { return mix(p[6], p[7], f); }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; let n = u32(p[0]); if (i >= n) { return; }
  let current = phase(oldH[i]); let k = conductivity(current.y); let g = geometry[i];
  var change = 0.0;
  if (i > 0u) {
    let other = phase(oldH[i-1u]); let k2 = conductivity(other.y);
    change += g.x * (2.0*k*k2/(k+k2)) * (other.x-current.x);
  } else { change += g.z; }
  if (i+1u < n) {
    let other = phase(oldH[i+1u]); let k2 = conductivity(other.y);
    change += g.y * (2.0*k*k2/(k+k2)) * (other.x-current.x);
  } else { change += g.w*k*(p[8]-current.x); }
  nextH[i] = oldH[i] + change;
}`;

const STORAGE = 128, COPY_SRC = 4, COPY_DST = 8, MAP_READ = 1;
const copy = (state: RadialState): RadialState => ({ ...state, config: { ...state.config, material: { ...state.config.material } }, enthalpy: [...state.enthalpy] });

export async function createRadialGpu(device: GPUDevice, input: RadialState, restoredGpu?: number[]): Promise<RadialGpuSession> {
  validateRadialState(input);
  let reference = copy(input), accepted = restoredGpu ? Float32Array.from(restoredGpu) : Float32Array.from(input.enthalpy);
  if (restoredGpu && (restoredGpu.length !== input.enthalpy.length || restoredGpu.some(x => !Number.isFinite(x) || Math.fround(x) !== x))) throw new RangeError('Invalid GPU radial checkpoint field');
  let errors = compareRadialFields(reference, accepted); checkErrors(errors);
  const { config } = reference, { material, dtSeconds } = config;
  const count = config.cells, bytes = count * 4;
  if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize || count * 16 > device.limits.maxStorageBufferBindingSize || count * 16 > device.limits.maxBufferSize) throw new RangeError('Radial grid exceeds GPU buffer limits');
  const dr = (config.iceThicknessM + config.oceanDepthM) / count;
  const geometry = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const cell = radialCellGeometry(config, i);
    geometry[i*4] = dtSeconds * cell.innerAreaM2 / (cell.volumeM3 * dr);
    geometry[i*4+1] = dtSeconds * cell.outerAreaM2 / (cell.volumeM3 * dr);
    geometry[i*4+2] = dtSeconds * config.basalHeatFluxWm2 * cell.innerAreaM2 / cell.volumeM3;
    geometry[i*4+3] = dtSeconds * cell.outerAreaM2 / (cell.volumeM3 * (dr/2));
  }
  const params = new Float32Array([count, material.density, material.iceHeatCapacity, material.waterHeatCapacity,
    material.latentHeat, material.meltingTemperature, material.iceConductivity, material.waterConductivity, config.surfaceTemperatureK]);
  if (!Array.from(geometry).every(Number.isFinite) || !Array.from(params).every(Number.isFinite)) throw new RangeError('Radial parameters exceed GPU float32 range');
  const buffers: GPUBuffer[] = [];
  const make = (size: number, usage: number) => { const buffer = device.createBuffer({ size, usage }); buffers.push(buffer); return buffer; };
  try {
    let source = make(bytes, STORAGE | COPY_SRC | COPY_DST), destination = make(bytes, STORAGE | COPY_SRC | COPY_DST);
    const geo = make(geometry.byteLength, STORAGE | COPY_DST), settings = make(params.byteLength, STORAGE | COPY_DST), readback = make(bytes, MAP_READ | COPY_DST);
    device.queue.writeBuffer(source, 0, accepted); device.queue.writeBuffer(geo, 0, geometry); device.queue.writeBuffer(settings, 0, params);
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' } });
    let stopped = false, lost = false, busy = false;
    void device.lost.then(() => { lost = true; });
    const snapshot = (): RadialGpuResult => ({ state: copy(reference), gpuEnthalpy: Array.from(accepted), errors: { ...errors } });
    return {
      snapshot,
      async advance() {
        if (stopped || lost) throw new Error(lost ? 'GPU device was lost' : 'Radial GPU session stopped');
        if (busy) throw new Error('Radial GPU step already in progress');
        busy = true;
        try {
          const candidate = stepRadial(reference);
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: destination } },
            { binding: 2, resource: { buffer: geo } }, { binding: 3, resource: { buffer: settings } },
          ] }));
          pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
          encoder.copyBufferToBuffer(destination, 0, readback, 0, bytes); device.queue.submit([encoder.finish()]);
          await readback.mapAsync(MAP_READ);
          const next = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
          if (stopped || lost) throw new Error(lost ? 'GPU device was lost' : 'Radial GPU session cancelled');
          const nextErrors = compareRadialFields(candidate, next); checkErrors(nextErrors);
          reference = candidate; accepted = next; errors = nextErrors; [source, destination] = [destination, source];
          return snapshot();
        } catch (error) { stopped = true; throw error; } finally { busy = false; }
      },
      destroy() { stopped = true; for (const buffer of buffers) buffer.destroy(); },
    };
  } catch (error) { for (const buffer of buffers) buffer.destroy(); throw error; }
}
