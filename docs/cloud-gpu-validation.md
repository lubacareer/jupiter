# On-demand cloud GPU validation

The desktop app and ordinary CI do not require the project owner's computer to
be online. GPU hardware validation can be performed manually on a temporary
cloud machine; do **not** register that machine as a GitHub self-hosted runner.
The GPU test executes the native packaged app on the cloud host. A Docker build,
CUDA device, or successful hosted CI build alone does not establish WebGPU
graphics support. The result is a research-prototype comparison, not a
scientific validation of Europa's interior model.

## Before provisioning

1. Select the exact reviewed 40-character commit SHA and the platform being
   tested. For an open PR, the **Prepare manual GPU validation (no GPU test)**
   GitHub workflow can verify the PR head and show the build commands. That
   workflow does not run a GPU test.
2. Check Scaleway account access, payment status, quota, region availability,
   graphics-session access, and the current full price before starting anything.
   The approved initial budget is **US $10 total** for both Linux and macOS,
   including taxes, currency conversion, compute, storage and networking. Reserve
   the 24-hour minimum Mac charge and a conservative buffer for both machines.
   Stop if the expected combined cost cannot fit. Provider estimates may not be
   final and billing alerts are not a guaranteed hard spending cap.
3. Use a disposable machine with a hardware-backed graphical session and the
   supported Node version from `package.json`. A headless SSH session or
   `nvidia-smi` result does not prove Chromium can access an adapter. Do not use
   `--enable-unsafe-webgpu`, GPU blocklist bypasses, or software adapters. Do
   not put GitHub or Docker Hub tokens on the machine or in its environment.

For macOS, the selected [Scaleway M2-L Mac mini](https://www.scaleway.com/en/pricing/apple-silicon/)
has a [24-hour minimum lease](https://www.scaleway.com/en/docs/apple-silicon/faq/).
Enable automatic deletion after 24 hours in the console and set a reminder to
verify deletion and billing. Use the provider's [remote desktop procedure](https://www.scaleway.com/en/docs/apple-silicon/how-to/access-remote-desktop-mac-mini/)
to establish a graphical session if necessary; remote access alone does not prove
that Electron can use the GPU.

For Linux, investigate the [Scaleway L4 GPU instance](https://www.scaleway.com/en/pricing/gpu/)
only if its full quote fits the remaining budget. Its default NVIDIA packages
are [headless drivers](https://www.scaleway.com/en/docs/gpu/troubleshooting/fix-driver-issues/),
so a GPU-backed desktop and Chromium WebGPU are **not established**. Confirm a
suitable display and driver configuration with the provider before starting;
do not install unsupported drivers just to make the test pass. Block storage and
flexible IPs are billed separately and may continue to incur charges after a
machine is stopped. If support or budget cannot be confirmed, leave Linux
unverified instead of provisioning.

## Build and run on the cloud machine

On a clean cloud host, replace `REVIEWED_SHA` with the exact commit selected
above. Clone the public repository, check out that commit, and verify `HEAD`
before building. Keep all output, including failures, until the report has been
retained. The commands below are for a POSIX shell on Linux or macOS:

```sh
git clone https://github.com/lubacareer/jupiter.git
cd jupiter
PR_NUMBER=2  # Replace with the reviewed PR number.
git fetch origin "refs/pull/$PR_NUMBER/head"
REVIEWED_SHA='<40-character-reviewed-commit-sha>'
git switch --detach "$REVIEWED_SHA"
node scripts/run-cloud-gpu.cjs "$REVIEWED_SHA"
```

The wrapper checks that the working tree is clean and `HEAD` matches the requested SHA and then runs `npm ci`,
the test suite, the production build, native packaging, and the **packaged** GPU
benchmark. It writes `gpu-report-submission.json` and a one-line base64
`gpu-report-submission.txt`, including a non-passing infrastructure-failure
record if a stage fails after the SHA preflight. The GPU harness also writes
`gpu-validation-report.json` when it starts. Preserve the submission even when
the command exits nonzero. If checkout, Node, or the SHA preflight fails before
a submission is written, record the test as incomplete; do not fabricate a
passing report. Review files for private information before uploading. Hardware
reports describe the actual adapter, platform, OS, Electron and Chromium
versions, and separate orbit and thermal results.

A valid hardware result identifies the adapter and completes all ten initial
Europa periods, with position error at most 10 km at every reported sample. It
also completes 100 thermal steps within 0.05 K maximum temperature difference,
0.002 maximum liquid-fraction difference and 0.0001 normalized energy
difference. A missing or anonymous adapter, software renderer, GPU device loss,
failed comparison, or missing report is **not** a pass.
The report validator currently recognizes this benchmark's 10,232 steps and
853 orbital samples. Update the validator if the benchmark itself changes.

## Retain the report and clean up

The owner can submit the envelope as an artifact using the **Ingest self-reported
GPU validation** workflow. Display the wrapper's already-encoded submission:

```sh
cat gpu-report-submission.txt
```

In GitHub Actions, run the ingestion workflow from `main` with the reviewed
commit SHA, `Windows`, `Linux` or `macOS`, provider name, and that base64 value.
The commit and platform must match the submission; provider accepts 1–64 ASCII
letters, numbers, spaces, dots, dashes or underscores. Do not include credentials
or private logs. The artifact stores the submitted envelope containing the report
and a manifest with its SHA-256 digest and the submitted commit and provider.
These are self-reported and **unverified**; a hash does not attest that the cloud
test was actually run or that the claimed commit produced it.
The repository currently retains artifacts for 90 days; download anything that
must be retained longer before it expires. Failed GPU harness reports are also
accepted.

After preserving results, delete the Linux instance, its allocated block
volumes and flexible IPs, and verify that each no longer exists or incurs
charges. For the Mac, verify the scheduled deletion actually completed after
the mandatory minimum period and confirm billing stopped. Record any cleanup
failure and follow up with the provider; a stopped machine can still have
billable resources. Do not leave temporary credentials or persistent runners.

Linux hardware support and macOS hardware validation remain outstanding until
the actual packaged cloud tests complete; the existing Windows result came from
one local machine and is not a requirement to keep it online.
