import { createInitialOrbit, orbitDiagnostics, stepOrbit, type OrbitState, type BodyName } from './orbit';
import { CHECKPOINT_MODEL, checkpointDigest, verifyCheckpointIntegrity } from './checkpointIntegrity';

type Sample = { timeSeconds: number; eccentricity: number; semiMajorAxisKm: number; resonanceAngleDeg: number };
type Parameters = { eccentricity: number; semiMajorAxisKm: number };
type Overrides = Partial<Parameters>;
type Provenance = 'local' | 'imported-unverified';
type CheckpointPayload = { version: 3; state: OrbitState; parameters: Parameters; initialOverrides: Overrides; samples: Sample[]; provenance: Provenance; model: typeof CHECKPOINT_MODEL };
type Checkpoint = CheckpointPayload & { checksum: { algorithm: 'sha256'; digest: string } };
type LoadedCheckpoint = { state: OrbitState; parameters: Parameters; initialOverrides: Overrides; samples: Sample[]; provenance: Provenance; checksumStatus: 'verified' | 'unavailable' };
type Command = { type: 'start'; parameters: Overrides } | { type: 'pause' | 'reset' | 'getCheckpoint' | 'getExport' } | { type: 'load'; checkpoint: unknown };
type Channel = { postMessage: (data: unknown) => void; on: (name: string, cb: (event: { data: Command }) => void) => void };
const parent = (process as unknown as { parentPort: Channel }).parentPort;
const epoch = createInitialOrbit();
const epochDiagnostics = orbitDiagnostics(epoch);
const defaultParameters: Parameters = { eccentricity: epochDiagnostics.eccentricity, semiMajorAxisKm: epochDiagnostics.semiMajorAxisKm };
const modelGms = new Map(epoch.bodies.map(body => [body.name, body.gm]));
let state: OrbitState | null = null;
let parameters: Parameters | null = null;
let initialOverrides: Overrides = {};
let samples: Sample[] = [];
let provenance: Provenance = 'local';
let checksumStatus: 'verified' | 'unavailable' | undefined;
let status: 'idle' | 'running' | 'paused' | 'error' = 'idle';
let notice: string | undefined = 'Point-mass gravity only; no tidal back-reaction.';
let restoreRevision = 0;
let restoredParameters: Parameters | undefined;
let restoredOverrides: Overrides | undefined;
const dt = 300;

