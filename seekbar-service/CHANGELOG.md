# Changelog

## [0.4.1] — 2026-10-26

- Fix data races between sprite workers and job polling/list/cancellation APIs.
  Workers publish result fields together after upload cleanup; HTTP responses
  use stable snapshots and queued cancellation shares the dequeue lock.
- Fix progress callbacks reading the submitted-job count without its lock.
- Add concurrent job-response and cancellation regression tests. Release
  binaries and images require the sidecar test workflow to pass first.
- Align the build toolchain with the main app (Go 1.27.2).
