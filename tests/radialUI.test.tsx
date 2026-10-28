// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRadialState, defaultRadialConfig } from '../src/simulation/radialInterior'
import { cutawayBands, cutawayColor } from '../src/ui/cutawayGeometry'
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
  it('keeps a fixed temperature color scale when the field evolves and clamps values outside it', () => {
    const state = createRadialState(defaultRadialConfig())
    const hot = [...state.enthalpy]
    const { density, latentHeat, waterHeatCapacity, meltingTemperature } = state.config.material
    hot[0] = density * (latentHeat + waterHeatCapacity * (500 - meltingTemperature))
    const first = cutawayBands({ state, enthalpy: state.enthalpy, field: 'temperature', scale: 'true' })
    const later = cutawayBands({ state: { ...state, timeSeconds: state.config.dtSeconds }, enthalpy: hot, field: 'temperature', scale: 'true' })
    expect([first.min, first.max]).toEqual([100, 423.15])
    expect([later.min, later.max]).toEqual([first.min, first.max])
    expect(cutawayColor(200, later.min, later.max)).toEqual(cutawayColor(200, first.min, first.max))
    expect(cutawayColor(500, later.min, later.max)).toEqual(cutawayColor(later.max, later.min, later.max))
    expect(cutawayColor(0, later.min, later.max)).toEqual(cutawayColor(later.min, later.min, later.max))
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
    expect(screen.getByText(/Temperature color scale 100.00–423.15 K \(colors saturate outside this range\)/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Interior field'), { target: { value: 'liquidFraction' } })
    fireEvent.change(screen.getByLabelText('Layer scale'), { target: { value: 'true' } })
    expect(screen.getByText(/Liquid fraction 0–1 · true radial scale/)).toBeTruthy()
  })
  it('uses the restored configuration for the temperature scale and does not change it during a run', () => {
    const initial = createRadialState(defaultRadialConfig())
    const config = { ...initial.config, surfaceTemperatureK: 150 }
    const restored = createRadialState(config)
    render(<Workspace />)
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'paused', backend: 'cpu', state: restored, provenance: 'imported-unverified', checksumStatus: 'verified', restoreRevision: 1, restoredConfig: config } }))
    expect(screen.getByText(/Temperature color scale 150.00–423.15 K/)).toBeTruthy()
    expect(screen.getByText(/checksum verified at load · origin and results unverified/)).toBeTruthy()
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'running', backend: 'cpu', state: { ...restored, timeSeconds: config.dtSeconds }, provenance: 'imported-unverified', restoreRevision: 1, restoredConfig: config } }))
    expect(screen.getByText(/Temperature color scale 150.00–423.15 K/)).toBeTruthy()
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'idle', provenance: 'local' } }))
    expect(screen.getByText(/Interior is schematic until a radial run is available/)).toBeTruthy()
    act(() => workers[0].emit({ type: 'snapshot', snapshot: { status: 'paused', backend: 'cpu', state: initial, provenance: 'local' } }))
    expect(screen.getByText(/Temperature color scale 100.00–423.15 K/)).toBeTruthy()
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
