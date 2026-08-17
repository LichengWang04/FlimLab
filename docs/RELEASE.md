# FilmLab Windows 发布手册

## 发布输入

- 发布分支必须无未提交文件，版本号与 tag 完全一致（例如 `1.0.0-beta.1`）。
- GitHub Actions secrets：`WINDOWS_CSC_LINK` 为 PFX 的 base64 或安全下载地址，`WINDOWS_CSC_KEY_PASSWORD` 为证书密码。证书须包含 Windows Code Signing EKU 且在有效期内。
- 只有 `.github/workflows/release.yml` 产出的签名 x64 NSIS 包可公开分发；工作区或 `dist:win:unsigned` 产物只能做本地结构验收。

## 可复现流程

1. 从 tag 干净 checkout，执行 `npm ci`、`npm audit --omit=dev`、`npm run check`、`npm run build`。
2. `npm run dist:win` 在打包前强制检查签名变量；electron-builder 使用 SHA-256 Authenticode 和 DigiCert RFC 3161 可信时间戳。
3. 对安装器执行签名验证；静默安装到临时目录，再验证 `FilmLab.exe` 与卸载器签名。
4. 运行安装后的 `FilmLab.exe --smoke`，完成卸载并确认进程退出。
5. 生成 `SHA256SUMS.txt` 与 `RELEASE-METADATA.json`，记录版本、tag、Git commit、UTC 构建时间、Node/Electron 版本。
6. 人工在干净 Windows 10/11 x64 虚拟机复核安装、启动、单帧和整卷 TIFF/JPEG 实际导出、覆盖升级及卸载；检查 100%–200% DPI、键盘、1100×700、多显示器、中文/空格/长路径、只读目录和空间不足提示。

## 发布与撤回

- GitHub Release 标记为 prerelease，并同时发布安装器、blockmap、SHA-256、元数据、变更说明、隐私说明和已知限制。
- 下载入口固定为 GitHub Releases，支持入口为 GitHub Issues。公测版采用手动更新，不在应用内自动下载。
- 坏版本立即把 Release 标为 draft 或删除对应资产，在 Release 顶部公告受影响版本和规避方式；保留上一已验证安装包与哈希作为回退版本。修复版本必须使用新版本号和新 tag，禁止移动或重写已发布 tag。

## 外部验收记录

每次发布在 Release 说明附上 Windows 10/11 机器、安装/升级/卸载、四种实际导出、签名状态与验收人。真实底片跨设备色彩基准在公测后建设，不是 `1.0.0-beta.1` 放行项。
