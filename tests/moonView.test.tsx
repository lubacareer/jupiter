// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Suspense, startTransition, useState } from 'react'
import type * as Three from 'three'

const renderers = vi.hoisted(() => [] as Array<{ domElement: HTMLCanvasElement; scene?: Three.Scene; camera?: Three.Camera; dispose: ReturnType<typeof vi.fn> }> )
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>()
  class Renderer {
    domElement = document.createElement('canvas')
    scene?: Three.Scene
    camera?: Three.Camera
    dispose = vi.fn()
    constructor() { renderers.push(this) }
    setPixelRatio() {}
    setSize() {}
    render(scene: Three.Scene, camera: Three.Camera) { this.scene = scene; this.camera = camera }
  }
  return { ...actual, WebGLRenderer: Renderer }
})
import * as THREE from 'three'
import { MoonView } from '../src/ui/MoonView'
import { createRadialState, defaultRadialConfig } from '../src/simulation/radialInterior'
import { cutawayColor } from '../src/ui/cutawayGeometry'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); renderers.length = 0 })

describe('Europa cutaway rendering', () => {
  it('shows the reverse of the Europa vector, colors calculated faces, rotates and disposes', () => {
    const state = createRadialState(defaultRadialConfig())
    const { rerender, unmount } = render(<MoonView orbit={{ europaPositionKm: [10, 0, 0] }} thermal={{ state, enthalpy: state.enthalpy, field: 'temperature', scale: 'exaggerated' }}/>)
    const renderer = renderers[0], scene = renderer.scene!
    const arrow = scene.children.find(child => child instanceof THREE.ArrowHelper) as THREE.ArrowHelper
    expect(arrow.visible).toBe(true)
    expect(arrow.position.x).toBeLessThan(0)
    const colorFaces: THREE.Mesh[] = []
    scene.traverse(child => { if (child instanceof THREE.Mesh && child.geometry.getAttribute('color')) colorFaces.push(child) })
    expect(colorFaces.length).toBe(2)
    expect(colorFaces[0].geometry.getAttribute('color').count).toBeGreaterThan(100)
    const moon = scene.children.find(child => child instanceof THREE.Group) as THREE.Group
    const rotation = moon.rotation.x
    fireEvent.keyDown(screen.getByRole('img', { name: /Europa 3D cutaway/i }), { key: 'ArrowUp' })
    expect(moon.rotation.x).not.toBe(rotation)
    rerender(<MoonView />)
    act(() => vi.advanceTimersByTime(250))
    expect(arrow.visible).toBe(false)
    unmount()
    expect(renderer.dispose).toHaveBeenCalledOnce()
  })
  it('draws the last committed field when a later render suspends before the mesh timer fires', () => {
    const state = createRadialState(defaultRadialConfig())
    const committed = [...state.enthalpy], speculative = [...state.enthalpy]
    const latent = state.config.material.density * state.config.material.latentHeat
    committed[0] = .4 * latent; speculative[0] = .1 * latent
    const never = new Promise<void>(() => {})
    let attempts = 0
    function Block({ pending }: { pending: boolean }) { if (pending) { attempts++; throw never }; return null }
    function Harness() {
      const [stage, setStage] = useState(0)
      const values = stage === 0 ? state.enthalpy : stage === 1 ? committed : speculative
      return <><button onClick={() => setStage(1)}>Commit field</button><button onClick={() => startTransition(() => setStage(2))}>Suspend field</button><Suspense fallback="Waiting">
        <MoonView thermal={{ state, enthalpy: values, field: 'liquidFraction', scale: 'true' }}/><Block pending={stage === 2}/>
      </Suspense></>
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Commit field' }))
    fireEvent.click(screen.getByRole('button', { name: 'Suspend field' }))
    expect(attempts).toBeGreaterThan(0)
    act(() => vi.advanceTimersByTime(250))
    const faces: THREE.Mesh[] = []
    renderers[0].scene!.traverse(child => { if (child instanceof THREE.Mesh && child.geometry.getAttribute('color')) faces.push(child) })
    const displayedRed = faces[0].geometry.getAttribute('color').getX(50)
    const expected = new THREE.Color().setRGB(...cutawayColor(.4, 0, 1), THREE.SRGBColorSpace).r
    expect(displayedRed).toBeCloseTo(expected, 5)
  })
})
