# FilmLab 设计说明

本文描述当前代码所实现的边界和验收口径。若 README、界面文案或历史方案与本文冲突，应以可测试的代码契约和本文列出的限制为准。

## 1. 设计目标与非目标

FilmLab 面向个人翻拍胶片负片，核心目标是：保留线性处理域、让预览与 GPU/CPU 母版使用同一套配方、隔离真实文件路径和写盘权限、保存可长期核验的来源身份，并明确区分“可浏览的 sRGB 编码”与“设备匹配的颜色结果”。

当前不承诺：

- 默认模式具有相机颜色准确性；
- PTC 噪声模型可以替代相机光谱响应或色卡矩阵；
- X-Trans、Foveon、sRAW 或任意非 2×2 Bayer RAW 可解码；
- DNG 是原始传感器马赛克的再封装；当前 DNG 是处理后的 16-bit 线性 sRGB 正像；
- 不同显卡上的 GPU 母版像素逐位一致；正式路径允许浮点实现差异，并保留同配方 CPU 回退。

## 2. 进程与数据边界

```text
Renderer
  ├─ 持有 assetId、项目配方、安全摘要和预览数据
  ├─ WebGL2 模式可持有受控的线性 RGB / Bayer 像素载荷
  └─ 通过受校验 IPC 请求操作
          │
          ▼
Electron main
  ├─ SourceRegistry：assetId ↔ 本机绝对路径
  ├─ ProjectLifecycleService：活动/最近会话、只读、迁移、恢复与备份
  ├─ ProjectService：单个目录项目的 schema 校验与原子写入
  └─ 原子文件发布、原生对话框、导出会话
          │
          ▼
Utility worker ── RAW sidecar / TIFF codec
  ├─ 解码真实源文件
  ├─ 计算预览与全分辨率母版
  └─ 返回缩小结果或写入目标文件
```

渲染进程不接收源文件绝对路径。GPU 预览与母版会把受控的 decoder-linear RGB 或 Bayer 载荷交给渲染器并缓存在 WebGL 纹理中；母版按 256 像素高的条带读回，不在 renderer 组装完整输出栅格。载荷不包含路径或文件读取能力，写盘与原子发布仍由 main/utility 边界完成。

## 3. 像素域与处理顺序

每个核心缓冲区都应有明确的域语义，禁止把显示编码值当作线性光参与片基扣除或密度计算。

```text
RAW CFA
→ 每 CFA 黑电平扣除 / 白位归一化 / 线性去马赛克
→ camera-linear RGB
→ 几何与线性域修复
→ 片基参考
→ A7R V PTC 低信噪比正则化（严格匹配时，仅用于密度输入）
→ relative-density-log10
→ 默认模式按片基 + 中性高密度锚点做保守逐通道 H&D 归一化 / 标定配置反转
→ linear-srgb-d65 正像
→ 亮度域曝光、对数域对比度（锚定 0.18 中灰）、高光压缩、饱和度
→ display-linear
→ 交付编码与容器
```

反转阶段的域规则：色卡标定配置保持绝对密度域，因为该域就是设备匹配声明本身。曲线端点按末段对数斜率外推，不做硬钳制。串扰矩阵产生的负值在反转阶段钳零；校准模式的白平衡作用于 3D LUT 之前。调色阶段的色域保护（超出显示上限的通道等比压缩、负值归零）始终生效，与高光压缩开关无关。CPU 与 WebGL2 路径共享同一组公式（GPU 以 log2/exp2 实现等价的对数外推）。

默认模式在显式 Dmax ROI 下记录 R/G/B 独立密度范围，使用户选定的中性高密度区域在反转后落到同一归一化密度；标准模式默认不从场景内容推断该范围，只有用户在高级设置显式打开自动中和后，才对足够低色度的高密度尾部运行启发式，彩色主体不会在默认设置下被强行当作灰卡。该范围可作为整卷参考保存，但仍属于未标定的技术起点，不提升 `uncalibrated` 的颜色可信度。预饱和在密度域围绕三通道均值调整色度，默认 1.08，并由 CPU 与 WebGL2 共享同一公式。

修复阶段的 CPU/GPU 一致口径：除尘判定两侧都使用「8 邻域中位数 × 1.4826」的稳健 MAD 尺度（GPU 以 19 比较器排序网络求中位数）；但修复内核仍是已知近似——GPU 用邻域均值替换缺陷像素，CPU 用距离加权中位数修复，且 GPU 划痕判定不做 CPU 的连续段长度过滤（GPU 预览可能修复 CPU 会保留的短痕）。两边输出都受同一 `uncalibrated`/`profile-unverified`/`device-matched` 可信度口径约束，a7rv 验收以母版与回退路径的格式/位深/ICC/XMP/DNG 标签一致性为准。

