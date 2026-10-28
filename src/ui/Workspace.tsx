import { useEffect, useMemo, useRef, useState } from 'react'
import { MoonView } from './MoonView'
import { createInitialOrbit, orbitDiagnostics } from '../simulation/orbit'
import { createParameterState, editParameter, restoreParameters, type SimulationParameters, type ParameterOverrides } from './parameterState'
import { GpuPanel, type GpuFileBridge } from './GpuPanel'
import { OrbitDiagnosticsView, OrbitView, type PlotSample } from './OrbitAnalysis'
import type { OrbitalBaseline } from '../simulation/orbitAnalysis'
import type { GpuWorkerSnapshot } from '../simulation/gpuProtocol'
import type { RadialWorkerSnapshot } from '../simulation/radialProtocol'
import { RadialPanel } from './RadialPanel'
import { cutawayBands, type CutawayField, type CutawayScale } from './cutawayGeometry'
import './radial.css'

export type { SimulationParameters, ParameterOverrides } from './parameterState'
export type SimulationSample = PlotSample
export type SimulationSnapshot = {
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error'
  timeSeconds: number
  samples: SimulationSample[]
  baseline?: OrbitalBaseline
  message?: string
  gpuStatus?: string
  workerAvailable?: boolean
  workerGeneration?: number
  defaultParameters?: SimulationParameters
  restoredParameters?: SimulationParameters
  restoredOverrides?: ParameterOverrides
  restoreRevision?: number
  provenance?: 'local' | 'imported-unverified'
  checksumStatus?: 'verified' | 'unavailable'
}
export type WorkspaceProps = {
  gpuBridge?: GpuFileBridge
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

function Parameter({ label, symbol, value, min, max, units, onChange }: { label: string; symbol: string; value: number; min: number; max: number; units?: string; onChange: (value: number) => void }) {
  const id = `parameter-${symbol}`
  const [draft, setDraft] = useState(String(value))
  const [bounds, setBounds] = useState(() => ({ min: Math.min(min, value), max: Math.max(max, value) }))
  useEffect(() => setDraft(String(value)), [value])
  // Retain every restored extent for the lifetime of this control, even if the
  // user later edits back toward the normal exploration range.
  useEffect(() => {
    setBounds(previous => {
      const next = { min: Math.min(previous.min, min, value), max: Math.max(previous.max, max, value) }
      return next.min === previous.min && next.max === previous.max ? previous : next
    })
  }, [min, max, value])
  // Include a newly restored value immediately, before the effect persists it.
  const rangeMin = Math.min(bounds.min, min, value)
  const rangeMax = Math.max(bounds.max, max, value)
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

export default function Workspace({ snapshot = DEFAULT_SNAPSHOT, onStart, onPause, onReset, onExport, onSaveCheckpoint, onLoadCheckpoint, gpuBridge }: WorkspaceProps) {
  const [parameters, setParameters] = useState(() => createParameterState(snapshot.defaultParameters ?? EPOCH_PARAMETERS))
  const [gpuSnapshot, setGpuSnapshot] = useState<GpuWorkerSnapshot | undefined>()
  const [radialSnapshot, setRadialSnapshot] = useState<RadialWorkerSnapshot | undefined>()
  const [orbitalSource, setOrbitalSource] = useState<'cpu' | 'gpu'>('cpu')
  const [field, setField] = useState<CutawayField>('temperature')
  const [scale, setScale] = useState<CutawayScale>('exaggerated')
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
  const selectedSample = orbitalSource === 'cpu' ? latest : gpuSnapshot?.orbitAnalysisSamples?.at(-1)
  const orbit = useMemo(() => selectedSample?.positionsKm?.Europa ? { europaPositionKm: selectedSample.positionsKm.Europa } : undefined, [selectedSample])
  const selectedState = radialSnapshot?.state
  const selectedEnthalpy = radialSnapshot?.backend === 'gpu' ? radialSnapshot.gpuEnthalpy : selectedState?.enthalpy
  const thermal = useMemo(() => selectedState && selectedEnthalpy ? { state: selectedState, enthalpy: selectedEnthalpy, field, scale } : undefined, [selectedState, selectedEnthalpy, field, scale])
  const thermalLegend = useMemo(() => thermal ? cutawayBands(thermal) : undefined, [thermal])
  const distance = orbit ? Math.hypot(...orbit.europaPositionKm) : undefined
  const isActive = snapshot.status === 'running'
  const workerAvailable = snapshot.workerAvailable !== false
  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><div className="brand-icon"><span /></div><div><strong>Europa Engine</strong><small>ORBITAL & INTERIOR DYNAMICS</small></div></div>
      <div className="header-actions"><span className="prototype-label"><span /> RESEARCH PROTOTYPE</span><button className="utility-button" onClick={onLoadCheckpoint} disabled={!onLoadCheckpoint}>Open checkpoint</button><button className="utility-button" onClick={onSaveCheckpoint} disabled={!onSaveCheckpoint || !workerAvailable || snapshot.samples.length === 0}>Save checkpoint</button><button className="utility-button" onClick={onExport} disabled={!onExport || !workerAvailable || snapshot.samples.length === 0}>Export data</button></div>
    </header>
    <div className="titlebar"><div><span className="section-kicker">SIMULATION WORKSPACE</span><h1>Europa dynamics</h1><p>Explore independent models of orbital motion and interior phase change.</p></div><div className="status-chip"><span className={isActive ? 'status-dot active' : 'status-dot'} /> {snapshot.status === 'idle' ? 'Ready' : snapshot.status}</div></div>
    <div className="workspace-grid">
      <section className="panel moon-panel" aria-labelledby="moon-title">
        <div className="panel-heading"><div><h2 id="moon-title">Europa cutaway</h2><p>1D radial interior · drag or use arrow keys to rotate</p></div><span className="subtle-tag">RESEARCH MODEL</span></div>
        <div className="cutaway-controls"><label>Orbit overlay <select aria-label="Orbit overlay source" value={orbitalSource} onChange={event => setOrbitalSource(event.target.value as 'cpu' | 'gpu')}><option value="cpu">CPU orbit</option><option value="gpu">GPU orbit</option></select></label><label>Interior field <select aria-label="Interior field" value={field} onChange={event => setField(event.target.value as CutawayField)}><option value="temperature">Temperature</option><option value="liquidFraction">Liquid fraction</option></select></label><label>Layer scale <select aria-label="Layer scale" value={scale} onChange={event => setScale(event.target.value as CutawayScale)}><option value="exaggerated">Exaggerated</option><option value="true">True radial scale</option></select></label></div>
        <div className="moon-stage"><MoonView thermal={thermal} orbit={orbit}/><div className="moon-caption">{!thermal && <><span><b className="legend-swatch ice"/> Ice shell</span><span><b className="legend-swatch ocean"/> Ocean</span></>}{thermalLegend?.transitionRadius !== null && thermalLegend?.transitionRadius !== undefined && <span><b className="legend-swatch transition"/> 50% liquid transition</span>}<span><b className="legend-swatch rock"/> Solid interior (illustrative)</span></div></div>
        <div className="cutaway-readout">{distance === undefined ? `${orbitalSource.toUpperCase()} orbit unavailable · start a run for Jupiter direction` : `${orbitalSource.toUpperCase()} orbit · Jupiter direction arrow · ${distance.toLocaleString(undefined, { maximumFractionDigits: 0 })} km away · orbital time ${formatDays(selectedSample!.timeSeconds)} days · eccentricity ${selectedSample!.eccentricity.toFixed(5)} · semi-major axis ${selectedSample!.semiMajorAxisKm.toLocaleString(undefined, { maximumFractionDigits: 0 })} km · Laplace angle ${typeof selectedSample!.resonanceAngleDeg === 'number' && Number.isFinite(selectedSample!.resonanceAngleDeg) ? `${selectedSample!.resonanceAngleDeg.toFixed(1)}°` : 'unavailable'}`}</div>
        {thermalLegend ? <div className="cutaway-readout"><span className="field-gradient" aria-hidden="true"/> {field === 'temperature' ? `Temperature ${thermalLegend.min.toFixed(1)}–${thermalLegend.max.toFixed(1)} K` : 'Liquid fraction 0–1'} · {scale === 'true' ? 'true radial scale' : 'exaggerated layer scale'} · {radialSnapshot?.backend?.toUpperCase()} radial result · interior time {(selectedState!.timeSeconds / 31557600).toLocaleString(undefined, { maximumFractionDigits: 1 })} years</div> : <div className="cutaway-readout">Interior is schematic until a radial run is available.</div>}
        <div className="moon-footnote">Radial results have no lateral variation. Moon orientation and rocky interior are illustrative; orbital and interior runs are independent.</div>
      </section>
      <div className="right-column">
        <section className="panel orbit-panel" aria-labelledby="orbit-title"><div className="panel-heading"><div><h2 id="orbit-title">CPU orbit around Jupiter</h2><p>Live four-body positions · point-mass model</p></div><span className="subtle-tag">CPU</span></div><OrbitView samples={snapshot.samples} label="CPU"/></section>
        <section className="panel parameters-panel" aria-labelledby="parameters-title"><div className="panel-heading"><div><h2 id="parameters-title">Orbital parameters</h2><p>Changing inputs applies when you start a new run.</p></div></div>
          <Parameter label="Eccentricity" symbol="e" value={eccentricity} min={0} max={0.1} onChange={value => updateParameter('eccentricity', value)}/>
          <Parameter label="Semi-major axis" symbol="a" value={semiMajorAxisKm} min={600000} max={800000} units="km" onChange={value => updateParameter('semiMajorAxisKm', value)}/>
        </section>
        <section className="panel plot-panel" aria-labelledby="plot-title"><div className="panel-heading"><div><h2 id="plot-title">CPU orbital evolution</h2><p>Osculating elements and resonance over simulated time</p></div></div><OrbitDiagnosticsView samples={snapshot.samples} baseline={snapshot.baseline} label="CPU"/></section>
      </div>
    </div>
    <div className="bottom-grid">
      <section className="panel stats-panel"><div className="panel-heading"><div><h2>Run status</h2><p>Current orbital integration</p></div></div><div className="stats-grid"><div><span>SIMULATED TIME</span><strong>{formatDays(snapshot.timeSeconds)} <small>days</small></strong></div><div><span>ECCENTRICITY</span><strong>{latest ? latest.eccentricity.toFixed(5) : '—'}</strong></div><div><span>RESONANCE ANGLE</span><strong>{latest?.resonanceAngleDeg !== undefined && Number.isFinite(latest.resonanceAngleDeg) ? `${latest.resonanceAngleDeg.toFixed(1)}°` : '—'}</strong></div></div>{snapshot.provenance === 'imported-unverified' && <p className="run-message">Imported checkpoint{snapshot.checksumStatus === 'verified' ? ' · checksum verified at load' : snapshot.checksumStatus === 'unavailable' ? ' · checksum unavailable' : ''} · origin and trajectory unverified</p>}{snapshot.message && <p className={snapshot.status === 'error' ? 'run-message error' : 'run-message'} role="status">{snapshot.message}</p>}</section>
      <section className="panel control-panel"><div className="panel-heading"><div><h2>Simulation controls</h2><p>Orbital research prototype</p></div><span className="subtle-tag">FOUR-BODY</span></div><div className="control-buttons"><button className="primary-button" onClick={() => onStart?.(parameters.overrides)} disabled={!onStart || isActive}><span aria-hidden="true">▶</span> Start new run</button><button className="utility-button" onClick={onPause} disabled={!onPause || !workerAvailable || !['running', 'paused'].includes(snapshot.status)}>{snapshot.status === 'paused' ? 'Resume' : 'Pause'}</button><button className="utility-button" onClick={onReset} disabled={!onReset || !workerAvailable || snapshot.status === 'idle'}>Reset</button></div><div className="gpu-status">{snapshot.gpuStatus || 'GPU compute: not connected'}</div></section>
    </div>
    <RadialPanel bridge={gpuBridge} onSnapshot={setRadialSnapshot}/>
    {gpuBridge && <GpuPanel parameters={parameters.overrides} bridge={gpuBridge} onSnapshot={setGpuSnapshot} />}
    <aside className="model-note"><span className="note-icon">i</span><p><strong>Model scope:</strong> The orbital models, radial interior model and synthetic Cartesian thermal experiment are independent. The radial model is not a coupled 3D tidal, ocean or self-gravity solver. Results are not mission predictions.</p></aside>
    <footer><span>EUROPA ENGINE <span className="footer-sep">/</span> RESEARCH PROTOTYPE</span><span>Local simulation <span className="footer-sep">·</span> Results depend on model assumptions</span></footer>
  </main>
}
