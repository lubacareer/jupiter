import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { OrbitalBaseline, OrbitalSample } from '../simulation/orbitAnalysis'

// Older checkpoints have no positions or conservation history. Keep them as gaps.
export type PlotSample = Omit<OrbitalSample, 'resonanceAngleDeg'> & { resonanceAngleDeg?: number }
const bodies = ['Io', 'Europa', 'Ganymede'] as const
const colors = { Io: '#e6be65', Europa: '#89d1ff', Ganymede: '#d5a98d' } as const
const days = (time: number) => (time / 86400).toLocaleString(undefined, { maximumFractionDigits: 2 })
const finiteVector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)

type SceneUpdate = { update: (samples: readonly PlotSample[]) => void }

/** Jupiter-centered ICRF vectors; globe radii are illustrative, not to scale. */
export function OrbitView({ samples, label }: { samples: readonly PlotSample[]; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneUpdate | null>(null)
  const actionRef = useRef<((action: 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'reset') => void) | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [viewVersion, setViewVersion] = useState(0)
  const latest = samples[samples.length - 1]
  const hasPositions = !!latest?.positionsKm && bodies.every(body => finiteVector(latest.positionsKm?.[body]))

  useEffect(() => {
    const element = host.current
    if (!element || !hasPositions) { setUnavailable(false); return }
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }) }
    catch { setUnavailable(true); return }
    setUnavailable(false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    element.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, 1, .01, 100)
    camera.position.set(1.5, 2.5, 4.5)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enablePan = false
    controls.minDistance = 1.5; controls.maxDistance = 20
    controls.target.set(0, 0, 0)
    const group = new THREE.Group()
    scene.add(group)
    scene.add(new THREE.AmbientLight(0xffffff, 2))
    const sun = new THREE.DirectionalLight(0xffecd2, 2)
    sun.position.set(-3, 3, 5); scene.add(sun)
    const jupiter = new THREE.Mesh(new THREE.SphereGeometry(.17, 24, 16), new THREE.MeshStandardMaterial({ color: '#bd8d6b' }))
    scene.add(jupiter)
    const markers = Object.fromEntries(bodies.map(body => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(.055, 16, 12), new THREE.MeshStandardMaterial({ color: colors[body] }))
      mesh.visible = false; scene.add(mesh); return [body, mesh]
    })) as unknown as Record<typeof bodies[number], THREE.Mesh>
    const render = () => renderer.render(scene, camera)
    const resize = () => {
      const width = Math.max(element.clientWidth, 1), height = Math.max(element.clientHeight, 1)
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render()
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
    observer?.observe(element)
    if (!observer) window.addEventListener('resize', resize)
    controls.addEventListener('change', render)
    actionRef.current = action => {
      if (action === 'reset') camera.position.set(1.5, 2.5, 4.5)
      else if (action === 'left' || action === 'right') {
        camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), action === 'left' ? .2 : -.2)
      } else if (action === 'up' || action === 'down') {
        const spherical = new THREE.Spherical().setFromVector3(camera.position)
        spherical.phi = THREE.MathUtils.clamp(spherical.phi + (action === 'up' ? -.2 : .2), .05, Math.PI - .05)
        camera.position.setFromSpherical(spherical)
      } else camera.position.multiplyScalar(action === 'in' ? .8 : 1.25).clampLength(controls.minDistance, controls.maxDistance)
      controls.update(); render()
    }
    const clearTrails = () => {
      for (const child of [...group.children]) {
        group.remove(child)
        if (child instanceof THREE.Line) { child.geometry.dispose(); (child.material as THREE.Material).dispose() }
      }
    }
    sceneRef.current = { update(rows) {
      clearTrails()
      // Rescale consistently across the entire retained trail, keeping all bodies in view.
      let extent = 1
      for (const row of rows) for (const body of bodies) {
        const vector = row.positionsKm?.[body]
        if (finiteVector(vector)) extent = Math.max(extent, Math.abs(vector[0]), Math.abs(vector[1]), Math.abs(vector[2]))
      }
      const toVector = (v: [number, number, number]) => new THREE.Vector3(v[0] / extent * 1.8, v[1] / extent * 1.8, v[2] / extent * 1.8)
      for (const body of bodies) {
        let segment: THREE.Vector3[] = []
        const flush = () => {
          if (segment.length > 1) group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(segment), new THREE.LineBasicMaterial({ color: colors[body], transparent: true, opacity: .7 })))
          segment = []
        }
        for (const row of rows) {
          const vector = row.positionsKm?.[body]
          if (finiteVector(vector)) segment.push(toVector(vector)); else flush()
        }
        flush()
        const current = rows[rows.length - 1]?.positionsKm?.[body]
        markers[body].visible = finiteVector(current)
        if (finiteVector(current)) markers[body].position.copy(toVector(current))
      }
      render()
    } }
    resize(); setViewVersion(value => value + 1)
    return () => {
      sceneRef.current = null
      actionRef.current = null
      controls.removeEventListener('change', render); controls.dispose()
      observer?.disconnect(); if (!observer) window.removeEventListener('resize', resize)
      clearTrails()
      for (const mesh of [jupiter, ...Object.values(markers)]) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose() }
      renderer.dispose(); renderer.domElement.remove()
    }
  }, [hasPositions])
  useEffect(() => { sceneRef.current?.update(samples) }, [samples, viewVersion])

  return <div className="orbit-analysis-view">
    <div ref={host} className="orbit-analysis-canvas" role="img" aria-label={`${label} Jupiter-centered orbital positions and trails in 3D`}/>
    {!hasPositions && !unavailable && <p className="orbit-overlay">Start or resume a run to see orbital positions.</p>}
    {unavailable && <p className="orbit-overlay" role="status">3D view unavailable: WebGL could not be initialized.</p>}
    <div className="orbit-legend" aria-label="Orbital body legend"><span><b style={{ background: '#bd8d6b' }}/> Jupiter</span>{bodies.map(body => <span key={body}><b style={{ background: colors[body] }}/>{body}</span>)}</div>
    <div className="orbit-view-controls" aria-label={`${label} orbit view controls`}>
      <button type="button" disabled={!hasPositions || unavailable} onClick={() => actionRef.current?.('left')} aria-label={`${label} rotate orbit left`}>↶</button>
      <button type="button" disabled={!hasPositions || unavailable} onClick={() => actionRef.current?.('right')} aria-label={`${label} rotate orbit right`}>↷</button>
      <button type="button" disabled={!hasPositions || unavailable} onClick={() => actionRef.current?.('up')} aria-label={`${label} rotate orbit up`}>↑</button>
      <button type="button" disabled={!hasPositions || unavailable} onClick={() => actionRef.current?.('down')} aria-label={`${label} rotate orbit down`}>↓</button>
      <button type="button" disabled={!hasPositions || unavailable} onClick={() => actionRef.current?.('in')} aria-label={`${label} zoom orbit in`}>+</button>
      <button type="button" disabled={!hasPositions || unavailable} onClick={() => actionRef.current?.('out')} aria-label={`${label} zoom orbit out`}>−</button>
      <button type="button" disabled={!hasPositions || unavailable} onClick={() => actionRef.current?.('reset')} aria-label={`${label} reset orbit view`}>Reset view</button>
    </div>
    <p className="orbit-explanation">Jupiter-centered ICRF · {latest ? `${days(latest.timeSeconds)} simulated days` : 'No simulation data'} · Drag to rotate; scroll to zoom · Body sizes exaggerated</p>
  </div>
}

