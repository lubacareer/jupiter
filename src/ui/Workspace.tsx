import { useEffect, useRef, useState } from 'react'
import { MoonView } from './MoonView'
import { createInitialOrbit, orbitDiagnostics } from '../simulation/orbit'
import { createParameterState, editParameter, restoreParameters, type SimulationParameters, type ParameterOverrides } from './parameterState'

export type { SimulationParameters, ParameterOverrides } from './parameterState'
export type SimulationSample = { timeSeconds: number; eccentricity: number; semiMajorAxisKm: number; resonanceAngleDeg?: number }
export type SimulationSnapshot = {
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error'
  timeSeconds: number
  samples: SimulationSample[]
  message?: string
  gpuStatus?: string
  workerAvailable?: boolean
  workerGeneration?: number
  defaultParameters?: SimulationParameters
  restoredParameters?: SimulationParameters
  restoredOverrides?: ParameterOverrides
  restoreRevision?: number
  provenance?: 'local' | 'imported-unverified'
}
export type WorkspaceProps = {
  snapshot?: SimulationSnapshot
  onStart?: (params: ParameterOverrides) => void
  onPause?: () => void
  onReset?: () => void
  onExport?: () => void
  onSaveCheckpoint?: () => void
  onLoadCheckpoint?: () => void
}

const DEFAULT_SNAPSHOT: SimulationSnapshot = { status: 'idle', timeSeconds: 0, samples: [] }
const epochDiagnostics = orbitDiagnostics(createInitialOrbit())
const EPOCH_PARAMETERS: SimulationParameters = { eccentricity: epochDiagnostics.eccentricity, semiMajorAxisKm: epochDiagnostics.semiMajorAxisKm }
const formatDays = (seconds: number) => (seconds / 86400).toLocaleString(undefined, { maximumFractionDigits: 2 })

function OrbitGraphic({ eccentricity }: { eccentricity: number }) {
  const focus = 262 - Math.min(Math.max(eccentricity, 0), 1) * 211
  return <svg className="orbit-graphic" viewBox="0 0 520 190" aria-label="Schematic of Europa's orbit around Jupiter" role="img">
    <defs>
      <radialGradient id="jupiter-fill" cx="32%" cy="28%"><stop stopColor="#e4c7aa" /><stop offset="0.68" stopColor="#a0785f" /><stop offset="1" stopColor="#4f3c37" /></radialGradient>
      <linearGradient id="europa-fill" x2="1" y2="1"><stop stopColor="#eff8f9"/><stop offset="1" stopColor="#7e9ca9"/></linearGradient>
    </defs>
    <ellipse cx="262" cy="95" rx="211" ry="66" fill="none" stroke="#61758a" strokeWidth="1.2" strokeDasharray="6 6" />
    <ellipse cx="262" cy="95" rx="211" ry={66 * Math.sqrt(1 - eccentricity * eccentricity)} fill="none" stroke="#ffb34e" strokeWidth="2" />
    <g transform={`translate(${focus - 93},0)`}><circle cx="93" cy="95" r="37" fill="url(#jupiter-fill)" />
    <path d="M58 83 Q92 76 128 84 M57 96 Q92 102 130 95 M62 109 Q93 117 124 108" fill="none" stroke="#e7c3a7" opacity=".38" strokeWidth="3"/>
    <text x="93" y="151" textAnchor="middle" fill="#9dafc0" fontSize="11">JUPITER</text></g>
    <circle cx="473" cy="95" r="10" fill="url(#europa-fill)" />
    <text x="455" y="128" textAnchor="middle" fill="#9dafc0" fontSize="11">EUROPA</text>
  </svg>
}

