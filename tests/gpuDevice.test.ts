import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestHardwareDevice } from '../src/simulation/gpuDevice';

afterEach(() => vi.unstubAllGlobals());
function adapter(info: Record<string, unknown>, fallback?: boolean) {
  const device = {};
  const requestDevice = vi.fn().mockResolvedValue(device);
  vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn().mockResolvedValue({ info, isFallbackAdapter: fallback, requestDevice }) } });
  return { device, requestDevice };
}
describe('hardware GPU capability checks', () => {
  it('accepts an identified non-fallback adapter', async () => {
    const { device } = adapter({ vendor: 'amd', architecture: 'rdna-3', isFallbackAdapter: false });
    expect(await requestHardwareDevice()).toEqual({ device, description: 'amd / rdna-3' });
  });
  it.each([
    [{ vendor: 'google', description: 'SwiftShader', isFallbackAdapter: false }, undefined],
    [{ vendor: 'amd', isFallbackAdapter: true }, false],
    [{ vendor: 'amd' }, undefined],
    [{ vendor: '', description: '', isFallbackAdapter: false }, undefined],
  ])('rejects software, fallback and unverifiable adapters', async (info, fallback) => {
    const { requestDevice } = adapter(info, fallback);
    await expect(requestHardwareDevice()).rejects.toThrow();
    expect(requestDevice).not.toHaveBeenCalled();
  });
});
