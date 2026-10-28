import type { RadialConfig, RadialState } from './radialInterior';
import type { RadialGpuErrors } from './radialGpu';

export type RadialBackend = 'cpu' | 'gpu';
export type RadialWorkerSnapshot = {
  status: 'idle' | 'running' | 'paused' | 'error';
  backend?: RadialBackend;
  state?: RadialState;
  gpuEnthalpy?: number[];
  errors?: RadialGpuErrors;
  device?: string;
  provenance: 'local' | 'imported-unverified';
  message?: string;
  restoreRevision?: number;
  restoredConfig?: RadialConfig;
};
export type RadialWorkerCommand =
  | { type: 'start'; backend: RadialBackend; config: RadialConfig }
  | { type: 'pause' | 'resume' | 'reset' | 'checkpoint' | 'export' }
  | { type: 'load'; checkpoint: unknown };
export type RadialWorkerEvent =
  | { type: 'snapshot'; snapshot: RadialWorkerSnapshot }
  | { type: 'checkpoint' | 'export'; document: object };