function Plot({ samples }: { samples: SimulationSample[] }) {
  const finite = samples.filter(sample => Number.isFinite(sample.timeSeconds) && Number.isFinite(sample.eccentricity))
  const width = 520, height = 165, left = 50, right = 16, top = 14, bottom = 30
  const minT = finite.length ? finite[0].timeSeconds : 0
  const maxT = finite.length > 1 ? finite[finite.length - 1].timeSeconds : minT + 86400
  const minRaw = finite.length ? finite.reduce((min, sample) => Math.min(min, sample.eccentricity), Infinity) : 0
  const maxRaw = finite.length ? finite.reduce((max, sample) => Math.max(max, sample.eccentricity), -Infinity) : 0.01
  const padding = Math.max((maxRaw - minRaw) * .15, .0001)
  const minY = Math.max(0, minRaw - padding), maxY = maxRaw + padding
  const points = finite.map(p => `${left + (p.timeSeconds - minT) / (maxT - minT || 1) * (width - left - right)},${top + (maxY - p.eccentricity) / (maxY - minY || 1) * (height - top - bottom)}`).join(' ')
  return <div className="chart-wrap">
    {finite.length === 0 && <div className="chart-empty">Run the orbit model to generate data</div>}
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Plot of orbital eccentricity over simulated time">
      {[0, 1, 2, 3].map(i => {
        const y = top + i * (height - top - bottom) / 3
        return <g key={i}><line x1={left} x2={width - right} y1={y} y2={y} stroke="#26394a"/><text x={left - 8} y={y + 3} textAnchor="end" fill="#849caf" fontSize="10">{(maxY - (maxY - minY) * i / 3).toFixed(4)}</text></g>
      })}
      <line x1={left} x2={left} y1={top} y2={height - bottom} stroke="#526779"/>
      <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} stroke="#526779"/>
      {finite.length > 1 && <polyline points={points} fill="none" stroke="#55b8ff" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />}
      {finite.length === 1 && <circle cx={left} cy={top + (maxY - finite[0].eccentricity) / (maxY - minY) * (height - top - bottom)} r="3" fill="#55b8ff"/>}
      <text x={left} y={height - 10} fill="#849caf" fontSize="10">{formatDays(minT)}</text>
      <text x={width - right} y={height - 10} textAnchor="end" fill="#849caf" fontSize="10">{formatDays(maxT)} days</text>
    </svg>
  </div>
}

function Parameter({ label, symbol, value, min, max, units, onChange }: { label: string; symbol: string; value: number; min: number; max: number; units?: string; onChange: (value: number) => void }) {
  const id = `parameter-${symbol}`
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  // Preserve valid imported values outside the normal exploration range.
  const rangeMin = Math.min(min, value)
  const rangeMax = Math.max(max, value)
  const commitDraft = () => {
    const n = draft.trim() === '' ? NaN : Number(draft)
    const next = Number.isFinite(n) ? Math.max(rangeMin, Math.min(rangeMax, n)) : value
    setDraft(String(next))
    onChange(next)
  }
  return <div className="parameter-row">
    <label htmlFor={id}>{label} <i>{symbol}</i></label>
    <input id={id} type="range" min={rangeMin} max={rangeMax} step="any" value={value} onChange={event => onChange(Number(event.target.value))}/>
    <input aria-label={`${label} value`} type="number" min={rangeMin} max={rangeMax} step="any" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitDraft} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    <span className="unit">{units || ' '}</span>
  </div>
}

