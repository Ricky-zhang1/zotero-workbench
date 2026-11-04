# 1.0.0 开源预览：原版 ZCode 功能对照

核对日期：2026-11-04。1.0.0 定位为开源预览。范围是 canonical 源码中的 `vendor/zcode-zotero-0.2.1/dist/server.mjs`、其构建补丁、`src/server.mjs` 和 `src/ui/`。这是静态源码对照，不代表本次构建、真实文库或正式宿主回归通过。

## 结论

组合根仍调用原版 `createZoteroMcpServer()`，再注册工作台自有工具；没有看到原版 21 个工具或 10 个资源因接入新写入网关而被移除。自有源码另有 36 个 `register()` 工具，按源码静态计数合计 57 个不同名称。这个数字来自源码静态计数，不是本次运行时探测。README 中“44 个工具”的说明与当前源码计数不一致，应在发布材料中复核，不能当作当前运行时计数。

新增的 `LibraryLocalWrites` 只为工作台的预览/确认流程增加一条本地写入路径，复用原版 `session.writer`；原版 `add_item`、`attach_pdf`、`update_item`、`add_note`、`create_collection`、`authorize_writes` 等仍由原版 session/tool 实现提供。它们未被新网关替换，因此行为仍在，但原版直接写入工具不经过新的 `ReviewTransactions` 预览和操作台账。这是两条并存的写入路径与治理差异，不是原功能被移除。

## 原版 MCP 工具

| 原版工具 | 当前源码状态 | 说明 |
|---|---|---|
| `list_collections`、`search_library`、`get_item`、`search_annotations` | 保留 | 原版本地文库与批注读取。 |
| `read_fulltext`、`find_in_pdf` | 保留 | 原版 PDF 文本读取与定位；另有工作台自有证据、全文续读工具。 |
| `cite`、`open_item`、`show_items` | 保留 | 原版引用、导航和面板列表操作。 |
| `highlight`、`clear_highlights` | 保留并受约束 | `highlight` 仍创建会话候选；候选保存文案被改为必须经过 `review_evidence`。`clear_highlights` 仍只清会话候选。 |
| `save_highlights` | 保留入口，修改行为 | 构建补丁将描述改为禁用兼容端点；组合根只允许 `origin=user` 走自有保存路由，AI 候选须走审计链。协议测试有负向断言。 |
| `add_item`、`attach_pdf`、`update_item`、`add_note`、`create_collection` | 保留原版直接工具 | 仍使用原版本地 API writer 与 Zotero 授权。能力比当前工作台表单宽：例如导入可选 PDF、集合、标签和附带笔记，更新可操作标签/集合，笔记接受 Markdown。它们不会自动获得新网关的预览 token 和台账保障。 |
| `export_bib`、`authorize_writes` | 保留 | 前者写工作区 `.bib` 文件；后者请求 Zotero 写入授权。 |
| `panel_launch_zotero`、`panel_refresh` | 保留为 app-only | 原版面板打开 Zotero 和刷新连接的入口。 |

其他改变均由构建脚本对固定上游锚点做文字/界面补丁：服务器名与产品名改为工作台；候选高亮明确标记为会话状态；列表摘要增加 `extra`，以支持工作台期刊等级解析；面板根组件换成 `WorkbenchRoot`。补丁采用唯一锚点，构建脚本发现锚点不唯一或缺失会停止。

## MCP 资源

原版静态注册 10 个资源，当前组合仍使用同一个 server 实例，源码未见删注册：

| 资源 | 用途 | 当前依据 |
|---|---|---|
| `panel`、`state`、`setup` | MCP App HTML、运行状态、Zotero 连接设置/交接 | `createZoteroMcpServer()` 原注册；面板 HTML 由构建产物替换。 |
| `collections`、`items`、`item`、`annotations` | 文库分类、列表、条目、批注 JSON | 原注册。 |
| `pdf-info`、`pdf-part`、`pdfjs-data` | PDF 元信息、分块读取及 PDF.js 资源 | 原注册。 |

