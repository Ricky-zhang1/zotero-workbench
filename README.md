# Zotero Workbench · 文献工作台 1.2

在 Codex 中浏览 Zotero 文库、阅读 PDF、管理高亮与笔记，并把研究者选定材料带入当前 Agent 会话。Zotero 是文献与批注的唯一数据源。

**1.2.2 开源预览**：新增标题摘要双语；保留研究导读、逐页全文中文翻译、外文高亮自动对照和材料分组。实现、真实调用与正式宿主验收分别记录，详见 [标题摘要双语](docs/RELEASE-1.2.2.md)、[高亮笔记更新](docs/RELEASE-1.2.1.md)、[1.2 说明](docs/RELEASE-1.2.md) 和 [原版功能对照](docs/upstream-parity.md)。

## 阅读与研究

- 文库分类、搜索、详情、多选、PDF 阅读、双击打开、可收起导航；期刊等级使用有文字和来源的 Pill。
- 单条点击翻译标题与摘要，外文详情默认双语；仅发送当前元数据，中文不调用，缺摘要不补写，译文不覆盖 Zotero 原字段。
- 高亮可就地添加或编辑阅读笔记，保存到原 Zotero 批注备注；原文与笔记分开，保存带版本保护并回读核实。
- 高亮创建、单击移除和原 key 恢复；右栏勾选/全选、复制、累计加入上下文。保留版本检查、可恢复操作记录和写后核对，结果不明不自动重发。
- 研究页按文献、颜色、材料类型或显式研究类型分组。高亮原文、其他原文批注、阅读者备注和独立笔记分块，切换分组和回跳 PDF 后保留仍有效的选择。
- 外文高亮/下划线默认自动显示中文对照，成功后逐批继续，每批最多20条，可随时关闭。仅处理用户明确选择并载入的范围；不自动翻译阅读者备注和独立笔记，失败不自动重试。
- 每篇文献可一键生成全文中文翻译，切换原文、中文或对照，按页回原 PDF，复制带页码回链的译文 Markdown。逐块保留原文、核对覆盖，不覆盖原 PDF，也不将译文伪装为作者原话；本版不重排导出译文 PDF。
- TextFold 保留主题、结论、要点、关键原句、全文五层；新增研究问题、论证、概念、方法证据、发现边界和文献对话导读。作者主张与研究者提示分开，每条依据核对物理页和原文引句；缺少材料时显示缺口。
- TextFold、全文译文和初稿可从当前范围的最近结果分别恢复，不为切换结果重跑模型。来源暂不可核验时隐藏旧译文，保留成功快照供重新核验。
- 人工选择的摘录与笔记进入当前 Agent 上下文；协作草稿和论断保留来源回链与人工反馈。机器译文和导读不会自动进入人工所选写作语料。
- 引用与条目导出、DOI/arXiv 单条识别导入，以及固定上游 ZCode Zotero 0.2.1 的21个工具和资源入口保留；部分 AI 证据高亮保存增加审计限制。

## 安装与条件

在 Releases 下载适合平台的 portable ZIP，解压后通过 Codex 支持的本地 marketplace 入口安装。包内置官方 Node 24，基础文库/PDF/普通批注不要求另装 Node、Python 或 Zotero MCP。没有本地市场入口的 Codex 版本尚不支持这条安装路径；ZIP 不是双击安装器。

Zotero 需运行并在“设置→高级”允许本机通信。首次写入仍由 Zotero 原生授权；只有选择“始终允许”并由 Zotero 返回 remember=true 时，才在本机私有状态目录保存本插件授权。Codex 与 DSH 共用该位置，更新版本不会复制其他应用的凭据。写入能力要求 Zotero 10，原生授权仍由 Zotero 管理；插件不静默绕过权限。语义检索和 AI 证据审计需要对应的可选服务，它们失联不阻塞文库与翻译。

翻译使用内置 Node 与已登录、可用的 Codex CLI，不要求 TextFold Python 环境。TextFold 仍需 Python 研究环境及 Poppler：维护者可运行 `python3 scripts/setup-research.py` 准备锁定依赖。扫描件、缺字及不可提取页面不会跳过后冒充全文完成；本版不含 OCR。全文处理当前限1–200页、16万字符。

阅读任务沿用 Codex CLI 的服务与账号。可选 `ZOTERO_WORKBENCH_RESEARCH_MODEL` 仅覆盖后台子进程模型；未设时读取 `~/.local/share/zotero-workbench/research-settings.json` 中的可选 `model` 字段（状态根可由 `ZOTERO_WORKBENCH_STATE_DIR` 调整）。两者均未设则沿用 CLI 原配置，不自动挑模型或改全局设置。模型不可用时明确失败，不伪造生成结果。

## 数据流

文库列表与 PDF 在本机读取。外文详情默认将当前文献标题和摘要交给已配置阅读模型生成双语对照，列表只在点击该条翻译时启动；不发送 PDF 或笔记。加入上下文或提问将选定内容交给当前宿主模型；研究页自动对照会把所选范围内的外文高亮/下划线交给已配置阅读模型，全文翻译和 TextFold 按钮会发送相应全文文字。服务按自身规则处理资料和额度。译文、导读、协作和操作记录只保存在本机私有状态目录，不上传 Git，不构成第二份权威文库。详见[数据与许可边界](docs/privacy-and-release.md)。

## 宿主与验证

macOS Apple Silicon 已做实际内置运行时启动、Zotero只读连接、虚构材料真实模型调用，以及受控浏览器的实际按钮/来源回跳、浅深色和窄栏检查。受控浏览器不是正式 Codex 宿主，不能替代其新版本激活与写入/真实消息送达验收。Windows包仅构建校验，Intel Mac和Linux也不宣称真机通过。

DSH源码适配在 `integrations/dsh`：Host+Client、全页/侧栏、当前会话消息桥和共享研究视图。可通过 DSH 支持的 `plugin_manager install_bundle` 安装该目录；后台翻译/TextFold使用Codex CLI阅读模型，不冒称DSH原生模型。1.2的DSH桥有自动化覆盖，尚未做该版本完整正式UI验收。ZCode参考包的保留不代表本工作台全部新UI已适配ZCode。

## 从源码开发

```sh
node scripts/build.mjs
node --test --test-concurrency=1 tests/*.test.mjs
node --test integrations/dsh/test/*.test.mjs
python3 -m unittest discover -s tests -p package_portable_test.py
# 准备TextFold依赖后，直接执行这个文件；unittest discover不会收集其带点文件名。
python3 tests/research-worker.test.py
python3 scripts/package-portable.py --target darwin-arm64
```

源码里的本地维护安装器不是普通用户的便携安装流程；更新前检查运行中的版本，避免移除仍在使用的缓存。文档：[架构](docs/architecture.md)、[分发](docs/distribution.md)、[上游对照](docs/upstream-parity.md)。

## 许可与贡献

工作台及固定ZCode上游遵循MIT；TextFold保留Apache-2.0 LICENSE/NOTICE，PDF.js及Node的声明随包分发。可选PyMuPDF适用其自身许可，不包含于基础便携包。本项目不承诺所有依赖组合均适用于任意闭源再分发，开源预览不代表商业与全平台稳定背书。

欢迎issue和PR。请使用虚构文献复现，不上传私人PDF、笔记、账号、API key或本机研究缓存。
