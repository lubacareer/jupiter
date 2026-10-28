import { useEffect, useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import type { Vec3 } from '../simulation/orbit'
import { cutawayBands, cutawayColor, type CutawayData } from './cutawayGeometry'

export type MoonOrbit = { europaPositionKm: Vec3 }
type SceneUpdates = { thermal: (data?: CutawayData) => void; orbit: (orbit?: MoonOrbit) => void }

/** A schematic cutaway. Geometry and displacement are deliberately not solver output. */
export function MoonView({ thermal, orbit }: { thermal?: CutawayData; orbit?: MoonOrbit }) {
  const mount = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<SceneUpdates | null>(null)
  const pendingThermal = useRef(thermal)
  useLayoutEffect(() => { pendingThermal.current = thermal }, [thermal])
  const thermalTimer = useRef<number | undefined>(undefined)
  const lastThermalUpdate = useRef(-Infinity)

  useEffect(() => {
    const host = mount.current
    if (!host) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      host.textContent = '3D view unavailable: WebGL could not be initialized.'
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(33, 1, 0.1, 100)
    camera.position.set(0, 0.2, 4.8)
    scene.add(new THREE.AmbientLight(0x97b4d1, 1.65))
    const sun = new THREE.DirectionalLight(0xffead2, 3.1)
    sun.position.set(-3, 4, 5)
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0x3886cf, 0.9)
    fill.position.set(3, -2, 2)
    scene.add(fill)

    const moon = new THREE.Group()
    // Show both the exterior and the removed quadrant on first render.
    moon.rotation.set(-0.08, Math.PI * 0.75 + 0.42, 0.08)
    scene.add(moon)
    const schematic = new THREE.Group()
    const calculated = new THREE.Group()
    moon.add(schematic, calculated)
    const arc = Math.PI * 1.5
    const layers: Array<[number, number, number, number]> = [
      [1, 0.84, 0xc6d5d9, 0.83],
      [0.84, 0.59, 0x176899, 0.32],
      [0.59, 0, 0x534d48, 1],
    ]
    const resources: Array<THREE.BufferGeometry | THREE.Material> = []
    const textures: THREE.Texture[] = []
    for (const [outer, inner, color, roughness] of layers) {
      const material = new THREE.MeshStandardMaterial({ color, roughness, metalness: color === 0x176899 ? 0.25 : 0.03, side: THREE.DoubleSide })
      const geometry = new THREE.SphereGeometry(outer, 64, 40, 0, arc)
      resources.push(material, geometry)
      let surface = material
      if (outer === 1) {
        // Procedural texture is illustrative, not a map of observed fractures.
        const canvas = document.createElement('canvas')
        canvas.width = 1024; canvas.height = 512
        const context = canvas.getContext('2d')
        if (context) {
          let seed = 41
          const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
          context.fillStyle = '#d8e0df'; context.fillRect(0, 0, canvas.width, canvas.height)
          for (let i = 0; i < 6500; i++) {
            const shade = 150 + Math.floor(random() * 85)
            context.fillStyle = `rgba(${shade},${shade + 3},${shade + 2},0.055)`
            context.fillRect(random() * 1024, random() * 512, 2 + random() * 18, 1 + random() * 6)
          }
          for (let i = 0; i < 130; i++) {
            const x = random() * 1024, y = random() * 512
            context.beginPath(); context.moveTo(x, y)
            context.bezierCurveTo(x + (random() - .5) * 100, y + 30, x + (random() - .5) * 120, y + 75, x + (random() - .5) * 130, y + 130)
            context.strokeStyle = i % 4 === 0 ? 'rgba(119,83,64,.45)' : 'rgba(137,112,96,.24)'
            context.lineWidth = i % 4 === 0 ? 1.5 : .6; context.stroke()
          }
          const texture = new THREE.CanvasTexture(canvas)
          texture.colorSpace = THREE.SRGBColorSpace
          textures.push(texture)
          surface = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, map: texture, side: THREE.DoubleSide })
          resources.push(surface)
        }
      }
      ;(outer === 1 ? moon : schematic).add(new THREE.Mesh(geometry, surface))
      // Join adjacent spherical layers at the two edges of the removed wedge.
      for (const phi of [0, arc]) {
        const positions: number[] = []
        const indices: number[] = []
        const steps = 48
        for (let i = 0; i <= steps; i++) {
          const theta = Math.PI * i / steps
          for (const radius of [inner, outer]) {
            positions.push(-radius * Math.cos(phi) * Math.sin(theta), radius * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta))
          }
          if (i < steps) {
            const n = i * 2
            indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2)
          }
        }
        const face = new THREE.BufferGeometry()
        face.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
        face.setIndex(indices)
        face.computeVertexNormals()
        resources.push(face)
        schematic.add(new THREE.Mesh(face, material))
      }
    }
    // Fine longitudes provide visual texture without implying measured surface data.
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x8b735e, transparent: true, opacity: 0.32 })
    resources.push(lineMaterial)
    for (let j = 0; j < 28; j++) {
      const points: THREE.Vector3[] = []
      const phi = 0.08 + (arc - 0.16) * j / 27
      for (let i = 4; i <= 76; i++) {
        const theta = Math.PI * i / 80
        const p = phi + 0.035 * Math.sin(theta * 5 + j * 1.7)
        points.push(new THREE.Vector3(-1.003 * Math.cos(p) * Math.sin(theta), 1.003 * Math.cos(theta), 1.003 * Math.sin(p) * Math.sin(theta)))
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      resources.push(geometry)
      moon.add(new THREE.Line(geometry, lineMaterial))
    }
    const direction = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(1.12, 0, 0), .58, 0xffc579, .18, .09)
    direction.visible = false
    scene.add(direction)
    const clearCalculated = () => {
      for (const child of [...calculated.children]) {
        calculated.remove(child)
        if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
          child.geometry.dispose()
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.forEach(material => material.dispose())
        }
      }
    }
    sceneRef.current = {
      orbit(value) {
        const v = value?.europaPositionKm
        if (!v || !v.every(Number.isFinite) || Math.hypot(...v) === 0) { direction.visible = false; return }
        const vector = new THREE.Vector3(-v[0], -v[1], -v[2]).normalize()
        direction.position.copy(vector).multiplyScalar(1.12)
        direction.setDirection(vector)
        direction.visible = true
      },
      thermal(data) {
        clearCalculated()
        schematic.visible = !data
        if (!data) return
        const result = cutawayBands(data)
        const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x534d48, roughness: 1, side: THREE.DoubleSide })
        const rock = new THREE.Mesh(new THREE.SphereGeometry(result.rockRadius, 48, 32, 0, arc), rockMaterial)
        calculated.add(rock)
        // Two radial cut faces, made from cell-aligned strips with one color per cell.
        for (const phi of [0, arc]) {
          const positions: number[] = [], colors: number[] = [], indices: number[] = []
          const addBand = (inner: number, outer: number, color: [number, number, number]) => {
            const start = positions.length / 3, steps = 24
            // Mesh vertex colors are linear; the legend's CSS colors are sRGB.
            const linearColor = new THREE.Color().setRGB(...color, THREE.SRGBColorSpace).toArray()
            for (let i = 0; i <= steps; i++) {
              const theta = Math.PI * i / steps
              for (const radius of [inner, outer]) {
                positions.push(-radius * Math.cos(phi) * Math.sin(theta), radius * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta))
                colors.push(...linearColor)
              }
              if (i < steps) { const n = start + i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2) }
            }
          }
          addBand(0, result.rockRadius, [.19, .17, .16])
          for (const band of result.bands) addBand(band.inner, band.outer, cutawayColor(band.value, result.min, result.max))
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
          geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
          geometry.setIndex(indices); geometry.computeVertexNormals()
          calculated.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })))
          if (result.transitionRadius !== null) {
            const points = Array.from({ length: 49 }, (_, i) => {
              const theta = Math.PI * i / 48, r = result.transitionRadius!
              return new THREE.Vector3(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta))
            })
            calculated.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xffffff })))
          }
        }
      },
    }
    let dragging = false
    let previousX = 0
    let previousY = 0
    const onDown = (event: PointerEvent) => { dragging = true; previousX = event.clientX; previousY = event.clientY; renderer.domElement.setPointerCapture(event.pointerId) }
    const onMove = (event: PointerEvent) => {
      if (!dragging) return
      moon.rotation.y += (event.clientX - previousX) * 0.008
      moon.rotation.x += (event.clientY - previousY) * 0.008
      previousX = event.clientX; previousY = event.clientY
    }
    const onUp = () => { dragging = false }
    const onKey = (event: KeyboardEvent) => {
      const step = 0.12
      if (event.key === 'ArrowLeft') moon.rotation.y -= step
      else if (event.key === 'ArrowRight') moon.rotation.y += step
      else if (event.key === 'ArrowUp') moon.rotation.x -= step
      else if (event.key === 'ArrowDown') moon.rotation.x += step
      else return
      event.preventDefault()
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onUp)
    host.addEventListener('keydown', onKey)
    const resize = () => {
      const width = host.clientWidth || 1
      const height = host.clientHeight || 1
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      // Fit the globe for both wide and tall panels, leaving room for the direction arrow.
      const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2)
      const halfHorizontal = Math.atan(Math.tan(halfVertical) * camera.aspect)
      camera.position.z = Math.max(4.8, 1.85 / Math.sin(Math.min(halfVertical, halfHorizontal)))
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    let frame = 0
    let phase = 0
    let previousWobble = 0
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const draw = () => {
      if (!dragging && !reducedMotion.matches) {
        phase += 0.006
        const wobble = 0.08 * Math.sin(phase)
        moon.rotation.y += wobble - previousWobble
        previousWobble = wobble
      }
      renderer.render(scene, camera)
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onUp)
      host.removeEventListener('keydown', onKey)
      sceneRef.current = null
      clearCalculated()
      direction.dispose()
      resources.forEach(resource => resource.dispose())
      textures.forEach(texture => texture.dispose())
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])
  // Geometry can contain thousands of radial cells. Throttle only the visual
  // mesh, never the simulation data; a pending update always draws the newest.
  useEffect(() => {
    const apply = () => { thermalTimer.current = undefined; sceneRef.current?.thermal(pendingThermal.current); lastThermalUpdate.current = performance.now() }
    const delay = Math.max(0, 200 - (performance.now() - lastThermalUpdate.current))
    if (!thermal || delay === 0) {
      if (thermalTimer.current !== undefined) window.clearTimeout(thermalTimer.current)
      apply()
    } else if (thermalTimer.current === undefined) thermalTimer.current = window.setTimeout(apply, delay)
  }, [thermal])
  useEffect(() => () => { if (thermalTimer.current !== undefined) window.clearTimeout(thermalTimer.current) }, [])
  useEffect(() => { sceneRef.current?.orbit(orbit) }, [orbit])
  return <div ref={mount} className="moon-canvas" role="img" tabIndex={0} aria-label="Europa 3D cutaway; drag or use arrow keys to rotate. Interior values are a radial model; orientation is illustrative." />
}
