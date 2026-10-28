import { createInitialOrbit, orbitDiagnostics, stepOrbit, type OrbitState, type Vec3 } from './orbit';

/** GPU results are checked against an independently advanced float64 orbit. */
export const ORBIT_GPU_DT_SECONDS = 300;
export const ORBIT_GPU_ERROR_LIMIT_KM = 10;
const LENGTH_KM = 1_000_000;
const TIME_SECONDS = 100_000;
const FLOATS_PER_BODY = 20;
const BODY_COUNT = 4;
const SAMPLE_STEPS = 12;
const BUFFER_BYTES = FLOATS_PER_BODY * BODY_COUNT * 4;
// Numeric WebGPU flags also make the code testable outside a browser.
const MAP_READ = 1, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, STORAGE = 128;

export interface GpuOrbitCheckpoint {
  version: 1;
  initialState: OrbitState;
  reference: OrbitState;
  /** Position, velocity and their compensated residuals, all in normalized units. */
  packedState: number[];
  steps: number;
  maxSteps: number;
}
export interface GpuOrbitSample {
  state: OrbitState;
  reference: OrbitState;
  errorKm: number;
  steps: number;
  maxSteps: number;
  completed: boolean;
}
export interface GpuOrbitSession {
  /** Optional validation runs before the candidate replaces the accepted state. */
  advance(validateCandidate?: (candidate: GpuOrbitSample) => void): Promise<GpuOrbitSample>;
  checkpoint(): GpuOrbitCheckpoint;
  sample(): GpuOrbitSample;
  dispose(): void;
}

const SHADER = /* wgsl */ `
struct Body { pos: vec4<f32>, vel: vec4<f32>, pc: vec4<f32>, vc: vec4<f32>, gm: vec4<f32> }
struct Config { steps: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> input: array<Body, 4>;
@group(0) @binding(1) var<storage, read_write> output: array<Body, 4>;
@group(0) @binding(2) var<uniform> config: Config;
const DT: f32 = 0.003;
fn acceleration(p: array<vec3<f32>, 4>, gm: array<f32, 4>, i: u32) -> vec3<f32> {
  var a = vec3<f32>(0.0);
  for (var j = 0u; j < 4u; j++) {
    if (i != j) {
      let r = p[j] - p[i];
      let r2 = dot(r, r);
      a += gm[j] * r * inverseSqrt(r2) / r2;
    }
  }
  return a;
}
@compute @workgroup_size(1)
fn main() {
  var p: array<vec3<f32>, 4>;
  var v: array<vec3<f32>, 4>;
  var pc: array<vec3<f32>, 4>;
  var vc: array<vec3<f32>, 4>;
  var gm: array<f32, 4>;
  for (var i = 0u; i < 4u; i++) { p[i] = input[i].pos.xyz; v[i] = input[i].vel.xyz; pc[i] = input[i].pc.xyz; vc[i] = input[i].vc.xyz; gm[i] = input[i].gm.x; }
  for (var step = 0u; step < config.steps; step++) {
    var oldA: array<vec3<f32>, 4>;
    for (var i = 0u; i < 4u; i++) { oldA[i] = acceleration(p, gm, i); }
    for (var i = 0u; i < 4u; i++) {
      let delta = v[i] * DT + oldA[i] * (0.5 * DT * DT);
      let y = delta - pc[i];
      let next = p[i] + y;
      pc[i] = (next - p[i]) - y;
      p[i] = next;
    }
    for (var i = 0u; i < 4u; i++) {
      let delta = (oldA[i] + acceleration(p, gm, i)) * (0.5 * DT);
      let y = delta - vc[i];
      let next = v[i] + y;
      vc[i] = (next - v[i]) - y;
      v[i] = next;
    }
  }
  for (var i = 0u; i < 4u; i++) { output[i].pos = vec4<f32>(p[i], 0.0); output[i].vel = vec4<f32>(v[i], 0.0); output[i].pc = vec4<f32>(pc[i], 0.0); output[i].vc = vec4<f32>(vc[i], 0.0); output[i].gm = vec4<f32>(gm[i], 0.0, 0.0, 0.0); }
}`;

const clone = (s: OrbitState): OrbitState => ({ timeSeconds: s.timeSeconds, bodies: s.bodies.map(b => ({ ...b, position: [...b.position], velocity: [...b.velocity] })) });
function sameState(a: OrbitState, b: OrbitState): boolean {
  return !!a && a.timeSeconds === b.timeSeconds && Array.isArray(a.bodies) && a.bodies.length === b.bodies.length && a.bodies.every((body, i) =>
    !!body && body.name === b.bodies[i].name && body.gm === b.bodies[i].gm && Array.isArray(body.position) && Array.isArray(body.velocity) &&
    body.position.length === 3 && body.velocity.length === 3 && body.position.every((n, j) => n === b.bodies[i].position[j]) && body.velocity.every((n, j) => n === b.bodies[i].velocity[j]));
}

