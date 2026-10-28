import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRadialState, defaultRadialConfig, stepRadial } from '../src/simulation/radialInterior';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ device: vi.fn(), gpu: vi.fn() }));
vi.mock('../src/simulation/gpuDevice', () => ({ requestHardwareDevice: mocks.device }));
vi.mock('../src/simulation/radialGpu', () => ({ createRadialGpu: mocks.gpu }));
let worker: { onmessage?: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const send = (data: unknown) => worker.onmessage!({ data });
const messages = () => worker.postMessage.mock.calls.map(c => c[0]);
const snapshots = () => messages().filter(m => m.type === 'snapshot').map(m => m.snapshot);
const doc = (type: string) => messages().filter(m => m.type === type).at(-1).document;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); worker = { postMessage: vi.fn() }; vi.stubGlobal('self', worker);
  vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer } });
  mocks.device.mockReset(); mocks.gpu.mockReset();
  await import('../src/simulation/radialWorker');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('independent radial worker', () => {
  it('runs CPU, exports a versioned state, and restores without certifying its origin', async () => {
    send({ type: 'start', backend: 'cpu', config: defaultRadialConfig() }); await flush();
    await vi.advanceTimersByTimeAsync(60); await flush();
    expect(snapshots().at(-1).state.timeSeconds).toBeGreaterThan(0);
    send({ type: 'pause' }); send({ type: 'checkpoint' }); send({ type: 'export' }); await flush();
    const saved = structuredClone(doc('checkpoint'));
    expect(saved.format).toBe('europa-radial-checkpoint-v2');
    expect(saved.checksum.algorithm).toBe('sha256');
    expect(doc('export').format).toBe('europa-radial-export-v2');
    expect(doc('export').checksum).toBeUndefined();
    expect(saved.units.enthalpy).toBe('J/m^3');
    send({ type: 'reset' }); send({ type: 'load', checkpoint: saved }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'verified', state: saved.state });
  });
  it('loads legacy v1 without a checksum and labels its origin unverified', async () => {
    send({ type: 'start', backend: 'cpu', config: defaultRadialConfig() }); await flush();
    send({ type: 'pause' }); send({ type: 'checkpoint' }); await flush();
    const saved = structuredClone(doc('checkpoint'));
    delete saved.checksum; saved.version = 1; saved.format = 'europa-radial-checkpoint-v1';
    send({ type: 'load', checkpoint: saved }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'paused', provenance: 'imported-unverified', checksumStatus: 'unavailable' });
    send({ type: 'checkpoint' }); await flush();
    expect(doc('checkpoint')).toMatchObject({ version: 2, provenance: 'imported-unverified', checksum: { algorithm: 'sha256' } });
    expect(doc('checkpoint').checksumStatus).toBeUndefined();
  });
  it('hashes a detached published snapshot while the run continues', async () => {
    const pending = deferred<ArrayBuffer>();
    let calculated: ArrayBuffer | undefined;
    vi.stubGlobal('crypto', { subtle: { digest: (_algorithm: string, bytes: Uint8Array) => {
      calculated = Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
      return pending.promise;
    } } });
    send({ type: 'start', backend: 'cpu', config: defaultRadialConfig() }); await flush();
    send({ type: 'checkpoint' }); await flush();
    await vi.advanceTimersByTimeAsync(90); await flush();
    expect(snapshots().at(-1).state.timeSeconds).toBeGreaterThan(0);
    pending.resolve(calculated!); await flush();
    expect(doc('checkpoint').state.timeSeconds).toBe(0);
  });
  it('rejects altered payload and checksum without interrupting an active run', async () => {
    send({ type: 'start', backend: 'cpu', config: defaultRadialConfig() }); await flush();
    send({ type: 'checkpoint' }); await flush();
    const original = structuredClone(doc('checkpoint'));
    for (const tamper of [
      (v: any) => { v.state.enthalpy[0] += 123; },
      (v: any) => { v.state.config.basalHeatFluxWm2 += 1; },
      (v: any) => { v.device = 'different device'; },
      (v: any) => { v.checksum.digest = '0'.repeat(64); },
      (v: any) => { delete v.checksum; },
    ]) {
      const changed = structuredClone(original); tamper(changed);
      send({ type: 'load', checkpoint: changed }); await flush();
      expect(snapshots().at(-1)).toMatchObject({ status: 'running', message: expect.stringMatching(/checksum/i) });
    }
    const changedModel = structuredClone(original); changedModel.model = 'other';
    send({ type: 'load', checkpoint: changedModel }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'running', message: expect.stringMatching(/unsupported/i) });
  });
  it('checksums GPU field values and verifies key order independently of whitespace', async () => {
    const state = createRadialState(defaultRadialConfig());
    const result = { state, gpuEnthalpy: Array.from(Float32Array.from(state.enthalpy)), errors: { maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 } };
    mocks.device.mockResolvedValue({ device: { lost: new Promise(() => {}) }, description: 'hardware' });
    mocks.gpu.mockResolvedValue({ snapshot: () => result, advance: vi.fn(), destroy: vi.fn() });
    send({ type: 'start', backend: 'gpu', config: defaultRadialConfig() }); await flush();
    send({ type: 'checkpoint' }); await flush();
    const saved = structuredClone(doc('checkpoint'));
    const reversed = Object.fromEntries(Object.entries(saved).reverse());
    send({ type: 'load', checkpoint: JSON.parse(JSON.stringify(reversed, null, 4)) }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'paused', checksumStatus: 'verified', provenance: 'imported-unverified' });
    const corrupt = structuredClone(saved); corrupt.gpuEnthalpy[0] += 10;
    send({ type: 'load', checkpoint: corrupt }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'paused', message: expect.stringMatching(/checksum mismatch/i) });
  });
  it('rejects an invalid load without interrupting a running CPU result', async () => {
    send({ type: 'start', backend: 'cpu', config: defaultRadialConfig() }); await flush();
    const previous = snapshots().at(-1).state;
    send({ type: 'load', checkpoint: { format: 'invalid' } }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'running', state: previous, message: expect.stringMatching(/unsupported/i) });
    await vi.advanceTimersByTimeAsync(30); await flush();
    expect(snapshots().at(-1).state.timeSeconds).toBeGreaterThan(previous.timeSeconds);
  });
  it('preserves the last published GPU sample when a step fails or loses the device', async () => {
    const loss = deferred<GPUDeviceLostInfo>();
    mocks.device.mockResolvedValue({ device: { lost: loss.promise }, description: 'hardware' });
    const state = createRadialState(defaultRadialConfig());
    const result = { state, gpuEnthalpy: Array.from(Float32Array.from(state.enthalpy)), errors: { maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 } };
    const session = { snapshot: vi.fn(() => result), advance: vi.fn().mockRejectedValue(new Error('accuracy limit')), destroy: vi.fn() };
    mocks.gpu.mockResolvedValue(session);
    send({ type: 'start', backend: 'gpu', config: defaultRadialConfig() }); await flush();
    await vi.advanceTimersByTimeAsync(30); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'error', state, message: 'accuracy limit' });
    send({ type: 'checkpoint' }); await flush();
    expect(doc('checkpoint').state).toEqual(state);
    loss.resolve({ message: 'lost', reason: 'unknown' } as GPUDeviceLostInfo); await flush();
    expect(snapshots().at(-1).state).toEqual(state);
  });
  it('discards a GPU step that finishes after reset', async () => {
    const step = deferred<unknown>();
    mocks.device.mockResolvedValue({ device: { lost: new Promise(() => {}) }, description: 'hardware' });
    const state = createRadialState(defaultRadialConfig());
    const result = { state, gpuEnthalpy: Array.from(Float32Array.from(state.enthalpy)), errors: { maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 } };
    const session = { snapshot: vi.fn(() => result), advance: vi.fn(() => step.promise), destroy: vi.fn() };
    mocks.gpu.mockResolvedValue(session);
    send({ type: 'start', backend: 'gpu', config: defaultRadialConfig() }); await flush();
    vi.advanceTimersByTime(30); await flush();
    send({ type: 'reset' }); await flush();
    step.resolve({ ...result, state: stepRadial(state) }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'idle' });
    expect(session.destroy).toHaveBeenCalledOnce();
  });
  it('retains the producing adapter after loss and a rejected replacement', async () => {
    const loss = deferred<GPUDeviceLostInfo>();
    const replacementLoss = deferred<GPUDeviceLostInfo>();
    mocks.device.mockResolvedValueOnce({ device: { lost: loss.promise }, description: 'adapter A' })
      .mockResolvedValueOnce({ device: { lost: replacementLoss.promise }, description: 'adapter B' });
    const state = createRadialState(defaultRadialConfig());
    const session = { snapshot: () => ({ state, gpuEnthalpy: Array.from(Float32Array.from(state.enthalpy)), errors: { maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 } }), advance: vi.fn(), destroy: vi.fn() };
    mocks.gpu.mockResolvedValueOnce(session).mockRejectedValueOnce(new Error('replacement rejected'));
    send({ type: 'start', backend: 'gpu', config: defaultRadialConfig() }); await flush();
    loss.resolve({ message: 'lost', reason: 'unknown' } as GPUDeviceLostInfo); await flush();
    send({ type: 'start', backend: 'gpu', config: defaultRadialConfig() }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'error', device: 'adapter A', message: 'replacement rejected' });
    send({ type: 'export' }); await flush();
    expect(doc('export').device).toBe('adapter A');
  });
});
