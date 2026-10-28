import { createInitialOrbit, orbitDiagnostics, stepOrbit, type OrbitState, type OrbitBody, type BodyName, type Vec3 } from './orbit';
import { CHECKPOINT_MODEL, checkpointDigest, verifyCheckpointIntegrity } from './checkpointIntegrity';
import { makeOrbitalBaseline, makeOrbitalSample, parseOrbitalBaseline, parseOrbitalSample, type OrbitalBaseline, type OrbitalSample } from './orbitAnalysis';

type Sample = OrbitalSample;
type Parameters = { eccentricity: number; semiMajorAxisKm: number };
type Overrides = Partial<Parameters>;
type Provenance = 'local' | 'imported-unverified';
type CheckpointPayload = { version: 4; state: OrbitState; parameters: Parameters; initialOverrides: Overrides; samples: Sample[]; baseline: OrbitalBaseline; provenance: Provenance; model: typeof CHECKPOINT_MODEL };
type Checkpoint = CheckpointPayload & { checksum: { algorithm: 'sha256'; digest: string } };
type LoadedCheckpoint = { state: OrbitState; parameters: Parameters; initialOverrides: Overrides; samples: Sample[]; baseline: OrbitalBaseline; provenance: Provenance; checksumStatus: 'verified' | 'unavailable' };
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
let baseline: OrbitalBaseline | null = null;
let provenance: Provenance = 'local';
let checksumStatus: 'verified' | 'unavailable' | undefined;
let status: 'idle' | 'running' | 'paused' | 'error' = 'idle';
let notice: string | undefined = 'Point-mass gravity only; no tidal back-reaction.';
let restoreRevision = 0;
let restoredParameters: Parameters | undefined;
let restoredOverrides: Overrides | undefined;
const dt = 300;