function sampleFor(current: OrbitState): Sample {
  const d = orbitDiagnostics(current);
  return { timeSeconds: current.timeSeconds, eccentricity: d.eccentricity, semiMajorAxisKm: d.semiMajorAxisKm, resonanceAngleDeg: d.laplaceAngleDeg };
}
function checkpoint(): Checkpoint {
  if (!state || !parameters) throw new Error('No simulation is loaded');
  const payload: CheckpointPayload = { version: 3, state, parameters, initialOverrides, samples, provenance, model: CHECKPOINT_MODEL };
  return { ...payload, checksum: { algorithm: 'sha256', digest: checkpointDigest(payload) } };
}
function snapshot() {
  parent.postMessage({ type: 'snapshot', snapshot: { status, timeSeconds: state?.timeSeconds ?? 0, samples, message: notice, gpuStatus: 'GPU solver unavailable · orbital integrator uses CPU float64', defaultParameters, restoreRevision, restoredParameters, restoredOverrides, provenance, checksumStatus } });
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validE = (value: unknown): value is number => finite(value) && value >= 0 && value < 1;
const validA = (value: unknown): value is number => finite(value) && value > 0;
const validParameters = (value: unknown): value is Parameters =>
  isObject(value) && validE(value.eccentricity) && validA(value.semiMajorAxisKm);
function parseOverrides(value: unknown): Overrides {
  if (!isObject(value) || Object.keys(value).some(key => key !== 'eccentricity' && key !== 'semiMajorAxisKm') ||
      ('eccentricity' in value && !validE(value.eccentricity)) ||
      ('semiMajorAxisKm' in value && !validA(value.semiMajorAxisKm))) throw new Error('Invalid orbital parameters');
  return {
    ...('eccentricity' in value ? { eccentricity: value.eccentricity as number } : {}),
    ...('semiMajorAxisKm' in value ? { semiMajorAxisKm: value.semiMajorAxisKm as number } : {}),
  };
}
function nearlyEqual(a: number, b: number, absolute: number, relative = 1e-12): boolean {
  return Math.abs(a - b) <= absolute + relative * Math.max(Math.abs(a), Math.abs(b));
}
function nearlyEqualAngle(a: number, b: number, tolerance: number): boolean {
  const radians = (a - b) * Math.PI / 180;
  return Math.abs(Math.atan2(Math.sin(radians), Math.cos(radians)) * 180 / Math.PI) <= tolerance;
}
/** Structural and model consistency checks cannot authenticate a user-supplied file. */
function parseCheckpoint(value: unknown): LoadedCheckpoint {
  if (!isObject(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) throw new Error('Invalid or unsupported checkpoint');
  if (value.version === 3) verifyCheckpointIntegrity(value);
  if (!validParameters(value.parameters) ||
      !isObject(value.state) || !finite(value.state.timeSeconds) || value.state.timeSeconds < 0 ||
      !Array.isArray(value.state.bodies) || value.state.bodies.length !== 4 ||
      !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 2000) throw new Error('Invalid or unsupported checkpoint');
  const bodies = value.state.bodies;
  const names = new Set<string>();
  const vector = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(finite);
  for (const body of bodies) {
    if (!isObject(body) || typeof body.name !== 'string' || !modelGms.has(body.name as BodyName) ||
        names.has(body.name) || body.gm !== modelGms.get(body.name as BodyName) ||
        !vector(body.position) || !vector(body.velocity)) throw new Error('Invalid checkpoint body or model constants');
    names.add(body.name);
  }
  const stateTime = value.state.timeSeconds;
  let previousTime = -1;
  for (const item of value.samples) {
    if (!isObject(item) || !finite(item.timeSeconds) || item.timeSeconds < 0 || item.timeSeconds > stateTime ||
        item.timeSeconds <= previousTime || !validE(item.eccentricity) || !validA(item.semiMajorAxisKm) ||
        !finite(item.resonanceAngleDeg) || item.resonanceAngleDeg < -180 || item.resonanceAngleDeg > 180) throw new Error('Invalid checkpoint sample history');
    previousTime = item.timeSeconds;
  }
  const typedState = value.state as unknown as OrbitState;
  const actual = sampleFor(typedState);
  const last = value.samples[value.samples.length - 1] as Sample;
  if (last.timeSeconds !== stateTime || !nearlyEqual(last.eccentricity, actual.eccentricity, 1e-10) ||
      !nearlyEqual(last.semiMajorAxisKm, actual.semiMajorAxisKm, 1e-5) ||
      !nearlyEqualAngle(last.resonanceAngleDeg, actual.resonanceAngleDeg, 1e-7)) throw new Error('Checkpoint history does not match its current state');
  // Older files may contain extra parameter fields; retain only the supported
  // inputs so restored overrides can always be passed back to Start.
  const normalizedParameters: Parameters = { eccentricity: value.parameters.eccentricity, semiMajorAxisKm: value.parameters.semiMajorAxisKm };
  const overrides = value.version === 1 ? { ...normalizedParameters } : parseOverrides(value.initialOverrides);
  if (value.version !== 1) {
    const expected = { ...defaultParameters, ...overrides };
    if (!nearlyEqual(expected.eccentricity, normalizedParameters.eccentricity, 1e-10) ||
        !nearlyEqual(expected.semiMajorAxisKm, normalizedParameters.semiMajorAxisKm, 1e-5) ||
        (value.provenance !== 'local' && value.provenance !== 'imported-unverified')) throw new Error('Invalid checkpoint initial parameters or provenance');
  }
  return { state: typedState, parameters: normalizedParameters, initialOverrides: overrides, samples: value.samples as Sample[], provenance: 'imported-unverified', checksumStatus: value.version === 3 ? 'verified' : 'unavailable' };
}
parent.on('message', ({ data: command }) => {
  const previousStatus = status;
  try {
    switch (command.type) {
      case 'start': {
        const nextOverrides = parseOverrides(command.parameters);
        const nextState = createInitialOrbit(nextOverrides);
        const nextSample = sampleFor(nextState);
        state = nextState;
        parameters = { ...defaultParameters, ...nextOverrides };
        initialOverrides = nextOverrides;
        // Keep the last snapshot usable by a newly mounted renderer without
        // incrementing the load revision or resetting a live editor's drafts.
        restoredParameters = { ...parameters };
        restoredOverrides = { ...initialOverrides };
        samples = [nextSample];
        provenance = 'local';
        checksumStatus = undefined;
        status = 'running';
        notice = 'Point-mass gravity only; no tidal back-reaction. Plot and export retain the latest 2,000 samples.';
        snapshot();
        break;
      }
      case 'pause':
        if (status === 'running') status = 'paused';
        else if (status === 'paused') status = 'running';
        notice = undefined;
        snapshot();
        break;
      case 'reset':
        state = null; parameters = null; initialOverrides = {}; samples = []; provenance = 'local'; checksumStatus = undefined; status = 'idle'; notice = undefined;
        restoredParameters = undefined; restoredOverrides = undefined; snapshot(); break;
      case 'load': {
        const loaded = parseCheckpoint(command.checkpoint);
        ({ state, parameters, initialOverrides, samples, provenance, checksumStatus } = loaded);
        restoredParameters = { ...loaded.parameters };
        restoredOverrides = { ...loaded.initialOverrides };
        restoreRevision++;
        status = 'paused';
        notice = checksumStatus === 'verified' ? 'Checksum verified; imported origin remains unverified. Resume to continue.' : 'Legacy checkpoint checksum unavailable; imported origin remains unverified. Resume to continue.';
        snapshot();
        break;
      }
      case 'getCheckpoint': parent.postMessage({ type: 'checkpoint', checkpoint: checkpoint() }); break;
      case 'getExport': parent.postMessage({ type: 'export', checkpoint: checkpoint() }); break;
    }
  } catch (error) {
    // Invalid commands do not interrupt an existing integration.
    status = state ? previousStatus : 'error';
    notice = error instanceof Error ? error.message : 'Command failed';
    snapshot();
  }
});
setInterval(() => {
  if (status !== 'running' || !state) return;
  try {
    let next = state;
    for (let i = 0; i < 12; i++) next = stepOrbit(next, dt);
    const nextSample = sampleFor(next);
    state = next;
    samples.push(nextSample);
    if (samples.length > 2000) samples.shift();
    snapshot();
  } catch (error) {
    status = 'error'; notice = error instanceof Error ? error.message : 'Integration failed'; snapshot();
  }
}, 100);
snapshot();
