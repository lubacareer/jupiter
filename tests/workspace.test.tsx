// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Workspace, { type SimulationSnapshot } from '../src/ui/Workspace'
import { createInitialOrbit, orbitDiagnostics } from '../src/simulation/orbit'

vi.mock('../src/ui/MoonView', () => ({ MoonView: () => null }))
afterEach(cleanup)

const epoch = orbitDiagnostics(createInitialOrbit())
const snapshot = (extra: Partial<SimulationSnapshot> = {}): SimulationSnapshot => ({ status: 'paused', timeSeconds: 0, samples: [], restoreRevision: 0, workerGeneration: 1, ...extra })

describe('orbital parameter controls', () => {
  it('shows exact epoch values and submits no overrides for an unchanged Start or blur', () => {
    const start = vi.fn()
    render(<Workspace snapshot={snapshot()} onStart={start} />)
    const eccentricity = screen.getByLabelText('Eccentricity value') as HTMLInputElement
    const axis = screen.getByLabelText('Semi-major axis value') as HTMLInputElement
    expect(Number(eccentricity.value)).toBe(epoch.eccentricity)
    expect(Number(axis.value)).toBe(epoch.semiMajorAxisKm)
    fireEvent.focus(eccentricity)
    fireEvent.blur(eccentricity)
    fireEvent.click(screen.getByRole('button', { name: /start new run/i }))
    expect(start).toHaveBeenLastCalledWith({})
  })

  it('sends only the edited field, preserving the other epoch value', () => {
    const start = vi.fn()
    render(<Workspace snapshot={snapshot()} onStart={start} />)
    const eccentricity = screen.getByLabelText('Eccentricity value')
    fireEvent.change(eccentricity, { target: { value: '0.04' } })
    fireEvent.blur(eccentricity)
    fireEvent.click(screen.getByRole('button', { name: /start new run/i }))
    expect(start).toHaveBeenLastCalledWith({ eccentricity: 0.04 })
    expect(Number((screen.getByLabelText('Semi-major axis value') as HTMLInputElement).value)).toBe(epoch.semiMajorAxisKm)
  })

  it('restores imported out-of-range values once and preserves later edits across snapshots', () => {
    const start = vi.fn()
    const loaded = snapshot({ restoreRevision: 1, restoredParameters: { eccentricity: 0.2, semiMajorAxisKm: 900000 }, restoredOverrides: { eccentricity: 0.2, semiMajorAxisKm: 900000 }, provenance: 'imported-unverified' })
    const { rerender } = render(<Workspace snapshot={snapshot()} onStart={start} />)
    rerender(<Workspace snapshot={loaded} onStart={start} />)
    const eccentricity = screen.getByLabelText('Eccentricity value') as HTMLInputElement
    const axis = screen.getByLabelText('Semi-major axis value') as HTMLInputElement
    expect(Number(eccentricity.value)).toBe(0.2)
    expect(Number(axis.value)).toBe(900000)
    expect(Number((screen.getByRole('slider', { name: /eccentricity/i }) as HTMLInputElement).max)).toBe(0.2)
    expect(screen.getByText(/origin and trajectory unverified/i)).toBeTruthy()
    fireEvent.focus(axis)
    fireEvent.blur(axis)
    fireEvent.change(eccentricity, { target: { value: '0.15' } })
    rerender(<Workspace snapshot={{ ...loaded, restoredParameters: { ...loaded.restoredParameters! }, restoredOverrides: { ...loaded.restoredOverrides! }, timeSeconds: 1800 }} onStart={start} />)
    expect(eccentricity.value).toBe('0.15')
    fireEvent.blur(eccentricity)
    rerender(<Workspace snapshot={{ ...loaded, restoredParameters: { ...loaded.restoredParameters! }, restoredOverrides: { ...loaded.restoredOverrides! }, timeSeconds: 3600 }} onStart={start} />)
    expect(Number(eccentricity.value)).toBe(0.15)
    fireEvent.click(screen.getByRole('button', { name: /start new run/i }))
    expect(start).toHaveBeenLastCalledWith({ eccentricity: 0.15, semiMajorAxisKm: 900000 })
  })

  it('restores override metadata and applies the same revision from a replacement worker', () => {
    const start = vi.fn()
    const restored = snapshot({ restoreRevision: 1, restoredParameters: { eccentricity: 0.02, semiMajorAxisKm: epoch.semiMajorAxisKm }, restoredOverrides: { eccentricity: 0.02 } })
    const { rerender } = render(<Workspace snapshot={restored} onStart={start} />)
    fireEvent.click(screen.getByRole('button', { name: /start new run/i }))
    expect(start).toHaveBeenLastCalledWith({ eccentricity: 0.02 })
    const axis = screen.getByLabelText('Semi-major axis value')
    fireEvent.change(axis, { target: { value: '700000' } })
    fireEvent.blur(axis)
    fireEvent.click(screen.getByRole('button', { name: /start new run/i }))
    expect(start).toHaveBeenLastCalledWith({ eccentricity: 0.02, semiMajorAxisKm: 700000 })
    rerender(<Workspace snapshot={{ ...restored, workerGeneration: 2, restoredParameters: { eccentricity: 0.03, semiMajorAxisKm: 710000 }, restoredOverrides: { eccentricity: 0.03, semiMajorAxisKm: 710000 } }} onStart={start} />)
    fireEvent.click(screen.getByRole('button', { name: /start new run/i }))
    expect(start).toHaveBeenLastCalledWith({ eccentricity: 0.03, semiMajorAxisKm: 710000 })
  })

  it('keeps edits made while a run is active when new snapshots arrive', () => {
    const start = vi.fn()
    const running = snapshot({ status: 'running', restoreRevision: 1, restoredParameters: { eccentricity: 0.02, semiMajorAxisKm: epoch.semiMajorAxisKm }, restoredOverrides: { eccentricity: 0.02 } })
    const { rerender } = render(<Workspace snapshot={running} onStart={start} />)
    const axis = screen.getByLabelText('Semi-major axis value') as HTMLInputElement
    fireEvent.change(axis, { target: { value: '710000' } })
    rerender(<Workspace snapshot={{ ...running, timeSeconds: 3600, restoredParameters: { ...running.restoredParameters! }, restoredOverrides: { ...running.restoredOverrides! } }} onStart={start} />)
    expect(axis.value).toBe('710000')
    fireEvent.blur(axis)
    rerender(<Workspace snapshot={{ ...running, status: 'paused', timeSeconds: 7200 }} onStart={start} />)
    fireEvent.click(screen.getByRole('button', { name: /start new run/i }))
    expect(start).toHaveBeenLastCalledWith({ eccentricity: 0.02, semiMajorAxisKm: 710000 })
  })

  it('prevents stale actions after a worker exit while allowing a new run or load', () => {
    const action = vi.fn()
    render(<Workspace snapshot={snapshot({ status: 'error', workerAvailable: false, samples: [{ timeSeconds: 1, eccentricity: 0.01, semiMajorAxisKm: 671000 }] })} onStart={action} onLoadCheckpoint={action} onSaveCheckpoint={action} onExport={action} onPause={action} onReset={action} />)
    expect((screen.getByRole('button', { name: /start new run/i }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: /open checkpoint/i }) as HTMLButtonElement).disabled).toBe(false)
    for (const name of [/save checkpoint/i, /export data/i, /^pause$/i, /^reset$/i]) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
  })
})