function sampleFor(current: OrbitState, reference: OrbitalBaseline): Sample {
  return makeOrbitalSample(current, reference);
}
function checkpoint(): Checkpoint {
  if (!state || !parameters || !baseline) throw new Error('No simulation is loaded');
  const payload: CheckpointPayload = { version: 4, state, parameters, initialOverrides, samples, baseline, provenance, model: CHECKPOINT_MODEL };
  return { ...payload, checksum: { algorithm: 'sha256', digest: checkpointDigest(payload) } };
}
function snapshot() {
  parent.postMessage({ type: 'snapshot', snapshot: { status, timeSeconds: state?.timeSeconds ?? 0, samples, baseline: baseline ?? undefined, message: notice, gpuStatus: 'GPU solver unavailable · orbital integrator uses CPU float64', defaultParameters, restoreRevision, restoredParameters, restoredOverrides, provenance, checksumStatus } });
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
  if (!isObject(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)) throw new Error('Invalid or unsupported checkpoint');
  if (value.version === 3 || value.version === 4) verifyCheckpointIntegrity(value);
  if (!validParameters(value.parameters) ||
      !isObject(value.state) || !finite(value.state.timeSeconds) || value.state.timeSeconds < 0 ||
      !Array.isArray(value.state.bodies) || value.state.bodies.length !== 4 ||
      !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 2000) throw new Error('Invalid or unsupported checkpoint');
  const bodies: OrbitBody[] = [];
  const names = new Set<string>();
  const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
  for (const body of value.state.bodies) {
    if (!isObject(body) || typeof body.name !== 'string' || !modelGms.has(body.name as BodyName) ||
        names.has(body.name) || body.gm !== modelGms.get(body.name as BodyName) ||
        !vector(body.position) || !vector(body.velocity)) throw new Error('Invalid checkpoint body or model constants');
    names.add(body.name);
    bodies.push({ name: body.name as BodyName, gm: body.gm as number, position: [...body.position], velocity: [...body.velocity] });
  }
  const stateTime = value.state.timeSeconds;
  let previousTime = -1;
  const normalizedSamples: Sample[] = [];
  for (const item of value.samples) {
    // Before v4, analysis fields were not defined: ignore any imported extras.
    const raw = item as Record<string, unknown>;
    const sample = value.version === 4 ? parseOrbitalSample(item, stateTime) : parseOrbitalSample({
      timeSeconds: raw?.timeSeconds, eccentricity: raw?.eccentricity, semiMajorAxisKm: raw?.semiMajorAxisKm, resonanceAngleDeg: raw?.resonanceAngleDeg,
    }, stateTime);
    if (sample.timeSeconds <= previousTime) throw new Error('Invalid checkpoint sample history');
    previousTime = sample.timeSeconds;
    normalizedSamples.push(sample);
  }
  const typedState: OrbitState = { timeSeconds: stateTime, bodies };
  const loadedBaseline = value.version === 4 ? parseOrbitalBaseline(value.baseline, stateTime) : makeOrbitalBaseline(typedState, 'restored');
  const actual = sampleFor(typedState, loadedBaseline);
  const last = normalizedSamples[normalizedSamples.length - 1];
  if (last.timeSeconds !== stateTime || !nearlyEqual(last.eccentricity, actual.eccentricity, 1e-10) ||
      !nearlyEqual(last.semiMajorAxisKm, actual.semiMajorAxisKm, 1e-5) ||
      !nearlyEqualAngle(last.resonanceAngleDeg, actual.resonanceAngleDeg, 1e-7)) throw new Error('Checkpoint history does not match its current state');
  if (value.version === 4) {
    if (!last.positionsKm || last.energyDrift === undefined || last.angularMomentumDrift === undefined ||
        (['Io', 'Europa', 'Ganymede'] as const).some(name => last.positionsKm![name].some((n, i) => !nearlyEqual(n, actual.positionsKm![name][i], 1e-6))) ||
        !nearlyEqual(last.energyDrift, actual.energyDrift!, 1e-12) || !nearlyEqual(last.angularMomentumDrift, actual.angularMomentumDrift!, 1e-12) ||
        normalizedSamples.some(sample => sample.positionsKm && sample.timeSeconds < loadedBaseline.timeSeconds)) {
      throw new Error('Checkpoint analysis does not match its current state or baseline');
    }
  } else {
    // The restored state is known, but older trajectory positions are not.
    normalizedSamples[normalizedSamples.length - 1] = actual;
  }
  // Older files may contain extra parameter fields; retain only the supported
  // inputs so restored overrides can always be passed back to Start.
  const normalizedParameters: Parameters = { eccentricity: value.parameters.eccentricity, semiMajorAxisKm: value.parameters.semiMajorAxisKm };
  // Version 1 has no override metadata. Equal-to-epoch values are inferred as
  // defaults; exact comparison preserves even small user-specified differences.
  const overrides: Overrides = value.version === 1 ? {
    ...(normalizedParameters.eccentricity === defaultParameters.eccentricity ? {} : { eccentricity: normalizedParameters.eccentricity }),
    ...(normalizedParameters.semiMajorAxisKm === defaultParameters.semiMajorAxisKm ? {} : { semiMajorAxisKm: normalizedParameters.semiMajorAxisKm }),
  } : parseOverrides(value.initialOverrides);
  if (value.version !== 1) {
    const expected = { ...defaultParameters, ...overrides };
    if (!nearlyEqual(expected.eccentricity, normalizedParameters.eccentricity, 1e-10) ||
        !nearlyEqual(expected.semiMajorAxisKm, normalizedParameters.semiMajorAxisKm, 1e-5) ||
        (value.provenance !== 'local' && value.provenance !== 'imported-unverified')) throw new Error('Invalid checkpoint initial parameters or provenance');
  }
  return { state: typedState, parameters: normalizedParameters, initialOverrides: overrides, samples: normalizedSamples, baseline: loadedBaseline, provenance: 'imported-unverified', checksumStatus: value.version === 3 || value.version === 4 ? 'verified' : 'unavailable' };
}
parent.on('message', ({ data: command }) => {
  const previousStatus = status;
  try {
    switch (command.type) {
      case 'start': {
        const nextOverrides = parseOverrides(command.parameters);
        const nextState = createInitialOrbit(nextOverrides);
        const nextBaseline = makeOrbitalBaseline(nextState, 'initial');
        const nextSample = sampleFor(nextState, nextBaseline);
        state = nextState;
        baseline = nextBaseline;
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
        state = null; parameters = null; initialOverrides = {}; samples = []; baseline = null; provenance = 'local'; checksumStatus = undefined; status = 'idle'; notice = undefined;
        restoredParameters = undefined; restoredOverrides = undefined; snapshot(); break;
      case 'load': {
        const loaded = parseCheckpoint(command.checkpoint);
        ({ state, parameters, initialOverrides, samples, baseline, provenance, checksumStatus } = loaded);
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
  if (status !== 'running' || !state || !baseline) return;
  try {
    let next = state;
    for (let i = 0; i < 12; i++) next = stepOrbit(next, dt);
    const nextSample = sampleFor(next, baseline);
    state = next;
    samples.push(nextSample);
    if (samples.length > 2000) samples.shift();
    snapshot();
  } catch (error) {
    status = 'error'; notice = error instanceof Error ? error.message : 'Integration failed'; snapshot();
  }
}, 100);
snapshot();
