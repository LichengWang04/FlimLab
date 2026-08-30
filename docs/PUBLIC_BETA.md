# FilmLab 1.0.0-beta.3 公共测试说明

这是面向 Windows x64 的首个公开测试候选版，用于收集真实胶片、相机与扫描仪组合的兼容性反馈，不是稳定版。

## 未签名安装包

本测试版有意不使用 Windows 代码签名。Windows Defender SmartScreen 可能显示“未知发布者”或阻止直接运行，这是预期行为，不代表安装包已被篡改。

- 只从 FilmLab 官方 GitHub Releases 页面下载；
- 下载后用 Release 同页的 `SHA256SUMS.txt` 校验安装器；
- 哈希不一致时不要运行，并立即通过 GitHub Issues 报告；
- 不要从网盘、群聊附件或第三方镜像取得安装包。

## 已验证范围

- Windows x64 安装、启动、单帧与整卷 TIFF/JPEG 导出及卸载由发布流水线自动验证；
- JPEG、PNG，以及受支持的 8/16 位整数 strip TIFF 路径有自动化回归；
- Sony A7R V ARW 已使用 6 张私有样张验证元数据与 1600 px 真实解码；
- CR2、NEF、RW2 共用 LibRaw 解码路径，但当前没有对应真实相机样张验收记录，因此属于实验性支持；
- WebGPU 只加速交互预览，完整导出仍使用确定性的 CPU Worker。

## 已知限制

- 高像素 RAW 全尺寸导出需要较多可用物理内存；资源不足时 FilmLab 会在解码前拒绝任务并给出中文提示；
- 自动片基、中和与白平衡不等同于相机、光源、胶片或扫描仪的颜色标定；
- DNG、HEIF、多页 TIFF、tiled/浮点/YCbCr/JPEG 压缩 TIFF 不受支持；
- 本测试版不包含自动更新，请从 GitHub Releases 手动检查后续版本。

提交问题时可附上“复制诊断信息”的内容；是否提供去隐私样片完全由用户决定。
