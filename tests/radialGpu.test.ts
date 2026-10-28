import { describe, expect, it, vi } from 'vitest';
import { createRadialState, defaultRadialConfig } from '../src/simulation/radialInterior';
import { compareRadialFields, createRadialGpu } from '../src/simulation/radialGpu';

// This mock exercises command flow, not actual shader accuracy; hardware must be tested separately.
function fakeDevice() {
  let perturb = 0, lose!: (value: GPUDeviceLostInfo) => void;
  type Buffer = { data: ArrayBuffer; destroy: ReturnType<typeof vi.fn>; mapAsync: () => Promise<void>; getMappedRange: () => ArrayBuffer; unmap: () => void };
  const device = {
    limits: { maxStorageBufferBindingSize: 1e8, maxBufferSize: 1e8 },
    lost: new Promise<GPUDeviceLostInfo>(resolve => { lose = resolve; }),
    createBuffer: ({ size }: { size: number }): Buffer => ({ data: new ArrayBuffer(size), destroy: vi.fn(), mapAsync: async () => {}, getMappedRange() { return this.data; }, unmap() {} }),
    createShaderModule: () => ({}),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: ({ entries }: { entries: { resource: { buffer: Buffer } }[] }) => entries.map(e => e.resource.buffer),
    createCommandEncoder() {
      let bindings: Buffer[], source: Buffer, target: Buffer;
      return {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup(_i: number, b: Buffer[]) { bindings = b; }, dispatchWorkgroups() {}, end() {} }),
        copyBufferToBuffer(from: Buffer, _a: number, to: Buffer) { source = from; target = to; },
        finish: () => () => {
          const old = new Float32Array(bindings[0].data), next = new Float32Array(bindings[1].data);
          const geometry = new Float32Array(bindings[2].data), p = new Float32Array(bindings[3].data);
          const phase = (h: number) => h < 0 ? [p[5] + h / (p[1]*p[2]), 0] : h <= p[1]*p[4] ? [p[5], h/(p[1]*p[4])] : [p[5]+(h-p[1]*p[4])/(p[1]*p[3]), 1];
          for (let i = 0; i < old.length; i++) {
            const [t, f] = phase(old[i]), k = p[6]*(1-f)+p[7]*f;
            let change = 0;
            if (i) { const [u, g] = phase(old[i-1]), k2 = p[6]*(1-g)+p[7]*g; change += geometry[i*4]*2*k*k2/(k+k2)*(u-t); } else change += geometry[i*4+2];
            if (i+1 < old.length) { const [u, g] = phase(old[i+1]), k2 = p[6]*(1-g)+p[7]*g; change += geometry[i*4+1]*2*k*k2/(k+k2)*(u-t); } else change += geometry[i*4+3]*k*(p[8]-t);
            next[i] = old[i] + change + perturb;
          }
          new Uint8Array(target.data).set(new Uint8Array(source.data));
        },
      };
    },
    queue: {
      writeBuffer(buffer: Buffer, offset: number, input: ArrayBufferView) { new Uint8Array(buffer.data, offset).set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)); },
      submit(commands: (() => void)[]) { commands.forEach(command => command()); },
    },
  } as unknown as GPUDevice;
  return { device, setPerturb: (n: number) => { perturb = n; }, lose: () => lose({ message: 'lost', reason: 'unknown' } as GPUDeviceLostInfo) };
}

describe('radial GPU reference gate', () => {
  it('compares every cell and finite integrated energy using spherical volumes', () => {
    const state = createRadialState(defaultRadialConfig());
    const gpu = Float32Array.from(state.enthalpy);
    expect(compareRadialFields(state, gpu).maxTemperatureKelvin).toBeLessThan(0.05);
    gpu[0] = NaN;
    expect(() => compareRadialFields(state, gpu)).toThrow(/finite/);
  });
  it('advances against the reference and rejects an inaccurate sample without replacing the accepted state', async () => {
    const fake = fakeDevice(), state = createRadialState(defaultRadialConfig());
    const session = await createRadialGpu(fake.device, state);
    let accepted = await session.advance();
    for (let i = 0; i < 9; i++) accepted = await session.advance();
    expect(accepted.state.timeSeconds).toBeGreaterThan(0);
    expect(accepted.errors.maxTemperatureKelvin).toBeLessThan(0.05);
    expect(accepted.errors.maxLiquidFraction).toBeLessThan(0.002);
    expect(accepted.errors.normalizedEnergy).toBeLessThan(0.0001);
    fake.setPerturb(1e7);
    await expect(session.advance()).rejects.toThrow(/accuracy limit/);
    expect(session.snapshot()).toEqual(accepted);
    session.destroy();
  });
  it('rejects mismatched imported fields and device loss', async () => {
    const fake = fakeDevice(), state = createRadialState(defaultRadialConfig());
    await expect(createRadialGpu(fake.device, state, [1])).rejects.toThrow(/checkpoint field/);
    const session = await createRadialGpu(fake.device, state);
    const last = session.snapshot();
    fake.lose(); await Promise.resolve();
    await expect(session.advance()).rejects.toThrow(/lost/);
    expect(session.snapshot()).toEqual(last);
    session.destroy();
  });
});
