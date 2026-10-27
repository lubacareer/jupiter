// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GpuPanel } from '../src/ui/GpuPanel'
import { createGpuCheckpoint, parseGpuCheckpoint } from '../src/simulation/gpuCheckpoint'
import { defaultGpuThermalConfig } from '../src/simulation/gpuThermal'
import { interiorDiagnostics } from '../src/simulation/interior'
import type { GpuWorkerCheckpoint, GpuWorkerEvent } from '../src/simulation/gpuProtocol'

class MockWorker {
  static instances: MockWorker[] = []
  onmessage: ((event: MessageEvent<GpuWorkerEvent>) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { MockWorker.instances.push(this) }
  emit(data: GpuWorkerEvent) { act(() => this.onmessage?.({ data } as MessageEvent<GpuWorkerEvent>)) }
}

function checkpoint(): GpuWorkerCheckpoint {
  const { state, dt, forcing } = defaultGpuThermalConfig()
  return { mode: 'thermal', history: [{ timeSeconds: 0, error: 0 }], data: {
    version: 1, grid: state.grid, material: state.material, time: 0, dt,
    forcing: { volumetricHeating: 0.5, topOutwardFlux: forcing?.topOutwardFlux ?? 0, bottomOutwardFlux: forcing?.bottomOutwardFlux ?? 0 },
    gpuEnthalpy: Array.from(state.enthalpy), referenceEnthalpy: Array.from(state.enthalpy),
    initialEnergy: interiorDiagnostics(state).energy, cumulativeHeat: 0,
    errors: { maxTemperatureKelvin: 0, maxLiquidFraction: 0, normalizedEnergy: 0 },
  } }
}

beforeEach(() => { MockWorker.instances = []; vi.stubGlobal('Worker', MockWorker); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('GPU experiment UI', () => {
  it('clears lost results and starts a fresh worker only when retry is requested', () => {
    const bridge = { saveGpuDocument: vi.fn(), loadGpuCheckpoint: vi.fn() }
    render(<GpuPanel parameters={{}} bridge={bridge} />)
    const first = MockWorker.instances[0], data = checkpoint()
    if (data.mode !== 'thermal') throw new Error('bad fixture')
    first.emit({ type: 'snapshot', snapshot: { status: 'paused', mode: 'thermal', thermal: data.data, history: data.history, device: 'test GPU', provenance: 'local' } })
    expect((screen.getByRole('button', { name: 'Save GPU checkpoint' }) as HTMLButtonElement).disabled).toBe(false)
    act(() => first.onerror?.())
    expect(first.terminate).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/in-memory results were lost/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save GPU checkpoint' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Start GPU orbit' }) as HTMLButtonElement).disabled).toBe(true)
    expect(MockWorker.instances).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry GPU worker' }))
    expect(MockWorker.instances).toHaveLength(2)
    expect(first.terminate).toHaveBeenCalled()
    const second = MockWorker.instances[1]
    expect(second.postMessage).toHaveBeenCalledWith({ type: 'probe' })
    act(() => first.onerror?.())
    expect(second.terminate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start GPU orbit' }))
    expect(second.postMessage).toHaveBeenCalledWith({ type: 'start-orbit', parameters: {} })
  })

  it('sends independent experiment commands with edited orbital parameters', () => {
    const bridge = { saveGpuDocument: vi.fn(), loadGpuCheckpoint: vi.fn() }
    render(<GpuPanel parameters={{ eccentricity: 0.04 }} bridge={bridge} />)
    const worker = MockWorker.instances[0]
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'probe' })
    fireEvent.click(screen.getByRole('button', { name: 'Start GPU orbit' }))
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'start-orbit', parameters: { eccentricity: 0.04 } })
    fireEvent.click(screen.getByRole('button', { name: /start synthetic thermal/i }))
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start-thermal', config: expect.objectContaining({ state: expect.any(Object), dt: expect.any(Number) }) }))
  })

  it('saves a checksummed checkpoint with GPU state and history', async () => {
    const bridge = { saveGpuDocument: vi.fn().mockResolvedValue(true), loadGpuCheckpoint: vi.fn() }
    render(<GpuPanel parameters={{}} bridge={bridge} />)
    const worker = MockWorker.instances[0], data = checkpoint()
    if (data.mode !== 'thermal') throw new Error('bad fixture')
    worker.emit({ type: 'snapshot', snapshot: { status: 'paused', mode: 'thermal', thermal: data.data, history: data.history, device: 'test GPU', provenance: 'local' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save GPU checkpoint' }))
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'checkpoint' })
    worker.emit({ type: 'checkpoint', checkpoint: data })
    await waitFor(() => expect(bridge.saveGpuDocument).toHaveBeenCalled())
    const [kind, saved] = bridge.saveGpuDocument.mock.calls[0]
    expect(kind).toBe('checkpoint')
    expect((await parseGpuCheckpoint(saved)).checkpoint.data).toEqual(data)
  })

  it('verifies imported checksums before sending a restore, rejecting edits', async () => {
    const data = checkpoint()
    const valid = await createGpuCheckpoint('thermal', data, { description: 'test' }, { origin: 'local', input: 'new', checksum: 'unavailable' })
    const bridge = { saveGpuDocument: vi.fn(), loadGpuCheckpoint: vi.fn().mockResolvedValueOnce(valid) }
    render(<GpuPanel parameters={{}} bridge={bridge} />)
    const worker = MockWorker.instances[0]
    fireEvent.click(screen.getByRole('button', { name: 'Open GPU checkpoint' }))
    await waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'load', checkpoint: data }))
    const edited = structuredClone(valid)
    if (edited.data.mode !== 'thermal') throw new Error('bad fixture')
    edited.data.data.dt *= 2
    bridge.loadGpuCheckpoint.mockResolvedValueOnce(edited)
    const before = worker.postMessage.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Open GPU checkpoint' }))
    await screen.findByText(/checksum mismatch/i)
    expect(worker.postMessage).toHaveBeenCalledTimes(before)
  })
})
