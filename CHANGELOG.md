# Changelog

FilmLab follows [Semantic Versioning](https://semver.org/). This file records user-visible changes and release-boundary decisions.

## [Unreleased]

### Added

- Proprietary root license, CDDL-1.0 LibRaw election, packaged third-party license bundle and combined npm/vcpkg CycloneDX SBOM.
- High-severity dependency audit, Dependency Review and CodeQL security-extended workflows for JavaScript/TypeScript and C++.
- Formal privacy, security reporting, diagnostics, migration and support policies.
- Reproducible Windows NSIS, macOS DMG and Linux AppImage packages with generated FilmLab icons, version/publisher metadata and target-specific installation policy.
- Installed-package smoke verification that launches the packaged renderer, pings the packaged RAW sidecar and, on private A7R V runners, repeats real ARW import/relink/export through the installed executable.
- Tag release gates for Authenticode, Developer ID signing, Apple notarization tickets, checksums and GitHub Release publication.
- Complete `.filmlab` directory lifecycle: new, open, read-only open, save as and recent projects.
- Portable snapshots for every calibration profile referenced by a project.
- Automatic/manual project backups, explicit schema migration confirmation and read-only recovery from corrupt projects.
- Save-queue flushing and a final current-frame save before project switches and application exit.
- Production Electron/LibRaw A7R V acceptance covering project restart/copy, identity relink, four full-resolution master formats, metadata validation, GPU/CPU renderer backends and multi-cycle stability.
- Weekly/manual private-fixture matrix for Windows x64, macOS Intel and macOS Apple Silicon, with independent ExifTool/ImageMagick compatibility probes.

### Changed

- Production renderer CSP now denies every network connection; Vite development permits loopback HMR only.
- Locked build dependencies were refreshed within existing constraints to resolve all npm advisories reported on 2026-08-13.
- Project and recent absolute paths remain only in the machine-private `project-sessions-v1.json`; renderer APIs use opaque session IDs.
- `benchmark:raw` now drives a real ARW through Electron and the native sidecar instead of using Sharp to read a TIFF proxy.
- Batch export releases each completed full-resolution raster; atomic output retries clean dead-process artifacts without touching live exports.

## [0.1.0] - 2026-08-12

Initial repository baseline for the FilmLab desktop beta.

### Added

- Deterministic linear-light negative processing with RAW and 16-bit TIFF input.
- LibRaw sidecar for 2×2 Bayer cameras and exact Sony A7R V ISO 100 PTC matching.
- WebGL2 interactive preview with CPU fallback and canonical full-resolution CPU master export.
- TIFF, JPEG, HEIF/AVIF and device-matched linear DNG output with ICC/XMP metadata.
- Explicit `uncalibrated`, `profile-unverified` and `device-matched` colour-trust states.
- Project schema v8 with durable source identities, private local path recovery and directory relinking.
- Application quality CI and cross-platform RAW sidecar packaging workflow.

### Known limitations at 0.1.0

- The application initially opened one fixed active workspace; this limitation is removed in Unreleased.
- RAW support is limited to 2×2 Bayer sources. X-Trans, Foveon and sRAW are rejected.
- GPU strip export is infrastructure only; the desktop master path deliberately remains deterministic CPU processing.
- Device-matched colour requires a calibration profile matching both camera identity and decoder fingerprint.
