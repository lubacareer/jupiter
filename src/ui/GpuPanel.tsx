import { useEffect, useRef, useState } from 'react'
import { createGpuCheckpoint, exportGpuResult, parseGpuCheckpoint } from '../simulation/gpuCheckpoint'
import { defaultGpuThermalConfig } from '../simulation/gpuThermal'
import { phaseFromEnthalpy } from '../simulation/interior'
import type { GpuWorkerCommand, GpuWorkerEvent, GpuWorkerSnapshot } from '../simulation/gpuProtocol'
import type { ParameterOverrides } from './parameterState'

export interface GpuFileBridge {
  saveGpuDocument: (kind: 'checkpoint' | 'export', document: object) => Promise<boolean>
  loadGpuCheckpoint: () => Promise<unknown>
}

/** A separate worker keeps GPU work and its independent CPU comparison off the UI thread. */
export function GpuPanel({ parameters, bridge }: { parameters: ParameterOverrides; bridge: GpuFileBridge }) {
  const worker = useRef<Worker | null>(null)
  const latest = useRef<GpuWorkerSnapshot>({ status: 'idle', history: [], provenance: 'local' })
  const [snapshot, setSnapshot] = useState(latest.current)
  const [fileMessage, setFileMessage] = useState('')
  const [workerFailed, setWorkerFailed] = useState(false)
  const [workerGeneration, setWorkerGeneration] = useState(0)
  const send = (command: GpuWorkerCommand) => worker.current?.postMessage(command)
  useEffect(() => {
    const instance = new Worker(new URL('../simulation/gpuWorker.ts', import.meta.url), { type: 'module' })
    worker.current = instance
    instance.onmessage = (event: MessageEvent<GpuWorkerEvent>) => {
      if (worker.current !== instance) return
      if (event.data.type === 'snapshot') {
        latest.current = event.data.snapshot
        setSnapshot(event.data.snapshot)
        return
      }
      const { checkpoint, type: kind } = event.data
      const current = latest.current
      const adapter = { description: current.device ?? 'unknown' }
      const provenance = current.provenance === 'imported-unverified'
        ? { origin: 'unverified' as const, input: 'imported' as const, checksum: 'verified' as const }
        : { origin: 'local' as const, input: 'new' as const, checksum: 'unavailable' as const }
      void (async () => {
        try {
          const document = kind === 'checkpoint'
            ? await createGpuCheckpoint(checkpoint.mode, checkpoint, adapter, provenance)
            : exportGpuResult(checkpoint.mode, checkpoint, adapter, provenance)
          if (await bridge.saveGpuDocument(kind, document)) setFileMessage('GPU file saved.')
        } catch (error) { setFileMessage(error instanceof Error ? error.message : 'Could not save GPU file.') }
      })()
    }
    instance.onerror = () => {
      if (worker.current !== instance) return
      worker.current = null
      setWorkerFailed(true)
      const failed: GpuWorkerSnapshot = { status: 'error', history: [], provenance: 'local', message: 'GPU worker exited; in-memory results were lost. Retry to start a fresh worker.' }
      latest.current = failed
      setSnapshot(failed)
    }
    instance.postMessage({ type: 'probe' } satisfies GpuWorkerCommand)
    return () => { instance.terminate(); if (worker.current === instance) worker.current = null }
  }, [bridge, workerGeneration])
  const load = async () => {
    try {
      const file = await bridge.loadGpuCheckpoint()
      if (file == null) return
      const loaded = await parseGpuCheckpoint(file)
      send({ type: 'load', checkpoint: loaded.checkpoint.data })
      setFileMessage('Checksum verified; restore pending. Imported origin remains unverified.')
    } catch (error) { setFileMessage(error instanceof Error ? error.message : 'Could not load GPU checkpoint.') }
  }
  const active = snapshot.status === 'running'
  const hasResult = !!snapshot.orbit || !!snapshot.thermal
  const history = snapshot.history
  const maximumError = Math.max(...history.map(entry => entry.error), 1e-12)
  const historyPoints = history.map((entry, index) => `${10 + index * 480 / Math.max(history.length - 1, 1)},${90 - entry.error * 80 / maximumError}`).join(' ')
  const thermal = snapshot.thermal
  const phases = thermal?.gpuEnthalpy.map(enthalpy => phaseFromEnthalpy(enthalpy, thermal.material))
  const thermalSummary = phases?.length ? {
    min: phases.reduce((value, phase) => Math.min(value, phase.temperature), Infinity),
    max: phases.reduce((value, phase) => Math.max(value, phase.temperature), -Infinity),
    meanLiquid: phases.reduce((value, phase) => value + phase.liquidFraction, 0) / phases.length,
  } : undefined
  return <section className="panel gpu-experiment" aria-labelledby="gpu-experiment-title">
    <div className="panel-heading"><div><h2 id="gpu-experiment-title">GPU experiments</h2><p>Independent point-mass orbit and synthetic Cartesian heat experiment; no tidal coupling.</p></div><span className="subtle-tag">RESEARCH PROTOTYPE</span></div>
    <p className="gpu-status">{snapshot.device ? `WebGPU: ${snapshot.device}` : 'WebGPU hardware not yet available'} · {snapshot.status}</p>
    {workerFailed && <button className="utility-button" onClick={() => { setWorkerFailed(false); setSnapshot({ status: 'idle', history: [], provenance: 'local' }); setWorkerGeneration(value => value + 1) }}>Retry GPU worker</button>}
    <div className="control-buttons">
      <button className="utility-button" disabled={active || workerFailed} onClick={() => send({ type: 'start-orbit', parameters })}>Start GPU orbit</button>
      <button className="utility-button" disabled={active || workerFailed} onClick={() => send({ type: 'start-thermal', config: defaultGpuThermalConfig() })}>Start synthetic thermal experiment</button>
      <button className="utility-button" disabled={!['running', 'paused'].includes(snapshot.status)} onClick={() => send({ type: active ? 'pause' : 'resume' })}>{active ? 'Pause GPU' : 'Resume GPU'}</button>
      <button className="utility-button" disabled={!hasResult} onClick={() => send({ type: 'reset' })}>Reset GPU</button>
    </div>
    <div className="control-buttons">
      <button className="utility-button" disabled={workerFailed} onClick={() => void load()}>Open GPU checkpoint</button>
      <button className="utility-button" disabled={!hasResult} onClick={() => send({ type: 'checkpoint' })}>Save GPU checkpoint</button>
      <button className="utility-button" disabled={!hasResult} onClick={() => send({ type: 'export' })}>Export GPU data</button>
    </div>
    {snapshot.orbit && <p>Orbit: {(snapshot.orbit.state.timeSeconds / 86400).toFixed(3)} days · step {snapshot.orbit.steps} / {snapshot.orbit.maxSteps} · CPU position difference {snapshot.orbit.errorKm.toFixed(4)} km (limit 10 km).</p>}
    {snapshot.thermal && <p>Thermal: {snapshot.thermal.time.toFixed(3)} s · maximum temperature difference {snapshot.thermal.errors.maxTemperatureKelvin.toPrecision(3)} K · liquid fraction difference {snapshot.thermal.errors.maxLiquidFraction.toPrecision(3)} · normalized energy difference {snapshot.thermal.errors.normalizedEnergy.toPrecision(3)}.</p>}
    {thermalSummary && <p>Synthetic field: {thermalSummary.min.toFixed(3)}–{thermalSummary.max.toFixed(3)} K · mean liquid fraction {thermalSummary.meanLiquid.toFixed(4)}.</p>}
    {history.length > 1 && <svg viewBox="0 0 500 100" className="chart" role="img" aria-label={snapshot.mode === 'orbit' ? 'GPU orbital position error over time' : 'GPU thermal temperature error over time'}><line x1="10" y1="90" x2="490" y2="90" stroke="#526779"/><polyline points={historyPoints} fill="none" stroke="#55b8ff" strokeWidth="2"/><text x="10" y="12" fill="#849caf" fontSize="10">Maximum shown: {maximumError.toPrecision(3)} {snapshot.mode === 'orbit' ? 'km' : 'K'}</text></svg>}
    {snapshot.provenance === 'imported-unverified' && <p>Imported checkpoint · origin and trajectory unverified.</p>}
    {snapshot.message && <p role="status" className="run-message">{snapshot.message}</p>}
    {fileMessage && <p role="status" className="run-message">{fileMessage}</p>}
    <p className="moon-footnote">The thermal preset uses synthetic inputs, not Europa interior estimates. Each accepted GPU sample is compared with an independently advanced float64 CPU reference; this may be slower than CPU-only computation.</p>
  </section>
}
