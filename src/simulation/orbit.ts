/** Four-point-mass orbital dynamics. Distances are km and time is seconds. */
export type Vec3 = [number, number, number];
export type BodyName = 'Jupiter' | 'Io' | 'Europa' | 'Ganymede';
export interface OrbitBody { name: BodyName; gm: number; position: Vec3; velocity: Vec3 }
export interface OrbitState { timeSeconds: number; bodies: OrbitBody[] }
export interface OrbitDiagnostics {
  eccentricity: number;
  semiMajorAxisKm: number;
  laplaceAngleDeg: number;
  /** Energy and angular momentum are multiplied by G, a common constant factor. */
  energy: number;
  angularMomentum: Vec3;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, n: number): Vec3 => [a[0] * n, a[1] * n, a[2] * n];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
const normalize = (a: Vec3): Vec3 => { const n = norm(a); if (!(n > 0)) throw new Error('Cannot normalize a zero vector'); return scale(a, 1 / n); };
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

// Geometric Jupiter-relative ICRF states from NASA/JPL Horizons, JDTDB 2460676.5.
// GMs from JPL's JUP365 physical parameters, km^3/s^2. See docs/orbit.md.
const EPOCH_BODIES: OrbitBody[] = [
  { name: 'Jupiter', gm: 126686531.9, position: [0, 0, 0], velocity: [0, 0, 0] },
  { name: 'Io', gm: 5959.91547, position: [-331767.2233633774, -232759.6085216843, -116081.0219809785], velocity: [10.64281742908924, -12.42979809201595, -5.751715787923183] },
  { name: 'Europa', gm: 3202.71210, position: [665046.3683515391, -40757.88330377887, -3161.348805075318], velocity: [0.8816547197995626, 12.47831614009343, 5.920198224113511] },
  { name: 'Ganymede', gm: 9887.83275, position: [970419.4038091266, -409579.0558100821, -181098.1611503707], velocity: [4.562153179143141, 8.894571713613061, 4.338368983732783] },
];

function cloneBodies(bodies: OrbitBody[]): OrbitBody[] {
  return bodies.map(b => ({ ...b, position: [...b.position], velocity: [...b.velocity] }));
}

function recenter(bodies: OrbitBody[]): void {
  const total = bodies.reduce((s, b) => s + b.gm, 0);
  const center = scale(bodies.reduce((s, b) => add(s, scale(b.position, b.gm)), [0, 0, 0] as Vec3), 1 / total);
  const velocity = scale(bodies.reduce((s, b) => add(s, scale(b.velocity, b.gm)), [0, 0, 0] as Vec3), 1 / total);
  for (const b of bodies) { b.position = sub(b.position, center); b.velocity = sub(b.velocity, velocity); }
}

interface Elements { eccentricity: number; semiMajorAxisKm: number; meanLongitude: number; eccentricityVector: Vec3; angularMomentum: Vec3 }
function elements(central: OrbitBody, orbiting: OrbitBody): Elements {
  const r = sub(orbiting.position, central.position), v = sub(orbiting.velocity, central.velocity);
  const mu = central.gm + orbiting.gm, radius = norm(r), h = cross(r, v), hmag = norm(h);
  if (!(radius > 0 && hmag > 0 && mu > 0)) throw new Error('Degenerate orbital state');
  const evec = scale(sub(scale(r, dot(v, v) - mu / radius), scale(v, dot(r, v))), 1 / mu);
  const e = norm(evec), a = 1 / (2 / radius - dot(v, v) / mu);
  if (!(e < 1 && a > 0)) throw new Error('Only bound elliptical orbits are supported');
  const node: Vec3 = [-h[1], h[0], 0];
  const n = norm(node);
  let longitude: number;
  if (e < 1e-10) {
    // For an inclined orbit the projected azimuth is not the argument of latitude.
    longitude = n < 1e-10 * hmag
      ? Math.atan2(r[1], r[0])
      : Math.atan2(node[1], node[0]) + Math.atan2(dot(cross(node, r), h) / (n * radius * hmag), dot(node, r) / (n * radius));
  } else {
    const trueAnomaly = Math.atan2(dot(cross(evec, r), h) / (e * radius * hmag), dot(evec, r) / (e * radius));
    const eccentricAnomaly = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(trueAnomaly), e + Math.cos(trueAnomaly));
    const meanAnomaly = eccentricAnomaly - e * Math.sin(eccentricAnomaly);
    if (n < 1e-10 * hmag) {
      longitude = Math.atan2(evec[1], evec[0]) + meanAnomaly;
    } else {
      const ascendingNode = Math.atan2(node[1], node[0]);
      const argument = Math.atan2(dot(cross(node, evec), h) / (n * e * hmag), dot(node, evec) / (n * e));
      longitude = ascendingNode + argument + meanAnomaly;
    }
  }
  return { eccentricity: e, semiMajorAxisKm: a, meanLongitude: wrap(longitude), eccentricityVector: evec, angularMomentum: h };
}

