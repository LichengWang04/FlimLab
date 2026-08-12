# FilmLab 设计说明

本文描述当前代码所实现的边界和验收口径。若 README、界面文案或历史方案与本文冲突，应以可测试的代码契约和本文列出的限制为准。

## 1. 设计目标与非目标

FilmLab 面向个人翻拍胶片负片，核心目标是：保留线性处理域、让预览和母版使用同一套配方、隔离真实文件路径与权威 CPU 母版栅格、保存可长期核验的来源身份，并明确区分“可浏览的 sRGB 编码”与“设备匹配的颜色结果”。

当前不承诺：

- 通用或默认胶片预设具有相机颜色准确性；
- PTC 噪声模型可以替代相机光谱响应或色卡矩阵；
- X-Trans、Foveon、sRAW 或任意非 2×2 Bayer RAW 可解码；
- DNG 是原始传感器马赛克的再封装；当前 DNG 是处理后的 16-bit 线性 sRGB 正像；
- GPU 预览与不同显卡上的母版像素逐位一致；当前母版因此走 CPU 确定性路径。

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

渲染进程不接收源文件绝对路径，也不持有 CPU 权威母版的全分辨率输出栅格。GPU 交互预览会把受控的 decoder-linear RGB 或 Bayer 载荷交给渲染器并缓存在 WebGL 纹理中；载荷可能保持解码分辨率，但不包含路径或文件读取能力，也不作为当前最终母版来源。

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
→ 通用 / 默认预设 / 标定配置反转
→ linear-srgb-d65 正像
→ 亮度域曝光、对比度、高光压缩、饱和度
→ display-linear
→ 交付编码与容器
```

16-bit TIFF 输入分为两类：带 ICC 的显示编码 TIFF 先色彩管理到 sRGB 原色并逆 OETF；无 ICC TIFF 必须由用户保证已经线性化和完成光学校正。8-bit 图像和非 16-bit TIFF 不进入负片处理链。

## 4. RAW 与 Sony A7R V PTC

RAW sidecar 只调用 LibRaw `unpack()` 获取传感器数据，并执行 FilmLab 自己的固定 2×2 Bayer 线性去马赛克。它不读取内嵌 JPEG，不使用 LibRaw 自动白平衡、相机色彩矩阵、降噪、gamma 或显示渲染路径。解码器版本和去马赛克版本共同形成 `decoderFingerprint`，供标定可信度核验。

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
| 通用模式 | `uncalibrated` | 可浏览、可编辑的未设备表征输出 | 禁止 |
| 默认 C-41 预设 | `uncalibrated` | 预设外观，不是颜色准确还原 | 禁止 |
| 标定配置缺失或相机/解码器不匹配 | `profile-unverified` | 使用了配置，但不能声称设备匹配 | 禁止 |
| 相机型号与 `decoderFingerprint` 均匹配 | `device-matched` | 设备匹配的 `linear-srgb-d65` 结果 | 允许 |

TIFF、JPEG 和 HEIF 可以在三种可信度下导出，因为其 ICC 只声明接收端应如何解释编码值。所有母版都在 XMP 中写入可信度、原因、来源/标定相机和 `colorAccuracyClaim`。只有 `device-matched` 使用 `device-matched-linear-srgb-d65`，其他状态统一写为 `not-device-characterized`。

## 6. 预览与母版导出

当前桌面入口的职责划分如下：

- WebGL2 负责交互预览；不可用时回退 Canvas2D。
- utility worker 的 CPU 全分辨率管线是当前权威母版路径。它重新计算片基、白点和配方，不复用预览分辨率统计。
- GPU 条带导出 IPC 和容器写入器已经实现，供受控实验或后续优化使用；它们不是当前界面的默认验收路径。
- TIFF/DNG 写入器支持连续条带；JPEG/HEIF 先把条带暂存为原始样本，再由 Sharp 完成编码，因此不应描述为全程恒定内存流式编码。

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
- 任何“GPU 导出”表述都必须区分已存在的条带接口与当前桌面默认 CPU 母版路径。
- 任何“项目可归档”表述都不得暗示项目包含有绝对路径；本机位置索引是私有、可重建状态。
- 新增输入格式、输出格式、相机模型或 CI 触发条件时，应同时更新本文件、README 和对应测试。
