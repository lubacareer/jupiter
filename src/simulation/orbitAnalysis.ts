import { orbitDiagnostics, type OrbitState, type Vec3 } from './orbit';

/** Relative positions are in the ICRF axes with Jupiter at the origin. */
export type OrbitalPositions = { Io: Vec3; Europa: Vec3; Ganymede: Vec3 };
export type OrbitalSample = {
  timeSeconds: number;
  eccentricity: number;
  semiMajorAxisKm: number;
  resonanceAngleDeg: number;
  positionsKm?: OrbitalPositions;
  energyDrift?: number;
  angularMomentumDrift?: number;
};
export type OrbitalBaseline = {
  timeSeconds: number;
  energy: number;
  angularMomentum: Vec3;
  kind: 'initial' | 'restored';
};

const magnitude = (v: Vec3) => Math.hypot(...v);
export function makeOrbitalBaseline(state: OrbitState, kind: OrbitalBaseline['kind']): OrbitalBaseline {
  const diagnostics = orbitDiagnostics(state);
  if (!Number.isFinite(state.timeSeconds) || state.timeSeconds < 0 || !Number.isFinite(diagnostics.energy) || diagnostics.energy === 0 ||
      !Number.isFinite(magnitude(diagnostics.angularMomentum)) || magnitude(diagnostics.angularMomentum) === 0) {
    throw new RangeError('Cannot calculate conservation drift from zero or non-finite baseline');
  }
  return { timeSeconds: state.timeSeconds, energy: diagnostics.energy, angularMomentum: [...diagnostics.angularMomentum], kind };
}

export function makeOrbitalSample(state: OrbitState, baseline: OrbitalBaseline): OrbitalSample {
  const diagnostics = orbitDiagnostics(state);
  const jupiter = state.bodies.find(body => body.name === 'Jupiter');
  if (!jupiter) throw new Error('Missing Jupiter');
  const relative = (name: 'Io' | 'Europa' | 'Ganymede'): Vec3 => {
    const body = state.bodies.find(item => item.name === name);
    if (!body) throw new Error(`Missing ${name}`);
    return [body.position[0] - jupiter.position[0], body.position[1] - jupiter.position[1], body.position[2] - jupiter.position[2]];
  };
  const l0 = magnitude(baseline.angularMomentum);
  if (!Number.isFinite(baseline.energy) || baseline.energy === 0 || !Number.isFinite(l0) || l0 === 0) throw new RangeError('Invalid conservation baseline');
  const energyDrift = Math.abs(diagnostics.energy - baseline.energy) / Math.abs(baseline.energy);
  const angularMomentumDrift = magnitude([diagnostics.angularMomentum[0] - baseline.angularMomentum[0], diagnostics.angularMomentum[1] - baseline.angularMomentum[1], diagnostics.angularMomentum[2] - baseline.angularMomentum[2]]) / l0;
  const positionsKm = { Io: relative('Io'), Europa: relative('Europa'), Ganymede: relative('Ganymede') };
  if (!Number.isFinite(state.timeSeconds) || !Number.isFinite(diagnostics.eccentricity) || !Number.isFinite(diagnostics.semiMajorAxisKm) ||
      !Number.isFinite(diagnostics.laplaceAngleDeg) || !Object.values(positionsKm).every(vector => vector.every(Number.isFinite)) ||
      !Number.isFinite(energyDrift) || !Number.isFinite(angularMomentumDrift)) throw new RangeError('Non-finite orbital analysis');
  return { timeSeconds: state.timeSeconds, eccentricity: diagnostics.eccentricity, semiMajorAxisKm: diagnostics.semiMajorAxisKm,
    resonanceAngleDeg: diagnostics.laplaceAngleDeg, positionsKm, energyDrift, angularMomentumDrift };
}

/** Validate and normalize user-supplied analysis data; these checks do not authenticate it. */
export function parseOrbitalBaseline(value: unknown, maxTime: number): OrbitalBaseline {
  const v = value as Record<string, unknown> | null;
  const vector = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every(n => typeof n === 'number' && Number.isFinite(n));
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.timeSeconds !== 'number' || !Number.isFinite(v.timeSeconds) || v.timeSeconds < 0 || v.timeSeconds > maxTime ||
      typeof v.energy !== 'number' || !Number.isFinite(v.energy) || v.energy === 0 || !vector(v.angularMomentum) || !Number.isFinite(magnitude(v.angularMomentum)) || magnitude(v.angularMomentum) === 0 ||
      (v.kind !== 'initial' && v.kind !== 'restored')) throw new Error('Invalid orbital analysis baseline');
  return { timeSeconds: v.timeSeconds, energy: v.energy, angularMomentum: [...v.angularMomentum], kind: v.kind };
}

export function parseOrbitalSample(value: unknown, maxTime: number): OrbitalSample {
  const v = value as Record<string, unknown> | null;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const vector = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every(finite);
  if (!v || typeof v !== 'object' || Array.isArray(v) || !finite(v.timeSeconds) || v.timeSeconds < 0 || v.timeSeconds > maxTime ||
      !finite(v.eccentricity) || v.eccentricity < 0 || v.eccentricity >= 1 || !finite(v.semiMajorAxisKm) || v.semiMajorAxisKm <= 0 ||
      !finite(v.resonanceAngleDeg) || v.resonanceAngleDeg < -180 || v.resonanceAngleDeg > 180) throw new Error('Invalid checkpoint sample history');
  const result: OrbitalSample = { timeSeconds: v.timeSeconds, eccentricity: v.eccentricity, semiMajorAxisKm: v.semiMajorAxisKm, resonanceAngleDeg: v.resonanceAngleDeg };
  if ('positionsKm' in v || 'energyDrift' in v || 'angularMomentumDrift' in v) {
    const p = v.positionsKm as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || Array.isArray(p) || !vector(p.Io) || !vector(p.Europa) || !vector(p.Ganymede) ||
        !finite(v.energyDrift) || v.energyDrift < 0 || !finite(v.angularMomentumDrift) || v.angularMomentumDrift < 0) throw new Error('Invalid orbital analysis sample');
    result.positionsKm = { Io: [...p.Io], Europa: [...p.Europa], Ganymede: [...p.Ganymede] };
    result.energyDrift = v.energyDrift; result.angularMomentumDrift = v.angularMomentumDrift;
  }
  return result;
}