function pack(s: OrbitState): Float32Array {
  const data = new Float32Array(BODY_COUNT * FLOATS_PER_BODY);
  s.bodies.forEach((b, i) => {
    const base = i * FLOATS_PER_BODY;
    for (let k = 0; k < 3; k++) { data[base + k] = b.position[k] / LENGTH_KM; data[base + 4 + k] = b.velocity[k] * TIME_SECONDS / LENGTH_KM; }
    data[base + 16] = b.gm * TIME_SECONDS * TIME_SECONDS / (LENGTH_KM ** 3);
  });
  return data;
}
function unpack(packed: Float32Array, reference: OrbitState): OrbitState {
  const bodies = reference.bodies.map((b, i) => {
    const base = i * FLOATS_PER_BODY;
    const position = [0, 1, 2].map(k => packed[base + k] * LENGTH_KM) as Vec3;
    const velocity = [0, 1, 2].map(k => packed[base + 4 + k] * LENGTH_KM / TIME_SECONDS) as Vec3;
    return { name: b.name, gm: b.gm, position, velocity };
  });
  if (!packed.every(Number.isFinite) || !bodies.every(b => [...b.position, ...b.velocity].every(Number.isFinite))) throw new Error('GPU orbital result contains non-finite values');
  return { timeSeconds: reference.timeSeconds, bodies };
}
export function orbitPositionErrorKm(state: OrbitState, reference: OrbitState): number {
  const body = (s: OrbitState, name: string) => { const b = s.bodies.find(item => item.name === name); if (!b) throw new Error(`Missing ${name}`); return b; };
  const gJ = body(state, 'Jupiter'), gE = body(state, 'Europa'), cJ = body(reference, 'Jupiter'), cE = body(reference, 'Europa');
  return Math.hypot(...([0, 1, 2].map(i => (gE.position[i] - gJ.position[i]) - (cE.position[i] - cJ.position[i])) as Vec3));
}
function validateState(state: OrbitState): void {
  const model = createInitialOrbit();
  if (!state || !Array.isArray(state.bodies) || state.bodies.length !== BODY_COUNT || !Number.isFinite(state.timeSeconds) || state.timeSeconds < 0 ||
      state.bodies.map(b => b.name).join(',') !== 'Jupiter,Io,Europa,Ganymede' ||
      state.bodies.some((b, i) => b.gm !== model.bodies[i].gm || !Array.isArray(b.position) || !Array.isArray(b.velocity) || b.position.length !== 3 || b.velocity.length !== 3 || ![...b.position, ...b.velocity].every(Number.isFinite))) throw new Error('Invalid orbit or model constants');
  orbitDiagnostics(state);
}
function validateInitial(state: OrbitState): number {
  validateState(state);
  if (state.timeSeconds !== 0) throw new Error('GPU orbital initial state must use the model epoch');
  const a = orbitDiagnostics(state).semiMajorAxisKm;
  const mu = state.bodies[0].gm + state.bodies[2].gm;
  const steps = Math.floor(10 * 2 * Math.PI * Math.sqrt(a ** 3 / mu) / ORBIT_GPU_DT_SECONDS);
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > 10_000_000) throw new Error('Initial orbit is outside GPU run limits');
  return steps;
}

