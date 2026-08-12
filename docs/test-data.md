# 测试素材策略

真实相机 RAW、扫描母版和导出图像可能包含隐私信息，并且体积不适合普通 Git 历史。FilmLab 因此采用“素材在仓库外、本地路径受忽略、仓库只保存身份清单”的策略，不使用 Git LFS。

## 本地布局

Sony A7R V 回归素材默认放在仓库根目录的 `A7R5_RAW/`。该目录和根目录下的 `*-positive.tif` / `*-positive.tiff` 已被 `.gitignore` 排除。

受控测试机可从私有归档恢复素材，然后运行：

```powershell
npm run verify:test-data
```

该命令只验证本地素材身份；真实 ARW 的性能和图像验收应通过已构建的 RAW sidecar 与 Electron 工作台执行。`benchmark:raw` 当前用于 16-bit TIFF/Sharp 路径，不能替代 ARW 解码验收。

`test-data/a7rv-local-manifest.json` 仅保存文件名、字节尺寸和 SHA-256，不包含绝对路径、EXIF、像素或缩略图。新增或替换素材必须经过授权，并显式更新清单；内容不同但同名的文件不能作为同一回归样本。

## 仓库约束

`npm run check:repo` 会检查所有已跟踪文件；pre-commit 钩子会检查即将提交的文件。以下内容会被拒绝：

- 相机 RAW、DNG、TIFF 母版和已编译可执行文件；
- `A7R5_RAW/`、`release/`、`out/`、依赖或本机构建目录；
- 超过 20 MiB 的单个文件；
- 已知的临时或误生成文件名。

确有必要提交的小型二进制测试夹具时，应先修改检查器中的精确允许列表，并在变更说明中记录许可证、来源、隐私审查和用途。
