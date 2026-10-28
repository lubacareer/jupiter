/** Checkpoint integrity detects accidental corruption; it cannot authenticate the author. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 128) throw new Error('Radial checkpoint nesting is too deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from({ length: value.length }, (_, index) => {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error('Radial checkpoint contains a sparse array');
    return canonical(value[index], depth + 1);
  }).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(',')}}`;
  }
  throw new Error('Radial checkpoint contains a non-JSON value');
}

async function digest(payload: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this environment');
  const bytes = new TextEncoder().encode(canonical(payload));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function checksumRadialCheckpoint(payload: object): Promise<object> {
  // Canonical serialization freezes the complete payload before asynchronous hashing.
  const frozen = JSON.parse(canonical(payload)) as Record<string, unknown>;
  return { ...frozen, checksum: { algorithm: 'sha256', digest: await digest(frozen) } };
}

export async function verifyRadialCheckpoint(value: Record<string, unknown>): Promise<void> {
  const { checksum, ...payload } = value;
  if (!checksum || typeof checksum !== 'object' || Array.isArray(checksum)) throw new Error('Missing or invalid radial checkpoint checksum');
  const fields = checksum as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== 'algorithm,digest' || fields.algorithm !== 'sha256' ||
      typeof fields.digest !== 'string' || !/^[0-9a-f]{64}$/.test(fields.digest)) throw new Error('Missing or invalid radial checkpoint checksum');
  if (await digest(payload) !== fields.digest) throw new Error('Radial checkpoint checksum mismatch');
}
