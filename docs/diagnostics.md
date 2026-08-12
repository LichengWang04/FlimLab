# 故障诊断与安全取证

## 先保护原件

不要直接在唯一一份 `.filmlab` 项目、相机卡或母版上反复试验。复制项目目录，保留源照片只读备份，并记录 FilmLab 版本、提交、安装包 SHA-256、操作系统/架构、GPU/驱动、相机型号、RAW 格式和失败步骤。磁盘空间不足、断电残留和项目损坏应先复制现场，再使用应用内只读恢复。

## 本地状态位置

- Windows：通常为 `%APPDATA%\FilmLab`，缓存位于 Electron 的本地缓存目录。
- macOS：通常为 `~/Library/Application Support/FilmLab`。
- Linux：通常为 `~/.config/FilmLab`。
- 项目内容位于用户选择的 `<name>.filmlab/` 目录；源照片仍在原目录。

`project-sessions-v1.json`、`source-locations-v1.json`、控制台错误和系统崩溃转储都可能包含绝对路径、用户名或卷名。校准快照可能属于设备/工作室资产。发送前必须人工检查和脱敏。

## 最小诊断流程

1. 核对安装包签名、版本和 `SHA256SUMS`，不要把未签名 CI 包当成正式版。
2. 在项目副本上重现；记录是否可只读打开、是否能从项目备份恢复、是否只影响特定源或导出格式。
3. 运行 `npm run check`、`npm run audit:dependencies` 和 `npm run verify:raw-sidecar`（开发环境）。发行验收使用 `npm run verify:installed-release -- --package <包路径>`。
4. 仅收集最小错误文本和 JSON 验收报告。默认不要收集 RAW、TIFF/JPEG/HEIF/DNG、`.filmlab`、预览缓存或整个用户数据目录。
5. 若必须提供触发文件，先确认私密渠道、保留期限和删除方式；优先构造无个人内容的合成样例。

FilmLab 当前不会自动创建或上传诊断包。控制台重定向应由用户显式启用，完成后检查其中的路径和元数据。公开问题不得包含签名证书、密码、Apple API key、私有 fixture 哈希之外的内容或能恢复照片的信息。
