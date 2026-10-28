import type { GpuOrbitCheckpoint, GpuOrbitSample } from './gpuOrbit';
import type { GpuThermalConfig, GpuThermalSnapshot } from './gpuThermal';

export type GpuHistoryEntry = { timeSeconds: number; error: number };
export type GpuWorkerCheckpoint =
  | { mode: 'orbit'; data: GpuOrbitCheckpoint; history: GpuHistoryEntry[] }
  | { mode: 'thermal'; data: GpuThermalSnapshot; history: GpuHistoryEntry[] };
export type GpuWorkerCommand =
  | { type: 'probe' | 'pause' | 'resume' | 'reset' | 'checkpoint' | 'export' }
  | { type: 'start-orbit'; parameters: { eccentricity?: number; semiMajorAxisKm?: number } }
  | { type: 'start-thermal'; config: GpuThermalConfig }
  | { type: 'load'; checkpoint: GpuWorkerCheckpoint };
export interface GpuWorkerSnapshot {
  status: 'idle' | 'running' | 'paused' | 'error' | 'completed';
  mode?: 'orbit' | 'thermal';
  device?: string;
  message?: string;
  orbit?: GpuOrbitSample;
  thermal?: GpuThermalSnapshot;
  history: GpuHistoryEntry[];
  provenance: 'local' | 'imported-unverified';
}
export type GpuWorkerEvent =
  | { type: 'snapshot'; snapshot: GpuWorkerSnapshot }
  | { type: 'checkpoint' | 'export'; checkpoint: GpuWorkerCheckpoint };
