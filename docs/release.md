# FilmLab 发行与安装契约

FilmLab 只交付各宿主平台的原生包：Windows x64 NSIS、macOS x64/arm64 DMG 和 Linux x64 AppImage。`win-unpacked/` 等构建目录只是验证中间产物，不属于发行包。

## 本机构建与验证

当前平台 RAW worker 必须已存在于 `native/raw-worker/out/<platform>-<arch>/`，随后运行：

```powershell
npm ci
npm run verify:raw-sidecar
npm run check
npm run dist:win
```

macOS 使用 `dist:mac`，Linux 使用 `dist:linux`。dist 命令从 `build/icon.svg` 生成 PNG/ICO/ICNS，构建 Electron，再调用 electron-builder。打包前后钩子会在 sidecar 缺失、为空或没有复制到 `resources/raw-worker/<platform>-<arch>/` 时失败。

不使用私有 RAW 的安装验证命令为：

```powershell
npm run verify:installed-release -- --package release/FilmLab-0.1.0-win-x64.exe
```

它会安装或展开包，从发行应用启动隐藏 renderer，探测已安装 sidecar，并把它与已验证构建输入逐字节比较，报告写入 `artifacts/installed-release.json`。Windows 会向同一目录安装同一版本两次以验证原位升级身份，然后运行卸载程序；卸载默认保留项目与用户设置。

若提供私有 A7R V 素材挂载，再加入 `--fixture-root <directory>`。验证器会通过已安装可执行文件执行真实 ARW 导入、项目重启与重连、TIFF 导出、GPU/CPU renderer 检查和一轮稳定性测试，而非调用开发态 Electron。

## CI、签名与发布

`.github/workflows/raw-sidecar-release.yml` 在干净的 Windows x64、macOS Intel、macOS Apple Silicon 和 Linux x64 托管 runner 上构建；每个平台都必须安装或展开并启动产物。`v*` 标签还必须提供：

- Windows：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。安装器、主程序和已打包 RAW worker 的 Authenticode 状态都必须为 Valid。
- macOS：`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD` 用于 Developer ID；`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 用于 notarization。

缺少密钥或签名验证失败会中止标签构建。矩阵全部通过后，工作流才发布 NSIS、两种架构 DMG、AppImage、更新元数据和 `SHA256SUMS` 到 GitHub Release。非标签 CI 产物明确只是未签名验证包，不能称为正式发行版。

`.github/workflows/a7rv-acceptance.yml` 是私有素材发行门禁。Windows/macOS 自托管 runner 先验证开发构建，再生成原生包、安装它，并通过安装后的程序重复真实 A7R V 冒烟。只有对应平台报告通过才能声明该平台受支持；Windows 结果不能推定 macOS 兼容。

## 元数据与生命周期

- 稳定应用身份：`com.filmlab.desktop`。
- 产品与可执行文件：`FilmLab`；包版本和文件版本来自 `package.json`。
- 作者/公司元数据：Licheng Wang；Windows 可信发布者取 Authenticode 证书主体。
- Windows：每用户辅助安装，可修改目录，创建开始菜单/桌面快捷方式，原位升级，卸载保留设置。
- macOS：Photography 分类，最低 macOS 13，hardened runtime，DMG 内提供 Applications 链接。
- Linux：Graphics 分类 AppImage。AppImage 是便携包，因此安装验证定义为展开不可变文件系统并启动 `AppRun`。

项目当前标记为 `UNLICENSED`；发布安装器不会自动授予源代码或捆绑第三方组件的再分发权。发布维护者必须持续满足 `native/raw-worker/README.md` 中的 LibRaw 及第三方声明义务。
