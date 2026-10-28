import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { defaultRadialConfig, maximumRadialTimeStep, radialDiagnostics, radialFieldProfile, radialCellGeometry, type RadialConfig } from '../simulation/radialInterior'
import type { RadialWorkerCommand, RadialWorkerEvent, RadialWorkerSnapshot } from '../simulation/radialProtocol'
import type { GpuFileBridge } from './GpuPanel'

const initialSnapshot: RadialWorkerSnapshot = { status: 'idle', provenance: 'local' }
const years = (s: number) => (s / 31557600).toLocaleString(undefined, { maximumFractionDigits: 1 })

/** A separate worker keeps radial experiments independent of the orbital clocks. */
export function RadialPanel({ bridge, onSnapshot }: { bridge?: GpuFileBridge; onSnapshot: (snapshot: RadialWorkerSnapshot) => void }) {
  const worker = useRef<Worker | null>(null)
  const lastRestore = useRef<string | undefined>(undefined)
  const callback = useRef(onSnapshot)
  useLayoutEffect(() => { callback.current = onSnapshot }, [onSnapshot])
  const [generation, setGeneration] = useState(0)
  const [failed, setFailed] = useState(false)
  const [snapshot, setSnapshot] = useState<RadialWorkerSnapshot>(initialSnapshot)
  const [config, setConfig] = useState<RadialConfig>(defaultRadialConfig)
  const [backend, setBackend] = useState<'cpu' | 'gpu'>('cpu')
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (typeof Worker === 'undefined') { setFailed(true); return }
    const instance = new Worker(new URL('../simulation/radialWorker.ts', import.meta.url), { type: 'module' })
    worker.current = instance
    instance.onmessage = (event: MessageEvent<RadialWorkerEvent>) => {
      if (worker.current !== instance) return
      if (event.data.type === 'snapshot') {
        const next = event.data.snapshot
        const key = next.restoreRevision === undefined ? undefined : `${generation}:${next.restoreRevision}`
        if (key !== undefined && key !== lastRestore.current && next.restoredConfig) {
          setConfig(next.restoredConfig)
          if (next.backend) setBackend(next.backend)
        }
        lastRestore.current = key
        setSnapshot(event.data.snapshot); callback.current(event.data.snapshot)
      } else {
        const { type: kind, document } = event.data
        if (!bridge?.saveRadialDocument) { setMessage('Desktop file saving is unavailable.'); return }
        void bridge.saveRadialDocument(kind, document).then(saved => { if (saved) setMessage('Interior file saved.') })
          .catch(error => setMessage(error instanceof Error ? error.message : 'Could not save interior file.'))
      }
    }
    instance.onerror = () => {
      if (worker.current !== instance) return
      instance.terminate(); worker.current = null; setFailed(true)
      const error: RadialWorkerSnapshot = { status: 'error', provenance: 'local', message: 'Interior worker exited; in-memory results were lost. Retry to start a fresh worker.' }
      setSnapshot(error); callback.current(error)
    }
    return () => { instance.terminate(); if (worker.current === instance) worker.current = null }
  }, [bridge, generation])
  const send = (command: RadialWorkerCommand) => worker.current?.postMessage(command)
  const change = (name: keyof RadialConfig, value: number) => setConfig(previous => ({ ...previous, [name]: value }))
  const changeMaterial = (name: keyof RadialConfig['material'], value: number) => setConfig(previous => ({ ...previous, material: { ...previous.material, [name]: value } }))
  const start = () => {
    try {
      const next = { ...config, dtSeconds: maximumRadialTimeStep(config) * .45 }
      setMessage(''); send({ type: 'start', backend, config: next })
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid interior configuration.') }
  }
  const load = async () => {
    if (!bridge?.loadRadialCheckpoint) return
    try { const checkpoint = await bridge.loadRadialCheckpoint(); if (checkpoint != null) send({ type: 'load', checkpoint }) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not open interior checkpoint.') }
  }
  const state = snapshot.state
  const displayedEnthalpy = snapshot.backend === 'gpu' ? snapshot.gpuEnthalpy : state?.enthalpy
  const referenceDiagnostics = state ? radialDiagnostics(state) : undefined
  const profile = state && displayedEnthalpy ? radialFieldProfile(state.config, displayedEnthalpy) : undefined
  const diagnostics = state && profile ? (() => {
    let volume = 0, liquid = 0
    profile.cells.forEach((cell, i) => { const v = radialCellGeometry(state.config, i).volumeM3; volume += v; liquid += v * cell.liquidFraction })
    return { minTemperatureK: Math.min(...profile.cells.map(cell => cell.temperatureK)), maxTemperatureK: Math.max(...profile.cells.map(cell => cell.temperatureK)), meanLiquidFraction: liquid / volume, iceThicknessM: profile.iceThicknessM }
  })() : undefined
  const active = snapshot.status === 'running'
  return <section className="panel radial-panel" aria-labelledby="radial-title">
    <div className="panel-heading"><div><h2 id="radial-title">Europa-inspired radial interior</h2><p>Independent 1D spherical conduction and phase change; no orbital heating, ocean circulation, or tidal coupling.</p></div><span className="subtle-tag">RESEARCH PROTOTYPE</span></div>
    <div className="radial-controls">
      <label>Interior backend <select aria-label="Interior backend" value={backend} onChange={event => setBackend(event.target.value as 'cpu' | 'gpu')}><option value="cpu">CPU double precision</option><option value="gpu">WebGPU with CPU comparison</option></select></label>
      <label>Radius (km) <input type="number" aria-label="Interior radius in km" value={config.radiusM / 1000} onChange={event => change('radiusM', Number(event.target.value) * 1000)}/></label>
      <label>Initial ice thickness (km) <input type="number" aria-label="Initial ice thickness in km" value={config.iceThicknessM / 1000} onChange={event => change('iceThicknessM', Number(event.target.value) * 1000)}/></label>
      <label>Initial ocean depth (km) <input type="number" aria-label="Initial ocean depth in km" value={config.oceanDepthM / 1000} onChange={event => change('oceanDepthM', Number(event.target.value) * 1000)}/></label>
      <label>Radial cells <input type="number" aria-label="Radial cells" value={config.cells} onChange={event => change('cells', Number(event.target.value))}/></label>
      <label>Surface temperature (K) <input type="number" aria-label="Surface temperature in K" value={config.surfaceTemperatureK} onChange={event => change('surfaceTemperatureK', Number(event.target.value))}/></label>
      <label>Basal heat flux (W/m²) <input type="number" aria-label="Basal heat flux in watts per square metre" value={config.basalHeatFluxWm2} onChange={event => change('basalHeatFluxWm2', Number(event.target.value))}/></label>
    </div>
    <details className="radial-material"><summary>Material properties (constant)</summary><div className="radial-controls">
      {([['density', 'Density (kg/m³)'], ['iceHeatCapacity', 'Ice heat capacity (J/kg K)'], ['waterHeatCapacity', 'Water heat capacity (J/kg K)'], ['iceConductivity', 'Ice conductivity (W/m K)'], ['waterConductivity', 'Water conductivity (W/m K)'], ['latentHeat', 'Latent heat (J/kg)'], ['meltingTemperature', 'Melting temperature (K)']] as const).map(([name, label]) => <label key={name}>{label} <input type="number" aria-label={label} value={config.material[name]} onChange={event => changeMaterial(name, Number(event.target.value))}/></label>)}
    </div></details>
    <p className="radial-note">Edits apply to a new run. The timestep is selected from the diffusion stability limit; surface temperature and heat flux are assumptions.</p>
    <div className="control-buttons"><button className="primary-button" disabled={active || failed} onClick={start}>Start interior run</button><button className="utility-button" disabled={failed || !['running', 'paused'].includes(snapshot.status)} onClick={() => send({ type: active ? 'pause' : 'resume' })}>{active ? 'Pause interior' : 'Resume interior'}</button><button className="utility-button" disabled={failed || snapshot.status === 'idle'} onClick={() => send({ type: 'reset' })}>Reset interior</button>{failed && <button className="utility-button" onClick={() => { setFailed(false); setGeneration(g => g + 1) }}>Retry interior worker</button>}</div>
    <div className="control-buttons"><button className="utility-button" disabled={failed || !bridge?.loadRadialCheckpoint} onClick={() => void load()}>Open interior checkpoint</button><button className="utility-button" disabled={failed || !state || !bridge?.saveRadialDocument} onClick={() => send({ type: 'checkpoint' })}>Save interior checkpoint</button><button className="utility-button" disabled={failed || !state || !bridge?.saveRadialDocument} onClick={() => send({ type: 'export' })}>Export interior data</button></div>
    <p className="radial-note">Status: {snapshot.status}{snapshot.backend && ` · ${snapshot.backend.toUpperCase()}`}{snapshot.device && ` · ${snapshot.device}`}{state && ` · interior time ${years(state.timeSeconds)} years`}</p>
    {diagnostics && <p className="radial-note">Temperature {diagnostics.minTemperatureK.toFixed(2)}–{diagnostics.maxTemperatureK.toFixed(2)} K · mean liquid fraction {diagnostics.meanLiquidFraction.toFixed(3)} · {diagnostics.iceThicknessM === null ? 'No unique ice–liquid transition' : `ice thickness ${(diagnostics.iceThicknessM / 1000).toFixed(2)} km`} · {snapshot.backend === 'gpu' ? 'CPU reference e' : 'E'}nergy balance error {referenceDiagnostics!.energyErrorJ.toExponential(3)} J</p>}
    {snapshot.errors && <p className="radial-note">CPU comparison: temperature {snapshot.errors.maxTemperatureKelvin.toPrecision(3)} K · liquid fraction {snapshot.errors.maxLiquidFraction.toPrecision(3)} · normalized enthalpy {snapshot.errors.normalizedEnergy.toPrecision(3)}</p>}
    {snapshot.provenance === 'imported-unverified' && <p className="radial-note">Imported interior checkpoint{snapshot.checksumStatus === 'verified' ? ' · checksum verified at load' : snapshot.checksumStatus === 'unavailable' ? ' · checksum unavailable' : ''} · origin and results unverified.</p>}
    {(snapshot.message || message) && <p role="status" className="radial-note">{snapshot.message || message}</p>}
  </section>
}