测试边界：`tests/protocol.test.mjs` 读取并检查 `ui://zotero/panel.html`、MCP App 入口和面板脚本可解析，也检查 `workbench_state`；当前可见测试未逐项请求上述全部资源模板或真实 PDF 分块资源。

## 核心 UI

| 区域 | 当前实现 | 核对边界 |
|---|---|---|
| 原版文库/阅读器 | `WorkbenchRoot` 将原版 `vne` 保留为中心文库/阅读器；inline display mode 直接返回原版 root。PDF.js 阅读、翻页/缩放、原生批注显示仍由上游主体提供。 | 构建补丁依赖压缩 UI 的固定锚点；源码与语法测试不等于正式 Codex 面板中的完整交互回归。 |
| 工作台外壳 | 增加分类导航、信息检查、详情栏、条目与引用、批注证据、研究和协作页面；保留原版阅读器挂载点。 | 当前有面板源码与构建集成测试；此处不把它标成 1.0 宿主验收完成。 |
| 原版交互调整 | 列表选择同步到工作台；详情栏打开时单击选择条目供详情栏显示，否则单击延迟打开详情；双击有 PDF 的条目打开 PDF、无 PDF 时打开详情；期刊等级徽章来自 Zotero extra/标签；选文可加入当前对话。 | `scripts/build.mjs` 有锚点改写，`tests/panel-workbench-ui.test.mjs` 有相应 UI 构建断言；本次未运行测试。 |
| 高亮操作 | 用户在 PDF 选文可直接经 app-only 工具保存并回读；Agent 候选仍可显示/定位，但须走独立审计写入；移除/恢复有工作台受控流程。 | 原版“保存 Agent 高亮”语义被有意改变；恢复/移除须按各自真实 Zotero 版本及正式宿主证据验收。 |

## 代码、测试、真实验收分层

- **源码存在**：上列原版工具与资源注册可在固定上游 runtime 找到；构建脚本通过源码补丁继续导出 `createZoteroMcpServer()`。这只能证明实现入口存在。
- **自动测试**：当前协议测试检查部分上游工具仍可见、MCP App 面板资源与状态工具，并拒绝未经审计的 `save_highlights` 路径。面板测试覆盖若干生成锚点与交互。此处是对测试源码的只读核对，本次没有运行它们；不能据此报告全量测试通过。
- **正式宿主/文库验收**：当前 README 记载 0.14.x 的 Codex 真实 UI 闭环仍待主代理验收，DSH/ZCode 尚未验收。历史版本的 Codex、DSH 或模拟服务记录不能代替 1.0 当前构建的三端验收，也不能证明所有原版工具都与当前 Zotero 版本端到端正常。
- **平台边界**：当前发布验收范围为 macOS arm64；其他操作系统和处理器架构尚未验收。
- **待补验证**：1.0.0 的完整自动测试、干净环境安装与冷启动，以及三端真实宿主回归由主代理补验；本次版本号和文档更新不代表这些验证通过。

## 1.0 发布前需明确的兼容性边界

1. 保留原版直写工具时，需决定它们是否继续作为公开模型工具；若保留，应在 1.0 文档中说明它们走 Zotero 原生授权、但不走工作台预览/台账网关。若要求所有写入统一审计，则需另行迁移这些旧工具，不能仅凭新增网关宣称完成。
2. 新网关覆盖的表单范围目前窄于原版工具能力；原版 `add_item` 的 PDF/集合/标签/伴随笔记、`attach_pdf`、标签与集合更新、独立笔记等应单独列作“原版工具保留”或未来统一网关工作的范围，不能误写成新表单已支持。
3. 公开发布前需基于固定 vendor 校验和重建 1.0 构建，并单独验收安装、Zotero 版本/权限、原版资源与工具、MCP App UI 及 Codex/DSH/ZCode 宿主。此文不构成开源许可证审计或发布通过证明。
