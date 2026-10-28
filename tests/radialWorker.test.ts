import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRadialState, defaultRadialConfig, stepRadial } from '../src/simulation/radialInterior';

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
    expect(saved.format).toBe('europa-radial-checkpoint-v1');
    expect(doc('export').format).toBe('europa-radial-export-v1');
    expect(saved.units.enthalpy).toBe('J/m^3');
    send({ type: 'reset' }); send({ type: 'load', checkpoint: saved }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'paused', provenance: 'imported-unverified', state: saved.state });
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
