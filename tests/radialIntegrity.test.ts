import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { checksumRadialCheckpoint, verifyRadialCheckpoint } from '../src/simulation/radialIntegrity';

afterEach(() => vi.unstubAllGlobals());

it('uses standard SHA-256 over sorted canonical JSON and detects changed payloads', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const checkpoint = await checksumRadialCheckpoint({ b: 2, a: 1 }) as Record<string, unknown> & { checksum: { algorithm: string; digest: string } };
  expect(checkpoint.checksum).toEqual({ algorithm: 'sha256', digest: '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777' });
  await expect(verifyRadialCheckpoint({ a: 1, b: 2, checksum: checkpoint.checksum })).resolves.toBeUndefined();
  await expect(verifyRadialCheckpoint({ a: 1, b: 3, checksum: checkpoint.checksum })).rejects.toThrow(/checksum mismatch/i);
});
