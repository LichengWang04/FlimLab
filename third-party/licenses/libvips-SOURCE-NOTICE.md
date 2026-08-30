# libvips source notice

FilmLab distributes the prebuilt image runtime published with `sharp` 0.35.3:

- `@img/sharp-win32-x64` 0.35.3 ships `libvips-42.dll` and `libvips-cpp-8.18.3.dll`.

This binary package bundles libvips 8.18.3 together with the image codec components
that the sharp project statically links into it (JPEG-XL/WebP/PNG/TIFF/HEIF
codecs, glib, and related libraries). FilmLab uses them exactly as published on
npm and does not modify them.

Upstream sources:

- libvips 8.18.3, distributed under LGPL-3.0-or-later:
  https://github.com/libvips/libvips/tree/v8.18.3
- Prebuilt libvips binaries and their pinned dependency build scripts are
  produced by the sharp project:
  https://github.com/lovell/sharp-libvips

The complete corresponding source for the libvips binaries and their bundled
components is obtainable from the two repositories above, using the versions
pinned by the sharp-libvips release that matches sharp 0.35.3.

The applicable license text is installed beside this notice in
`resources/legal/licenses/LGPL-3.0-or-later.txt`. Copyright and license
statements of the Apache-2.0-licensed sharp packaging live in
`resources/legal/licenses/sharp-LICENSE.txt` and
`resources/legal/licenses/sharp-win32-x64-LICENSE.txt`.
