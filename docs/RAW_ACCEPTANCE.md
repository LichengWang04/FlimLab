# RAW 私有样张验收记录

验收日期：2026-08-30

当前私有样张集包含 6 张 Sony A7R V ARW（约 61.9–63.5 MiB/张）。样片本身、生成的缩小 TIFF、差分图和绝对路径不进入仓库或 Release；下列 SHA-256 只用于复现实测样张身份。

| 样张 | SHA-256 |
| --- | --- |
| DSC01683.ARW | `04a4bdac6718dc180cd01b4ad6aeec0115379129016e17acfd512cc0219aae0b` |
| DSC01684.ARW | `93e9af542653dfc78d0351ad5faa11beb64450fcf5d0190af5d7fa0e9bdd6180` |
| DSC01688.ARW | `4913327896ba79dace7058dde98fc00f1176fb715038bd56e9401fbb3a4bf5a9` |
| DSC01692.ARW | `4003b0891e408c2147584ad1e1fca3b0636d33d8c20c8a51d9fb8b9a5664878a` |
| DSC01694.ARW | `cd1152242c8bc9d831c06277ab5392fe7bff44d7bc9a1497d12ffa32fc9dcbfd` |
| DSC01695.ARW | `c59ab4a86841027a4a34f1b2f4c0601fa8e8ac224b333806cf4a2e541b848e6a` |

## 当前结果

- 文件识别、元数据与 LibRaw 解码：6/6 通过；每张读取为 `4782×3188` 的半尺寸线性栅格。
- 1600 px 真实预览：6/6 通过；每张输出 `1600×1067`。
- Negadoctor 5.6 私有对照：6/6 通过，详见同版本的 `NEGADOCTOR_ACCEPTANCE_RESULTS.json`。
- 全尺寸 JPEG 导出：本轮未记为通过。两次真实冒烟均在解码前被内存保护正确拒绝；任务估算需要约 2.1 GiB 可用内存，而测试机在尝试时不足。该结果验证了 fail-closed 资源边界，不等同于全尺寸输出验收。
- CR2 / NEF / RW2：没有真实样张，不能记为实测通过。

公开能力说明必须与本记录一致；扩展名识别或模拟 Worker 测试不能替代真实相机文件验收。
