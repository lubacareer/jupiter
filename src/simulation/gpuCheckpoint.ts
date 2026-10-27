/** Browser-safe, corruption-detecting GPU checkpoint format. A digest is not a signature. */
import type { GpuWorkerCheckpoint } from './gpuProtocol';

export type GpuMode = 'orbit' | 'thermal';
export interface GpuProvenance { origin: 'local' | 'unverified'; input: 'new' | 'imported'; checksum: 'verified' | 'unavailable' }
export type GpuAdapterMetadata = Record<string, string>;
export interface GpuCheckpoint {
  version: 4;
  mode: GpuMode;
  model: { id: string; epoch: string; solver: string };
  backend: 'webgpu';
  precision: 'float32';
  adapter: GpuAdapterMetadata;
  provenance: GpuProvenance;
  data: GpuWorkerCheckpoint;
  checksum: { algorithm: 'sha256'; digest: string };
}

const models = {
  orbit: { id: 'europa-four-body-point-mass', epoch: '2025-01-01T00:00:00 TDB', solver: 'webgpu-velocity-verlet-dt-300s' },
  thermal: { id: 'cartesian-enthalpy-experiment', epoch: 'none', solver: 'webgpu-explicit-finite-volume' },
} as const;

function canonical(value: unknown, depth = 0): string {
  if (depth > 128) throw new Error('Checkpoint nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from({ length: value.length }, (_, i) => {
    if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error('Checkpoint contains a sparse array');
    return canonical(value[i], depth + 1);
  }).join(',')}]`;
  if (typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Checkpoint contains a non-JSON value');
}
async function digest(payload: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this environment');
  const bytes = new TextEncoder().encode(canonical(payload));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function equalKeys(value: Record<string, unknown>, keys: string): boolean { return Object.keys(value).sort().join(',') === keys; }
function validateAdapter(adapter: unknown): asserts adapter is GpuAdapterMetadata {
  if (!object(adapter) || Object.keys(adapter).length > 20 || Object.entries(adapter).some(([k, v]) => k.length > 100 || typeof v !== 'string' || v.length > 500)) {
    throw new Error('Invalid GPU adapter metadata');
  }
}
function validateProvenance(provenance: unknown): asserts provenance is GpuProvenance {
  if (!object(provenance) || !equalKeys(provenance, 'checksum,input,origin') ||
      !['local', 'unverified'].includes(provenance.origin as string) || !['new', 'imported'].includes(provenance.input as string) ||
      !['verified', 'unavailable'].includes(provenance.checksum as string) ||
      (provenance.input === 'imported' && provenance.origin !== 'unverified')) throw new Error('Invalid GPU provenance');
}

/** Save a fresh digest over the complete current payload. */
export async function createGpuCheckpoint(mode: GpuMode, data: GpuWorkerCheckpoint,
  adapter: GpuAdapterMetadata, provenance: GpuProvenance): Promise<GpuCheckpoint> {
  if (!(mode in models)) throw new Error('Unsupported GPU mode');
  validateAdapter(adapter); validateProvenance(provenance);
  if (data.mode !== mode || data.data.version !== 1 || !Array.isArray(data.history)) throw new Error('Invalid GPU checkpoint payload');
  // Clone through canonical JSON to detach from mutable simulation state.
  const payload = JSON.parse(canonical({ version: 4, mode, model: models[mode], backend: 'webgpu', precision: 'float32', adapter, provenance, data })) as Omit<GpuCheckpoint, 'checksum'>;
  return { ...payload, checksum: { algorithm: 'sha256', digest: await digest(payload) } };
}

/** Verify metadata and digest before constructing a candidate GPU session. */
export async function parseGpuCheckpoint(value: unknown): Promise<{ checkpoint: GpuCheckpoint; provenance: GpuProvenance }> {
  if (!object(value) || !equalKeys(value, 'adapter,backend,checksum,data,mode,model,precision,provenance,version') || value.version !== 4 ||
      (value.mode !== 'orbit' && value.mode !== 'thermal') || value.backend !== 'webgpu' || value.precision !== 'float32') throw new Error('Unsupported GPU checkpoint');
  validateAdapter(value.adapter); validateProvenance(value.provenance);
  if (!object(value.model) || !equalKeys(value.model, 'epoch,id,solver') ||
      canonical(value.model) !== canonical(models[value.mode])) throw new Error('Unsupported GPU checkpoint model');
  if (!object(value.data) || value.data.mode !== value.mode || !object(value.data.data) || value.data.data.version !== 1 || !Array.isArray(value.data.history)) throw new Error('Invalid GPU checkpoint payload');
  if (!object(value.checksum) || !equalKeys(value.checksum, 'algorithm,digest') || value.checksum.algorithm !== 'sha256' ||
      typeof value.checksum.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.checksum.digest)) throw new Error('Missing or invalid checkpoint checksum');
  const { checksum, ...payload } = value;
  if (await digest(payload) !== checksum.digest) throw new Error('Checkpoint checksum mismatch');
  const checkpoint = JSON.parse(canonical(value)) as GpuCheckpoint;
  return { checkpoint, provenance: { origin: 'unverified', input: 'imported', checksum: 'verified' } };
}

/** Exports are distinct documents and must not carry a checkpoint checksum. */
export function exportGpuResult(mode: GpuMode, data: GpuWorkerCheckpoint,
  adapter: GpuAdapterMetadata, provenance: GpuProvenance): object {
  validateAdapter(adapter); validateProvenance(provenance);
  if (data.mode !== mode || data.data.version !== 1 || !Array.isArray(data.history)) throw new Error('Invalid GPU export payload');
  return JSON.parse(canonical({ format: 'europa-gpu-export-v1', mode, model: models[mode], backend: 'webgpu', precision: 'float32',
    adapter, provenance, data, assumptions: ['GPU computation compared with independently advanced double-precision CPU reference',
      'Prototype only; not a validated Europa mission prediction', 'Imported data is unverified; checksums do not authenticate its origin'],
    units: mode === 'orbit' ? { position: 'km', velocity: 'km/s', time: 's' } : { enthalpy: 'J/m^3', temperature: 'K', time: 's' } }));
}
