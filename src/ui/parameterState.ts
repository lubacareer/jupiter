/** Values shown in the controls and the explicit changes used to start a run. */
export type SimulationParameters = { eccentricity: number; semiMajorAxisKm: number }
export type ParameterOverrides = Partial<SimulationParameters>
export type ParameterState = { values: SimulationParameters; overrides: ParameterOverrides }

export function createParameterState(defaults: SimulationParameters): ParameterState {
  return { values: { ...defaults }, overrides: {} }
}

export function editParameter(state: ParameterState, key: keyof SimulationParameters, value: number): ParameterState {
  // Focus/blur on an unchanged numeric field must not turn an exact epoch into an override.
  if (Object.is(state.values[key], value)) return state
  return { values: { ...state.values, [key]: value }, overrides: { ...state.overrides, [key]: value } }
}

export function restoreParameters(values: SimulationParameters, overrides: ParameterOverrides): ParameterState {
  return { values: { ...values }, overrides: { ...overrides } }
}
