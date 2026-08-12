# FilmLab

FilmLab 是面向个人翻拍胶片负片的 Electron 工作台。处理核心始终区分像素域，并把真实文件的解码、CPU 预览计算和权威母版导出放在独立的 Electron utility worker 中：渲染进程不会得到源文件路径；启用 WebGL2 预览时只会接收渲染所需的受控线性/Bayer 像素载荷。

```text
相机 RAW ── LibRaw sidecar ── camera-linear RGB ──┐
                                                    ├─ 片基密度反转 ─ 色彩变换 ─ 亮度域调色 ─ TIFF / JPEG / HEIF / DNG
16-bit TIFF ─────────────── transmission-linear RGB ─┘
```

## 当前可用能力

- RAW 解码协议：原生 `filmlab-raw-worker` 使用 LibRaw `unpack()`、每 CFA 黑电平扣除、白位归一化与固定 Bayer 线性去马赛克，输出 RGB16LE 相机线性缓存；不会读取内嵌 JPEG/缩略图，也不会调用 LibRaw 的渲染、自动白平衡、相机矩阵、降噪或 gamma 路径。
- Sony A7R V PTC 优化：当 RAW 元数据严格匹配 `ILCE-7RM5`、ISO 100，且每通道白位减黑位大于 8191 DN（用来排除 12-bit 模式）时，使用 Photons to Photos 的 14-bit 实测参数（读出噪声 1.368 DN、2.759 e⁻/DN、PRNU 0.38%）和该文件实际归一化范围建立信号相关噪声模型。在进入对数密度前，以一西格玛不确定度正则化接近噪声底的样本，减少浓密底片区域的随机彩色斑点；对中高信号的影响趋近于零，线性透射视图和色彩矩阵不受此步骤改变。ISO 320 高转换增益、12-bit RAW 及其他 ISO 不会复用 ISO 100 参数。
- 16-bit TIFF 输入：只接收 16-bit TIFF；带 ICC 的 TIFF 会先色彩管理到 sRGB 原色并执行逆传递函数，得到线性透射率后再计算密度。无 ICC 的 TIFF 仍明确按已经线性化、完成光学校正的数据读取并给出提示；8-bit PNG/JPEG 与非 16-bit TIFF 会被拒绝。
- 三种独立模式：通用、默认 C-41 预设、色卡标定配置。标定配置明确要求 `relative-density-log10 → linear-srgb-d65`，可携带三条反特性曲线、3×3 矩阵和可选 3D LUT。
- 色卡配置导入：通过原生对话框导入、校验并保存 `filmlab.calibration-profile` JSON；配置只以安全摘要和 ID 暴露给界面。核心还支持导入 `.cube` 3D LUT 以及用至少 18 个色块做无截距的加权岭回归矩阵拟合。
- 色卡自动工作流：针对已旋正、透视校正的 6×4 ColorChecker Classic 照片，自动定位规则网格、在色块中央做 MAD 异常值剔除采样，并生成/保存可选用的矩阵标定配置；色块位置、采样和拟合都可在核心单独测试。当前自动生成的是单位特性曲线 + 色彩矩阵配置，针对特定胶卷仍应在受控拍摄条件下复核并导入完整特性曲线/LUT。
- 几何配方：项目会持久保存并在预览/导出中执行片基 ROI、90° 定向、以画面直线为水平/垂直参考的 ±15° 直尺拉直、可拖动裁切和四角透视校正。项目保存源文件尺寸、最后修改时间和完整 SHA-256 内容指纹，但不保存绝对路径；同机重启后会验证本机私有位置索引并自动重连。
- 无边框片基恢复：可在同卷任一保留未曝光边缘的帧上测量并冻结线性片基 RGB，再随完整配方复用到已经裁掉边缘的帧；若整卷都没有片基参考，可从线性透射画面的联合高透射上包络生成带置信度上限的临时估算。估算结果会冻结后再用于预览与母版，且界面持续提示它不能替代实测 Dmin。
- 修复与批处理：在线性传输域提供可复核掩膜的除尘、划痕修复、保边降噪和阈值反遮罩锐化。TIFF 批处理是顺序队列，展示已完成数量并允许取消；取消会让正在进行的原子 TIFF 写入安全完成后停止后续项目。
- 项目工作流：项目本地预设、最多 80 步处理配方撤销/重做、安全的来源身份重连及批量导出状态都已接入桌面界面；整卷统一反转可把一帧的完整配方锁定为整卷基准，并记录来源帧、支持更新或取消。源目录移动后可选择新根目录递归扫描，即使文件改名也会按尺寸与内容指纹匹配；旧项目首次按文件名重连后会自动补齐身份。
- 多格式母版：当前桌面入口统一通过 utility worker 的全分辨率 CPU 确定性管线导出。支持 16-bit Deflate TIFF、8-bit JPEG、10-bit HEIF（AV1/AVIF）和 16-bit 线性 sRGB DNG；全部写入处理 XMP，显示编码格式同时嵌入 sRGB ICC。写入先落到同目录临时文件，再原子发布。
- 输出色彩可信度：通用和默认预设始终标为“未校准”；校准模式只有在来源相机型号与解码器指纹都匹配配置时才是“设备匹配”，其余情况标为“配置未验证”。sRGB ICC 只声明交付编码，不证明上游相机颜色准确；DNG 因此仅允许设备匹配输出。
- 现代桌面工作台：可选择真实帧、导入色卡配置、预览三种视图，并对真实源文件直接导出 TIFF、JPEG、HEIF 或符合条件的 DNG 母版。

