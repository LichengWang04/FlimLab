# Third-Party Notices

FilmLab Windows 安装包直接分发以下运行时与传递依赖。各组件按其自身许可证分发；对应许可证原文随安装包位于 `resources/legal/licenses`，Electron 自带的 Chromium 完整声明位于 `LICENSES.chromium.html`。

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| Electron（含 Chromium、Node.js 及其内置组件） | 43.1.0 | MIT；内置组件见随包 `LICENSES.chromium.html` | 桌面运行时 |
| React | 19.2.7 | MIT | 用户界面 |
| React DOM | 19.2.7 | MIT | 用户界面渲染 |
| Scheduler | 0.27.0 | MIT | React 传递依赖 |
| sharp | 0.35.3 | Apache-2.0 | JPEG/PNG 解码与 JPEG 编码 |
| @img/colour | 1.1.0 | MIT | sharp 传递依赖 |
| @img/sharp-win32-x64 | 0.35.3 | Apache-2.0 AND LGPL-3.0-or-later | Windows x64 原生图像运行时，捆绑 libvips 二进制 |
| libvips（含其捆绑的图像编解码组件） | 8.18.3 | LGPL-3.0-or-later；许可证原文见随包 `legal/licenses/LGPL-3.0-or-later.txt`，二进制来源与源码取得方式见随包 `legal/licenses/libvips-SOURCE-NOTICE.md` | sharp 捆绑的图像处理核心库 |
| detect-libc | 2.1.2 | Apache-2.0 | sharp 平台检测传递依赖 |
| semver | 7.8.5 | ISC | sharp 版本判断传递依赖 |
| libraw-wasm | 1.6.0 | ISC | 相机 RAW 解码的 JavaScript/Worker 封装 |
| LibRaw | 0.22.1 | CDDL-1.0（FilmLab 选择的分发条款） | `libraw-wasm` 内嵌的 CR2/NEF/RW2/ARW 解码核心 |
| Little CMS | 2.19.1 | MIT | `libraw-wasm` 内嵌的色彩转换组件 |

LibRaw 对应的准确上游源码取得方式及 WASM 构建来源记录在随包 `resources/legal/RAW-SOURCE-NOTICE.md`。FilmLab 未修改 LibRaw 0.22.1 源文件；应用侧 Node Worker 适配器为 FilmLab 自有代码。

electron-vite、Vite、TypeScript、electron-builder 及类型声明只参与构建，不作为应用运行时代码分发；其许可证仍保留在源码依赖树与锁文件中。
