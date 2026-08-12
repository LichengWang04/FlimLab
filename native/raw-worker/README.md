# FilmLab RAW worker

`filmlab-raw-worker` is a small native executable that keeps camera RAW
decoding outside Electron and outside the renderer. It speaks JSON Lines over
stdin/stdout and writes a worker-private, linear RGB cache. It is deliberately
not a Node native module, so an Electron upgrade does not require rebuilding a
Node ABI add-on.

## What it produces

The worker opens a RAW file with LibRaw 0.22.1, calls only `unpack()`, reads the
unpacked sensor mosaic, subtracts black levels, normalizes against the sensor
white level and uses FilmLab's fixed `bilinear-bayer-v1` demosaic. It does not
call `dcraw_process()`, thumbnail APIs, camera white balance, camera color
matrices, gamma, noise reduction or highlight recovery.

The worker has two versioned output modes:

- `bilinear-bayer-v1` writes the existing row-major
  `filmlab-rgb16le-v1` RGB cache for CPU processing and export.
- `gpu-bayer-v1` writes a compact, single-channel
  `filmlab-bayer16le-v1` cache. Its response includes the canonical row-major
  2×2 `bayerPattern` (`0=R`, `1=G`, `2=B`), and the renderer performs
  demosaic together with geometry sampling in WebGL2.

The RGB cache layout is:

```
R0 uint16 little-endian, G0 uint16 little-endian, B0 uint16 little-endian,
R1, G1, B1, ...
```

The Bayer cache contains one little-endian `uint16` sample per output pixel.
Both modes contain black-subtracted, white-level-normalized camera-linear
values, not linear sRGB. FilmLab's optical calibration and color transform
stages remain responsible for mapping them to a viewing space.

Decode metadata includes camera make/model, capture ISO, per-CFA black levels,
sensor white level and the effective `normalizationRangeDnRgb` used for R/G/B.
The utility worker uses those values only when an exact sensor/ISO photon-
transfer profile exists; they are not a camera colour matrix.

The current implementation intentionally accepts 2×2 Bayer RAW only. It
returns `UNSUPPORTED_CFA` for X-Trans, Foveon, sRAW or a source for which
LibRaw exposes rendered RGB rather than a sensor mosaic. A failure is safer
than producing a deceptively plausible conversion with the wrong CFA model.

## JSON Lines protocol (version 1)

All requests need a non-empty string `id`. Paths must be absolute UTF-8 paths.
Only the main process / utility process may send paths; the renderer must never
receive a cache or source path.

### Decode request

```json
{"id":"job-42","type":"decode","sourcePath":"/absolute/frame.NEF","cachePath":"/absolute/cache/frame.rgb16le","options":{"demosaic":"bilinear-bayer-v1"}}
```

For GPU preview, set `options.demosaic` to `gpu-bayer-v1`. Preview decimation
uses an odd source stride so the 2×2 CFA phase remains valid after sampling.

The sidecar emits zero or more progress events:

```json
{"id":"job-42","event":"progress","stage":"unpacking","fraction":0.12}
```

Its terminal response is either:

```json
{"id":"job-42","ok":true,"result":{"cachePath":"/absolute/cache/frame.rgb16le","cacheFormat":"filmlab-rgb16le-v1","width":6048,"height":4024,"channels":3,"bitDepth":16,"byteOrder":"little-endian","bytes":146098176,"sourceDomain":"camera-linear-rgb","decoderFingerprint":"libraw-0.22.1+bilinear-bayer-v1","metadata":{}}}
```

or:

```json
{"id":"job-42","ok":false,"error":{"code":"UNSUPPORTED_CFA","message":"..."}}
```

Supported error codes are `INVALID_REQUEST`, `SOURCE_NOT_FOUND`,
`OPEN_FAILED`, `UNPACK_FAILED`, `UNSUPPORTED_CFA`, `INVALID_RAW_LAYOUT`,
`INVALID_RAW_LEVELS`, `TOO_MANY_PIXELS`, `CACHE_EXISTS`,
`CACHE_WRITE_FAILED` and `INTERNAL_ERROR`.