来源身份与全分辨率负载：机器私有 `source-locations-v1.json` 除完整 SHA-256 外还保存首/尾 64 KiB 的探针哈希；mtime 与尺寸同时匹配时先验探针，失配才做全量重哈希，因此替换内容并保留 mtime 的文件不能再冒充原母片。GPU 母版的全分辨率源像素在首传后按 `sourceKey` 缓存在渲染进程（LRU 2 条），重复导出只重新计算分析元数据；首传仍是一次完整的跨进程结构化克隆——Electron 的 IPC 传输列表只暴露 `MessagePort`，不支持 `ArrayBuffer`/`TypedArray` 直接转移，这是当前交付层已知的拷贝边界。

16-bit TIFF 输入分为两类：带 ICC 的显示编码 TIFF 先色彩管理到 sRGB 原色并逆 OETF；无 ICC TIFF 必须由用户保证已经线性化和完成光学校正。scRGB 转换可能为超色域颜色产生负分量，输入时一律钳零，避免对数密度阶段被顶到 6.0 D 形成亮斑。8-bit 图像和非 16-bit TIFF 不进入负片处理链。

## 4. RAW 与 Sony A7R V PTC

RAW sidecar 只调用 LibRaw `unpack()` 获取传感器数据，并执行 FilmLab 自己版本化的 2×2 Bayer 去马赛克。默认 `edge-aware-bayer-v2` 以水平/垂直梯度和二阶校正估计绿色，再以内插色差恢复红蓝；GPU 的 `gpu-edge-aware-bayer-v2` 接收单通道 Bayer 后执行同一算法语义。旧双线性模式只作为显式兼容选项。它不读取内嵌 JPEG，不使用 LibRaw 自动白平衡、相机色彩矩阵、降噪、gamma 或显示渲染路径。LibRaw 版本与算法版本共同形成 `decoderFingerprint`；从 v1 升级到 v2 会使旧配置降为 `profile-unverified`，必须重新标定而不能默认为等价。

A7R V PTC 模型只在以下条件全部满足时启用：

- 相机型号为 `ILCE-7RM5`；
- 拍摄 ISO 为 100；
- 每个通道的白位减黑位大于 8191 DN 且不超过 65535 DN；下限用于排除 12-bit 模式，模型本身仍采用 14-bit 测量参数。

模型使用 Photons to Photos 的 1.368 DN 读出噪声、2.759 e⁻/DN 转换增益和 0.38% PRNU，并结合每个文件的白位减黑位范围。在取对数前对噪声底附近样本做一西格玛正则化，以减少浓密负片区域的随机彩色斑点。它不会修改线性透射视图、相机色彩矩阵或中高信号；ISO 320、12-bit RAW 和其他 ISO 不复用 ISO 100 参数。

PTC 描述噪声统计而非光谱响应，所以它只能改善低信号显示稳定性，不能提升颜色可信度等级。

## 5. 输出色彩可信度

色彩可信度描述上游颜色含义，ICC 描述交付编码，两者必须分开。

| 模式/状态 | 可信度 | 可声称内容 | DNG |
| --- | --- | --- | --- |
| 默认模式 | `uncalibrated` | 可浏览、可编辑的未设备表征输出 | 禁止 |
| 标定配置缺失或相机/解码器不匹配 | `profile-unverified` | 使用了配置，但不能声称设备匹配 | 禁止 |
| 相机、解码器及完整拍摄上下文均匹配 | `device-matched` | 设备匹配的 `linear-srgb-d65` 结果 | 允许 |

TIFF、JPEG 和 HEIF 可以在两种模式的可信度状态下导出，因为其 ICC 只声明接收端应如何解释编码值。设备匹配不仅要求相机型号与 `decoderFingerprint` 一致，还要求镜头、胶片、冲洗工艺和光源等配置上下文一致；缺失上下文时不能宣称设备匹配。所有母版都在 XMP 中写入可信度、原因、来源/标定相机和 `colorAccuracyClaim`。只有 `device-matched` 使用 `device-matched-linear-srgb-d65`，其他状态统一写为 `not-device-characterized`。

## 6. 预览与母版导出

当前桌面入口的职责划分如下：

