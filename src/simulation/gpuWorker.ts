import { createInitialOrbit } from './orbit';
import { createGpuOrbit, type GpuOrbitSession } from './gpuOrbit';
import { createGpuThermal, type GpuThermalSession } from './gpuThermal';
import { requestHardwareDevice } from './gpuDevice';
import type { GpuHistoryEntry, GpuWorkerCheckpoint, GpuWorkerCommand, GpuWorkerEvent, GpuWorkerSnapshot } from './gpuProtocol';

type Active = { mode: 'orbit'; session: GpuOrbitSession } | { mode: 'thermal'; session: GpuThermalSession };
let active: Active | undefined;
let snapshot: GpuWorkerSnapshot = { status: 'idle', history: [], provenance: 'local' };
let device: GPUDevice | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let stepping = false;
let generation = 0;
const post = (event: GpuWorkerEvent) => self.postMessage(event);
const notify = () => post({ type: 'snapshot', snapshot });
const close = (item?: Active) => { if (item?.mode === 'orbit') item.session.dispose(); else item?.session.destroy(); };
const stopTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
const reportError = (error: unknown) => error instanceof Error ? error.message : 'GPU command failed';

async function getDevice(): Promise<GPUDevice> {
  if (device) return device;
  const selected = await requestHardwareDevice();
  device = selected.device;
  snapshot = { ...snapshot, device: selected.description };
  selected.device.lost.then(info => {
    if (device !== selected.device) return;
    device = undefined; generation++; stopTimer();
    snapshot = { ...snapshot, status: 'error', message: `GPU device lost: ${info.message || info.reason}` };
    notify();
  });
  return device;
}

