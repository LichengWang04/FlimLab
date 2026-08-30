# FilmLab Windows 公共测试版发布手册

## 发布输入

- 发布分支必须无未提交文件，`package.json` 版本号与不可移动的 tag 完全一致（例如 `1.0.0-beta.3`）。
- 公共测试版有意不使用 Windows 代码签名；不得配置 `CSC_LINK`、签名密码或把 `NotSigned` 描述成已验证发布者。
- 只有 `.github/workflows/release.yml` 从干净 tag 产出的 Windows x64 NSIS 包可以作为官方公共测试版分发。下载入口固定为 FilmLab 官方 GitHub Releases，安装器必须与同页 `SHA256SUMS.txt` 匹配。
- 私有 RAW 和 Negadoctor 样张只用于本地验收，不进入 Git、Actions artifact 或 GitHub Release。

## 可复现流程

1. 从 tag 干净 checkout，执行 `npm ci`、`npm run audit:release`、`npm run check`、`npm run build`。发布审计会输出锁定的 Electron 版本；生产依赖漏洞或 Electron high/critical 公告会阻断发布，其他仅开发依赖告警记为 CI warning；审计服务不可用或 JSON 无法解析时按失败处理。
2. 设置 `FILMLAB_RAW_FIXTURES`，用 4–6 张真实相机 RAW 执行 `npm run prepare:negadoctor-fixtures`。该步骤会验证元数据与 1600 px 解码，并在私有目录生成缩小的 16 位线性 Rec.2020 TIFF；原片、生成物和绝对路径均不得提交。
3. 设置 `DARKTABLE_CLI`（必须报告 5.6.0）和 `FILMLAB_NEGADOCTOR_FIXTURES`，执行 `npm run acceptance:negadoctor`。验收使用独立配置/数据库、关闭 OpenCL，并保存逐图指标和差分缩略图。
4. 执行 `npm run dist:win` 生成未签名安装器。确认安装器、安装后的 `FilmLab.exe` 与卸载器均为 `NotSigned`；任何意外签名状态都阻断当前流水线，避免发布说明与实际文件不一致。
5. 静默安装到临时目录，运行 `FilmLab.exe --smoke` 和安装后的导出 smoke，完成卸载并确认进程退出。
6. 只为确切的安装器生成 `SHA256SUMS.txt`；生成 `RELEASE-METADATA.json`，记录版本、tag、Git commit、UTC 构建时间、Node/Electron 版本、`public-beta` 渠道和 `NotSigned` 状态。
7. 人工在干净 Windows 10/11 x64 虚拟机复核 SmartScreen 提示、安装、启动、单帧和整卷 TIFF/JPEG 实际导出、覆盖升级及卸载；检查 100%–200% DPI、键盘、1100×700、多显示器、中文/空格/长路径、只读目录和空间不足提示。

## 发布与撤回

- GitHub Release 标记为 prerelease，只发布确切安装器、SHA-256、构建元数据、变更说明、隐私说明、公共测试说明和不含私有路径的验收记录。禁止用 `release/*.yml` 或宽泛通配符上传 electron-builder 调试配置。
- Release 标题和说明必须显著标注“公共测试版（未签名）”，解释 SmartScreen 的“未知发布者”提示，并要求用户核对 SHA-256。
- 公测版采用手动更新，不在应用内自动下载。
- 坏版本立即把 Release 标为 draft 或删除对应资产，在 Release 顶部公告受影响版本和规避方式；保留上一已验证安装包与哈希作为回退版本。修复版本必须使用新版本号和新 tag，禁止移动或重写已发布 tag。

## 外部验收记录

每次发布在 Release 说明附上 Windows 10/11 机器、安装/升级/卸载、实际导出、`NotSigned` 状态、RAW 实测边界与 Negadoctor 逐图全局 SSIM（global SSIM，非窗口化实现）/ΔE00 指标。Negadoctor 样张门槛为非裁切、非剪裁像素亮度全局 SSIM ≥ 0.98、中位 ΔE00 ≤ 2、P95 ΔE00 ≤ 5；未配置私有样张时脚本只完成版本预检并明确标记跳过，不能作为兼容验收通过记录。
