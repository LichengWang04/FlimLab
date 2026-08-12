# FilmLab support policy

## Supported release boundary

The maintained code line is `main` and the newest published minor release.
Official platform claims require a passing native package workflow and, for
real-camera behavior, a passing private A7R V acceptance report on that exact
platform/architecture. Current intended packages are Windows x64 NSIS, macOS
13+ Intel/Apple Silicon DMG, and Linux x64 AppImage.

RAW support is limited to 2×2 Bayer sources accepted by LibRaw 0.22.1. Sony
A7R V ISO 100 has an exact PTC noise profile; PTC is not a colour calibration.
Device-matched colour still requires a matching calibration profile. X-Trans,
Foveon, sRAW and anonymous server-side upload processing are outside the
supported boundary.

## Getting help

Use a normal GitHub issue for reproducible non-security defects and feature
requests. Use the private process in `SECURITY.md` for vulnerabilities. Include
version/commit, signed-vs-local package, OS/architecture/GPU, source format and
camera model, expected/actual behavior, and minimal steps. Prefer synthetic or
redacted fixtures. Never upload a real photograph or project merely because a
template asks for an attachment.

Support is best effort and carries no response or restoration SLA. A valid bug
report does not guarantee support for a new camera, codec, operating system,
GPU driver or colour-accuracy claim. See `docs/diagnostics.md` for safe evidence
collection and `docs/migration.md` before changing application/schema versions.
