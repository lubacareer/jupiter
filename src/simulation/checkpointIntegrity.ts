import { createHash } from 'node:crypto';

/** Identifies the equations and epoch for which version-3 checkpoints are valid. */
export const CHECKPOINT_MODEL = Object.freeze({
  id: 'europa-four-body-point-mass',
  epoch: '2025-01-01T00:00:00 TDB',
  solver: 'velocity-verlet-dt-300s',
});

/**
 * Canonical JSON: recursively sorted object keys, JSON primitive encoding and
 * original array order. Checkpoints are JSON; reject non-JSON values rather
 * than silently hashing a different representation from the saved file.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 128) throw new Error('Checkpoint nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from({ length: value.length }, (_, index) => {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error('Checkpoint contains a sparse array');
    return canonicalJson(value[index], depth + 1);
  }).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Checkpoint contains a non-JSON object');
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Checkpoint contains a non-JSON value');
}

export function checkpointDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/** Verify all payload fields, including unknown fields, before normalization. */
export function verifyCheckpointIntegrity(value: Record<string, unknown>): void {
  const { checksum, ...payload } = value;
  if (!checksum || typeof checksum !== 'object' || Array.isArray(checksum)) throw new Error('Missing or invalid checkpoint checksum');
  const fields = checksum as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== 'algorithm,digest' || fields.algorithm !== 'sha256' ||
      typeof fields.digest !== 'string' || !/^[0-9a-f]{64}$/.test(fields.digest)) throw new Error('Missing or invalid checkpoint checksum');
  if (checkpointDigest(payload) !== fields.digest) throw new Error('Checkpoint checksum mismatch');
  const model = payload.model;
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('Invalid checkpoint model metadata');
  const metadata = model as Record<string, unknown>;
  if (Object.keys(metadata).sort().join(',') !== 'epoch,id,solver' ||
      metadata.id !== CHECKPOINT_MODEL.id || metadata.epoch !== CHECKPOINT_MODEL.epoch || metadata.solver !== CHECKPOINT_MODEL.solver) {
    throw new Error('Unsupported checkpoint model metadata');
  }
}
