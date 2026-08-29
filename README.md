# FilmLab

FilmLab 是一款面向个人胶片翻拍与扫描的负像还原工作台。它在本机完成片基检测、密度反转、橙罩中和、白平衡和基础调色，并以原始分辨率导出正像。

当前版本为 `1.0.0-beta.2`，公开发布目标为 Windows x64。FilmLab 不上传图像、源文件路径、配方或遥测数据，也不要求在线账户。

[下载与版本](https://github.com/LichengWang04/FlimLab/releases) · [问题反馈](https://github.com/LichengWang04/FlimLab/issues) · [隐私说明](PRIVACY.md) · [更新记录](CHANGELOG.md)

## 开始使用

### 1. 安装

Windows x64 安装包统一通过 [GitHub Releases](https://github.com/LichengWang04/FlimLab/releases) 发布，请以该页面实际列出的可用版本为准。公测版采用手动更新，不会在应用内自动下载新版本。

正式发布的安装程序应带有有效的 Windows 数字签名。仓库工作区或 `dist:win:unsigned` 生成的未签名包仅用于本地结构验收，不应对外分发。

### 2. 准备底片文件

为了让密度计算可靠，推荐使用：

- 未经自动反转、自动调色或锐化的扫描/翻拍文件；
- 保留一小段未曝光片基边缘的画面，便于手动测量片基；
- 16 位、无 ICC、已线性化的 RGB TIFF，常规 JPEG/PNG，或相机原始文件 CR2/NEF/RW2/ARW；
- 同一卷中方向、曝光和扫描设置尽量一致的文件。

FilmLab 会把无 ICC 的 16 位 TIFF 解释为线性扫描数据。如果扫描软件写入的是未标记的非线性值，反转结果可能出现密度和颜色偏差。

### 3. 导入

- 点击“导入底片…”可选择一张或多张文件；
- 点击“导入文件夹…”可导入文件夹中的受支持图像，文件按名称排序，不递归扫描子文件夹；
- 多张图像会显示为一卷胶片，每帧拥有独立配方。

### 4. 校正与反转

1. 在应当水平的画面边缘上绘制参考线，FilmLab 会校正任意角度并自动去除旋转后的空角。
2. 按需框选裁剪区域。旋转发生变化时，原裁剪、片基和中性选区会被清除，避免继续使用失效坐标。
3. 默认片基模式会自动估算未曝光片基；若画面保留了片基边缘，选择“手动选取”并框选该区域通常更可靠。
4. “FilmLab 经典”引擎保持历史算法：建议先保持“自动 Dmax”“自动中和橙罩”和“自动白平衡”开启，再按需调整曝光、对比度、高光压缩和饱和度。
5. “相纸反相 5.6”引擎使用独立的片基密度、相纸打印曲线与高光软压缩。可先框选片基和曝光内容，再点“稳健自动设置”；分析结果会一次性写入配方，因此复制整卷和会话恢复可以复现。高级区可编辑 Dmin RGB、扫描曝光偏置、阴影色偏、高光白平衡和相纸黑位。

自动片基、中和与白平衡都是无色卡的单帧全局估计。它们提供实用起点，但不能替代针对相机、光源、胶片和扫描仪的颜色标定。

### 5. 导出

- “导出当前”会以当前帧的配方重新处理原始全分辨率文件；
- “导出整卷”会顺序处理所有未跳过帧，并显示进度；
- 整卷导出可取消，取消前已完成的文件会保留；
- 单帧失败不会中断其余帧，完成后会显示失败摘要；
- 输出目录存在同名文件时会自动添加 `-2` 等后缀，不会静默覆盖。

TIFF 输出为 16 位 sRGB，JPEG 输出为质量 95 的 8 位 sRGB。两种格式都先写入同目录临时文件，再原子发布最终文件。

## 单帧与整卷工作流

导入多张图像后，可以逐帧旋转、裁剪和调色，也可以把当前帧的完整配方应用到整卷。每帧都可单独标记为“跳过”或从当前胶卷移除。

FilmLab 会在 Electron 的本地用户数据目录保存最近会话，包括源文件路径、逐帧配方、跳过状态和当前帧，用于异常退出后的恢复。源文件被移动、删除或变得不可读时，对应帧可能无法恢复。详细说明见 [PRIVACY.md](PRIVACY.md)。

没有引擎标记的历史会话会自动作为“FilmLab 经典”配方恢复，原参数和输出路径不变。切换到“相纸反相 5.6”会建立一份独立的新参数集合，不会把经典引擎的白平衡、白点归一化或通用 tone map 叠加到新引擎上。

## 格式兼容性

| 类型 | 支持情况 | 说明 |
| --- | --- | --- |
| JPEG / PNG 输入 | 支持 | 按显示编码的 sRGB 解码并转换到线性光域 |
| CR2 / NEF / RW2 / ARW 输入 | 支持 | 由 LibRaw 0.22.1 解码为 16 位线性 sRGB；关闭自动提亮、相机白平衡和自动白平衡 |
| 8 位整数 TIFF | 支持 | RGB 或灰度、strip 布局 |
| 16 位整数 TIFF | 支持 | RGB 或灰度、strip 布局；无 ICC 时按线性扫描数据处理 |
| TIFF 压缩 | 部分支持 | 无压缩、Deflate、LZW、PackBits |
| 带 ICC 的 TIFF | 不支持 | 为避免隐式色彩转换和 16 位精度损失，会明确拒绝 |
| 多页 TIFF | 不支持 | 会明确拒绝；请拆分为单页文件后导入 |
| tiled、浮点、YCbCr、JPEG 压缩 TIFF | 不支持 | 请先转换为受支持的整数 RGB strip TIFF |
| 其他 RAW / DNG / HEIF 输入 | 不支持 | 文件选择和文件夹扫描只接收上列四种 RAW 扩展名 |
| TIFF 输出 | 支持 | 16 位、Deflate、sRGB 编码值 |
| JPEG 输出 | 支持 | 8 位、质量 95、sRGB 编码值 |

输出文件不嵌入 ICC 或 XMP；交付像素值按未标记 sRGB 约定解释。

RAW 的具体机型兼容性取决于内置 LibRaw 0.22.1 的相机支持范围。FilmLab 对 RAW 使用完整传感器解码结果，不以嵌入式 JPEG 预览替代；无法识别或损坏的文件会明确报错。RAW 处理不是设备级标定流程，仍建议保留未曝光片基并通过实际画面校正。

## 处理流程

经典引擎：

```text
扫描/翻拍负片
→ 线性透射率
→ 片基估计与相对密度
→ Dmax 与橙罩中和
→ 密度反转为场景线性正像
→ 白平衡、曝光、对比度、高光和饱和度
→ 白点归一化与 sRGB 编码
→ 16-bit TIFF / JPEG
```

相纸反相 5.6 引擎：

```text
扫描/翻拍负片
→ JPEG/PNG 按 sRGB 线性化，RAW 解码为线性 sRGB，或无 ICC 16-bit TIFF 按声明的线性原色解释
→ 线性 Rec.2020 工作空间
→ Dmin 片基密度校正与 Dmax/阴影/高光校正
→ 相纸黑位、打印曝光与相纸等级曲线
→ 相纸光泽指数软压缩
→ 线性 sRGB 与现有 sRGB 编码
→ 16-bit TIFF / JPEG
```

“相纸反相 5.6”的默认值、参数范围和像素公式冻结到 darktable 5.6.0 negadoctor；目标是参数语义与主要视觉结构兼容，不承诺不同输入配置跨应用逐像素相同。FilmLab 的实现为独立重写，参考链接见 [darktable 5.6.0 negadoctor 源码](https://github.com/darktable-org/darktable/blob/release-5.6.0/src/iop/negadoctor.c)与[官方手册](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/negadoctor/)。

胶片条缩略图由主进程以最多 2 个任务并发解码；1600 px 编辑预览由常驻 Web Worker 生成场景线性缓存，并只保留最新交互请求。支持 WebGPU 的设备会把经典引擎与“相纸反相 5.6”引擎的场景线性预览保留为 GPU 纹理，曝光、对比度、高光压缩与饱和度等高频调节只更新 WGSL 着色器 uniform，不再重复 CPU 管线；着色器阶段与 CPU 线性光域公式保持同序。WebGPU 不可用时自动使用 Canvas2D/CPU，所有全分辨率导出仍走可复现的 CPU Worker 路径。

全分辨率导出在主进程之外的 Worker 中完成，大图可通过多个 Node Worker Threads 分块处理。真正的 Worker 通信或退出故障会回退到保守的 CPU 路径；连续两项导出出现这类故障时，本次会话后续导出改用串行路径。GPU 只加速交互预览调色（两个处理引擎），不改变导出像素合同。

## 隐私与安全边界

- 所有图像处理都在本机完成，不包含广告、分析、崩溃上报、在线账户或云端处理；
- “复制诊断信息”只包含版本、系统、Worker 状态、帧数和去路径化错误状态，不包含图像或源文件路径；
- 一般源文件最大 1 GiB、最长边 32,768 像素、总像素不超过 1 亿；RAW 因 WASM 内存与解码缓冲限制进一步收紧为 256 MiB、70 MP；
- 单卷最多 500 帧；TIFF 最多 65,536 个 strip，单个 strip 解码上限为 256 MiB；
- 导出前会检查目标目录权限、预计可用空间和处理峰值内存；100 MP 是格式上限，不保证低内存机器一定能够执行；
- 仅当预计峰值不超过物理内存的 75%，且当前可用内存覆盖预计峰值与 512 MiB 系统余量时才开始全分辨率处理；
- 无效请求、损坏文件、内存不足、磁盘空间不足和不可写目录会转换为可读错误。

## 适用范围与已知限制

- 默认模式未经相机、光源、胶片或扫描仪配置文件标定，不承诺设备级颜色准确性；
- 主体颜色严重占优、混合光、染料层退化、老化褪色或特殊扫描曲线可能使自动中和与白平衡只能给出折中结果；
- 当前公测不以跨设备真实底片颜色基准集作为放行条件；
- 自动片基无法从已经完全裁掉片基边缘的画面中唯一恢复真实 Dmin，建议保留并手动框选一段未曝光边缘；
- 任意角度旋转和超大图像处理可能短暂占用较多内存；整卷会逐帧导出，不会同时驻留全部全分辨率图像；
- RAW 首次解码会启动独立 WASM Worker，通常比 JPEG/PNG 慢；相机型号超出 LibRaw 0.22.1 支持范围时需要先转为受支持的 TIFF；
- 当前正式发布目标仅为 Windows x64；仓库虽保留其他平台构建脚本，但不代表已经提供正式支持或经过发布验收。

## 开发与验证

建议使用 Node.js 24 和锁定的依赖版本：

```powershell
npm ci
npm run dev
```

常用验证命令：

```powershell
npm run check         # TypeScript 类型检查 + 全部测试
npm run build         # Electron 生产构建
npm run smoke         # 构建并执行应用启动 smoke
npm run smoke:gpu     # 在真实 Electron 渲染器中验证 WebGPU WGSL 着色器路径
npm run smoke:raw     # 用 FILMLAB_RAW_FIXTURE 做元数据、预览与全尺寸 JPEG 导出
npm run smoke:export  # 构建并验证实际 TIFF/JPEG 导出
npm run benchmark     # 预览与 24MP CPU 导出基准，仅记录耗时
npm run acceptance:negadoctor # 校验 darktable 5.6.0；配置私有样张后执行跨应用指标
```

可选的真实 RAW 回归通过环境变量提供，不把相机样片提交到仓库：

```powershell
$env:FILMLAB_RAW_FIXTURE = 'D:\samples\negative.ARW'
node --test test/raw-import.test.ts
```

真实 RAW 回归应单独运行：LibRaw WASM 会占用至少 256 MiB 基础堆，与全量并发测试同时执行可能有意触发 FilmLab 的低内存保护。

私有样张目录结构、配方清单和指标输出见 [Negadoctor 5.6 验收说明](docs/NEGADOCTOR_ACCEPTANCE.md)。

Windows 打包：

```powershell
npm run dist:win           # 正式签名构建；要求代码签名环境变量
npm run dist:win:unsigned  # 本地结构验收；产物不得分发
```

正式发布会从干净 tag 执行依赖安装、审计、测试、构建、签名打包、安装后 smoke、实际导出、卸载和 Authenticode 验证。详细流程见 [docs/RELEASE.md](docs/RELEASE.md)。

## 代码结构

```text
src/core/      与 Electron 无关的处理核心和像素域类型
src/main/      解码、导出、会话、资源限制和 Electron 主进程
src/preload/   contextBridge 白名单桥接
src/renderer/  React 界面、画布交互、胶片条和预览 Worker
test/          核心、集成、整卷服务和发布边界测试
```

像素会在 `transmission-linear`、`relative-density`、`scene-linear-rgb` 和 `display-linear` 等显式域之间转换，避免把显示编码值误用于密度计算。源文件绝对路径保留在主进程，渲染进程只接收不透明帧标识、文件名和降采样像素。

## 反馈

请通过 [GitHub Issues](https://github.com/LichengWang04/FlimLab/issues) 报告问题。提交诊断信息或样片完全自愿；公开样片前请先移除不希望披露的画面与元数据。
