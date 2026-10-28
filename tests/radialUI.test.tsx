// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRadialState, defaultRadialConfig } from '../src/simulation/radialInterior'
import { cutawayBands } from '../src/ui/cutawayGeometry'
import type { RadialWorkerEvent } from '../src/simulation/radialProtocol'
import type { GpuWorkerSnapshot } from '../src/simulation/gpuProtocol'
import Workspace from '../src/ui/Workspace'

vi.mock('../src/ui/MoonView', () => ({ MoonView: ({ thermal, orbit }: { thermal?: { enthalpy: number[] }, orbit?: { europaPositionKm: number[] } }) => <div data-testid="mock-moon">{thermal ? `field ${thermal.enthalpy[0]}` : 'no field'}; {orbit ? `orbit ${orbit.europaPositionKm[0]}` : 'no orbit'}</div> }))
vi.mock('../src/ui/GpuPanel', () => ({ GpuPanel: ({ onSnapshot }: { onSnapshot: (snapshot: Partial<GpuWorkerSnapshot>) => void }) => <button onClick={() => onSnapshot({ status: 'paused', mode: 'orbit', orbitAnalysisSamples: [{ timeSeconds: 86400, eccentricity: .02, semiMajorAxisKm: 671000, resonanceAngleDeg: 5, positionsKm: { Io: [1, 0, 0], Europa: [8, 0, 0], Ganymede: [2, 0, 0] } }] })}>Set GPU orbit</button> }))
const workers: FakeWorker[] = []
class FakeWorker {
  onmessage: ((event: MessageEvent<RadialWorkerEvent>) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { workers.push(this) }
  emit(event: RadialWorkerEvent) { this.onmessage?.({ data: event } as MessageEvent<RadialWorkerEvent>) }
}
beforeEach(() => { workers.length = 0; vi.stubGlobal('Worker', FakeWorker) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('radial cutaway presentation', () => {
  it('maps calculated fields at both scales and shows an identifiable interface', () => {
    const state = createRadialState(defaultRadialConfig())
    const exaggerated = cutawayBands({ state, enthalpy: state.enthalpy, field: 'liquidFraction', scale: 'exaggerated' })
    const physical = cutawayBands({ state, enthalpy: state.enthalpy, field: 'temperature', scale: 'true' })
    expect(exaggerated.bands).toHaveLength(state.config.cells)
    expect(exaggerated.rockRadius).toBe(.59)
    expect(exaggerated.transitionRadius).toBeCloseTo(.84)
    expect(physical.rockRadius).toBeCloseTo((state.config.radiusM - state.config.iceThicknessM - state.config.oceanDepthM) / state.config.radiusM)
    expect(physical.bands[0].outer).toBeLessThan(physical.bands.at(-1)!.outer)
    expect(physical.min).toBeLessThan(physical.max)
  })
  it('selects independent CPU/GPU orbits and renders the accepted GPU radial field without CPU fallback', () => {
    const state = createRadialState(defaultRadialConfig())
    const bridge = { saveGpuDocument: vi.fn(), loadGpuCheckpoint: vi.fn() }
    const sample = { timeSeconds: 0, eccentricity: .01, semiMajorAxisKm: 671000, resonanceAngleDeg: 0, positionsKm: { Io: [1, 0, 0] as [number, number, number], Europa: [3, 4, 0] as [number, number, number], Ganymede: [2, 0, 0] as [number, number, number] } }
    render(<Workspace snapshot={{ status: 'paused', timeSeconds: 0, samples: [sample] }} gpuBridge={bridge}/>)
    expect(screen.getByTestId('mock-moon').textContent).toContain('orbit 3')
    expect(screen.getByText(/CPU orbit · Jupiter direction arrow · 5 km away/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Orbit overlay source'), { target: { value: 'gpu' } })
    expect(screen.getByText(/GPU orbit unavailable/)).toBeTruthy()
    fireEvent.click(screen.getByText('Set GPU orbit'))
    expect(screen.getByTestId('mock-moon').textContent).toContain('orbit 8')
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'paused', backend: 'gpu', state, provenance: 'local' } }))
    expect(screen.getByTestId('mock-moon').textContent).toContain('no field')
    const gpuEnthalpy = [...state.enthalpy]; gpuEnthalpy[0] += 100
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'paused', backend: 'gpu', state, gpuEnthalpy, provenance: 'local' } }))
    expect(screen.getByTestId('mock-moon').textContent).toContain(`field ${gpuEnthalpy[0]}`)
    expect(screen.getByText(/GPU radial result/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Interior field'), { target: { value: 'liquidFraction' } })
    fireEvent.change(screen.getByLabelText('Layer scale'), { target: { value: 'true' } })
    expect(screen.getByText(/Liquid fraction 0–1 · true radial scale/)).toBeTruthy()
  })
  it('sends configured starts and restores controls once, without overwriting later edits', () => {
    const state = createRadialState(defaultRadialConfig())
    render(<Workspace />)
    fireEvent.change(screen.getByLabelText('Interior backend'), { target: { value: 'gpu' } })
    fireEvent.change(screen.getByLabelText('Basal heat flux in watts per square metre'), { target: { value: '0.08' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start interior run' }))
    expect(workers[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', backend: 'gpu', config: expect.objectContaining({ basalHeatFluxWm2: .08 }) }))
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'paused', backend: 'cpu', state, provenance: 'imported-unverified', restoreRevision: 1, restoredConfig: state.config } }))
    expect((screen.getByLabelText('Basal heat flux in watts per square metre') as HTMLInputElement).value).toBe('0.05')
    fireEvent.change(screen.getByLabelText('Basal heat flux in watts per square metre'), { target: { value: '0.09' } })
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'running', backend: 'cpu', state, provenance: 'imported-unverified', restoreRevision: 1, restoredConfig: { ...state.config } } }))
    expect((screen.getByLabelText('Basal heat flux in watts per square metre') as HTMLInputElement).value).toBe('0.09')
  })
})
