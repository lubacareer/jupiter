/** Independent worker: the radial clock is not coupled to either orbital clock. */
import { createRadialState, radialDiagnostics, radialFieldProfile, stepRadial, validateRadialState, type RadialState } from './radialInterior';
import { createRadialGpu, type RadialGpuSession } from './radialGpu';
import { requestHardwareDevice } from './gpuDevice';
import { checksumRadialCheckpoint, verifyRadialCheckpoint } from './radialIntegrity';
import type { RadialBackend, RadialWorkerCommand, RadialWorkerEvent, RadialWorkerSnapshot } from './radialProtocol';

type Active = { backend: 'cpu' } | { backend: 'gpu'; session: RadialGpuSession };
let active: Active | undefined, device: GPUDevice | undefined;
let deviceDescription: string | undefined;
let snapshot: RadialWorkerSnapshot = { status: 'idle', provenance: 'local' };
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0, stepping = false, restoreRevision = 0;
const notify = () => self.postMessage({ type: 'snapshot', snapshot } satisfies RadialWorkerEvent);
const stopTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
const close = (item?: Active) => { if (item?.backend === 'gpu') item.session.destroy(); };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Radial command failed';
const copyState = (state: RadialState): RadialState => {
  const c = state.config, m = c.material;
  return { timeSeconds: state.timeSeconds, initialEnergyJ: state.initialEnergyJ, cumulativeHeatJ: state.cumulativeHeatJ,
    enthalpy: Array.from(state.enthalpy), config: { radiusM: c.radiusM, iceThicknessM: c.iceThicknessM,
      oceanDepthM: c.oceanDepthM, cells: c.cells, surfaceTemperatureK: c.surfaceTemperatureK,
      basalHeatFluxWm2: c.basalHeatFluxWm2, dtSeconds: c.dtSeconds, material: { density: m.density,
        iceHeatCapacity: m.iceHeatCapacity, waterHeatCapacity: m.waterHeatCapacity, iceConductivity: m.iceConductivity,
        waterConductivity: m.waterConductivity, latentHeat: m.latentHeat, meltingTemperature: m.meltingTemperature } } };
};

async function getDevice(): Promise<GPUDevice> {
  if (device) return device;
  const selected = await requestHardwareDevice();
  device = selected.device;
  deviceDescription = selected.description;
  void selected.device.lost.then(info => {
    if (device !== selected.device) return;
    device = undefined; deviceDescription = undefined;
    if (active?.backend !== 'gpu') return;
    generation++; stopTimer();
    snapshot = { ...snapshot, status: 'error', message: `GPU device lost: ${info.message || info.reason}` };
    notify();
  });
  return device;
}

function document(kind: 'checkpoint' | 'export'): object {
  if (!snapshot.state || !snapshot.backend) throw new Error('No radial interior result is available');
  return {
    format: kind === 'checkpoint' ? 'europa-radial-checkpoint-v2' : 'europa-radial-export-v2',
    version: 2, model: 'spherical-radial-enthalpy-v1', backend: snapshot.backend,
    precision: snapshot.backend === 'gpu' ? 'float32-with-float64-reference' : 'float64',
    device: snapshot.backend === 'gpu' ? snapshot.device ?? 'unknown' : null,
    provenance: snapshot.provenance, state: copyState(snapshot.state),
    ...(snapshot.gpuEnthalpy ? { gpuEnthalpy: [...snapshot.gpuEnthalpy], errors: { ...snapshot.errors } } : {}),
    diagnostics: radialDiagnostics(snapshot.state),
    diagnosticsBasis: snapshot.backend === 'gpu' ? 'float64 CPU reference state' : 'float64 CPU state',
    fieldProfile: radialFieldProfile(snapshot.state.config, snapshot.gpuEnthalpy ?? snapshot.state.enthalpy),
    fieldProfileBasis: snapshot.backend === 'gpu' ? 'accepted float32 GPU field' : 'float64 CPU state',
    units: { radiusM: 'm', timeSeconds: 's', enthalpy: 'J/m^3', energy: 'J', temperature: 'K', basalHeatFluxWm2: 'W/m^2', liquidFraction: 'dimensionless' },
    assumptions: ['Spherically symmetric water-ice layer', 'Fixed rocky boundary', 'No ocean circulation, tidal heating or orbital feedback', 'Imported data and origin are unverified'],
  };
}

