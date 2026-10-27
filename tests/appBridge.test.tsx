// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'

// Keep the entry point's automatic mount separate from the app under test.
vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>()
  return { ...actual, createRoot: (container: Element | DocumentFragment, options?: Parameters<typeof actual.createRoot>[1]) =>
    container instanceof Element && container.id === 'root'
      ? { render: vi.fn(), unmount: vi.fn() }
      : actual.createRoot(container, options) }
})
vi.mock('../src/ui/MoonView', () => ({ MoonView: () => null }))
vi.mock('../src/ui/GpuPanel', () => ({ GpuPanel: () => null }))

let App: ComponentType
beforeAll(async () => {
  document.body.insertAdjacentHTML('beforeend', '<div id="root"></div>')
  App = (await import('../src/main')).App
})
afterEach(() => { cleanup(); delete window.europa })

describe('desktop file action bridge', () => {
  it('calls each exposed bridge method with no React event arguments', () => {
    const bridge = {
      command: vi.fn(),
      subscribe: vi.fn((callback) => {
        callback({ status: 'paused', timeSeconds: 0, samples: [{ timeSeconds: 0, eccentricity: 0.01, semiMajorAxisKm: 671000 }] })
        return () => {}
      }),
      saveCheckpoint: vi.fn(), loadCheckpoint: vi.fn(), exportData: vi.fn(),
      saveGpuDocument: vi.fn(), loadGpuCheckpoint: vi.fn(),
    }
    window.europa = bridge
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open checkpoint' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save checkpoint' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export data' }))
    for (const action of [bridge.loadCheckpoint, bridge.saveCheckpoint, bridge.exportData]) {
      expect(action).toHaveBeenCalledOnce()
      expect(action).toHaveBeenCalledWith()
    }
  })

  it('leaves the file actions disabled when the desktop bridge is unavailable', () => {
    delete window.europa
    render(<App />)
    for (const name of ['Open checkpoint', 'Save checkpoint', 'Export data']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
