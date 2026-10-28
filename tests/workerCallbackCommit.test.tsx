// @vitest-environment jsdom
import { Suspense, startTransition, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GpuPanel } from '../src/ui/GpuPanel'
import { RadialPanel } from '../src/ui/RadialPanel'

class MockWorker {
  static instances: MockWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { MockWorker.instances.push(this) }
  emit() { act(() => this.onmessage?.({ data: { type: 'snapshot', snapshot: { status: 'idle', history: [], provenance: 'local' } } } as MessageEvent)) }
}

beforeEach(() => { MockWorker.instances = []; vi.stubGlobal('Worker', MockWorker) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe.each(['gpu', 'radial'] as const)('%s worker callback commits', mode => {
  it('does not expose a callback from a suspended render to the active worker', () => {
    const previous = vi.fn(), speculative = vi.fn()
    const never = new Promise<void>(() => {})
    const bridge = { saveGpuDocument: vi.fn(), loadGpuCheckpoint: vi.fn() }
    let attempts = 0
    function Block({ pending }: { pending: boolean }) {
      if (pending) { attempts++; throw never }
      return null
    }
    function Harness() {
      const [pending, setPending] = useState(false)
      return <><button onClick={() => startTransition(() => setPending(true))}>Suspend update</button><Suspense fallback="Waiting">
        {mode === 'gpu' ? <GpuPanel parameters={{}} bridge={bridge} onSnapshot={pending ? speculative : previous}/> : <RadialPanel onSnapshot={pending ? speculative : previous}/>}
        <Block pending={pending}/>
      </Suspense></>
    }
    render(<Harness />)
    const worker = MockWorker.instances[0]
    fireEvent.click(screen.getByRole('button', { name: 'Suspend update' }))
    expect(attempts).toBeGreaterThan(0)
    worker.emit()
    expect(previous).toHaveBeenCalledOnce()
    expect(speculative).not.toHaveBeenCalled()
    expect(MockWorker.instances).toHaveLength(1)
  })
  it('delivers to a newly committed callback without restarting the worker', () => {
    const previous = vi.fn(), current = vi.fn()
    const bridge = { saveGpuDocument: vi.fn(), loadGpuCheckpoint: vi.fn() }
    const component = (callback: typeof previous) => mode === 'gpu' ? <GpuPanel parameters={{}} bridge={bridge} onSnapshot={callback}/> : <RadialPanel onSnapshot={callback}/>
    const { rerender } = render(component(previous))
    const worker = MockWorker.instances[0]
    rerender(component(current))
    worker.emit()
    expect(current).toHaveBeenCalledOnce()
    expect(previous).not.toHaveBeenCalled()
    expect(MockWorker.instances).toHaveLength(1)
  })
})