`ping` returns protocol/capability metadata; `shutdown` acknowledges and exits.
The parent should cancel a decode by terminating its child process, then delete
the incomplete cache. The parent process also sweeps stale `.<cache>.partial-N`
artifacts before each decode, because the sidecar's temporary-file sequence
number restarts per process and a leftover would collide with `.partial-1`.
The protocol is intentionally single-job and streaming, so it never transfers
a full-resolution raster through Electron IPC.

## Build the worker

The supported, reproducible dependency path is vcpkg. `vcpkg.json` pins LibRaw
to 0.22.1; choose a static triplet for a simpler desktop bundle.

```powershell
cd native/raw-worker
vcpkg install --triplet x64-windows-static --x-manifest-root=.
cmake -S . -B build/windows-x64 `
  -DCMAKE_TOOLCHAIN_FILE="$env:VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" `
  -DVCPKG_TARGET_TRIPLET=x64-windows-static
cmake --build build/windows-x64 --config Release
```

Equivalent release artifacts are needed for every Electron target. CI sets
`FILMLAB_RAW_WORKER_OUTPUT_DIR` while configuring CMake, so the executable is
written directly to its package input location rather than copied from a build
tree by hand:

| Electron target | Expected release artifact |
| --- | --- |
| `win32-x64` | `native/raw-worker/out/win32-x64/filmlab-raw-worker.exe` |
| `darwin-arm64` | `native/raw-worker/out/darwin-arm64/filmlab-raw-worker` |
| `darwin-x64` | `native/raw-worker/out/darwin-x64/filmlab-raw-worker` |
| `linux-x64` | `native/raw-worker/out/linux-x64/filmlab-raw-worker` |

The Electron main process should prefer an explicit absolute
`FILMLAB_RAW_SIDECAR` environment override for local development. For packaged
builds it should resolve the matching file under
`process.resourcesPath/raw-worker/<platform>-<arch>/`. If no executable exists,
return `RAW_SIDECAR_UNAVAILABLE`; never fall back to an embedded JPEG or an
unannounced renderer decoder.

## CI and distributable bundles

`.github/workflows/raw-sidecar-release.yml` builds the four table entries with
static vcpkg triplets, sends each executable a `ping` request, and verifies that
the answer declares **only** `supportedCfa: ["bayer-2x2"]`. It then runs
electron-builder on the matching operating system. electron-builder's pre-pack
and post-pack hooks reject a package if its current target's sidecar is missing
or was not copied to `resources/raw-worker/<platform>-<arch>/`.

Push and pull-request runs retain both the worker and the installer as CI
artifacts. A version-tag run passes `forceCodeSigning=true` for Windows and
macOS, so it fails instead of issuing an unsigned release package. Configure
`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` for Authenticode and `CSC_LINK` /
`CSC_KEY_PASSWORD` plus the applicable Apple notarization credentials for macOS.
Windows extra-resource `.exe` files are included in electron-builder's signing
pass; macOS signing walks executable files under `Contents`, including this
sidecar. Linux AppImage is distributed as a package artifact and should be
published with the project's release checksum/signature policy.

The vcpkg manifest pins its baseline as well as LibRaw 0.22.1. Update those two
values together only after rebuilding every matrix target and deliberately
changing `decoderFingerprint` if the decoder's behavior changes.

## License and shipping notes

FilmLab elects **CDDL-1.0** for its static distribution of unmodified LibRaw
0.22.1. The LGPL route is not used for the packaged RAW worker. Every installer
contains `resources/legal/LibRaw-0.22.1.CDDL.txt`, the upstream copyright
notice, and a source notice identifying the exact 0.22.1 archive SHA-512,
vcpkg baseline and build recipe. `scripts/verify-raw-sidecar.cjs` rejects a
package if those materials or its CycloneDX SBOM are absent.

The complete repository inventory is in `THIRD_PARTY_NOTICES.md`; generated
platform-specific npm license texts and native notices live under
`resources/legal/`. A LibRaw version, vcpkg baseline, build patch or static
dependency change must update that inventory and source notice in the same
commit. The FilmLab source in this folder does not invoke LibRaw's rendered-
image path, but linking and redistribution remain subject to these notices.

The bilinear demosaic is deterministic and deliberately conservative. It is a
good linear input for the FilmLab negative pipeline, not a claim of a universal
camera rendering. More advanced demosaicers may be added as separately named,
versioned options so their decoder fingerprint remains part of a calibration
profile's capture fingerprint.
