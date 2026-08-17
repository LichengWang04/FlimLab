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
| @img/sharp-win32-x64（含 libvips 及其图像编解码组件） | 0.35.3 | Apache-2.0 AND LGPL-3.0-or-later；捆绑组件声明见包内许可证 | Windows x64 原生图像运行时 |
| detect-libc | 2.1.2 | Apache-2.0 | sharp 平台检测传递依赖 |
| semver | 7.8.5 | ISC | sharp 版本判断传递依赖 |

electron-vite、Vite、TypeScript、electron-builder 及类型声明只参与构建，不作为应用运行时代码分发；其许可证仍保留在源码依赖树与锁文件中。
