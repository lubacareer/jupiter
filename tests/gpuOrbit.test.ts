import { describe, expect, it } from 'vitest';
import { createInitialOrbit, orbitDiagnostics, stepOrbit, type OrbitState } from '../src/simulation/orbit';
import { createGpuOrbit, ORBIT_GPU_DT_SECONDS, orbitPositionErrorKm } from '../src/simulation/gpuOrbit';

// This fake exercises session lifecycle and comparison gates. Real WGSL accuracy
// still requires the hardware tests described in the GPU validation workflow.
function fakeDevice(initial: OrbitState, behavior: 'match' | 'diverge' | 'nan' = 'match') {
  type Buffer = { bytes: ArrayBuffer; destroy: () => void; mapAsync: () => Promise<void>; getMappedRange: () => ArrayBuffer; unmap: () => void };
  let reference = initial;
  const device = {
    lost: new Promise(() => {}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: ({ size }: { size: number }): Buffer => ({ bytes: new ArrayBuffer(size), destroy() {}, async mapAsync() {}, getMappedRange() { return this.bytes; }, unmap() {} }),
    createBindGroup: ({ entries }: { entries: { resource: { buffer: Buffer } }[] }) => entries.map(e => e.resource.buffer),
    createCommandEncoder: () => {
      let group: Buffer[] = [];
      let copy: (() => void) | undefined;
      return {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup(_index: number, value: Buffer[]) { group = value; }, dispatchWorkgroups() {}, end() {} }),
        copyBufferToBuffer: (source: Buffer, _a: number, destination: Buffer, _b: number, length: number) => { copy = () => new Uint8Array(destination.bytes).set(new Uint8Array(source.bytes, 0, length)); },
        finish: () => () => {
          const input = new Float32Array(group[0].bytes), output = new Float32Array(group[1].bytes);
          output.set(input);
          const count = new Uint32Array(group[2].bytes)[0];
          for (let i = 0; i < count; i++) reference = stepOrbit(reference, ORBIT_GPU_DT_SECONDS);
          if (behavior === 'match') reference.bodies.forEach((b, i) => { for (let k = 0; k < 3; k++) { output[i * 20 + k] = b.position[k] / 1_000_000; output[i * 20 + 4 + k] = b.velocity[k] / 10; } });
          if (behavior === 'nan') output[40] = NaN;
          copy?.();
        },
      };
    },
    queue: {
      writeBuffer(buffer: Buffer, offset: number, data: ArrayBufferView) { new Uint8Array(buffer.bytes, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); },
      submit(commands: (() => void)[]) { commands.forEach(command => command()); },
    },
  };
  return device as unknown as GPUDevice;
}

describe('GPU orbital comparison', () => {
  it('measures Jupiter-relative position difference', () => {
    const a = createInitialOrbit(), b = createInitialOrbit();
    b.bodies[2].position[0] += 3;
    b.bodies[0].position[1] += 4;
    expect(orbitPositionErrorKm(a, b)).toBeCloseTo(5);
  });

  it('advances an independent reference and restores accepted compensated state', async () => {
    const initial = createInitialOrbit();
    const session = await createGpuOrbit(fakeDevice(initial), initial);
    const first = await session.advance();
    expect(first.steps).toBe(12);
    expect(first.errorKm).toBeLessThan(10);
    expect(first.reference.timeSeconds).toBe(3600);
    const periods = 10 * 2 * Math.PI * Math.sqrt(orbitDiagnostics(initial).semiMajorAxisKm ** 3 / (initial.bodies[0].gm + initial.bodies[2].gm));
    expect(first.maxSteps).toBe(Math.floor(periods / ORBIT_GPU_DT_SECONDS));
    const saved = session.checkpoint();
    const restored = await createGpuOrbit(fakeDevice(saved.reference), initial, saved);
    expect(restored.checkpoint()).toEqual(saved);
    expect((await restored.advance()).steps).toBe(24);
    session.dispose(); restored.dispose();
  });

  it.each(['diverge', 'nan'] as const)('stops on %s output and preserves the last accepted state', async behavior => {
    const initial = createInitialOrbit();
    const session = await createGpuOrbit(fakeDevice(initial, behavior), initial);
    const saved = session.checkpoint();
    await expect(session.advance()).rejects.toThrow(behavior === 'nan' ? /non-finite/ : /exceeded 10 km/);
    expect(session.checkpoint()).toEqual(saved);
    await expect(session.advance()).rejects.toThrow();
    session.dispose();
  });

  it('does not commit a candidate when its analysis validation fails', async () => {
    const initial = createInitialOrbit();
    const session = await createGpuOrbit(fakeDevice(initial), initial);
    const before = session.checkpoint();
    let candidateSteps = 0;
    await expect(session.advance(candidate => { candidateSteps = candidate.steps; throw new Error('analysis rejected'); })).rejects.toThrow(/analysis rejected/);
    expect(candidateSteps).toBe(12);
    expect(session.checkpoint()).toEqual(before);
    expect(session.sample().steps).toBe(0);
    session.dispose();
  });

  it('rejects altered packed model constants on restore', async () => {
    const initial = createInitialOrbit();
    const session = await createGpuOrbit(fakeDevice(initial), initial);
    const saved = session.checkpoint(); saved.packedState[16] *= 2;
    await expect(createGpuOrbit(fakeDevice(initial), initial, saved)).rejects.toThrow(/model constants/);
    session.dispose();
  });

  it('rejects altered epoch model constants and non-f32 continuation data', async () => {
    const initial = createInitialOrbit();
    const changed = createInitialOrbit(); changed.bodies[0].gm += 1;
    await expect(createGpuOrbit(fakeDevice(changed), changed)).rejects.toThrow(/model constants/);
    const session = await createGpuOrbit(fakeDevice(initial), initial);
    const saved = session.checkpoint(); saved.packedState[0] += 1e-12;
    await expect(createGpuOrbit(fakeDevice(initial), initial, saved)).rejects.toThrow(/checkpoint/);
    session.dispose();
  });

  it('stops on device loss while preserving the accepted checkpoint', async () => {
    const initial = createInitialOrbit(), device = fakeDevice(initial);
    let lose!: (value: { message: string; reason: string }) => void;
    Object.defineProperty(device, 'lost', { value: new Promise(resolve => { lose = resolve; }) });
    const session = await createGpuOrbit(device, initial), saved = session.checkpoint();
    lose({ message: 'adapter removed', reason: 'unknown' });
    await Promise.resolve();
    await expect(session.advance()).rejects.toThrow(/device lost/i);
    expect(session.checkpoint()).toEqual(saved);
    session.dispose();
  });
});
