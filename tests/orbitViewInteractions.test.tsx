// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as Three from 'three'

const instances = vi.hoisted(() => [] as Array<{ domElement: HTMLCanvasElement; scene?: Three.Scene; camera?: Three.Camera; dispose: ReturnType<typeof vi.fn> }>)
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>()
  class Renderer {
    domElement = document.createElement('canvas')
    scene?: Three.Scene
    camera?: Three.Camera
    dispose = vi.fn()
    constructor() { instances.push(this) }
    setPixelRatio() {}
    setSize() {}
    render(scene: Three.Scene, camera: Three.Camera) { this.scene = scene; this.camera = camera }
  }
  return { ...actual, WebGLRenderer: Renderer }
})

import { OrbitView, type PlotSample } from '../src/ui/OrbitAnalysis'
import * as THREE from 'three'

afterEach(() => { cleanup(); instances.length = 0 })

describe('3D orbital view', () => {
  it('plots Jupiter-relative positions and trails and provides working camera controls', () => {
    const row = (timeSeconds: number, x: number): PlotSample => ({ timeSeconds, eccentricity: .01, semiMajorAxisKm: 671000,
      resonanceAngleDeg: 0, positionsKm: { Io: [x, 0, 0], Europa: [0, 2, 0], Ganymede: [0, 0, 4] } })
    const { unmount } = render(<OrbitView label="CPU" samples={[row(0, 1), row(3600, 2)]} />)
    const renderer = instances[0]
    const scene = renderer.scene!
    const lines: THREE.Line[] = []
    scene.traverse(item => { if (item instanceof THREE.Line) lines.push(item) })
    expect(lines).toHaveLength(3)
    const ioPositions = lines[0].geometry.getAttribute('position')
    expect(ioPositions.getX(0)).toBeCloseTo(.45)
    expect(ioPositions.getX(1)).toBeCloseTo(.9)
    const camera = renderer.camera!
    const initial = camera.position.clone()
    fireEvent.click(screen.getByRole('button', { name: /CPU rotate orbit left/i }))
    expect(camera.position.x).not.toBeCloseTo(initial.x)
    const beforeZoom = camera.position.length()
    fireEvent.click(screen.getByRole('button', { name: /CPU zoom orbit in/i }))
    expect(camera.position.length()).toBeLessThan(beforeZoom)
    fireEvent.click(screen.getByRole('button', { name: /CPU reset orbit view/i }))
    expect(camera.position.distanceTo(initial)).toBeLessThan(1e-8)
    const up = screen.getByRole('button', { name: /CPU rotate orbit up/i })
    fireEvent.click(up)
    expect(camera.position.y).toBeGreaterThan(initial.y)
    for (let i = 0; i < 30; i++) fireEvent.click(up)
    expect(new THREE.Spherical().setFromVector3(camera.position).phi).toBeGreaterThanOrEqual(.049)
    const down = screen.getByRole('button', { name: /CPU rotate orbit down/i })
    for (let i = 0; i < 30; i++) fireEvent.click(down)
    expect(new THREE.Spherical().setFromVector3(camera.position).phi).toBeLessThanOrEqual(Math.PI - .049)
    unmount()
    expect(renderer.dispose).toHaveBeenCalledOnce()
  })
})
