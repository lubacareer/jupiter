import { describe, expect, it, vi } from 'vitest';
import { createInteriorState, interiorDiagnostics, stepInterior } from '../src/simulation/interior';
import { compareThermalStates, createGpuThermal, defaultGpuThermalConfig } from '../src/simulation/gpuThermal';
import { createGpuCheckpoint, exportGpuResult, parseGpuCheckpoint } from '../src/simulation/gpuCheckpoint';

// A controllable command-buffer test double checks lifecycle and acceptance; real
// hardware validation is required separately to check the shader and precision.
function fakeDevice() {
  let change = 0;
  let lose!: (reason: GPUDeviceLostInfo) => void;
  const buffers: { data: ArrayBuffer; destroy: () => void; mapAsync: () => Promise<void>; getMappedRange: () => ArrayBuffer; unmap: () => void }[] = [];
  const device = {
    limits: { maxStorageBufferBindingSize: 1e8, maxBufferSize: 1e8 },
    lost: new Promise<GPUDeviceLostInfo>(resolve => { lose = resolve; }),
    createBuffer({ size }: { size: number }) {
      const b = { data: new ArrayBuffer(size), destroy: vi.fn(), mapAsync: async () => {}, getMappedRange() { return this.data; }, unmap() {} };
      buffers.push(b); return b;
    },
    createShaderModule() { return {}; },
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: ({ entries }: { entries: { resource: { buffer: typeof buffers[number] } }[] }) => entries.map(entry => entry.resource.buffer),
    createCommandEncoder() {
      let bindings: typeof buffers = [];
      let src: typeof buffers[number], dst: typeof buffers[number];
      return {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup(_index: number, b: typeof buffers) { bindings = b; }, dispatchWorkgroups() {}, end() {} }),
        copyBufferToBuffer(from: typeof buffers[number], _a: number, to: typeof buffers[number]) { src = from; dst = to; },
        finish: () => () => {
          const input = new Float32Array(bindings[0].data), output = new Float32Array(bindings[1].data);
          for (let i = 0; i < output.length; i++) output[i] = input[i] + change;
          new Uint8Array(dst.data).set(new Uint8Array(src.data));
        },
      };
    },
    queue: {
      writeBuffer(buffer: typeof buffers[number], offset: number, input: ArrayBufferView) {
        new Uint8Array(buffer.data, offset).set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      },
      submit(commands: (() => void)[]) { commands.forEach(command => command()); },
    },
  } as unknown as GPUDevice;
  return { device, setChange: (value: number) => { change = value; }, lose: () => lose({ reason: 'unknown', message: 'device lost' } as GPUDeviceLostInfo) };
}

const flags = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, MAP_READ: 1 };
vi.stubGlobal('GPUBufferUsage', flags);
vi.stubGlobal('GPUMapMode', { READ: 1 });

function uniformConfig() {
  const config = defaultGpuThermalConfig();
  return { ...config, state: createInteriorState(config.state.grid, config.state.material, 270), forcing: {} };
}