type PlotKey = 'eccentricity' | 'semiMajorAxisKm' | 'resonanceAngleDeg'
const plotInfo: Record<PlotKey, { title: string; unit: string; color: string }> = {
  eccentricity: { title: 'Eccentricity', unit: '', color: '#55b8ff' },
  semiMajorAxisKm: { title: 'Semi-major axis', unit: 'km', color: '#e5b46b' },
  resonanceAngleDeg: { title: 'Laplace resonance angle', unit: '°', color: '#a6ddb8' },
}

/** Return disjoint traces when values are missing or a wrapped angle crosses its seam. */
export function plotSegments(samples: readonly PlotSample[], key: PlotKey): PlotSample[][] {
  const segments: PlotSample[][] = []
  let current: PlotSample[] = []
  for (const sample of samples) {
    const value = sample[key]
    if (!Number.isFinite(sample.timeSeconds) || typeof value !== 'number' || !Number.isFinite(value)) {
      if (current.length) segments.push(current)
      current = []; continue
    }
    const previous = current[current.length - 1]?.[key]
    if (key === 'resonanceAngleDeg' && typeof previous === 'number' && Math.abs(value - previous) > 180) {
      segments.push(current); current = []
    }
    current.push(sample)
  }
  if (current.length) segments.push(current)
  return segments
}