- 智能几何与 GPU 预览：直尺拉直允许沿画面中应当水平或垂直的边缘拖出参考线，并把它校正为最近的平行轴；自动裁切直接贴合检测到的成像区内边界，不额外保留片基。1080p 画布优先使用高性能 WebGL2 纹理更新，GPU 不可用时自动回退到 Canvas2D。仓库保留 GPU 条带导出接口和容器写入器，但当前桌面验收路径有意使用 CPU 全精度确定性母版，避免输出像素依赖显卡或预览分辨率统计。
- 自适应交互性能：控件变化先生成 960 边长快速预览，停止操作 180 ms 后自动细化到 1440 边长；两档线性中间结果分别缓存，避免色调调整重复执行密度反转。几何分析使用 1280 边长，最终母版仍从原始全分辨率数据计算。滑杆数值按输入事件即时更新，同一次拖动只写入一条撤销记录。

## 科学边界与当前要求

RAW sidecar 的源码已在 [`native/raw-worker`](native/raw-worker/README.md)，仓库不会提交平台二进制。开发时可设置绝对路径环境变量 `FILMLAB_RAW_SIDECAR`；发布 CI 会构建并把对应产物放入：

```text
native/raw-worker/out/win32-x64/filmlab-raw-worker.exe
native/raw-worker/out/darwin-arm64/filmlab-raw-worker
native/raw-worker/out/darwin-x64/filmlab-raw-worker
native/raw-worker/out/linux-x64/filmlab-raw-worker
```

`electron-builder` 会把这些文件打包到 `resources/raw-worker/`。若当前平台不存在 sidecar，软件会返回 `RAW_SIDECAR_UNAVAILABLE`，不会悄悄使用 JPEG 预览代替 RAW。当前原生解码器有意只支持 2×2 Bayer；X-Trans、Foveon、sRAW 等会明确拒绝。

RAW 经固定黑电平扣除、白位归一化和线性去马赛克后进入处理管线。默认片基 ROI 是左侧 8%，也应在后续 ROI 工具中确认。裁切后没有片基时，优先另拍/另选同卷未曝光片基并锁定参考；单张画面自动估算在数学上不能唯一确定真实片基与场景最低密度，只能作为待复核的起点。

Photon Transfer Curve 描述读出噪声、光子散粒噪声、转换增益和响应非均匀性，不描述传感器的光谱响应。因此 A7R V PTC 优化只提高低信噪比颜色的稳定性，不能让通用/默认预设升级为“颜色准确”；相机到线性 sRGB 的色彩含义仍必须来自设备匹配的色卡配置。Photons to Photos 也提示其实测读噪可能受黑电平裁切影响，所以该模型只在完全匹配的机型和 ISO 上启用，并保留明确提示。

校准模式会比对 RAW sidecar 的 `decoderFingerprint`（LibRaw 版本与去马赛克版本）和配置中的记录；不匹配时会保留导出能力但明确提示，不能把结果视为设备匹配的颜色还原。

导入的 TIFF 应是未进行显示风格化的负片扫描数据。带 ICC 的 Adobe RGB/sRGB 等显示编码 TIFF 会自动还原到线性光；无 ICC 文件必须已经线性化。不要把本软件导出的正像 TIFF 再作为负片输入。

## 输出格式与色彩可信度

| 格式 | 当前编码 | 色彩含义与限制 |
| --- | --- | --- |
| TIFF | 16-bit sRGB、Deflate、ICC + XMP | 可作为高位深交付文件；可信度由 XMP 单独声明 |
| JPEG | 8-bit sRGB、质量 95、4:4:4、ICC + XMP | 有损浏览/交付格式 |
| HEIF | 10-bit sRGB、AV1/AVIF、4:4:4、ICC + XMP | 当前保存为 `.avif` |
| DNG | 16-bit linear-sRGB 正像、XMP | 仅设备匹配；不是相机原始 CFA RAW |

通用和默认预设输出为 `uncalibrated`；配置缺失或相机/解码器不匹配时为 `profile-unverified`；只有相机型号与 `decoderFingerprint` 同时匹配标定配置时才是 `device-matched`。TIFF、JPEG、HEIF 中嵌入的 sRGB ICC 只说明交付编码，不会把未表征的相机 RGB 变成颜色准确的 sRGB。

