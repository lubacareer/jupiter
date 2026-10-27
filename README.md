# Europa Engine

Europa Engine is an **early research prototype**, not a validated Europa model. It provides a desktop workspace for experimenting with four-body orbital dynamics and a separately tested thermal component. It does not yet implement the coupled solver described in the project plan.

## Run

Install a supported Node.js version (22.22.2 or later in the 22.x line, 24.15.0 or later in the 24.x line, or 26.0.0 or later), then run `npm ci` and `npm run dev`. The desktop app runs locally and does not require an account or server. `npm test` runs the test suite; `npm run build` checks types and builds the app. `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` build platform installers on their respective operating systems. macOS distribution requires appropriate signing and notarization for public release.

## Available today

- A 3D illustrative cutaway and a four-point-mass Jupiter–Io–Europa–Ganymede orbital integration in a separate desktop process. Edit Europa's initial eccentricity and semi-major axis, run or pause, and plot osculating eccentricity and the Laplace angle. The illustration is not solver output and is not to scale.
- Checkpoint save/restore and JSON export of the current orbital state and the latest 2,000 samples. Runs use a 300-second integration step; elapsed animation time is not physical time. New checkpoints include a checksum to detect accidental changes, while older checkpoints remain loadable without one. Imported checkpoints are unverified user-supplied data: a checksum cannot establish their origin or scientific validity.
- Independent WebGPU experiments for the four-body orbit and a synthetic 3D Cartesian enthalpy model. Each published GPU result is compared with an independently advanced CPU float64 reference. An orbital difference above 10 km, a thermal comparison above its limits, device loss, or a non-finite result stops the experiment without accepting the failed result. GPU runs require a supported, identifiable hardware adapter; there is no silent CPU fallback.
- GPU checkpoints and field exports include device, precision, solver, reference and diagnostic information. Imported checkpoints remain unverified, even when their checksum matches. The GPU orbit runs at 300-second steps for at most ten initial Europa periods; thermal inputs are a synthetic demonstration, not Europa estimates. The two experiments are independent.

The initial orbital state comes from JPL Horizons at 2025-01-01 TDB. It is translated to the four-body centre of mass and edited values represent a hypothetical new orbit. See [orbital model and provenance](docs/orbit.md) and [thermal component](docs/interior.md) for equations, units, tests, and limitations.

## Scientific limitations

The orbit solver omits Jupiter's oblateness, Callisto, the Sun, tidal torques, dissipation, and orbital back-reaction. The prototype has **no coupled 3D viscoelasticity, ocean circulation, self-gravity, resolved moving ice–ocean boundary, or geological-timescale mode**. There is no validated Love-number, Stefan-front, ocean-flow, or full-system benchmark. Results must not be treated as mission predictions or research-validated results. The cutaway and current design are schematic and differ materially from the approved visual concept.

The tests demonstrate properties of the simplified components, not validity of a coupled planetary model. Long-term orbital trajectories and apparent resonances require particular caution.

The comparison limits are engineering checks, not scientific validation. A GPU run may be slower than a CPU-only run because it also advances a reference solution. See [build and hardware validation](docs/build-validation.md) for native packages, the Linux build image, and real-device checks.
