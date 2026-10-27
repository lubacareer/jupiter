/** A software or anonymous adapter cannot establish hardware validation. */
export async function requestHardwareDevice(): Promise<{ device: GPUDevice; description: string }> {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this renderer');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available');
  const info = adapter.info;
  if (!info) throw new Error('GPU adapter identity is unavailable; hardware cannot be verified');
  const description = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ');
  if (!info.vendor && !info.description) throw new Error('GPU adapter identity is unavailable; hardware cannot be verified');
  const fallback = info.isFallbackAdapter ?? (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter;
  if (fallback !== false) throw new Error(fallback ? 'Software GPU adapters are not supported' : 'GPU fallback status is unavailable; hardware cannot be verified');
  if (/swiftshader|llvmpipe|lavapipe|software|microsoft basic/i.test(description)) throw new Error('Software GPU adapters are not supported');
  const device = await adapter.requestDevice();
  return { device, description };
}
