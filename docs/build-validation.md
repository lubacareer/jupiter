# Build and validation infrastructure

The Checks workflow runs the test suite, production build, and unsigned native
packaging on GitHub-hosted Linux, Windows and macOS. Installers are uploaded as
workflow artifacts. These jobs do not prove that an actual GPU is available or
that the GPU accuracy gates pass. Builds run without the project owner's computer
being online, and the desktop packages do not require Docker. Pull requests and
pushes to `main` are checked; installer artifacts expire after seven days.

The public repository uses standard GitHub-hosted runners, which are free for
public repositories. Do not select paid larger runners or provision paid GPU
instances for these checks. GitHub's artifact and cache storage is subject to
account allowances and billing settings; check usage and budgets rather than
assuming unlimited storage. Docker Hub Personal supports public repositories
subject to pull-rate limits and fair-use terms. Provider limits may change.

`Dockerfile` defines a Linux Node/Electron build-and-test environment containing
the source at the selected commit. Build it with `docker build -t europa-engine-build .`;
run its tests with `docker run --rm europa-engine-build` or its production build
with `docker run --rm europa-engine-build npm run build`. The image is not a
containerized GUI app or a substitute for a hardware GPU test.

The manually dispatched **Publish Linux build image** workflow publishes to
`lubani27/europa-engine` only after its build and tests pass. Dispatch from
`main` as the repository owner, specifying an open same-repository PR and its
exact reviewed 40-character head SHA. Build and test run on a separate runner
before the publication job receives credentials; the PR head is checked again
after environment approval. Configure the `docker-publish` GitHub environment
to allow only `main` and require owner review, and store `DOCKERHUB_USERNAME`
and a narrowly scoped `DOCKERHUB_TOKEN` as environment secrets. Never store the
token as a repository or organization secret. Verify the environment protections
before adding the token: GitHub can create an unprotected environment when a
workflow references a missing one. Tags include the PR number, full commit SHA,
workflow run ID and attempt; they are never `latest`. Configure Docker Hub immutable-tag protection
with the regular expression `^pr-.*$`, and record the returned image digest when
consuming the image. A unique tag alone cannot prevent a
registry user from overwriting it.

Use `validate_only=true` when dispatching to check the PR and expected SHA
without building, requiring approval, accessing the token or publishing.

Native packages are unsigned. macOS public distribution additionally needs
proper signing and notarization; these artifacts are for testing.

GPU hardware validation is optional and currently limited to a manual Windows
test on a machine with a supported GPU. Check out the trusted commit, run
`npm ci`, `npm run build`, `npx electron-builder --dir --publish never`, and
`node electron/run-packaged-gpu.cjs`, then inspect `gpu-validation-report.json`.
The machine is not a CI runner and does not need to stay online. The hosted
**Prepare manual GPU validation (no GPU test)** workflow verifies a selected PR
and commit but does not run a hardware test. Do not register a personal machine
as a self-hosted runner for this public repository.

Linux and macOS GPU validation is not required for this release and has not been
established. The packaged Linux WSLg test did not find a WebGPU adapter. GPU
experiments still require a supported hardware adapter on whichever machine runs
them; there is no silent CPU fallback.
