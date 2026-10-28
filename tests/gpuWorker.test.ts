import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialOrbit, stepOrbit } from '../src/simulation/orbit';
import { makeOrbitalBaseline, makeOrbitalSample } from '../src/simulation/orbitAnalysis';
import { createGpuCheckpoint, exportGpuResult, parseGpuCheckpoint } from '../src/simulation/gpuCheckpoint';

const mocks = vi.hoisted(() => ({ getDevice: vi.fn(), createOrbit: vi.fn(), createThermal: vi.fn() }));
vi.mock('../src/simulation/gpuDevice', () => ({ requestHardwareDevice: mocks.getDevice }));
vi.mock('../src/simulation/gpuOrbit', () => ({ createGpuOrbit: mocks.createOrbit }));
vi.mock('../src/simulation/gpuThermal', () => ({ createGpuThermal: mocks.createThermal }));

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let worker: { onmessage?: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
let session: { sample: ReturnType<typeof vi.fn>; advance: ReturnType<typeof vi.fn>; checkpoint: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
const initial = createInitialOrbit();
const sample = { state: initial, reference: initial, errorKm: 0, steps: 0, maxSteps: 100, completed: false };
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

  it.each([
    'Thermal energy accounting does not match the reference state',
    'GPU thermal accuracy limit exceeded: normalizedEnergy',
  ])('keeps an active run when a thermal checkpoint is rejected: %s', async (message) => {
    send({ type: 'start-orbit', parameters: {} }); await flush();
    mocks.createThermal.mockRejectedValue(new RangeError(message));
    send({ type: 'load', checkpoint: { mode: 'thermal', data: {}, history: [{ timeSeconds: 0, error: 0 }] } }); await flush();
    expect(snapshots().at(-1).status).toBe('running');
    expect(snapshots().at(-1).message).toBe(message);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('does not start a second GPU step when paused and resumed during a pending step', async () => {
    const step = deferred<typeof sample>();
    session.advance.mockImplementation((validate: (candidate: typeof sample) => void) => step.promise.then(candidate => { validate(candidate); return candidate; }));
    send({ type: 'start-orbit', parameters: {} }); await flush();
    vi.advanceTimersByTime(30); await flush();
    expect(session.advance).toHaveBeenCalledTimes(1);
    send({ type: 'pause' }); send({ type: 'resume' }); await flush();
    vi.advanceTimersByTime(100); await flush();
    expect(session.advance).toHaveBeenCalledTimes(1);
    let advanced = initial;
    for (let i = 0; i < 12; i++) advanced = stepOrbit(advanced, 300);
    step.resolve({ ...sample, state: advanced, reference: advanced, steps: 12 }); await flush();
    vi.advanceTimersByTime(30); await flush();
    expect(session.advance).toHaveBeenCalledTimes(2);
  });

  it('creates analysis only for accepted states and preserves it on a failed comparison', async () => {
    session.advance.mockRejectedValue(new Error('GPU orbital comparison exceeded 10 km'));
    send({ type: 'start-orbit', parameters: {} }); await flush();
    const started = snapshots().at(-1);
    expect(started.orbitAnalysisBaseline.kind).toBe('initial');
    expect(started.orbitAnalysisSamples).toHaveLength(1);
    expect(started.orbitAnalysisSamples[0].positionsKm.Europa).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30); await flush();
    const failed = snapshots().at(-1);
    expect(failed.status).toBe('error');
    expect(failed.orbitAnalysisSamples).toEqual(started.orbitAnalysisSamples);
  });

  it('retains the previous published state when candidate analysis fails', async () => {
    session.advance.mockImplementation(async (validate: (candidate: typeof sample) => void) => {
      const invalid = structuredClone(sample);
      invalid.state.bodies[2].position[0] = NaN;
      validate(invalid);
      return invalid;
    });
    send({ type: 'start-orbit', parameters: {} }); await flush();
    const started = snapshots().at(-1);
    await vi.advanceTimersByTimeAsync(30); await flush();
    const failed = snapshots().at(-1);
    expect(failed.status).toBe('error');
    expect(failed.orbit).toEqual(started.orbit);
    expect(failed.orbitAnalysisSamples).toEqual(started.orbitAnalysisSamples);
    expect(failed.history).toEqual(started.history);
  });

  it('saves the last published state if device loss overtakes a completed step', async () => {
    const lost = deferred<{ message: string; reason: string }>();
    mocks.getDevice.mockResolvedValue({ device: { lost: lost.promise }, description: 'test hardware' });
    const step = deferred<typeof sample>();
    session.advance.mockImplementation((validate: (candidate: typeof sample) => void) => step.promise.then(candidate => { validate(candidate); return candidate; }));
    const published = { version: 1, steps: 0 };
    session.checkpoint.mockReturnValue(published);
    send({ type: 'start-orbit', parameters: {} }); await flush();
    vi.advanceTimersByTime(30); await flush();
    let later = initial;
    for (let i = 0; i < 12; i++) later = stepOrbit(later, 300);
    session.checkpoint.mockReturnValue({ version: 1, steps: 12 });
    lost.resolve({ message: 'device removed', reason: 'unknown' }); await flush();
    step.resolve({ ...sample, state: later, reference: later, steps: 12 }); await flush();
    send({ type: 'checkpoint' }); await flush();
    const sent = worker.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'checkpoint').at(-1);
    expect(sent.checkpoint.data).toEqual(published);
    expect(sent.checkpoint.history).toEqual([{ timeSeconds: 0, error: 0 }]);
    expect(sent.checkpoint.orbitAnalysisSamples).toHaveLength(1);
    expect(snapshots().at(-1).status).toBe('error');
  });

  it('saves the last published thermal state when device loss overtakes a completed step', async () => {
    const lost = deferred<{ message: string; reason: string }>();
    mocks.getDevice.mockResolvedValue({ device: { lost: lost.promise }, description: 'test hardware' });
    const errors = { maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 };
    const first = { version: 1, time: 0, errors, gpuEnthalpy: [1], referenceEnthalpy: [1] };
    const later = { ...first, time: 10, gpuEnthalpy: [2], referenceEnthalpy: [2] };
    const step = deferred<typeof first>();
    let live = first;
    const thermal = { snapshot: vi.fn(() => live), advance: vi.fn(() => step.promise), destroy: vi.fn() };
    mocks.createThermal.mockResolvedValue(thermal);
    send({ type: 'start-thermal', config: {} }); await flush();
    send({ type: 'checkpoint' }); await flush();
    expect(worker.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'checkpoint').at(-1).checkpoint.data).toEqual(first);
    vi.advanceTimersByTime(30); await flush();
    live = later; // The session advanced, but its result has not been published.
    lost.resolve({ message: 'device removed', reason: 'unknown' }); await flush();
    step.resolve(later); await flush();
    send({ type: 'checkpoint' }); send({ type: 'export' }); await flush();
    for (const kind of ['checkpoint', 'export']) {
      const result = worker.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === kind).at(-1).checkpoint;
      expect(result.data).toEqual(first);
      expect(result.history).toEqual([{ timeSeconds: 0, error: 0 }]);
    }
    expect(snapshots().at(-1)).toMatchObject({ status: 'error', thermal: first });
    send({ type: 'reset' }); send({ type: 'checkpoint' }); await flush();
    expect(snapshots().at(-1).message).toMatch(/No GPU experiment/);
  });

  it('saves the updated thermal state after the matching history is published', async () => {
    const errors = { maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 };
    const first = { version: 1, time: 0, errors };
    const later = { version: 1, time: 10, errors };
    let live = first;
    mocks.createThermal.mockResolvedValue({ snapshot: () => live, advance: async () => { live = later; return later; }, destroy: vi.fn() });
    send({ type: 'start-thermal', config: {} }); await flush();
    await vi.advanceTimersByTimeAsync(30); await flush();
    send({ type: 'checkpoint' }); await flush();
    const saved = worker.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'checkpoint').at(-1).checkpoint;
    expect(saved.data).toEqual(later);
    expect(saved.history).toEqual([{ timeSeconds: 0, error: 0 }, { timeSeconds: 10, error: 0 }]);
  });

  it('does not relabel an old result when a replacement adapter fails', async () => {
    const lostA = deferred<{ message: string; reason: string }>();
    const lostB = deferred<{ message: string; reason: string }>();
    mocks.getDevice.mockResolvedValueOnce({ device: { lost: lostA.promise }, description: 'adapter A' })
      .mockResolvedValueOnce({ device: { lost: lostB.promise }, description: 'adapter B' });
    send({ type: 'start-orbit', parameters: {} }); await flush();
    lostA.resolve({ message: 'removed', reason: 'unknown' }); await flush();
    mocks.createOrbit.mockRejectedValueOnce(new Error('replacement rejected'));
    send({ type: 'start-orbit', parameters: {} }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'error', device: 'adapter A', message: 'replacement rejected' });
    send({ type: 'probe' }); await flush();
    expect(snapshots().at(-1).device).toBe('adapter A');
    send({ type: 'checkpoint' }); await flush();
    expect(worker.postMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'checkpoint').at(-1).checkpoint.data).toEqual({});
  });

  it('anchors legacy restores at the restored state without fabricating a trail', async () => {
    let later = initial;
    for (let i = 0; i < 12; i++) later = stepOrbit(later, 300);
    session.sample.mockReturnValue({ ...sample, state: later, reference: later, steps: 12 });
    session.checkpoint.mockReturnValue({ version: 1, initialState: initial, reference: later, packedState: [], steps: 12, maxSteps: 100 });
    send({ type: 'load', checkpoint: { mode: 'orbit', data: { initialState: initial }, history: [{ timeSeconds: 0, error: 0 }, { timeSeconds: 3600, error: 0 }] } });
    await flush();
    const restored = snapshots().at(-1);
    expect(restored.status).toBe('paused');
    expect(restored.provenance).toBe('imported-unverified');
    expect(restored.orbitAnalysisBaseline).toMatchObject({ kind: 'restored', timeSeconds: 3600 });
    expect(restored.orbitAnalysisSamples.map((item: { timeSeconds: number }) => item.timeSeconds)).toEqual([3600]);
    send({ type: 'checkpoint' }); await flush();
    const checkpoint = worker.postMessage.mock.calls.map(call => call[0]).reverse().find(message => message.type === 'checkpoint').checkpoint;
    const saved = await createGpuCheckpoint('orbit', checkpoint, {}, { origin: 'unverified', input: 'imported', checksum: 'verified' });
    expect(saved.version).toBe(5);
    const parsed = await parseGpuCheckpoint(saved);
    expect(parsed.checkpoint.data.history).toEqual([{ timeSeconds: 0, error: 0 }, { timeSeconds: 3600, error: 0 }]);
    const exported = exportGpuResult('orbit', parsed.checkpoint.data, {}, parsed.provenance) as any;
    expect(exported.data.history).toEqual(parsed.checkpoint.data.history);
    send({ type: 'load', checkpoint: parsed.checkpoint.data }); await flush();
    expect(snapshots().at(-1).orbitAnalysisBaseline).toMatchObject({ kind: 'restored', timeSeconds: 3600 });
    expect(snapshots().at(-1).orbitAnalysisSamples).toHaveLength(1);
  });

  it('does not resume a checkpoint that has already reached the orbital step limit', async () => {
    session.sample.mockReturnValue({ ...sample, steps: 100, completed: true });
    send({ type: 'load', checkpoint: { mode: 'orbit', data: { initialState: initial }, history: [{ timeSeconds: 0, error: 0 }] } });
    await flush();
    expect(snapshots().at(-1).status).toBe('completed');
    send({ type: 'resume' }); await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(session.advance).not.toHaveBeenCalled();
    expect(snapshots().at(-1).history).toHaveLength(1);
  });

  it('restores valid analysis and rejects a mismatched history without replacing the active run', async () => {
    send({ type: 'start-orbit', parameters: {} }); await flush();
    const baseline = makeOrbitalBaseline(initial, 'initial');
    const analysis = makeOrbitalSample(initial, baseline);
    const candidate = { ...session, dispose: vi.fn() };
    mocks.createOrbit.mockResolvedValue(candidate);
    const checkpoint = { mode: 'orbit', data: { initialState: initial }, history: [{ timeSeconds: 0, error: 0 }], orbitAnalysisBaseline: baseline, orbitAnalysisSamples: [analysis] };
    send({ type: 'load', checkpoint: { ...checkpoint, orbitAnalysisSamples: [{ ...analysis, eccentricity: analysis.eccentricity + 0.1 }] } }); await flush();
    expect(snapshots().at(-1).status).toBe('running');
    expect(snapshots().at(-1).message).toMatch(/does not match/);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();
    send({ type: 'load', checkpoint }); await flush();
    expect(snapshots().at(-1)).toMatchObject({ status: 'paused', provenance: 'imported-unverified', orbitAnalysisBaseline: baseline, orbitAnalysisSamples: [analysis] });
  });

  it.each([
    ['non-finite vector', (item: any) => { item.positionsKm.Europa[0] = NaN; }],
    ['negative drift', (item: any) => { item.energyDrift = -1; }],
    ['missing analysis', (item: any) => { delete item.positionsKm; }],
    ['unmatched time', (item: any) => { item.timeSeconds = 1; }],
  ])('rejects imported analysis with %s while preserving the active run', async (_label, mutate) => {
    send({ type: 'start-orbit', parameters: {} }); await flush();
    const baseline = makeOrbitalBaseline(initial, 'initial');
    const analysis = structuredClone(makeOrbitalSample(initial, baseline));
    mutate(analysis);
    const candidate = { ...session, dispose: vi.fn() };
    mocks.createOrbit.mockResolvedValue(candidate);
    send({ type: 'load', checkpoint: { mode: 'orbit', data: { initialState: initial }, history: [{ timeSeconds: 0, error: 0 }], orbitAnalysisBaseline: baseline, orbitAnalysisSamples: [analysis] } });
    await flush();
    expect(snapshots().at(-1).status).toBe('running');
    expect(snapshots().at(-1).message).toMatch(/invalid/i);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();
  });
});
