import { requestHardwareDevice } from './gpuDevice';
import { createInitialOrbit } from './orbit';
import { createGpuOrbit } from './gpuOrbit';
import { createGpuThermal, defaultGpuThermalConfig } from './gpuThermal';

interface TestResult { passed: boolean; error?: string; [key: string]: unknown }
async function run(): Promise<void> {
  const result: { passed: boolean; adapter?: string; orbit?: TestResult; thermal?: TestResult; error?: string } = { passed: false };
  try {
    const { device, description } = await requestHardwareDevice();
    result.adapter = description;
    try {
      const session = await createGpuOrbit(device, createInitialOrbit());
      let sample = session.sample(), maxErrorKm = sample.errorKm, samples = 0;
      try {
        while (!sample.completed) { sample = await session.advance(); maxErrorKm = Math.max(maxErrorKm, sample.errorKm); samples++; }
        result.orbit = { passed: true, samples, steps: sample.steps, maxSteps: sample.maxSteps, maxErrorKm, lastTimeSeconds: sample.state.timeSeconds };
      } finally { session.dispose(); }
    } catch (error) { result.orbit = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
    try {
      const session = await createGpuThermal(device, defaultGpuThermalConfig());
      let maxTemperatureKelvin = 0, maxLiquidFraction = 0, normalizedEnergy = 0;
      try {
        for (let i = 0; i < 100; i++) {
          const next = await session.advance();
          maxTemperatureKelvin = Math.max(maxTemperatureKelvin, next.errors.maxTemperatureKelvin);
          maxLiquidFraction = Math.max(maxLiquidFraction, next.errors.maxLiquidFraction);
          normalizedEnergy = Math.max(normalizedEnergy, next.errors.normalizedEnergy);
        }
        result.thermal = { passed: true, samples: 100, maxTemperatureKelvin, maxLiquidFraction, normalizedEnergy };
      } finally { session.destroy(); }
    } catch (error) { result.thermal = { passed: false, error: error instanceof Error ? error.message : String(error) }; }
    result.passed = result.orbit.passed && result.thermal.passed;
    device.destroy();
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  self.postMessage(result);
}
void run();