describe('experimental GPU thermal comparisons', () => {
  it('compares every cell and normalizes the integrated energy', () => {
    const state = uniformConfig().state;
    const gpu = Float32Array.from(state.enthalpy);
    const baseline = interiorDiagnostics(state).energy;
    expect(compareThermalStates(state, gpu, baseline, 0)).toEqual({ maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 });
    gpu[5] += 0.1;
    const errors = compareThermalStates(state, gpu, baseline, 0);
    expect(errors.maxTemperatureKelvin).toBeCloseTo(0.1, 5);
    expect(errors.normalizedEnergy).toBeGreaterThan(0);
    gpu[5] = NaN;
    expect(() => compareThermalStates(state, gpu, baseline, 0)).toThrow(/finite/);
  });

  it('does not let cancelling historical energy values weaken the GPU comparison', async () => {
    const config = uniformConfig();
    const original = await createGpuThermal(fakeDevice().device, config);
    const saved = original.snapshot();
    const gpuEnthalpy = Array.from(new Float32Array(saved.gpuEnthalpy.length).fill(-2.97));
    const initialEnergy = 1_000_000_000;
    const cumulativeHeat = interiorDiagnostics(config.state).energy - initialEnergy;
    const errors = compareThermalStates(config.state, gpuEnthalpy, initialEnergy, cumulativeHeat);
    expect(errors.maxTemperatureKelvin).toBeLessThan(0.05);
    expect(errors.maxLiquidFraction).toBe(0);
    expect(errors.normalizedEnergy).toBeCloseTo(0.003, 6);
    const fake = fakeDevice();
    const createBuffer = vi.spyOn(fake.device, 'createBuffer');
    await expect(createGpuThermal(fake.device, { ...saved, gpuEnthalpy, initialEnergy, cumulativeHeat }))
      .rejects.toThrow(/normalizedEnergy/);
    expect(createBuffer).not.toHaveBeenCalled();
    original.destroy();
  });

  it('supports large reference enthalpy while still enforcing the relative energy limit', async () => {
    const config = uniformConfig();
    config.state.material.waterHeatCapacity = 1e8;
    config.state.enthalpy.fill(1e8);
    const session = await createGpuThermal(fakeDevice().device, config);
    const saved = session.snapshot();
    const within = Array.from(new Float32Array(saved.gpuEnthalpy.length).fill(100_004_096));
    const errors = compareThermalStates(config.state, within, saved.initialEnergy, 0);
    expect(errors.maxTemperatureKelvin).toBeLessThan(0.05);
    expect(errors.normalizedEnergy).toBeCloseTo(4096 / 1e8, 8);
    const restored = await createGpuThermal(fakeDevice().device, { ...saved, gpuEnthalpy: within });
    restored.destroy();

    const beyond = Array.from(new Float32Array(saved.gpuEnthalpy.length).fill(100_010_240));
    await expect(createGpuThermal(fakeDevice().device, { ...saved, gpuEnthalpy: beyond }))
      .rejects.toThrow(/normalizedEnergy/);
    session.destroy();
  });

  it('uses absolute cell enthalpies when positive and negative reference energy cancels', async () => {
    const config = uniformConfig();
    config.state.enthalpy.fill(-100);
    config.state.enthalpy.fill(100, config.state.enthalpy.length / 2);
    expect(interiorDiagnostics(config.state).energy).toBe(0);
    const session = await createGpuThermal(fakeDevice().device, config);
    const saved = session.snapshot();
    const gpuEnthalpy = Array.from(Float32Array.from(saved.gpuEnthalpy, value => value + 0.005));
    const errors = compareThermalStates(config.state, gpuEnthalpy, 0, 0);
    expect(errors.normalizedEnergy).toBeCloseTo(0.00005, 6);
    const restored = await createGpuThermal(fakeDevice().device, { ...saved, gpuEnthalpy });
    restored.destroy(); session.destroy();
  });

  it('rejects overflow in the absolute reference-enthalpy scale', () => {
    const state = uniformConfig().state;
    state.enthalpy.fill(Number.MAX_VALUE);
    expect(() => compareThermalStates(state, new Float32Array(state.enthalpy.length), 0, 0))
      .toThrow(/absolute enthalpy density sum.*finite/);
  });

  it('restores the accepted GPU and reference states and advances independently', async () => {
    const fake = fakeDevice();
    const session = await createGpuThermal(fake.device, uniformConfig());
    const first = await session.advance();
    expect(first.time).toBeGreaterThan(0);
    const restored = await createGpuThermal(fakeDevice().device, JSON.parse(JSON.stringify(first)));
    const second = await restored.advance();
    expect(second.time).toBe(first.time + first.dt);
    expect(second.referenceEnthalpy).toEqual(first.referenceEnthalpy);
    expect(second.errors.maxTemperatureKelvin).toBe(0);
    session.destroy(); restored.destroy();
  });

  it('validates reference energy against baseline and cumulative heat before allocating GPU buffers', async () => {
    const config = uniformConfig();
    const session = await createGpuThermal(fakeDevice().device, config);
    const saved = session.snapshot();
    const scale = config.state.material.density * config.state.material.latentHeat * config.state.enthalpy.length *
      config.state.grid.dx * config.state.grid.dy * config.state.grid.dz;

    const withinTolerance = await createGpuThermal(fakeDevice().device, { ...saved, initialEnergy: saved.initialEnergy + scale * 0.00009 });
    withinTolerance.destroy();
    for (const invalid of [
      { ...saved, initialEnergy: saved.initialEnergy + scale * 0.00011 },
      { ...saved, cumulativeHeat: scale * 0.00011 },
      { ...saved, initialEnergy: NaN },
      { ...saved, initialEnergy: Infinity },
      { ...saved, cumulativeHeat: -Infinity },
      { ...saved, initialEnergy: Number.MAX_VALUE, cumulativeHeat: Number.MAX_VALUE },
    ]) {
      const fake = fakeDevice();
      const createBuffer = vi.spyOn(fake.device, 'createBuffer');
      await expect(createGpuThermal(fake.device, invalid)).rejects.toBeInstanceOf(RangeError);
      expect(createBuffer).not.toHaveBeenCalled();
    }

    // A real CPU step with sources and outward flux gives a nonzero net heat.
    const heated = defaultGpuThermalConfig();
    const next = stepInterior(heated.state, heated.dt, heated.forcing);
    const heat = interiorDiagnostics(next).energy - interiorDiagnostics(heated.state).energy;
    const heatedSaved = { ...saved, grid: next.grid, material: next.material, time: next.time, dt: heated.dt,
      forcing: { volumetricHeating: 0.5, topOutwardFlux: 2, bottomOutwardFlux: -0.5 },
      referenceEnthalpy: Array.from(next.enthalpy), gpuEnthalpy: Array.from(Float32Array.from(next.enthalpy)), cumulativeHeat: heat };
    expect(heat).not.toBe(0);
    const restored = await createGpuThermal(fakeDevice().device, heatedSaved);
    expect(restored.snapshot().cumulativeHeat).toBe(heat);
    restored.destroy(); session.destroy();
  });

  it('rejects new configurations with non-finite total energy', async () => {
    const config = uniformConfig();
    config.state.grid = { ...config.state.grid, dx: 1e103, dy: 1e103, dz: 1e103 };
    const fake = fakeDevice();
    const createBuffer = vi.spyOn(fake.device, 'createBuffer');
    await expect(createGpuThermal(fake.device, config)).rejects.toBeInstanceOf(RangeError);
    expect(createBuffer).not.toHaveBeenCalled();
  });

  it('rejects a mismatched field without replacing the accepted state', async () => {
    const fake = fakeDevice();
    const session = await createGpuThermal(fake.device, uniformConfig());
    const before = session.snapshot();
    fake.setChange(1);
    await expect(session.advance()).rejects.toThrow(/accuracy limit/);
    expect(session.snapshot()).toEqual(before);
    await expect(session.advance()).rejects.toThrow(/stopped/);
    session.destroy();
  });

  it('enforces liquid fraction and integrated-energy gates even when temperatures agree', async () => {
    const latentFake = fakeDevice();
    const latentConfig = uniformConfig();
    latentConfig.state = createInteriorState(latentConfig.state.grid, latentConfig.state.material, 273, 0.5);
    const latent = await createGpuThermal(latentFake.device, latentConfig);
    latentFake.setChange(0.03); // 0 K temperature difference, but 0.003 liquid-fraction difference.
    await expect(latent.advance()).rejects.toThrow(/maxLiquidFraction/);
    latent.destroy();

    const energyFake = fakeDevice();
    const energy = await createGpuThermal(energyFake.device, uniformConfig());
    energyFake.setChange(0.005); // Individually below the temperature gate; integrated energy exceeds its gate.
    await expect(energy.advance()).rejects.toThrow(/normalizedEnergy/);
    energy.destroy();
  });

  it('rejects lost devices, invalid restoration and oversized grids', async () => {
    const fake = fakeDevice();
    const session = await createGpuThermal(fake.device, uniformConfig());
    fake.lose(); await Promise.resolve();
    await expect(session.advance()).rejects.toThrow(/lost/);
    const invalid = { ...session.snapshot(), gpuEnthalpy: [0] };
    await expect(createGpuThermal(fakeDevice().device, invalid)).rejects.toThrow(/length/);
    const config = uniformConfig();
    config.state.grid.nx = 33;
    await expect(createGpuThermal(fakeDevice().device, config)).rejects.toThrow(/32/);
    session.destroy();
  });
});