function currentCheckpoint(): GpuWorkerCheckpoint {
  if (!active) throw new Error('No GPU experiment is loaded');
  const history = snapshot.history.map(row => ({ ...row }));
  return active.mode === 'orbit' ? { mode: 'orbit', data: active.session.checkpoint(), history } : { mode: 'thermal', data: active.session.snapshot(), history };
}
function historyFor(checkpoint: GpuWorkerCheckpoint): GpuHistoryEntry[] {
  if (!Array.isArray(checkpoint.history) || checkpoint.history.length < 1 || checkpoint.history.length > 2000) throw new Error('Invalid GPU checkpoint history');
  let previous = -1;
  return checkpoint.history.map(item => {
    if (!item || !Number.isFinite(item.timeSeconds) || item.timeSeconds < 0 || item.timeSeconds <= previous || !Number.isFinite(item.error) || item.error < 0 || item.error > (checkpoint.mode === 'orbit' ? 10 : 0.05)) throw new Error('Invalid GPU checkpoint history');
    previous = item.timeSeconds;
    return { timeSeconds: item.timeSeconds, error: item.error };
  });
}
function initialHistory(next: Active): GpuHistoryEntry[] {
  if (next.mode === 'orbit') { const s = next.session.sample(); return [{ timeSeconds: s.state.timeSeconds, error: s.errorKm }]; }
  const s = next.session.snapshot(); return [{ timeSeconds: s.time, error: s.errors.maxTemperatureKelvin }];
}
function display(next: Active): Pick<GpuWorkerSnapshot, 'orbit' | 'thermal'> {
  return next.mode === 'orbit' ? { orbit: next.session.sample(), thermal: undefined } : { orbit: undefined, thermal: next.session.snapshot() };
}
function schedule(): void {
  if (timer !== undefined || stepping || snapshot.status !== 'running' || !active) return;
  const version = generation, item = active;
  timer = setTimeout(async () => {
    timer = undefined; stepping = true;
    try {
      const result = await item.session.advance();
      if (version !== generation || active !== item) return;
      const timeSeconds = item.mode === 'orbit' ? (result as ReturnType<GpuOrbitSession['sample']>).state.timeSeconds : (result as ReturnType<GpuThermalSession['snapshot']>).time;
      const error = item.mode === 'orbit' ? (result as ReturnType<GpuOrbitSession['sample']>).errorKm : (result as ReturnType<GpuThermalSession['snapshot']>).errors.maxTemperatureKelvin;
      const history = [...snapshot.history, { timeSeconds, error }].slice(-2000);
      const completed = item.mode === 'orbit' && (result as ReturnType<GpuOrbitSession['sample']>).completed;
      snapshot = { ...snapshot, ...display(item), history, status: completed ? 'completed' : snapshot.status, message: completed ? 'Ten-orbit limit reached.' : snapshot.message };
      notify();
    } catch (error) {
      if (version !== generation || active !== item) return;
      stopTimer(); snapshot = { ...snapshot, status: 'error', message: reportError(error), ...display(item) }; notify();
    } finally { stepping = false; schedule(); }
  }, 30);
}
async function handle(command: GpuWorkerCommand): Promise<void> {
  try {
    switch (command.type) {
      case 'probe': await getDevice(); snapshot = { ...snapshot, message: 'Hardware WebGPU device available.' }; notify(); break;
      case 'start-orbit': case 'start-thermal': case 'load': {
        let loadedHistory: GpuHistoryEntry[] | undefined;
        if (command.type === 'load') {
          if (!command.checkpoint || (command.checkpoint.mode !== 'orbit' && command.checkpoint.mode !== 'thermal')) throw new Error('Invalid GPU checkpoint');
          loadedHistory = historyFor(command.checkpoint);
        }
        const gpu = await getDevice();
        let next: Active;
        if (command.type === 'start-orbit') next = { mode: 'orbit', session: await createGpuOrbit(gpu, createInitialOrbit(command.parameters)) };
        else if (command.type === 'start-thermal') next = { mode: 'thermal', session: await createGpuThermal(gpu, command.config) };
        else if (command.checkpoint.mode === 'orbit') next = { mode: 'orbit', session: await createGpuOrbit(gpu, command.checkpoint.data.initialState, command.checkpoint.data) };
        else next = { mode: 'thermal', session: await createGpuThermal(gpu, command.checkpoint.data) };
        if (device !== gpu) { close(next); throw new Error('GPU device was lost while starting the experiment'); }
        const actual = initialHistory(next)[0], last = loadedHistory?.[loadedHistory.length - 1];
        if (last && (last.timeSeconds !== actual.timeSeconds || Math.abs(last.error - actual.error) > 1e-9)) { close(next); throw new Error('GPU checkpoint history does not match its state'); }
        generation++; stopTimer(); close(active); active = next;
        snapshot = { ...snapshot, mode: next.mode, ...display(next), history: loadedHistory ?? initialHistory(next), status: command.type === 'load' ? 'paused' : 'running', provenance: command.type === 'load' ? 'imported-unverified' : 'local', message: command.type === 'load' ? 'Imported origin is unverified.' : undefined };
        notify(); schedule(); break;
      }
      case 'pause': if (snapshot.status === 'running') { snapshot = { ...snapshot, status: 'paused' }; stopTimer(); } notify(); break;
      case 'resume': if (active && snapshot.status === 'paused') { snapshot = { ...snapshot, status: 'running', message: undefined }; notify(); schedule(); } break;
      case 'reset': generation++; stopTimer(); close(active); active = undefined; snapshot = { status: 'idle', history: [], provenance: 'local', device: snapshot.device }; notify(); break;
      case 'checkpoint': case 'export': post({ type: command.type, checkpoint: currentCheckpoint() }); break;
      default: throw new Error('Unsupported GPU command');
    }
  } catch (error) {
    // Rejected commands never interrupt or overwrite an existing experiment.
    snapshot = { ...snapshot, status: active ? snapshot.status : 'error', message: reportError(error) };
    notify();
  }
}
// Serialize commands so a slow device request or restore cannot overtake a
// later reset/start. Integration remains asynchronous and independent.
let commandQueue = Promise.resolve();
self.onmessage = (event: MessageEvent<GpuWorkerCommand>) => { commandQueue = commandQueue.then(() => handle(event.data)); };
