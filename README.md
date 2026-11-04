# Zotero Workbench · 文献工作台 1.0

在 Codex 中浏览 Zotero 文库、阅读 PDF、管理高亮与笔记，并把选定材料带入当前 Agent 会话。Zotero 是文献与批注的唯一数据源。

**1.0.0 开源预览**：实现与测试开放，不表示所有平台和宿主均已验收。详细边界见 [1.0 说明](docs/RELEASE-1.0.md) 与 [原版功能对照](docs/upstream-parity.md)。

## 安装

在本仓库 Releases 下载适合电脑平台的 portable ZIP，解压后通过 Codex 支持的本地 marketplace 安装入口选择该目录并安装插件。便携包内置官方 Node 24，不要求另装 Node、Python 或手改 MCP 配置。若 Codex 版本没有本地市场入口，该版本尚不具备此安装路径；ZIP 不是双击安装器。

打开 Zotero，在“设置 → 高级”启用“允许本机其他应用与 Zotero 通信”。这项权限不能由插件静默绕过。Zotero 10 支持本地写入，写入时由 Zotero 请求授权；旧版主要提供读取，已配置旧 MCP 的使用者可保留兼容写入。

## 功能

- 文库分类、搜索、详情、多选、PDF 阅读、双击打开、可收起导航。
- 高亮、笔记、期刊等级 Pill、引用与条目导出、DOI/arXiv 单条识别导入。
- 高亮移除与原 key 恢复；预览、版本冲突检查、持久操作记录与写后回读。结果不明时不自动重发。
- 人工选择的摘录与笔记进入当前 Agent 上下文；协作草稿与论断保留来源回链及人工反馈。
- 保留上游 ZCode Zotero 0.2.1 的 21 个工具与资源入口；部分 AI 高亮保存行为增加审计限制，见对照文档。

文库、PDF、普通高亮、标准笔记/元数据/单条导入与引用不要求另装 Zotero MCP。可选语义检索和 AI 证据审计需对应服务。TextFold 自动任务保留，但仍需 Python 研究环境与已登录 Codex CLI；它不是基础便携包已免配置的能力。当前会话 Agent 协作不需要这些 Python 依赖。

## 验证与平台

macOS Apple Silicon 的官方内置运行时已进行空 PATH/隔离用户目录的真实启动、工具枚举、面板资源和 Zotero 只读连接检查。此检查不是正式 Codex UI 的完整按钮验收。Windows、Intel Mac、Linux 的打包目标不代表真机通过。1.0 所有平台的完整写入、恢复与宿主交互回归仍需继续完善。

## 从源码开发

需要 Node.js 24+；Python 仅用于打包测试或可选研究功能。

```sh
node scripts/build.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'package_portable_test.py'
python3 scripts/package-portable.py --target darwin-arm64
```

私有配置、个人研究文库、操作台账与模型凭证不在仓库内。便携包构建只从官方 Node 发布源获取固定版本运行时，验证 SHA-256 并附带许可证。源码中的本地维护安装器不是给普通用户使用的便携安装流程。

## 许可与贡献

工作台及固定 ZCode 上游遵循 MIT；TextFold 保留 Apache-2.0 LICENSE/NOTICE，PDF.js 与 Node 的许可声明随各自资源分发。可选 PyMuPDF 适用其自身许可，不包含在基础便携包中。本项目不宣称整个依赖组合适用于任意闭源再分发。

欢迎提交 issue 和 PR；请使用虚构文献复现问题，不上传私人 PDF、笔记、账号或 API key。更新请注明变更和实际验证范围，未通过的验收保持可见。

TextFold 自动任务另需 Poppler 的 `pdftotext`（例如 Ubuntu 的 `poppler-utils`）；它不内置于基础便携包。CI 显式安装此可选研究依赖，以执行真实双栏提取检查。基础阅读界面不因此要求安装 Poppler；PDF.js 无法定位的特殊字体文本仍可能需要该回退依赖。
