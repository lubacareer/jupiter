import { createInitialOrbit, orbitDiagnostics, stepOrbit, type OrbitState } from './orbit';

type Sample = { timeSeconds: number; eccentricity: number; semiMajorAxisKm: number; resonanceAngleDeg: number };
type Parameters = { eccentricity: number; semiMajorAxisKm: number };
type Checkpoint = { version: 1; state: OrbitState; parameters: Parameters; samples: Sample[] };
type Command = { type: 'start'; parameters: Parameters } | { type: 'pause' | 'reset' | 'getCheckpoint' | 'getExport' } | { type: 'load'; checkpoint: unknown };
type Channel = { postMessage: (data: unknown) => void; on: (name: string, cb: (event: { data: Command }) => void) => void };
const parent = (process as unknown as { parentPort: Channel }).parentPort;
let state: OrbitState | null = null;
let parameters: Parameters | null = null;
let samples: Sample[] = [];
let status: 'idle' | 'running' | 'paused' | 'error' = 'idle';
const dt = 300;

function sample(): Sample {
  if (!state) throw new Error('No simulation is loaded');
  const d = orbitDiagnostics(state);
  return { timeSeconds: state.timeSeconds, eccentricity: d.eccentricity, semiMajorAxisKm: d.semiMajorAxisKm, resonanceAngleDeg: d.laplaceAngleDeg };
}
function checkpoint(): Checkpoint {
  if (!state || !parameters) throw new Error('No simulation is loaded');
  return { version: 1, state, parameters, samples };
}
function snapshot(message?: string) {
  parent.postMessage({ type: 'snapshot', snapshot: { status, timeSeconds: state?.timeSeconds ?? 0, samples, message, gpuStatus: 'GPU solver unavailable · orbital integrator uses CPU float64' } });
}
function validCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const c = value as Checkpoint;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(finite);
  if (c.version !== 1 || !c.parameters || !finite(c.parameters.eccentricity) || c.parameters.eccentricity < 0 || c.parameters.eccentricity >= 1 || !finite(c.parameters.semiMajorAxisKm) || c.parameters.semiMajorAxisKm <= 0 || !c.state || !finite(c.state.timeSeconds) || c.state.timeSeconds < 0 || !Array.isArray(c.state.bodies) || c.state.bodies.length !== 4 || !Array.isArray(c.samples) || c.samples.length > 2000) return false;
  if (new Set(c.state.bodies.map(b => b.name)).size !== 4 || !['Jupiter', 'Io', 'Europa', 'Ganymede'].every(n => c.state.bodies.some(b => b.name === n))) return false;
  return c.state.bodies.every(b => finite(b.gm) && b.gm > 0 && vec(b.position) && vec(b.velocity)) && c.samples.every((s, i) => s && finite(s.timeSeconds) && s.timeSeconds >= 0 && s.timeSeconds <= c.state.timeSeconds && (i === 0 || s.timeSeconds > c.samples[i - 1].timeSeconds) && finite(s.eccentricity) && finite(s.semiMajorAxisKm) && finite(s.resonanceAngleDeg));
}
parent.on('message', ({ data: command }) => {
  try {
    switch (command.type) {
      case 'start':
        {
        const nextState = createInitialOrbit(command.parameters);
        const d = orbitDiagnostics(nextState);
        parameters = command.parameters;
        state = nextState;
        samples = [{ timeSeconds: state.timeSeconds, eccentricity: d.eccentricity, semiMajorAxisKm: d.semiMajorAxisKm, resonanceAngleDeg: d.laplaceAngleDeg }];
        status = 'running';
        snapshot('Point-mass gravity only; no tidal back-reaction. Plot and export retain the latest 2,000 samples.');
        break;
        }
      case 'pause':
        if (status === 'running') status = 'paused';
        else if (status === 'paused') status = 'running';
        snapshot();
        break;
      case 'reset': state = null; parameters = null; samples = []; status = 'idle'; snapshot(); break;
      case 'load':
        if (!validCheckpoint(command.checkpoint)) throw new Error('Invalid or unsupported checkpoint');
        orbitDiagnostics(command.checkpoint.state);
        ({ state, parameters, samples } = command.checkpoint);
        status = 'paused'; snapshot('Checkpoint loaded; resume to continue.'); break;
      case 'getCheckpoint': parent.postMessage({ type: 'checkpoint', checkpoint: checkpoint() }); break;
      case 'getExport': parent.postMessage({ type: 'export', checkpoint: checkpoint() }); break;
    }
  } catch (error) {
    status = state ? 'paused' : 'error';
    snapshot(error instanceof Error ? error.message : 'Simulation failed');
  }
});
setInterval(() => {
  if (status !== 'running' || !state) return;
  try {
    for (let i = 0; i < 12; i++) state = stepOrbit(state, dt);
    samples.push(sample());
    if (samples.length > 2000) samples.shift();
    snapshot();
  } catch (error) {
    status = 'error'; snapshot(error instanceof Error ? error.message : 'Integration failed');
  }
}, 100);
snapshot('Point-mass gravity only; no tidal back-reaction.');
