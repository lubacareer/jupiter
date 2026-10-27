import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Message = { type: string; [key: string]: unknown };
describe('simulation process', () => {
  let receive: (event: { data: Message }) => void;
  let sent: Message[];
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    sent = [];
    Object.defineProperty(process, 'parentPort', { configurable: true, value: {
      on: (_name: string, callback: typeof receive) => { receive = callback; },
      postMessage: (message: Message) => sent.push(message),
    } });
    await import('../src/simulation/worker');
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (process as unknown as { parentPort?: unknown }).parentPort;
  });
  it('runs, pauses, saves and restores a checkpoint without advancing while paused', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.01, semiMajorAxisKm: 671000 } } });
    vi.advanceTimersByTime(300);
    receive({ data: { type: 'pause' } });
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as { state: { timeSeconds: number }; samples: unknown[] };
    expect(saved.state.timeSeconds).toBe(10800);
    expect(saved.samples).toHaveLength(4);
    vi.advanceTimersByTime(500);
    receive({ data: { type: 'getCheckpoint' } });
    expect((sent.at(-1)?.checkpoint as typeof saved).state.timeSeconds).toBe(saved.state.timeSeconds);
    receive({ data: { type: 'reset' } });
    receive({ data: { type: 'load', checkpoint: saved } });
    const snapshot = sent.at(-1)?.snapshot as { status: string; timeSeconds: number };
    expect(snapshot.status).toBe('paused');
    expect(snapshot.timeSeconds).toBe(saved.state.timeSeconds);
    receive({ data: { type: 'pause' } });
    vi.advanceTimersByTime(100);
    receive({ data: { type: 'getCheckpoint' } });
    expect((sent.at(-1)?.checkpoint as typeof saved).state.timeSeconds).toBe(saved.state.timeSeconds + 3600);
  });
  it('rejects invalid starts and checkpoints without corrupting the existing state', () => {
    receive({ data: { type: 'start', parameters: { eccentricity: 0.01, semiMajorAxisKm: 671000 } } });
    receive({ data: { type: 'pause' } });
    receive({ data: { type: 'start', parameters: { eccentricity: 2, semiMajorAxisKm: 671000 } } });
    receive({ data: { type: 'getCheckpoint' } });
    const saved = sent.at(-1)?.checkpoint as { parameters: { eccentricity: number }; state: { timeSeconds: number } };
    expect(saved.parameters.eccentricity).toBe(0.01);
    receive({ data: { type: 'load', checkpoint: { version: 1 } } });
    receive({ data: { type: 'getCheckpoint' } });
    expect(sent.at(-1)?.checkpoint).toEqual(saved);
  });
});