/** Create the JPL epoch state; optional elements reconstruct Europa's osculating ellipse. */
export function createInitialOrbit(options: { eccentricity?: number; semiMajorAxisKm?: number } = {}): OrbitState {
  const bodies = cloneBodies(EPOCH_BODIES);
  const [jupiter, , europa] = bodies;
  if (options.eccentricity !== undefined || options.semiMajorAxisKm !== undefined) {
    const current = elements(jupiter, europa);
    const e = options.eccentricity ?? current.eccentricity;
    const a = options.semiMajorAxisKm ?? current.semiMajorAxisKm;
    if (!Number.isFinite(e) || e < 0 || e >= 1 || !Number.isFinite(a) || a <= 0) throw new Error('Expected 0 <= eccentricity < 1 and positive semi-major axis');
    const r = sub(europa.position, jupiter.position);
    const p = current.eccentricity > 1e-10 ? normalize(current.eccentricityVector) : normalize(r);
    const q = normalize(cross(normalize(current.angularMomentum), p));
    const cosf = dot(normalize(r), p), sinf = dot(normalize(r), q);
    const semilatus = a * (1 - e * e);
    const radius = semilatus / (1 + e * cosf);
    const speed = Math.sqrt((jupiter.gm + europa.gm) / semilatus);
    europa.position = add(jupiter.position, scale(add(scale(p, cosf), scale(q, sinf)), radius));
    europa.velocity = add(jupiter.velocity, scale(add(scale(p, -sinf), scale(q, e + cosf)), speed));
  }
  recenter(bodies);
  return { timeSeconds: 0, bodies };
}

function accelerations(bodies: OrbitBody[]): Vec3[] {
  const acceleration = bodies.map((): Vec3 => [0, 0, 0]);
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const delta = sub(bodies[j].position, bodies[i].position), distance = norm(delta);
    if (!(distance > 0) || !Number.isFinite(distance)) throw new Error('Coincident or invalid bodies');
    const direction = scale(delta, 1 / (distance * distance * distance));
    acceleration[i] = add(acceleration[i], scale(direction, bodies[j].gm));
    acceleration[j] = sub(acceleration[j], scale(direction, bodies[i].gm));
  }
  return acceleration;
}

/** Symmetric velocity-Verlet step; caller is responsible for timestep convergence. */
export function stepOrbit(state: OrbitState, dtSeconds: number): OrbitState {
  if (!Number.isFinite(dtSeconds) || dtSeconds === 0) throw new Error('A finite nonzero timestep is required');
  const bodies = cloneBodies(state.bodies), initial = accelerations(bodies);
  for (let i = 0; i < bodies.length; i++) {
    bodies[i].position = add(bodies[i].position, add(scale(bodies[i].velocity, dtSeconds), scale(initial[i], dtSeconds * dtSeconds / 2)));
  }
  const final = accelerations(bodies);
  for (let i = 0; i < bodies.length; i++) bodies[i].velocity = add(bodies[i].velocity, scale(add(initial[i], final[i]), dtSeconds / 2));
  return { timeSeconds: state.timeSeconds + dtSeconds, bodies };
}

export function orbitDiagnostics(state: OrbitState): OrbitDiagnostics {
  const body = (name: BodyName) => { const b = state.bodies.find(item => item.name === name); if (!b) throw new Error(`Missing ${name}`); return b; };
  const j = body('Jupiter'), io = elements(j, body('Io')), eu = elements(j, body('Europa')), ga = elements(j, body('Ganymede'));
  let energy = 0, angularMomentum: Vec3 = [0, 0, 0];
  for (let i = 0; i < state.bodies.length; i++) {
    const b = state.bodies[i];
    energy += b.gm * dot(b.velocity, b.velocity) / 2;
    angularMomentum = add(angularMomentum, scale(cross(b.position, b.velocity), b.gm));
    for (let k = i + 1; k < state.bodies.length; k++) {
      const c = state.bodies[k], distance = norm(sub(b.position, c.position));
      if (!(distance > 0)) throw new Error('Coincident bodies');
      energy -= b.gm * c.gm / distance;
    }
  }
  return { eccentricity: eu.eccentricity, semiMajorAxisKm: eu.semiMajorAxisKm, laplaceAngleDeg: wrap(io.meanLongitude - 3 * eu.meanLongitude + 2 * ga.meanLongitude) * 180 / Math.PI, energy, angularMomentum };
}
