# Build and validation infrastructure

The Checks workflow runs the test suite, production build, and unsigned native
packaging on GitHub-hosted Linux, Windows and macOS. Installers are uploaded as
workflow artifacts. These jobs do not prove that an actual GPU is available or
that the GPU accuracy gates pass. The desktop packages do not require Docker.

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

For real GPU validation, check out the trusted PR commit on the target machine,
then run `npm ci`, `npm run build`, `npx electron-builder --dir --publish never`,
and `node electron/run-packaged-gpu.cjs`. Inspect the resulting
`gpu-validation-report.json`. The manually dispatched **Prepare manual GPU
validation (no GPU test)** workflow verifies the selected PR and commit and displays these instructions; it
does not run a GPU test or report a hardware pass. This public personal repository
cannot restrict a self-hosted runner to a particular workflow. Do not register a
personal machine as a GPU runner; an ephemeral runner alone does not restrict
which job can reach it. Provisioning, billing, cleanup, and release of associated
storage and IP addresses remain manual; confirm the total quote against the
approved budget before provisioning.
Linux hardware validation remains outstanding: the packaged WSLg test did not
find a WebGPU adapter, even when Vulkan and Wayland were enabled. A CUDA-capable
device alone does not establish that Electron can use WebGPU.