- WebGL2 负责交互预览；不可用时回退 Canvas2D。
- 母版优先重新请求全分辨率 GPU 源，按输出几何进行 256 行分块渲染和有序读回；main 在开始会话前重新核验来源、配置与色彩可信度，renderer 不能自行授予 DNG 权限。
- GPU 会话建立失败时直接请求 CPU 导出；建立后任一渲染、读回或容器写入失败会取消临时写入，并以保存的同一配方、目标和可信度重新执行 utility CPU 全精度路径。
- GPU 结果是正式交付路径但不是跨 GPU 的逐位确定性参考。容器标签、尺寸、可信度与误差上限必须验收；需要逐位回归时使用 CPU 路径。
- TIFF/DNG 写入器支持连续条带；JPEG/HEIF 先把条带暂存为原始样本，再由 Sharp 完成编码，因此不应描述为全程恒定内存流式编码。

单帧与批量入口支持同一组 TIFF、JPEG、HEIF、DNG 格式。批量任务顺序执行，逐帧携带自己的模式、处理配方、Dmax 和校准快照；完成后释放全分辨率资源。DNG 仍逐帧要求 `device-matched`，不能因同一批次里其他帧匹配而放宽。

| 格式 | 像素编码 | 元数据 | 使用限制 |
| --- | --- | --- | --- |
| TIFF | 16-bit sRGB，Deflate | sRGB ICC + XMP | 所有可信度；ICC 不代表设备准确 |
| JPEG | 8-bit sRGB，质量 95，4:4:4，渐进 | sRGB ICC + XMP | 有损交付格式 |
| HEIF | AV1/AVIF，10-bit sRGB，4:4:4 | sRGB ICC + XMP | 当前文件扩展名为 `.avif` |
| DNG | 16-bit linear-sRGB 正像 | DNG 标签 + XMP | 仅 `device-matched`；不是原始 CFA RAW |

所有导出先写入目标目录的临时文件，成功后原子改名；失败或取消时清理临时文件。

## 7. 项目目录、来源身份与长期重连

当前 schema 为 v8。应用可以新建、打开、只读打开、另存和从最近列表恢复任意 `.filmlab` 目录；首次启动的兼容默认目录为 `<userData>/projects/workspace.filmlab/`。项目包为：

```text
<name>.filmlab/
├─ project.json
├─ calibration-profiles/<profile-id>.json
└─ backups/<kind>-<timestamp>-<uuid>/
   ├─ project.json
   ├─ backup.json
   └─ calibration-profiles/    # 可选
```

`project.json` 是可复制的项目内容，保存胶卷、帧、配方、预设、时间戳和来源身份，不保存绝对路径。每个来源身份包括：

- 原文件名与扩展名；
- 字节尺寸；
- 最后修改时间；
- 算法标识 `sha256-full-v1`；
- 完整文件 SHA-256。

本机最近源位置单独保存在 `<userData>/source-locations-v1.json`；活动项目与最近项目目录保存在 `<userData>/project-sessions-v1.json`。两个索引都含绝对路径，只用于同机自动恢复，不属于项目包、不随项目分享，也不暴露给渲染进程；渲染进程只获得路径 SHA-256 形成的会话 ID。项目目录与本机索引的拆分同时满足长期身份核验和隐私边界。

重连顺序为：

1. 启动时查找同一 assetId 的本机位置记录。
2. 尺寸和修改时间未变时快速接受；发生变化则重新计算完整 SHA-256。
3. 已知位置无效时保持离线，不把同名文件静默视为同一来源。
4. 用户选择“扫描目录重连”后，递归枚举受支持 RAW/TIFF；先按尺寸筛选，再以内容指纹确认，因此目录移动或文件改名仍可恢复。
5. v1–v7 旧项目允许首次按文件名人工重连，成功后立即补齐 v8 来源身份。

如果来源内容发生实际变化，应视为新来源。当前不会把已修改文件自动替换进旧配方，以避免历史处理无提示地指向不同母片。

项目引用的标定配置不只保存 `calibrationProfileId`：每次保存还会把经过校验的完整配置快照写入 `calibration-profiles/`，并删除已经不再引用的快照。换机打开时快照会再次经过 schema 校验后导入本机配置库；缺失被引用配置时拒绝写入，避免产生不可移植项目。

保存与恢复遵守以下状态规则：

