# Negadoctor 5.6 私有样张验收

验收脚本固定要求 darktable CLI 报告 `5.6.0`，并使用独立临时配置、内存数据库、关闭 OpenCL、线性 Rec.2020 输入/工作空间及 sRGB 输出。仓库中的 `scripts/negadoctor-5.6-template.xmp` 只启用输入色彩转换和 negadoctor；自定义预设与额外 tone mapping 均关闭。

设置 `FILMLAB_NEGADOCTOR_FIXTURES` 指向不纳入版本控制的目录。目录需包含 4–6 张无裁切、同尺寸比较所需的 16 位线性 Rec.2020 RGB TIFF，以及：

```json
{
  "cases": [
    {
      "name": "normal-color-negative",
      "input": "normal-color-negative.tif",
      "recipe": {
        "dminRgb": [1.0, 0.45, 0.25],
        "dmax": 2.046
      }
    }
  ]
}
```

`recipe` 会叠加到 `DEFAULT_NEGADOCTOR_56`，可以为每张样片填写全部冻结参数。建议覆盖正常彩负、强橙罩、偏色老片、高反差和黑白。输入路径必须留在私有目录内。

```powershell
$env:DARKTABLE_CLI = "C:\Program Files\darktable\bin\darktable-cli.exe"
$env:FILMLAB_NEGADOCTOR_FIXTURES = "D:\private\filmlab-negadoctor"
npm.cmd run acceptance:negadoctor
```

结果写入 `artifacts/negadoctor-acceptance/metrics.json` 和逐图差分缩略图。每张图都必须达到非剪裁像素亮度全局 SSIM ≥ 0.98、中位 ΔE00 ≤ 2、P95 ΔE00 ≤ 5；这里的 SSIM 指整幅亮度平面的全局统计（脚本内 `globalSsim`：单组均值/方差/协方差），并非标准局部窗口 SSIM，与其他工具的窗口化数值不直接可比。未设置样张目录时只做 darktable 版本预检并输出 `SKIP`，不等同于兼容验收通过。
