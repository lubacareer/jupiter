import { radialFieldProfile, type RadialState } from '../simulation/radialInterior'

export type CutawayField = 'temperature' | 'liquidFraction'
export type CutawayScale = 'true' | 'exaggerated'
export type CutawayData = { state: RadialState; enthalpy: number[]; field: CutawayField; scale: CutawayScale }
export type CutawayBand = { inner: number; outer: number; value: number }

/** Map each calculated radial cell to its displayed radius. No lateral variation is implied. */
export function cutawayBands({ state, enthalpy, field, scale }: CutawayData): { bands: CutawayBand[]; rockRadius: number; transitionRadius: number | null; min: number; max: number } {
  const config = state.config
  if (enthalpy.length !== config.cells || !enthalpy.every(Number.isFinite)) throw new Error('Invalid interior field')
  const profile = radialFieldProfile(config, enthalpy)
  const depth = config.iceThicknessM + config.oceanDepthM
  const base = config.radiusM - depth
  const transition = profile.iceThicknessM
  const rockRadius = scale === 'true' ? base / config.radiusM : .59
  const mapRadius = (radius: number) => {
    if (scale === 'true') return radius / config.radiusM
    const interfaceRadius = transition === null ? null : config.radiusM - transition
    if (interfaceRadius !== null && interfaceRadius > base && interfaceRadius < config.radiusM) {
      return radius <= interfaceRadius
        ? rockRadius + (radius - base) / (interfaceRadius - base) * (.84 - rockRadius)
        : .84 + (radius - interfaceRadius) / (config.radiusM - interfaceRadius) * .16
    }
    return rockRadius + (radius - base) / depth * (1 - rockRadius)
  }
  const width = depth / config.cells
  const bands = profile.cells.map((cell, i) => {
    return { inner: mapRadius(base + i * width), outer: mapRadius(base + (i + 1) * width), value: field === 'temperature' ? cell.temperatureK : cell.liquidFraction }
  })
  // Keep a given temperature the same color throughout the run. The bounds are
  // derived from immutable run configuration, not from the evolving field.
  const temperatureMax = config.material.meltingTemperature + 150
  const temperatureMin = config.surfaceTemperatureK < temperatureMax ? config.surfaceTemperatureK : 0
  return { bands, rockRadius, transitionRadius: transition === null ? null : mapRadius(config.radiusM - transition), min: field === 'temperature' ? temperatureMin : 0, max: field === 'temperature' ? temperatureMax : 1 }
}

/** A perceptually ordered dark-blue to warm-yellow scale, used for both plots and surfaces. */
export function cutawayColor(value: number, min: number, max: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min || 1)))
  const stops: Array<[number, number, number]> = [[.06, .18, .43], [.06, .58, .73], [.95, .79, .3]]
  const i = t < .5 ? 0 : 1
  const f = t < .5 ? t * 2 : (t - .5) * 2
  return stops[i].map((v, k) => v + f * (stops[i + 1][k] - v)) as [number, number, number]
}