1. 正常保存前创建自动备份，保留最近 10 份；手动备份保留最近 20 份。
2. v1–v7 项目只迁移到内存并以只读会话打开；确认迁移时先备份原文件，再原子写入 v8。
3. 主文件损坏时从最新可解析备份恢复为只读会话；确认恢复前不覆盖损坏文件。
4. 显式只读打开允许内存编辑和另存为，但禁止原目录自动保存。
5. 项目会话切换后，旧会话 ID 的延迟保存请求会被主进程拒绝，避免串写到新项目。
6. 切换项目和退出应用前，渲染进程取消 550 ms 防抖、等待已有保存队列，再提交包含当前帧尚未经过 160 ms 同步防抖的最新配方；主窗口收到确认后才关闭，渲染进程失联则在 8 秒安全超时后退出。

## 8. CI 与发布边界

普通代码质量工作流 [`.github/workflows/quality.yml`](../.github/workflows/quality.yml) 在以下事件触发：

- 所有 pull request；
- 推送到 `main`；
- 手动触发。

它在 Ubuntu 和 Windows、Node.js 24 上执行 `npm ci`、`npm run check` 和 `npm run build`，没有 `paths` 过滤，因此普通 `src/**`、`test/**` 和构建配置修改都会进入验证。

RAW sidecar 发布工作流 [`.github/workflows/raw-sidecar-release.yml`](../.github/workflows/raw-sidecar-release.yml) 负责各平台 LibRaw 构建、协议探测、打包与签名约束。该工作流可以保留针对原生源、锁文件和工作流本身的路径过滤；它不替代普通代码 CI。

真实 A7R V 验收工作流 [`.github/workflows/a7rv-acceptance.yml`](../.github/workflows/a7rv-acceptance.yml) 使用带授权私有素材挂载的自托管 Windows x64、macOS x64 和 macOS arm64 GPU 机器。生产构建通过环境指定的验收 spec 进入隐藏 Electron 模式，仍使用正式 `ProcessingService → utility process → image-worker → LibRaw sidecar`，不提供 Sharp/TIFF 替代解码。其验收顺序为：

1. 验证 ARW 尺寸和 SHA-256，再解码 1440 边预览并严格核验 A7R V、ISO 100 PTC 和 decoder fingerprint。
2. 保存含来源身份、逐帧配方和校准快照的目录项目；第二个 Electron 进程使用空白机器私有状态打开复制项目。
3. 确认旧绝对路径不会跨机泄漏、同尺寸篡改文件被拒绝、移动且改名的原内容能以 SHA-256 重连。
4. 主动终止 utility process，要求下一请求重新创建并成功解码；导出临时文件带 PID，重试同一目标时清理已死亡进程残留。ENOSPC 注入必须不发布目标且不留下 `.tmp/.raw`。
5. 从真实 ARW 全尺寸重新计算并导出 TIFF、JPEG、10-bit HEIF 和线性 DNG；独立解析尺寸、位深、ICC/XMP、LinearRaw 与 DNG 必需标签，再由 Sharp/libvips、ExifTool、ImageMagick及可用的系统 ImageIO 重开。
6. 隐藏 renderer 分别记录正常 GPU 的 WebGL2 backend 和 `--disable-gpu` 的 Canvas2D backend。每台机器必须报告实际后端，不能把 API 存在视为 GPU 通过。
7. 六个真实 ARW 默认运行 10 轮共 60 次预览/释放，记录每轮时间、当前 RSS、观测峰值和首末漂移。批处理每完成一帧显式释放 utility raster，使内存规模由单帧峰值而非照片总数决定。

DNG 容器验收使用动态匹配当前相机/decoder 的“验收专用单位变换”以通过设备身份门槛，其配置名称、拟合算法和 warning 都明确声明它不是色彩校准。该输出只能验证设备身份判定、容器、标签和软件解码兼容性，不能作为 A7R V 色彩准确性样张；颜色验收仍必须使用受控色卡拟合配置和独立参考值。

性能门槛位于 [`test-data/a7rv-acceptance-baseline.json`](../test-data/a7rv-acceptance-baseline.json)。Windows x64 的已有报告不能替代 macOS Intel/Apple Silicon 运行；跨平台能力只有对应自托管任务产生通过报告后才成立。

## 9. 文档验收规则

- 任何“颜色准确”“sRGB 母版”表述都必须同时说明可信度等级；未校准输出只能称为 sRGB 编码的可浏览/交付结果。
- 任何“GPU 导出”表述都必须同时说明正式 GPU 优先路径、CPU 回退和不保证跨显卡逐位一致。
- 任何“项目可归档”表述都不得暗示项目包含有绝对路径；本机位置索引是私有、可重建状态。
- 新增输入格式、输出格式、相机模型或 CI 触发条件时，应同时更新本文件、README 和对应测试。