describe('GPU checkpoint integrity and provenance', () => {
  it('round-trips canonical payloads, rejects tampering, and omits checksums from exports', async () => {
    const session = await createGpuThermal(fakeDevice().device, uniformConfig());
    const saved = await createGpuCheckpoint('thermal', { mode: 'thermal', data: session.snapshot(), history: [{ timeSeconds: 0, error: 0 }] }, { vendor: 'test' }, { origin: 'local', input: 'new', checksum: 'unavailable' });
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(saved).reverse())));
    const loaded = await parseGpuCheckpoint(reordered);
    expect(loaded.provenance).toEqual({ origin: 'unverified', input: 'imported', checksum: 'verified' });
    const again = await createGpuCheckpoint('thermal', loaded.checkpoint.data, loaded.checkpoint.adapter, loaded.provenance);
    expect((await parseGpuCheckpoint(again)).provenance.origin).toBe('unverified');
    const exported = exportGpuResult('thermal', again.data, again.adapter, again.provenance) as Record<string, unknown>;
    expect(exported).not.toHaveProperty('checksum');
    expect(exported.provenance).toEqual(loaded.provenance);
    for (const mutate of [
      (v: any) => { v.data.data.gpuEnthalpy[0] += 1; },
      (v: any) => { v.data.data.referenceEnthalpy[0] += 1; },
      (v: any) => { v.data.data.dt *= 2; },
      (v: any) => { v.data.history[0].error += 1; },
      (v: any) => { v.model.id = 'altered'; },
      (v: any) => { v.checksum.digest = '0'.repeat(64); },
    ]) {
      const changed = structuredClone(saved); mutate(changed);
      await expect(parseGpuCheckpoint(changed)).rejects.toThrow();
    }
    session.destroy();
  });
});