export default function Workspace({ snapshot = DEFAULT_SNAPSHOT, onStart, onPause, onReset, onExport, onSaveCheckpoint, onLoadCheckpoint }: WorkspaceProps) {
  const [parameters, setParameters] = useState(() => createParameterState(snapshot.defaultParameters ?? EPOCH_PARAMETERS))
  const lastRestoreKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = snapshot.restoreRevision === undefined ? undefined : `${snapshot.workerGeneration ?? 0}:${snapshot.restoreRevision}`
    if (key !== undefined && key !== lastRestoreKey.current && snapshot.restoredParameters && snapshot.restoredOverrides) {
      setParameters(restoreParameters(snapshot.restoredParameters, snapshot.restoredOverrides))
    }
    lastRestoreKey.current = key
  }, [snapshot.workerGeneration, snapshot.restoreRevision, snapshot.restoredParameters, snapshot.restoredOverrides])
  const { eccentricity, semiMajorAxisKm } = parameters.values
  const updateParameter = (key: keyof SimulationParameters, value: number) => setParameters(current => editParameter(current, key, value))
  const latest = snapshot.samples[snapshot.samples.length - 1]
  const isActive = snapshot.status === 'running'
  const workerAvailable = snapshot.workerAvailable !== false
  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><div className="brand-icon"><span /></div><div><strong>Europa Engine</strong><small>ORBITAL & INTERIOR DYNAMICS</small></div></div>
      <div className="header-actions"><span className="prototype-label"><span /> RESEARCH PROTOTYPE</span><button className="utility-button" onClick={onLoadCheckpoint} disabled={!onLoadCheckpoint}>Open checkpoint</button><button className="utility-button" onClick={onSaveCheckpoint} disabled={!onSaveCheckpoint || !workerAvailable || snapshot.samples.length === 0}>Save checkpoint</button><button className="utility-button" onClick={onExport} disabled={!onExport || !workerAvailable || snapshot.samples.length === 0}>Export data</button></div>
    </header>
    <div className="titlebar"><div><span className="section-kicker">SIMULATION WORKSPACE</span><h1>Europa dynamics</h1><p>Explore the relationship between orbital motion and Europa’s interior.</p></div><div className="status-chip"><span className={isActive ? 'status-dot active' : 'status-dot'} /> {snapshot.status === 'idle' ? 'Ready' : snapshot.status}</div></div>
    <div className="workspace-grid">
      <section className="panel moon-panel" aria-labelledby="moon-title">
        <div className="panel-heading"><div><h2 id="moon-title">Europa cutaway</h2><p>Illustrative interior · drag to rotate</p></div><span className="subtle-tag">SCHEMATIC</span></div>
        <div className="moon-stage"><MoonView /><div className="moon-caption"><span><b className="legend-swatch ice"/> Ice shell</span><span><b className="legend-swatch ocean"/> Ocean</span><span><b className="legend-swatch rock"/> Solid interior</span></div></div>
        <div className="moon-footnote">Interior geometry is illustrative and is not simulation output.</div>
      </section>
      <div className="right-column">
        <section className="panel orbit-panel" aria-labelledby="orbit-title"><div className="panel-heading"><div><h2 id="orbit-title">Orbit around Jupiter</h2><p>Initial conditions · schematic, not to scale</p></div><span className="orbit-key"><b /> INITIAL ORBIT</span></div><OrbitGraphic eccentricity={eccentricity}/></section>
        <section className="panel parameters-panel" aria-labelledby="parameters-title"><div className="panel-heading"><div><h2 id="parameters-title">Orbital parameters</h2><p>Changing inputs applies when you start a new run.</p></div></div>
          <Parameter label="Eccentricity" symbol="e" value={eccentricity} min={0} max={0.1} onChange={value => updateParameter('eccentricity', value)}/>
          <Parameter label="Semi-major axis" symbol="a" value={semiMajorAxisKm} min={600000} max={800000} units="km" onChange={value => updateParameter('semiMajorAxisKm', value)}/>
        </section>
        <section className="panel plot-panel" aria-labelledby="plot-title"><div className="panel-heading"><div><h2 id="plot-title">Orbital evolution</h2><p>Osculating eccentricity over simulated time</p></div><span className="plot-key"><b /> ECCENTRICITY</span></div><Plot samples={snapshot.samples}/><p className="plot-retention">Plot and export retain the latest 2,000 samples.</p></section>
      </div>
    </div>
    <div className="bottom-grid">
      <section className="panel stats-panel"><div className="panel-heading"><div><h2>Run status</h2><p>Current orbital integration</p></div></div><div className="stats-grid"><div><span>SIMULATED TIME</span><strong>{formatDays(snapshot.timeSeconds)} <small>days</small></strong></div><div><span>ECCENTRICITY</span><strong>{latest ? latest.eccentricity.toFixed(5) : '—'}</strong></div><div><span>RESONANCE ANGLE</span><strong>{latest?.resonanceAngleDeg !== undefined && Number.isFinite(latest.resonanceAngleDeg) ? `${latest.resonanceAngleDeg.toFixed(1)}°` : '—'}</strong></div></div>{snapshot.provenance === 'imported-unverified' && <p className="run-message">Imported checkpoint · origin and trajectory unverified</p>}{snapshot.message && <p className={snapshot.status === 'error' ? 'run-message error' : 'run-message'} role="status">{snapshot.message}</p>}</section>
      <section className="panel control-panel"><div className="panel-heading"><div><h2>Simulation controls</h2><p>Orbital research prototype</p></div><span className="subtle-tag">FOUR-BODY</span></div><div className="control-buttons"><button className="primary-button" onClick={() => onStart?.(parameters.overrides)} disabled={!onStart || isActive}><span aria-hidden="true">▶</span> Start new run</button><button className="utility-button" onClick={onPause} disabled={!onPause || !workerAvailable || !['running', 'paused'].includes(snapshot.status)}>{snapshot.status === 'paused' ? 'Resume' : 'Pause'}</button><button className="utility-button" onClick={onReset} disabled={!onReset || !workerAvailable || snapshot.status === 'idle'}>Reset</button></div><div className="gpu-status">{snapshot.gpuStatus || 'GPU compute: not connected'}</div></section>
    </div>
    <aside className="model-note"><span className="note-icon">i</span><p><strong>Model scope:</strong> This prototype currently exposes orbital dynamics only. The cutaway is illustrative; coupled 3D tidal, ocean, phase-change and self-gravity solvers are not yet available. Results are not mission predictions.</p></aside>
    <footer><span>EUROPA ENGINE <span className="footer-sep">/</span> RESEARCH PROTOTYPE</span><span>Local simulation <span className="footer-sep">·</span> Results depend on model assumptions</span></footer>
  </main>
}
