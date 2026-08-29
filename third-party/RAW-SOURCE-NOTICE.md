# Camera RAW decoder source notice

FilmLab distributes `libraw-wasm` 1.6.0. Its WebAssembly module is built from:

- LibRaw 0.22.1, distributed by FilmLab under CDDL-1.0:
  https://github.com/LibRaw/LibRaw/tree/0.22.1
- Little CMS 2.19.1, distributed under the MIT license:
  https://github.com/mm2/Little-CMS/tree/lcms2.19.1
- libraw-wasm JavaScript/C++ wrapper 1.6.0, distributed under ISC:
  https://www.npmjs.com/package/libraw-wasm/v/1.6.0
  https://github.com/ybouane/LibRaw-Wasm

The upstream build script pins LibRaw 0.22.1 and Little CMS 2.19.1 and links
them into the WebAssembly module with Emscripten. FilmLab does not modify the
LibRaw 0.22.1 source files. The FilmLab Node Worker compatibility bootstrap is
separate FilmLab code governed by FilmLab's own license.

The applicable license and copyright texts are installed beside this notice in
`resources/legal/licenses`.