## 10. 可安装发行物

`win-unpacked/`、`.app` 构建目录和 AppImage 展开目录都只是中间状态，不构成发行物。可交付对象严格限定为 Windows x64 NSIS、macOS x64/arm64 DMG + 自动更新 ZIP 与 Linux x64 AppImage。它们共享稳定的 `com.filmlab.desktop` 身份和 `package.json` 版本，sidecar 固定置于 `resources/raw-worker/<platform>-<arch>/`。

干净构建必须完成三层验证：打包前 sidecar 协议探测；打包后资源存在性与字节身份验证；安装/挂载/展开后从发行可执行文件启动隐藏 renderer 并再次探测 sidecar。带私有素材的 Windows/macOS runner 还必须通过安装后的应用重复真实 A7R V ARW 导入、跨进程项目恢复/重连、TIFF 母版导出及 GPU/CPU 回退，开发态 Electron 的通过结果不能替代它。

普通分支和 pull request 产生的包是未签名验证构建。`v*` 标签才是正式发行边界：Windows 安装器、主程序和 sidecar 必须通过 Authenticode；macOS `.app` 与 sidecar 必须通过 Developer ID 严格验证、Gatekeeper 评估及 stapled notarization ticket；任一密钥缺失或验证失败都中止。矩阵全部通过后才生成 `SHA256SUMS` 并发布 GitHub Release。平台命令和升级/卸载策略见 [`release.md`](release.md)。

## 11. 隐私、安全与供应链边界

生产 renderer 的 CSP 以 `default-src 'none'` 为基线并设置 `connect-src 'none'`，应用没有遥测或崩溃上传。发行更新只由 main 进程的 `electron-updater` 读取 GitHub Release 更新清单，renderer 只能通过窄 IPC 检查状态、确认安装或请求已知良好回滚。下载完成不会静默重启；安装前刷新项目保存队列。Windows 仅在上一稳定 NSIS 已缓存时提供回滚，新版本连续两次未显示主窗口时触发静默恢复；macOS/Linux 不尝试危险的应用目录改写，而明确要求从发行页重装。Vite 开发模式只对 localhost/127.0.0.1 的 HTTP/WebSocket 放行热更新。Electron 继续禁止 Node integration、权限请求、外部窗口与导航。

## 12. 校准生命周期、键盘与无障碍

机内校准库以 ID 为身份、`version` 为不可变内容边界。导入相同 ID 的新版本前先归档当前 JSON；相同 ID/version 但内容不同必须拒绝。导出只产生已重新序列化的有效文档，恢复历史版本会先归档当前版本，删除同时移除当前文件和历史目录。项目引用仍保存独立快照，因此删除机内配置不会改写已有项目。

所有核心操作必须可通过键盘完成：Ctrl/⌘+O 导入、Ctrl/⌘+Shift+O 打开项目、Ctrl/⌘+S 立即保存、Ctrl/⌘+E 单帧导出、Ctrl/⌘+Shift+E 批量导出、Ctrl/⌘+Z/Y 撤销/重做、Alt+左右切帧、F1 帮助。文本输入控件不截获编辑快捷键。界面提供跳转主内容链接、可见焦点、状态 live region、语义化 modal，以及 `prefers-reduced-motion` 降低动画；完整用户操作见 [`user-manual.md`](user-manual.md)。

FilmLab 原创内容使用根 `LICENSE` 的专有保留权利条款；npm 包保持 `private`/`UNLICENSED`。静态 LibRaw 0.22.1 分发明确选择 CDDL-1.0，并随包提供原文、版权、精确源码 archive SHA-512、vcpkg baseline 与构建配方。平台实际安装的 npm 许可证、原生组件清单和 CycloneDX SBOM 一并写入 `resources/legal/`，缺失时 `afterPack` 必须失败。

安全工作流每次 push/PR 及每周运行 high/critical npm audit 并生成 SBOM；公开仓库或已启用 GitHub Code Security 的私有仓库运行 Dependency Review 与 CodeQL `security-extended`（JavaScript/TypeScript、C++）。隐私、报告、支持、诊断和迁移口径分别以根 `PRIVACY.md`、`SECURITY.md`、`SUPPORT.md`、[`diagnostics.md`](diagnostics.md) 和 [`migration.md`](migration.md) 为准。