function OrbitalPlot({ samples, metric, label }: { samples: readonly PlotSample[]; metric: PlotKey; label: string }) {
  const info = plotInfo[metric], segments = plotSegments(samples, metric), rows = segments.flat()
  const minT = rows[0]?.timeSeconds ?? 0, maxT = rows[rows.length - 1]?.timeSeconds ?? minT
  const values = rows.map(row => row[metric] as number)
  const minRaw = metric === 'resonanceAngleDeg' ? -180 : values.length ? Math.min(...values) : 0
  const maxRaw = metric === 'resonanceAngleDeg' ? 180 : values.length ? Math.max(...values) : 1
  const padding = metric === 'resonanceAngleDeg' ? 0 : Math.max((maxRaw - minRaw) * .1, Math.abs(maxRaw) * .001, 1e-8)
  const minY = minRaw - padding, maxY = maxRaw + padding
  const x = (row: PlotSample) => 50 + ((row.timeSeconds - minT) / (maxT - minT || 1)) * 450
  const y = (row: PlotSample) => 12 + (maxY - (row[metric] as number)) / (maxY - minY || 1) * 100
  return <div className="orbit-plot"><h3>{info.title} {info.unit && <small>({info.unit})</small>}</h3>
    {rows.length === 0 && <p className="orbit-plot-empty">No data available</p>}
    <svg viewBox="0 0 520 145" className="chart" role="img" aria-label={`${label} ${info.title} over simulated time`}>
      {[0, 1, 2].map(i => <g key={i}><line x1="50" x2="500" y1={12 + i * 50} y2={12 + i * 50} stroke="#26394a"/><text x="44" y={15 + i * 50} textAnchor="end" fill="#a5bac8" fontSize="9">{(maxY - (maxY - minY) * i / 2).toPrecision(4)}</text></g>)}
      {segments.map((segment, i) => segment.length === 1 ? <circle key={i} cx={x(segment[0])} cy={y(segment[0])} r="2.5" fill={info.color}/> : <polyline key={i} points={segment.map(row => `${x(row)},${y(row)}`).join(' ')} fill="none" stroke={info.color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>)}
      <text x="50" y="137" fill="#a5bac8" fontSize="9">{days(minT)}</text><text x="500" y="137" fill="#a5bac8" fontSize="9" textAnchor="end">{days(maxT)} days</text>
    </svg>
  </div>
}

export function OrbitDiagnosticsView({ samples, baseline, label }: { samples: readonly PlotSample[]; baseline?: OrbitalBaseline; label: string }) {
  const last = samples[samples.length - 1]
  const drift = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toExponential(3) : 'Unavailable'
  const number = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) ? value.toPrecision(7) : 'Unavailable'
  return <div className="orbital-diagnostics">
    <div className="orbital-plots">{(['eccentricity', 'semiMajorAxisKm', 'resonanceAngleDeg'] as const).map(metric => <OrbitalPlot key={metric} samples={samples} metric={metric} label={label}/>)}</div>
    <details className="orbital-values"><summary>{label} current numerical values</summary>
      <p>Simulated time: {last ? `${number(last.timeSeconds)} seconds` : 'Unavailable'}</p>
      <p>Eccentricity: {number(last?.eccentricity)} · Semi-major axis: {number(last?.semiMajorAxisKm)} km · Laplace resonance angle: {number(last?.resonanceAngleDeg)} degrees</p>
      <p>Jupiter-centered ICRF position components (x, y, z), kilometres:</p>
      {bodies.map(body => <p key={body}>{body}: {finiteVector(last?.positionsKm?.[body]) ? last!.positionsKm![body].map(value => number(value)).join(', ') : 'Unavailable'}</p>)}
    </details>
    <div className="conservation-summary"><strong>Numerical conservation checks</strong><span>Relative energy drift: {drift(last?.energyDrift)}</span><span>Relative angular-momentum vector drift: {drift(last?.angularMomentumDrift)}</span>
      <span>Baseline: {baseline ? `${baseline.kind === 'initial' ? 'initial state' : 'restored state'} at ${days(baseline.timeSeconds)} simulated days` : 'Unavailable'}</span>
      <small>Mass-weighted model diagnostics; not physical validation. Plot and trails retain the latest 2,000 samples.</small>
    </div>
  </div>
}
