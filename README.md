# Europa Engine

Europa Engine is an **early research prototype**, not a validated Europa model. It provides a desktop workspace for experimenting with four-body orbital dynamics and a separately tested thermal component. It does not yet implement the coupled solver described in the project plan.

## Run

Install Node.js 22 or later, then run `npm ci` and `npm run dev`. The desktop app runs locally and does not require an account or server. `npm test` runs the numerical checks; `npm run build` checks types and builds the app. `npm run dist:win`, `npm run dist:mac`, and `npm run dist:linux` build platform installers on their respective operating systems. macOS distribution requires appropriate signing and notarization for public release.

## Available today

- A 3D illustrative cutaway and a four-point-mass Jupiter–Io–Europa–Ganymede orbital integration in a separate desktop process. Edit Europa's initial eccentricity and semi-major axis, run or pause, and plot osculating eccentricity and the Laplace angle. The illustration is not solver output and is not to scale.
- Checkpoint save/restore and JSON export of the current orbital state and the latest 2,000 samples. Runs use a 300-second integration step; elapsed animation time is not physical time. Imported checkpoints are unverified user-supplied data, even when their model constants pass validation.
- An independent, CPU-based 3D Cartesian enthalpy diffusion component, with numerical tests. This component is not connected to the user interface or the orbit model.

The initial orbital state comes from JPL Horizons at 2025-01-01 TDB. It is translated to the four-body centre of mass and edited values represent a hypothetical new orbit. See [orbital model and provenance](docs/orbit.md) and [thermal component](docs/interior.md) for equations, units, tests, and limitations.

## Scientific limitations

The orbit solver omits Jupiter's oblateness, Callisto, the Sun, tidal torques, dissipation, and orbital back-reaction. The prototype has **no GPU solver, coupled 3D viscoelasticity, ocean circulation, self-gravity, moving ice–ocean boundary, or geological-timescale mode**. The orbital run uses CPU double precision despite the planned GPU requirement. There is no validated Love-number, Stefan-front, ocean-flow, or full-system benchmark. Results must not be treated as mission predictions or research-validated results. The cutaway and current design are schematic and differ materially from the approved visual concept.

The tests demonstrate properties of the simplified components, not validity of a coupled planetary model. Long-term orbital trajectories and apparent resonances require particular caution.
