# FilmLab third-party notices

This inventory covers dependencies locked for FilmLab 0.1.0. The release build
generates a platform-specific license directory and a CycloneDX SBOM under
`resources/legal/`. Optional npm packages for other operating systems remain in
the lock-file/SBOM inventory but are not copied into a package unless installed
for that host.

## Native RAW worker components

The exact native dependency set is pinned by `native/raw-worker/vcpkg.json` at
vcpkg baseline `cd61e1e26a038e82d6550a3ebbe0fbbfe7da78e3`.

| Component | Version | License | Role/source |
| --- | --- | --- | --- |
| `LibRaw` | `0.22.1` | CDDL-1.0 (FilmLab election) | RAW parsing; [source](https://github.com/LibRaw/LibRaw/releases/tag/0.22.1) |
| `nlohmann-json` | `3.12.0` | MIT | Sidecar JSON protocol |
| `JasPer` | `4.2.9` | JasPer 2.0 | LibRaw/vcpkg transitive codec |
| `Little-CMS` | `2.19.1` | MIT | LibRaw/vcpkg transitive colour library |
| `zlib` | `1.3.2` | Zlib | LibRaw/vcpkg transitive compression |
| `libjpeg-turbo` | `3.1.4.1` | BSD-3-Clause/IJG terms | LibRaw/vcpkg transitive JPEG support |

FilmLab does not modify LibRaw source. It statically links LibRaw into
`filmlab-raw-worker` and elects CDDL-1.0. Every installer includes the complete
CDDL text, upstream copyright notice, and exact source/build retrieval
instructions. This software is based in part on the work of the Independent
JPEG Group.

## JavaScript and packaged image components

| Package | Version | SPDX expression |
| --- | --- | --- |
| `@emnapi/runtime` | `1.11.2` | MIT |
| `@img/colour` | `1.1.0` | MIT |
| `@img/sharp-darwin-arm64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-darwin-x64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-freebsd-wasm32` | `0.35.3` | Apache-2.0 |
| `@img/sharp-libvips-darwin-arm64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-darwin-x64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-arm` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-arm64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-ppc64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-riscv64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-s390x` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-x64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linuxmusl-arm64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-libvips-linuxmusl-x64` | `1.3.2` | LGPL-3.0-or-later |
| `@img/sharp-linux-arm` | `0.35.3` | Apache-2.0 |
| `@img/sharp-linux-arm64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-linux-ppc64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-linux-riscv64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-linux-s390x` | `0.35.3` | Apache-2.0 |
| `@img/sharp-linux-x64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-linuxmusl-arm64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-linuxmusl-x64` | `0.35.3` | Apache-2.0 |
| `@img/sharp-wasm32` | `0.35.3` | Apache-2.0 AND LGPL-3.0-or-later AND MIT |
| `@img/sharp-webcontainers-wasm32` | `0.35.3` | Apache-2.0 |
| `@img/sharp-win32-arm64` | `0.35.3` | Apache-2.0 AND LGPL-3.0-or-later |
| `@img/sharp-win32-ia32` | `0.35.3` | Apache-2.0 AND LGPL-3.0-or-later |
| `@img/sharp-win32-x64` | `0.35.3` | Apache-2.0 AND LGPL-3.0-or-later |
| `argparse` | `2.0.1` | Python-2.0 |
| `builder-util-runtime` | `9.7.0` | MIT |
| `debug` | `4.4.3` | MIT |
| `detect-libc` | `2.1.2` | Apache-2.0 |
| `electron-updater` | `6.8.9` | MIT |
| `fs-extra` | `10.1.0` | MIT |
| `graceful-fs` | `4.2.11` | ISC |
| `js-yaml` | `4.3.1` | MIT |
| `jsonfile` | `6.2.1` | MIT |
| `lazy-val` | `1.0.5` | MIT |
| `lodash.escaperegexp` | `4.1.2` | MIT |
| `lodash.isequal` | `4.5.0` | MIT |
| `lucide-react` | `1.24.0` | ISC |
| `ms` | `2.1.3` | MIT |
| `react` | `19.2.7` | MIT |
| `react-dom` | `19.2.7` | MIT |
| `sax` | `1.6.0` | BlueOak-1.0.0 |
| `scheduler` | `0.27.0` | MIT |
| `sharp` | `0.35.3` | Apache-2.0 |
| `semver` | `7.7.4` | ISC |
| `semver` | `7.8.5` | ISC |
| `tiny-typed-emitter` | `2.1.0` | MIT |
| `tslib` | `2.8.1` | 0BSD |
| `universalify` | `2.0.1` | MIT |

The generated license bundle copies the unmodified license/NOTICE files from
every runtime npm package actually installed for the target platform. Where an
upstream platform tarball declares `LGPL-3.0-or-later` but omits license files,
the bundle adds the standard unmodified GNU GPL v3 and LGPL v3 texts required
by the LGPL. Those binaries and their corresponding build source are published
by the [sharp-libvips project](https://github.com/lovell/sharp-libvips).
License expressions above are metadata, not a replacement for those texts.
