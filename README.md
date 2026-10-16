# DocBoxTrans

> 面向文献阅读的**划词翻译**工具集：桌面端打通稻壳阅读器，插件端打通 Zotero，共享同一套翻译引擎与「上下文增强翻译」能力。

本仓库包含两个子项目，二者面向不同的阅读场景，但采用一致的翻译服务与设计语言：

| 子项目 | 平台 | 技术栈 | 说明 |
| --- | --- | --- | --- |
| [**DocBoxTrans**](DocBoxTrans/) | Windows 桌面 | C# / .NET Framework | 稻壳阅读器划词翻译：热键取词、结果浮窗、翻译历史、随稻壳启停 |
| [**DocBoxTrans for Zotero**](DocBoxTrans-Zotero/) | Zotero 7+ 插件 | TypeScript | 在 Zotero 内置 PDF 阅读器中划词翻译、翻译记录侧栏、拼接翻译 |

> 注：Zotero 端插件声明支持 Zotero 7 及以上，但目前主要在 **Zotero 10** 上测试，对 Zotero 7 的完整兼容性尚待验证。

---

## 共同能力

- **多翻译源**：大模型（任意 OpenAI 兼容接口）、谷歌、必应、腾讯交互、有道智云、知网，共 6 个引擎。
- **上下文增强翻译**：把此前成功翻译的「原文 → 译文」作为参考注入大模型，统一术语与表达；按文档 / 条目隔离，避免互相串味。
- **本地留存**：翻译历史本地保存、不上传，支持标签、检索与筛选。
- **零/低依赖**：桌面端无需安装 .NET SDK（用 Windows 自带编译器即可构建）；插件端基于官方脚手架。

---

## 快速开始

- 桌面端（稻壳阅读器）：见 [DocBoxTrans/README.md](DocBoxTrans/README.md)
- 插件端（Zotero 7+）：见 [DocBoxTrans-Zotero/README.md](DocBoxTrans-Zotero/README.md)

---

## 仓库结构

```
.
├── DocBoxTrans/           # Windows 端：稻壳阅读器划词翻译（C# / .NET Framework）
├── DocBoxTrans-Zotero/    # Zotero 端：Zotero 7+ 划词翻译插件（TypeScript）
├── .github/workflows/     # GitHub Actions 发布工作流
├── LICENSE                # MIT
└── README.md
```

---

## 发布

发布通过 GitHub Actions（[.github/workflows/](.github/workflows/)）完成：

| 目标 | 触发方式 | 产物 |
| --- | --- | --- |
| **桌面端** | 推送 `desktop-v*` 标签 | `DocBoxTrans-<tag>.zip`（含 `DocBoxTrans.exe`、`DocBoxTransConfig.exe` 与图标），挂到该标签的 Release |
| **Zotero 插件** | 手动运行 `Release Zotero Plugin` 工作流 | `.xpi` 挂到 `v<version>` Release，并刷新 `release` 更新清单 Release 中的 `update.json` |

> 插件发布前，先把 `DocBoxTrans-Zotero/package.json` 的 `version` 提升到目标版本并推送；工作流据此创建 / 更新对应 Release。

---

## 许可协议

本项目基于 [MIT License](LICENSE) 开源。

## 免责声明

- 部分翻译源为第三方**非官方公开接口**（谷歌 / 必应 / 腾讯 / 知网等），仅供个人学习与研究使用，请勿用于商业用途或高频批量调用，并遵守各服务方的服务条款。
- 请妥善保管配置文件 / 偏好中的各类密钥，**不要将其提交到公开仓库**。
- 使用本项目产生的任何后果由使用者自行承担。
