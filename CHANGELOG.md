# Changelog

FilmLab follows [Semantic Versioning](https://semver.org/). This file records user-visible changes and release-boundary decisions.

## [Unreleased]

### Changed

- Film-inversion colour pipeline: preset curves are resampled onto each frame's measured Dmax−Dmin (calibrated profiles keep their absolute domain), curve endpoints extrapolate in the log domain instead of hard-clamping, cross-talk matrix negatives clamp at inversion, calibrated white balance moves ahead of the 3D LUT, tone contrast is a log-domain power law anchored at 0.18 mid grey, hue-preserving gamut compression is always active, and scRGB TIFF inputs floor out-of-gamut negatives. CPU and WebGL2 paths share the same formulas.

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
- Four-format TIFF/JPEG/HEIF/DNG batch export with per-frame recipes, safe names, progress, cancellation and per-frame DNG trust gates.
- Calibration profile export, immutable version history, restore and deletion across main-process IPC and the desktop inspector.
- GitHub Release update checks, user-confirmed installation, cached Windows last-known-good rollback and failed-startup recovery.
- Keyboard command map, skip navigation, live status announcements, reduced-motion support and a complete user manual.
- Versioned `edge-aware-bayer-v2` CPU/WebGL demosaic with the legacy bilinear algorithm retained only as an explicit compatibility path.
- Full-resolution tiled WebGL2 master export as the default desktop path, with source/trust revalidation and same-target CPU fallback.

### Changed

- Production renderer CSP still denies every network connection; only the packaged main-process updater can contact GitHub Release or an administrator-configured mirror. Vite development permits loopback HMR only.
- Locked build dependencies were refreshed within existing constraints to resolve all npm advisories reported on 2026-08-13.
- Project and recent absolute paths remain only in the machine-private `project-sessions-v1.json`; renderer APIs use opaque session IDs.
- `benchmark:raw` now drives a real ARW through Electron and the native sidecar instead of using Sharp to read a TIFF proxy.
- Batch export releases each completed full-resolution raster; atomic output retries clean dead-process artifacts without touching live exports.
- Decoder fingerprints now use `edge-aware-bayer-v2`; existing v1 calibration profiles intentionally become unverified until regenerated or explicitly revalidated.

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
