# Security policy

## Supported versions

Security fixes are made on `main` and the newest published FilmLab minor
release. Older builds, unsigned CI artifacts, locally modified packages and
project schemas newer than the running application are not supported.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** / Security Advisory channel for
the repository when available. Do not open a public issue before a report has
been assessed. If private reporting is unavailable, contact the repository
owner without attaching source photographs, `.filmlab` directories,
calibration profiles, signing material, crash dumps, or absolute filesystem
paths; first ask for a private transfer method.

Include the FilmLab version and commit, operating system/architecture, whether
the package was signed, the smallest reproducible sequence, the security
impact, and a proof of concept using synthetic/non-private data. Reports are
acknowledged and remediated on a best-effort basis; no response-time SLA is
offered by the community distribution.

## Security boundary

- The renderer is sandboxed, has no Node integration, rejects navigation and
  permission requests, and has production `connect-src 'none'` CSP.
- File paths and native processing stay in the main/utility/sidecar boundary.
  Renderer APIs receive opaque session IDs and renderer-safe metadata.
- FilmLab does not upload telemetry, photos, projects or crash reports.
- RAW files are untrusted binary input. The native LibRaw decoder is isolated
  in a child process, but this is defense in depth rather than a guarantee that
  malformed files are safe. Do not process anonymous internet uploads on a
  privileged workstation.
- Signed release artifacts, SHA-256 checksums, and SBOM attestations are the
  release trust boundary. Unsigned local/CI packages are test artifacts.

## Automated assurance

`.github/workflows/security.yml` runs a high-severity npm audit and produces a
CycloneDX SBOM for every push/PR and weekly. Dependency Review and CodeQL run
for public repositories, or for private repositories after GitHub Code
Security is enabled and repository variable `FILMLAB_GHAS_ENABLED=true` is
set. The C++ build also treats compiler warnings as first-class review output.

Security tooling does not replace review, fuzzing, certificate protection, or
platform hardening. Never commit signing certificates, passwords, Apple API
keys, private RAW fixtures, exported masters, or diagnostic archives.
