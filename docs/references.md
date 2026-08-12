# 参考边界

本仓库的代码、测试和预设均为独立实现，不复制任何下列项目的源码、LUT、专有预设或界面。

- [darktable Negadoctor](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/negadoctor/)：参考其“线性输入、片基 Dmin、负片反转、后置调色”的处理顺序，以及无边框时另拍同卷未曝光片基、测量 Dmin 后复制到其余帧的工作流。darktable 为 GPL-3.0；除非未来产品整体采用兼容许可证，否则只能参考公开算法和行为，不能复制源码。
- [RawTherapee Film Negative](https://rawpedia.rawtherapee.com/Film_Negative)：参考同一胶卷只需选择一次中性参考并复用处理配置的工作流，以及根据胶卷、老化和拍摄条件保留人工复核的边界。RawTherapee 同为 GPL-3.0，不能直接移植进非 GPL 产品。
- [Negative Lab Pro](https://www.negativelabpro.com/guide/basics/)：仅作为用户工作流与验收体验参考，例如整卷同步、边缘排除、非破坏性参数保存和技术处理与创意调色分离。它是专有软件；不得逆向、复制其算法、LUT、预设或界面。
- [LibRaw](https://www.libraw.org/docs)：当前原生 RAW sidecar 使用 LibRaw 0.22.1 的 `open_file()` / `unpack()` 数据路径，不使用其渲染或缩略图 API。发布时必须审查 LGPL-2.1/CDDL-1.0 双许可，随二进制保留所需通知与源码/可替换性义务。
- [Sharp](https://sharp.pixelplumbing.com/)：用于 16-bit TIFF 输入的 ICC 转换，以及 JPEG/HEIF 输出的 ICC、XMP 和容器编码。带配置文件的 TIFF 输入先转换到 sRGB 原色并显式还原为线性光；输出阶段再对已完成调色的线性数据执行 sRGB OETF。16-bit TIFF/DNG 由仓库内的确定性写入器生成，Sharp 不被用作相机 RAW 渲染器。
- [Photons to Photos — Photon Transfer Curve](https://www.photonstophotos.net/Charts/PTC.htm)：A7R V 的 ISO 100 噪声模型使用该页公开的 `Sony ILCE-7RM5` 实测行（14 bit、读出噪声 1.368 DN、转换系数 2.759 e⁻/DN、PRNU 0.38%）。页面明确提示数据来自观测，读出噪声可能因黑电平裁切而偏低；因此实现不会外推到未测 ISO，也不会将其表述成色彩校准。
- [EMVA 1288 Release 4.0 Linear](https://www.emva.org/wp-content/uploads/EMVA1288Linear_4.0Release.pdf)：用于核对线性相机 PTC 的方差模型、转换增益和有效拟合区间。FilmLab 只借鉴公开测量定义并实现独立的噪声传播；PTC 不提供相机到 XYZ/sRGB 的光谱色彩矩阵。