/** Runs a sample at a time; failed work never replaces the last accepted buffers. */
export async function createGpuOrbit(device: GPUDevice, initialState: OrbitState, restored?: GpuOrbitCheckpoint): Promise<GpuOrbitSession> {
  const maxSteps = validateInitial(initialState);
  let steps = 0, reference = clone(initialState), packed = pack(initialState);
  if (restored) {
    if (restored.version !== 1 || restored.maxSteps !== maxSteps || !Number.isSafeInteger(restored.steps) || restored.steps < 0 || restored.steps > maxSteps ||
        !sameState(restored.initialState, initialState) || !Array.isArray(restored.packedState) || restored.packedState.length !== BODY_COUNT * FLOATS_PER_BODY ||
        !restored.packedState.every(n => Number.isFinite(n) && Math.fround(n) === n) ||
        restored.packedState.some((n, i) => ([3, 7, 11, 15, 17, 18, 19].includes(i % FLOATS_PER_BODY)) && n !== 0)) throw new Error('Invalid GPU orbital checkpoint');
    validateState(restored.reference);
    if (restored.reference.timeSeconds !== initialState.timeSeconds + restored.steps * ORBIT_GPU_DT_SECONDS ||
        restored.reference.bodies.some((b, i) => b.name !== initialState.bodies[i].name || b.gm !== initialState.bodies[i].gm)) throw new Error('Inconsistent GPU orbital checkpoint reference');
    steps = restored.steps; reference = clone(restored.reference); packed = new Float32Array(restored.packedState);
    // Checkpoint GMs must match the model and cannot be changed independently.
    const initialPacked = pack(initialState);
    if (Array.from({ length: BODY_COUNT }, (_, i) => i * FLOATS_PER_BODY + 16).some(i => packed[i] !== initialPacked[i])) throw new Error('Invalid GPU orbital model constants');
  }
  let currentState = unpack(packed, reference);
  let errorKm = orbitPositionErrorKm(currentState, reference);
  if (!Number.isFinite(errorKm) || errorKm > ORBIT_GPU_ERROR_LIMIT_KM) throw new Error('GPU orbital checkpoint exceeds the 10 km reference limit');
  const module = device.createShaderModule({ label: 'four-body orbit', code: SHADER });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === 'error');
  if (errors.length) throw new Error(`GPU orbital shader failed: ${errors.map(item => item.message).join('; ')}`);
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  let active = device.createBuffer({ size: BUFFER_BYTES, usage: STORAGE | COPY_SRC | COPY_DST });
  let candidate = device.createBuffer({ size: BUFFER_BYTES, usage: STORAGE | COPY_SRC | COPY_DST });
  const staging = device.createBuffer({ size: BUFFER_BYTES, usage: MAP_READ | COPY_DST });
  const config = device.createBuffer({ size: 16, usage: UNIFORM | COPY_DST });
  device.queue.writeBuffer(active, 0, new Float32Array(packed));
  let failed: string | undefined, disposed = false, busy = false;
  device.lost.then(info => { failed = `GPU device lost: ${info.message || info.reason}`; }).catch(() => { failed = 'GPU device lost'; });
  const sample = (): GpuOrbitSample => ({ state: clone(currentState), reference: clone(reference), errorKm, steps, maxSteps, completed: steps >= maxSteps });
  return {
    sample,
    checkpoint: () => ({ version: 1, initialState: clone(initialState), reference: clone(reference), packedState: Array.from(packed), steps, maxSteps }),
    async advance(validateCandidate) {
      if (disposed) throw new Error('GPU orbital session has been disposed');
      if (failed) throw new Error(failed);
      if (busy) throw new Error('GPU orbital session is already advancing');
      if (steps >= maxSteps) return sample();
      busy = true;
      try {
        const count = Math.min(SAMPLE_STEPS, maxSteps - steps);
        let nextReference = reference;
        for (let i = 0; i < count; i++) nextReference = stepOrbit(nextReference, ORBIT_GPU_DT_SECONDS);
        device.queue.writeBuffer(config, 0, new Uint32Array([count, 0, 0, 0]));
        const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: active } }, { binding: 1, resource: { buffer: candidate } }, { binding: 2, resource: { buffer: config } },
        ] });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
        encoder.copyBufferToBuffer(candidate, 0, staging, 0, BUFFER_BYTES);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(MAP_READ);
        const nextPacked = new Float32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        if (failed) throw new Error(failed);
        const nextState = unpack(nextPacked, nextReference);
        const nextError = orbitPositionErrorKm(nextState, nextReference);
        if (!Number.isFinite(nextError) || nextError > ORBIT_GPU_ERROR_LIMIT_KM) throw new Error(`GPU orbital comparison exceeded 10 km (${nextError.toFixed(3)} km)`);
        orbitDiagnostics(nextState);
        // Derivations that must agree with the published state are checked
        // before committing buffers, reference state, or the step counter.
        if (validateCandidate) validateCandidate({ state: clone(nextState), reference: clone(nextReference), errorKm: nextError,
          steps: steps + count, maxSteps, completed: steps + count >= maxSteps });
        [active, candidate] = [candidate, active]; packed = nextPacked; reference = nextReference; currentState = nextState; errorKm = nextError; steps += count;
        return sample();
      } catch (error) {
        failed = error instanceof Error ? error.message : 'GPU orbital integration failed';
        throw new Error(failed);
      } finally { busy = false; }
    },
    dispose() { if (!disposed) { disposed = true; active.destroy(); candidate.destroy(); staging.destroy(); config.destroy(); } },
  };
}
