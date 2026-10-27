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
`lubani27/europa-engine` only after its build and tests pass. Select a trusted
branch which is the current head of an open, same-repository PR targeting main,
and enter that PR number. Never run this workflow with untrusted code: the
selected commit's build scripts execute before publishing. Configure the
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets in GitHub, not in
source files. Tags include the PR number, full commit SHA, workflow run ID and
attempt; they are never `latest`. Configure Docker Hub immutable-tag protection
for `pr-*` to enforce tag immutability at the registry, and record the returned
image digest when consuming the image. A unique tag alone cannot prevent a
registry user from overwriting it.

Native packages are unsigned. macOS public distribution additionally needs
proper signing and notarization; these artifacts are for testing.

For real GPU validation, a repository owner can manually dispatch **Hardware
GPU validation** on a trusted, same-repository PR head. It checks the selected
PR and commit before assigning work to a registered self-hosted runner with
`gpu` and the selected `Windows`, `Linux`, or `macOS` labels. Register only
short-lived trusted runners; never use this workflow for untrusted PR code.
It builds the native unpacked application, runs its hardware test, and uploads `gpu-validation-report.json`. Provisioning,
billing, cleanup, and release of associated storage and IP addresses remain
manual; confirm the total quote against the approved budget before provisioning.