async function parseCheckpoint(value: unknown): Promise<{ backend: RadialBackend; state: RadialState; gpuEnthalpy?: number[]; checksumStatus: 'verified' | 'unavailable' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid radial checkpoint');
  const v = value as Record<string, unknown>;
  if (!((v.format === 'europa-radial-checkpoint-v1' && v.version === 1) || (v.format === 'europa-radial-checkpoint-v2' && v.version === 2)) ||
      v.model !== 'spherical-radial-enthalpy-v1' ||
      (v.backend !== 'cpu' && v.backend !== 'gpu') ||
      v.precision !== (v.backend === 'gpu' ? 'float32-with-float64-reference' : 'float64')) throw new Error('Unsupported radial checkpoint');
  if (v.version === 2) await verifyRadialCheckpoint(v);
  // Validate before constructing a detached, known-field representation.
  const state = v.state as RadialState;
  validateRadialState(state);
  if (v.backend === 'gpu' && (!Array.isArray(v.gpuEnthalpy) || v.gpuEnthalpy.length !== state.config.cells ||
      v.gpuEnthalpy.some(x => typeof x !== 'number' || !Number.isFinite(x) || Math.fround(x) !== x))) throw new Error('Invalid GPU radial checkpoint');
  return { backend: v.backend, state: copyState(state), checksumStatus: v.version === 2 ? 'verified' : 'unavailable', ...(v.backend === 'gpu' ? { gpuEnthalpy: [...v.gpuEnthalpy as number[]] } : {}) };
}

function schedule(): void {
  if (timer !== undefined || stepping || !active || snapshot.status !== 'running') return;
  const version = generation, item = active, base = snapshot.state!;
  timer = setTimeout(async () => {
    timer = undefined; stepping = true;
    try {
      const next = item.backend === 'cpu' ? { state: stepRadial(base) } : await item.session.advance();
      if (version !== generation || active !== item) return;
      snapshot = { ...snapshot, ...next };
      notify();
    } catch (error) {
      if (version !== generation || active !== item) return;
      stopTimer(); snapshot = { ...snapshot, status: 'error', message: errorMessage(error) }; notify();
    } finally { stepping = false; schedule(); }
  }, 30);
}

async function handle(command: RadialWorkerCommand): Promise<void> {
  try {
    switch (command.type) {
      case 'start': case 'load': {
        const imported = command.type === 'load' ? await parseCheckpoint(command.checkpoint) : undefined;
        const backend = imported?.backend ?? (command.type === 'start' ? command.backend : undefined);
        if (backend !== 'cpu' && backend !== 'gpu') throw new Error('Invalid radial backend');
        const state = imported?.state ?? createRadialState((command as Extract<RadialWorkerCommand, { type: 'start' }>).config);
        let next: Active = { backend: 'cpu' }, result: Pick<RadialWorkerSnapshot, 'state' | 'gpuEnthalpy' | 'errors'> = { state };
        if (backend === 'gpu') {
          const selected = await getDevice();
          const session = await createRadialGpu(selected, state, imported?.gpuEnthalpy);
          if (selected !== device) { session.destroy(); throw new Error('GPU device lost while starting'); }
          next = { backend: 'gpu', session }; result = session.snapshot();
        }
        generation++; stopTimer(); close(active); active = next;
        if (imported) restoreRevision++;
        snapshot = { ...snapshot, backend, ...result, device: backend === 'gpu' ? deviceDescription : undefined,
          gpuEnthalpy: result.gpuEnthalpy, errors: result.errors,
          restoreRevision, restoredConfig: imported ? copyState(state).config : undefined,
          status: imported ? 'paused' : 'running', provenance: imported ? 'imported-unverified' : 'local', checksumStatus: imported?.checksumStatus,
          message: imported ? (imported.checksumStatus === 'verified' ? 'Checksum verified; imported checkpoint origin and fields remain unverified.' : 'Legacy checkpoint checksum unavailable; origin and fields remain unverified.') : undefined };
        notify(); schedule(); break;
      }
      case 'pause': if (snapshot.status === 'running') { snapshot = { ...snapshot, status: 'paused' }; stopTimer(); } notify(); break;
      case 'resume': if (active && snapshot.status === 'paused') { snapshot = { ...snapshot, status: 'running', message: undefined }; schedule(); } notify(); break;
      case 'reset': generation++; stopTimer(); close(active); active = undefined; snapshot = { status: 'idle', provenance: 'local', device: snapshot.device }; notify(); break;
      case 'checkpoint': case 'export': {
        const captured = document(command.type);
        const saved = command.type === 'checkpoint' ? await checksumRadialCheckpoint(captured) : captured;
        self.postMessage({ type: command.type, document: saved } satisfies RadialWorkerEvent); break;
      }
      default: throw new Error('Unsupported radial command');
    }
  } catch (error) { snapshot = { ...snapshot, status: active ? snapshot.status : 'error', message: errorMessage(error) }; notify(); }
}
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<RadialWorkerCommand>) => { queue = queue.then(() => handle(event.data)); };
