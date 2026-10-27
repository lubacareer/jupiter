import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getDevice: vi.fn(), createOrbit: vi.fn(), createThermal: vi.fn() }));
vi.mock('../src/simulation/gpuDevice', () => ({ requestHardwareDevice: mocks.getDevice }));
vi.mock('../src/simulation/gpuOrbit', () => ({ createGpuOrbit: mocks.createOrbit }));
vi.mock('../src/simulation/gpuThermal', () => ({ createGpuThermal: mocks.createThermal }));

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let worker: { onmessage?: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
let session: { sample: ReturnType<typeof vi.fn>; advance: ReturnType<typeof vi.fn>; checkpoint: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
const sample = { state: { timeSeconds: 0 }, reference: { timeSeconds: 0 }, errorKm: 0, steps: 0, maxSteps: 100, completed: false };
const device = { lost: new Promise(() => {}) };
const send = (data: unknown) => worker.onmessage!({ data });
const snapshots = () => worker.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'snapshot').map(message => message.snapshot);

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  worker = { postMessage: vi.fn() }; vi.stubGlobal('self', worker);
  session = { sample: vi.fn(() => sample), advance: vi.fn(), checkpoint: vi.fn(() => ({})), dispose: vi.fn() };
  mocks.getDevice.mockReset().mockResolvedValue({ device, description: 'test hardware' });
  mocks.createOrbit.mockReset().mockResolvedValue(session);
  mocks.createThermal.mockReset();
  await import('../src/simulation/gpuWorker');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('GPU worker command ordering', () => {
  it('serializes a slow start and subsequent reset', async () => {
    const selected = deferred<{ device: typeof device; description: string }>();
    mocks.getDevice.mockReturnValue(selected.promise);
    send({ type: 'start-orbit', parameters: {} }); send({ type: 'reset' });
    await flush();
    selected.resolve({ device, description: 'test hardware' }); await flush();
    expect(snapshots().at(-1).status).toBe('idle');
    expect(session.dispose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(session.advance).not.toHaveBeenCalled();
  });

  it('rejects a bad checkpoint without interrupting the active run', async () => {
    send({ type: 'start-orbit', parameters: {} }); await flush();
    send({ type: 'load', checkpoint: { mode: 'orbit', data: {}, history: [{ timeSeconds: 0, error: 11 }] } }); await flush();
    expect(snapshots().at(-1).status).toBe('running');
    expect(snapshots().at(-1).message).toMatch(/history/);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('does not start a second GPU step when paused and resumed during a pending step', async () => {
    const step = deferred<typeof sample>();
    session.advance.mockReturnValue(step.promise);
    send({ type: 'start-orbit', parameters: {} }); await flush();
    vi.advanceTimersByTime(30); await flush();
    expect(session.advance).toHaveBeenCalledTimes(1);
    send({ type: 'pause' }); send({ type: 'resume' }); await flush();
    vi.advanceTimersByTime(100); await flush();
    expect(session.advance).toHaveBeenCalledTimes(1);
    step.resolve({ ...sample, state: { timeSeconds: 3600 }, reference: { timeSeconds: 3600 }, steps: 12 }); await flush();
    vi.advanceTimersByTime(30); await flush();
    expect(session.advance).toHaveBeenCalledTimes(2);
  });
});
