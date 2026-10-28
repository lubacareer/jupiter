// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OrbitDiagnosticsView, OrbitView, plotSegments, type PlotSample } from '../src/ui/OrbitAnalysis'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function sample(timeSeconds: number, resonanceAngleDeg?: number): PlotSample {
  return { timeSeconds, eccentricity: .01, semiMajorAxisKm: 671000, resonanceAngleDeg }
}

describe('orbital analysis displays', () => {
  it('breaks wrapped angles at the seam and does not join missing legacy values', () => {
    const rows = [sample(0, 175), sample(1, 179), sample(2, -179), sample(3, -175), sample(4), sample(5, -170)]
    expect(plotSegments(rows, 'resonanceAngleDeg').map(segment => segment.map(row => row.timeSeconds))).toEqual([[0, 1], [2, 3], [5]])
    expect(plotSegments(rows, 'eccentricity')).toHaveLength(1)
  })

  it('labels restored baselines, missing drift, plots and retained history', () => {
    render(<OrbitDiagnosticsView label="CPU" samples={[sample(0, 179), sample(3600, -179)]} baseline={{ timeSeconds: 3600, energy: 1, angularMomentum: [1, 0, 0], kind: 'restored' }} />)
    expect(screen.getByRole('img', { name: /CPU eccentricity over simulated time/i })).toBeTruthy()
    const angle = screen.getByRole('img', { name: /CPU Laplace resonance angle over simulated time/i })
    expect(angle.querySelectorAll('polyline')).toHaveLength(0)
    expect(angle.querySelectorAll('circle')).toHaveLength(2)
    expect(screen.getByText(/relative energy drift: unavailable/i)).toBeTruthy()
    expect(screen.getByText(/baseline: restored state/i)).toBeTruthy()
    expect(screen.getByText(/not physical validation/i)).toBeTruthy()
  })

  it('offers a labeled empty state before any positions are available', () => {
    render(<OrbitView label="CPU" samples={[sample(0)]} />)
    expect(screen.getByText(/start or resume a run to see orbital positions/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: /CPU zoom orbit in/i }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/body sizes exaggerated/i)).toBeTruthy()
  })

  it('provides current orbital elements and Jupiter-relative coordinates as accessible text', () => {
    const row: PlotSample = { ...sample(3600, 12), positionsKm: { Io: [1, 2, 3], Europa: [4, 5, 6], Ganymede: [7, 8, 9] } }
    render(<><OrbitDiagnosticsView label="CPU" samples={[row]} /><OrbitDiagnosticsView label="GPU" samples={[sample(0)]} /></>)
    fireEvent.click(screen.getByText('CPU current numerical values'))
    fireEvent.click(screen.getByText('GPU current numerical values'))
    expect(screen.getByText(/Eccentricity: 0\.01000000.*Semi-major axis: 671000\.0 km.*Laplace resonance angle: 12\.00000 degrees/i)).toBeTruthy()
    expect(screen.getByText('Io: 1.000000, 2.000000, 3.000000')).toBeTruthy()
    expect(screen.getAllByText('Io: Unavailable')).toHaveLength(1)
    expect(screen.getAllByText(/Jupiter-centered ICRF position components/i)).toHaveLength(2)
  })

  it('reports unavailable WebGL while retaining textual orbit information', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const row = { ...sample(86400), positionsKm: { Io: [1, 2, 3] as [number, number, number], Europa: [4, 5, 6] as [number, number, number], Ganymede: [7, 8, 9] as [number, number, number] } }
    render(<OrbitView label="GPU" samples={[row]} />)
    expect(screen.getByRole('status').textContent).toMatch(/WebGL could not be initialized/)
    expect(screen.getByText(/1 simulated days/i)).toBeTruthy()
    expect((screen.getByRole('button', { name: /GPU rotate orbit left/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})
