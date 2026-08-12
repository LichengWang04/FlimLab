# 测试素材策略

真实相机 RAW、扫描母版和导出图像可能包含隐私信息，并且体积不适合普通 Git 历史。FilmLab 因此采用“素材在仓库外、本地路径受忽略、仓库只保存身份清单”的策略，不使用 Git LFS。

## 本地布局

Sony A7R V 回归素材默认放在仓库根目录的 `A7R5_RAW/`。该目录和根目录下的 `*-positive.tif` / `*-positive.tiff` 已被 `.gitignore` 排除。

受控测试机可从私有归档恢复素材，然后运行：

```powershell
npm run verify:test-data
```

该命令只验证本地素材身份。完整验收使用：

```powershell
npm run acceptance:a7rv
```

该入口先构建生产 Electron 应用，再使用真实 ARW 进入 utility process 和 LibRaw sidecar；`benchmark:raw` 也已改用同一链路并至少执行全分辨率 TIFF，而不再读取 TIFF/Sharp 代理输入。默认完整验收会复制首个夹具到忽略的 `artifacts/a7rv-e2e-work/`，模拟源目录移动、改名、内容篡改和项目跨机复制，并导出四种全分辨率母版。完成后可用 `npm run acceptance:masters` 通过 Sharp/libvips 重新打开；受控 CI 还强制使用 ExifTool 和 ImageMagick。

`test-data/a7rv-local-manifest.json` 仅保存文件名、字节尺寸和 SHA-256，不包含绝对路径、EXIF、像素或缩略图。新增或替换素材必须经过授权，并显式更新清单；内容不同但同名的文件不能作为同一回归样本。

`test-data/a7rv-acceptance-baseline.json` 固定传感器全尺寸、PTC 标识、预览/单格式时间上限、utility RSS 上限和 10 轮稳定性内存漂移上限。`referenceObservations` 是已通过机器的观测值，不是跨硬件性能承诺；改变硬件、sidecar、处理算法或输出编码器后，应保留旧报告并经过说明后更新参考值，不能仅为让失败消失而提高门槛。

## 仓库约束

`npm run check:repo` 会检查所有已跟踪文件；pre-commit 钩子会检查即将提交的文件。以下内容会被拒绝：

- 相机 RAW、DNG、TIFF 母版和已编译可执行文件；
- `A7R5_RAW/`、`release/`、`out/`、依赖或本机构建目录；
- 超过 20 MiB 的单个文件；
- 已知的临时或误生成文件名。

确有必要提交的小型二进制测试夹具时，应先修改检查器中的精确允许列表，并在变更说明中记录许可证、来源、隐私审查和用途。