## 项目目录与来源身份

项目 schema v8 以目录包保存，当前工作区布局为：

```text
projects/
└─ workspace.filmlab/
   └─ project.json       # 胶卷、逐帧修改、预设、保存时间和来源身份
```

`project.json` 不包含绝对路径，可以连同目录安全复制或归档。每个真实来源记录文件名、扩展名、字节尺寸、最后修改时间和 `sha256-full-v1` 完整内容指纹。应用安装目录之外的本机用户数据中另有 `source-locations-v1.json`，它保存最近验证过的绝对位置，只用于同机自动重连，不属于项目目录、不会暴露给渲染进程，也不会随项目分享。

启动时先以尺寸和修改时间快速验证已知位置；元数据发生变化时会重新计算 SHA-256。若文件或整级目录已移动，使用“扫描目录重连”选择新的根目录，应用会递归检查受支持的 RAW/TIFF，并以内容身份匹配。来源内容实际改变时不会静默连接为原文件，以免让已有处理配方指向错误母片。

## 处理顺序

```text
camera-linear RGB
→ RAW 黑电平扣除 / 白位归一化
→ 90° 定向 / 透视 / 直尺参考线拉直
→ 除尘 / 划痕修复 / 保边降噪 / 锐化
→ 未曝光片基 ROI / 同卷冻结参考 / 低置信度无边框估算
→ A7R V ISO 100 PTC 低信噪比正则化（仅密度输入）
→ 最终裁切与相对密度
→ 通用 / 胶片预设 / 标定配置反转
→ 场景线性正像
→ 亮度域曝光、对比度、高光压缩、饱和度
→ TIFF / JPEG / HEIF：sRGB OETF + ICC + XMP
  DNG：16-bit linear-sRGB + XMP（仅设备匹配）
```

核心使用 `Float32Array`、明确的域标签和可测试的纯函数；不会在 sRGB/JPEG 上直接减橙色，也不会用独立 RGB 曲线做显示调色。

## 运行与验证

```powershell
npm install
npm run check
npm run benchmark:preview
npm run build
npm run dev
```

`npm run dev` 会启动完整的 Electron 工作台。需要在普通浏览器中做隔离的界面验收时，访问 `http://localhost:5173/?web-demo`；该入口使用内建演示负片，不会读取本地源文件，也不替代 Electron 的真实处理链路。

`npm run check` 包含核心、项目隔离、标定配置/色卡矩阵、TIFF/ICC 和来源注册测试。`npm run dist` 使用 electron-builder 打包当前平台；发布前请按上面的路径提供对应 RAW sidecar。

仓库不提交真实相机 RAW、扫描母版或本地导出。Sony A7R V 回归素材采用外部本地保存和 SHA-256 身份清单；恢复及验证方法见 [`docs/test-data.md`](docs/test-data.md)。首次克隆后可执行 `git config core.hooksPath .githooks` 启用提交前的仓库卫生检查与完整测试。

普通应用 CI 位于 [`.github/workflows/quality.yml`](.github/workflows/quality.yml)，所有 pull request、推送到 `main` 和手动触发都会在 Ubuntu/Windows、Node.js 24 上执行 `npm ci`、`npm run check` 与 `npm run build`。它没有路径过滤；RAW sidecar 的发布工作流是独立职责，不能替代普通代码 CI。

## RAW sidecar 的可分发构建

CI 工作流 [`.github/workflows/raw-sidecar-release.yml`](.github/workflows/raw-sidecar-release.yml) 在 Windows x64、macOS x64/arm64 和 Linux x64 分别构建静态 LibRaw sidecar，并把产物直接写到 `native/raw-worker/out/<platform>-<arch>/`。每个产物都会执行 JSON Lines `ping` 验证，要求协议版本、缓存格式和 `supportedCfa: ["bayer-2x2"]` 均匹配；因此当前发布能力仍明确仅限 2×2 Bayer，未把 X-Trans、Foveon 或 sRAW 暗中列为支持。

electron-builder 在打包前后验证当前目标对应的 sidecar，最终位置固定为 `resources/raw-worker/<platform>-<arch>/`。版本标签构建会强制 Windows/macOS 代码签名，缺少证书即失败，不会产生被标记为发布版的未签名包；常规 CI 同时上传 sidecar 和安装包用于验证。签名环境变量、许可证义务和 Linux 发布签名策略见 [`native/raw-worker/README.md`](native/raw-worker/README.md)。

当前架构、色彩可信度、输出格式、项目重连和 CI 的统一验收口径见 [`docs/design.md`](docs/design.md)；测试素材策略见 [`docs/test-data.md`](docs/test-data.md)；版本变化见 [`CHANGELOG.md`](CHANGELOG.md)；开发参考、许可边界和第三方项目约束见 [`docs/references.md`](docs/references.md)。
