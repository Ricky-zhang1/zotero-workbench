# DeepSeek Harness 插件（zotero-workbench）

本目录是 **DeepSeek Harness（DSH）侧的唯一接入点**，包含两个半侧、两个界面入口：

- **Host 半侧**（`index.js`）：在 DSH Web 进程内注册同源路由 `/zotero-workbench/*`（文库、PDF、批注、引用导出、信息检查、`zotero://` 深链打开）。浏览 API 只读；全页阅读器另有一个受版本保护的接口，仅编辑现有批注的 `annotationComment`，并通过共享服务回读核实。插件同时通过 `cordis.patch.yml` 用 `@deepseek-ai/dsh-mcp-client` 启动仓库根目录的标准 MCP 服务器（`../../src/server.mjs`）。
- **Client 半侧**（`client.js` + `web/`）：
  - **全页工作台**：左侧边栏「Zotero 工作台」入口 → 主面板 `?mode=workspace`（文库浏览、信息检查、多选加入对话/提问、详情栏、引用导出、PDF 阅读 + 真实批注矩形/浮层）。
  - **右栏阅读器**：`dsh-better-sidebar` 右侧边栏的「Zotero 文献」tab → `?mode=sidebar` 紧凑阅读器。
  - **研究工作台（0.12.0）**：在全页工作台按所选高亮、批注与笔记生成带来源回链的初稿，或对单篇 PDF 启动 TextFold 五层阅读。

Zotero 仍是文献与批注的唯一数据源。除全页阅读器里编辑既有批注备注外，浏览器界面只读；该备注功能不新建笔记或批注，写入前核对 Zotero 实例、PDF 来源、版本和旧备注，写后回读，结果未知时不重发。MCP 里的其他写入仍走预览、授权和确认网关。

![全页 Zotero 工作台](docs/workspace-main.png)

![PDF 阅读 + 真实批注矩形](docs/workspace-annotations.png)

![批注浮层（可在 Zotero 中显示）](docs/workspace-annotation-popover.png)

![多选加入对话（写入当前会话输入框）](docs/workspace-add-to-chat.png)

## 目录结构

| 文件/目录 | 作用 |
| --- | --- |
| `package.json` | DSH plugin 清单：`dsh.bundle.patch` + `dsh.client`（platform/immediately/inject） |
| `cordis.patch.yml` | 两行：MCP 服务器连接 + 本插件 Host/Client 行；含本机绝对路径 |
| `index.js` | Host 半侧：只读 API（health/collections/items/item/pdf/citations/maintenance/open）、`/app/*`、`/pdfjs/*` 静态 |
| `client.js` | Client 半侧：`main` 全页工作台 + `sidebar.panellist` 入口 + 右栏 tab + postMessage 对话桥 |
| `web/` | 阅读器应用：`?mode=workspace` 全页工作区 / `?mode=sidebar` 紧凑阅读器；`lib/` 含 api、pdf-viewer（批注层）、host-bridge、workspace-app、sidebar-app |
| `locale/en.json`、`locale/zh.json` | 插件管理器中的名称与描述 |
| `icon.svg` | 图标（同仓库 `assets/icon.svg`） |
| `test/host-routes.test.mjs` | Host 路由测试（node:test，mock ctx + 真实 Zotero 只读联调） |

## 安装 / 更新 / 卸载

前置：Node 24+、Zotero 已启动、DSH 已安装 `dsh-better-sidebar`。

研究任务另需 Python 3 与本机已登录的 Codex CLI。首次使用前，从维护仓库根目录运行：

```sh
python3 scripts/setup-research.py
```

脚本为 TextFold 0.10.40 建立隔离运行环境，不下载模型或 OCR 引擎。研究任务由 DSH 共用的 Zotero Workbench 服务调用本机配置的 Codex CLI，**不调用 DSH 原生模型**；模型选择与额度取决于这台机器上的 Codex CLI 配置。若自动发现不到 CLI，可设置 `ZOTERO_WORKBENCH_CODEX` 指向其可执行文件。此准备步骤只影响研究任务，其余工作台能力仍可单独使用。

```text
在 DSH 会话中让代理调用 plugin_manager:
  install_bundle, target = <维护源码>/integrations/dsh 的绝对路径
```

当前机器为 `~/plugins/zotero-workbench/integrations/dsh`。安装后：

1. 左侧边栏出现「Zotero 工作台」→ 打开全页工作区；右栏 `+` → 「Zotero 文献」→ 紧凑阅读器；
2. 模型侧工具以 `mcp__zotero_workbench__<tool>` 命名（当前 44 个；0.12.0 新增 `research_materials`、`start_research_job`、`research_job`、`cancel_research_job`）；
3. 插件管理器可见、可禁用、可移除（`remove_bundle`）。

更新：改 `index.js` 后禁用/再启用 bundle 重载 Host 模块；改 `client.js` 由 HMR 重载；`web/` 静态文件按请求读盘（刷新 iframe 即可）。**换机器/移动仓库**必须改 `cordis.patch.yml` 里 node、`src/server.mjs`、`cwd`、PATH 四项绝对路径。该目录含本机路径，私有候选包打包时整体排除（见 `scripts/package-candidate.py`）。

## 使用

### 全页工作台（左侧入口）

- **左导航**：全部文献（计数）、信息检查（未归类 / 缺少 DOI / 缺少 PDF，服务端扫描缓存 120s）、分类树、保存的搜索。
- **列表**：搜索（标题/作者/年份，可切换「全文与笔记」）、排序、每行 checkbox + PDF 徽章、分页加载；支持多选，底部操作条「已选 N 项」+ **[加入对话] [提问] [清除]**（跨导航保留勾选）。
- **详情栏**：元数据（类型/作者/期刊/年份/语言/DOI/集合/标签/PDF）、摘要、批注列表、笔记；按钮 [阅读 PDF] [查看批注] [引用与导出] [在 Zotero 中显示]。
- **条目与引用**：对选中条目生成 BibTeX / BibLaTeX / RIS / CSL-JSON / 纯文本（APA/Chicago/MLA 近似），一键复制。
- **PDF 阅读**：页内阅读，页码/缩放/适合宽度；叠加 Zotero 真实批注矩形（黄/绿/红/蓝/紫/品红/橙/灰），点击矩形弹出浮层（原文、comment、页码、颜色条、[在 Zotero 中显示]、[复制原文]）。

### 研究工作台（0.12.0）

- **我的标注**：当前选择的文献或分类（含子分类）逐页读取。原文摘录、阅读者备注、独立笔记分开呈现；勾选后才会把相应来源 ID、指纹及内容交给本机 Codex CLI。生成的论文段落/综述逐段链接回已选材料，无法由这些材料支持的部分列为证据缺口；语义判断仍由研究者核对。
- **TextFold**：按单篇 PDF 启动完整全文阅读，生成「主题、结论、要点、关键原句、全文」层级；AI 概括与 PDF 原句分开标记，并可按页回跳。任务进度、取消与错误可见。无可读 PDF 文本、扫描页缺 OCR、漏页或 PDF 变化时明确失败，不用摘要或首句替代全文。
- **本机缓存**：任务来源与结果保存在 `~/.local/share/zotero-workbench/research/`（也可用 `ZOTERO_WORKBENCH_STATE_DIR` 改位置），目录/任务文件权限分别为 `0700`/`0600`。缓存会包含勾选标注、草稿以及 TextFold 派生结果；TextFold 的全文层保留提取出的原文。已完成任务目前不会自动过期。它不是独立文献数据库，也不会写回 Zotero。

**实现与验收状态**：研究界面和后台任务服务已接入；每台机器仍须确认 Codex CLI 已登录、TextFold 环境已安装，并确认目标 PDF 可完整提取文本。当前说明不把 DSH 原生模型、扫描 OCR、或所有宿主/模型/PDF 组合的真实验收算作已支持能力。

### 对话桥（加入对话 / 提问）

- 两个界面里的按钮都通过 iframe 同源 `postMessage` 交给 `client.js`，由它写入**当前会话输入框**（`uiSession.adapter.current` → `props.inputActions` / `conversation.input`）：
  - **加入对话**：把选中条目格式化为「标题（作者·年份）— `zotero://select/library/items/KEY`」追加到输入框（保留已有引用 chip），不自动发送；
  - **提问**：把问题 + 选中文献上下文（标题/作者/年份/摘要片段，必要时含批注原文）写入并**自动发送**，随后切回会话面板查看回答；
  - 当前没有打开的会话时，返回明确错误提示（按钮仍可复制到剪贴板）。
- 非 DSH 环境直接打开 `/zotero-workbench/app/` 时自动降级为「复制」模式，不报错。

### 右栏阅读器

右侧边栏 `+` → 「Zotero 文献」；紧凑三栏：文库/搜索/集合 + PDF（单页渲染）+ 真实批注列表；顶部有「打开完整工作台」按钮切到全页模式。

### 引用角标（逐字引文 → 原文）

研究任务里，模型按协议先 `read_fulltext`/`find_in_pdf` 取逐字原文与物理页（文本乱码/缺字时用 `read_page_text` 读 poppler 干净文本），再调用 `register_citation` 验证；验证通过才在正文写上标角标 `[N](https://zotero-wb.invalid/c/<citationId> "题名")`（同一文献一条回复内复用同号）。点击角标由 `dsh-better-sidebar` 拦截，打开右栏「Zotero 文献」tab 并把 citation id 交给阅读器：定位到对应 PDF 页，按登记时的 `rects` 画橙色临时高亮 + 闪烁，浮层显示引文/题名/页码，可切换同文献的多处引文、在 Zotero 中显示、复制原文（存为 Zotero 批注需 Zotero 10，当前置灰）。回答末尾用 `citation_source_list` 生成「来源」区，保留 `zotero://open-pdf/...` 深链。锚点持久化在 `~/.local/share/zotero-workbench/citations/registry.jsonl`（默认 5000 条 / 90 天）。中文 PDF 的 pdfjs 文本缺失时自动回退 poppler `pdftotext -bbox`。

工作台布局（P2 加固）：桌面宽屏下左右两栏都可点顶栏「导航」「详情」收起，也可拖动 6px 分隔条调宽（左 160–420 / 右 240–560，双击复位，键盘 ←/→ 16px、Home/End 到极限），宽度与折叠状态存在 `localStorage` 的 `zotero-workbench:workspace-layout:v1`，刷新/切换视图不丢；≤980px 回到浮层抽屉。「紧凑模式」通过宿主桥打开右栏阅读器，不再把工作台 iframe 自身跳转。角标定位状态机已按并发/重入审计加固：同一 nonce 的重发只处理一次、关闭浮层会使在途请求作废、越界页码立即报错、跨条目定位不会丢浮层内容。

![角标跳转后的引文高亮与浮层](web/docs/citation-reveal-highlight-1440.png)

## Host API（浏览器同源）

除打开操作和专用批注备注接口外，以下浏览器 API 只读，不修改 Zotero 数据。

| 路由 | 说明 |
| --- | --- |
| `GET /zotero-workbench/api/health` | `{ok, version, zotero:{reachable, version}, writes:{annotations, reason}}` |
| `GET /zotero-workbench/api/collections` | `{libraries, collections[], savedSearches}`（个人文库；组库标 `supported:false`） |
| `GET /zotero-workbench/api/items?q=&collection=&sort=&start=&limit=&mode=` | 条目列表；`mode=everything` 全文搜索；limit ≤ 100 |
| `GET /zotero-workbench/api/item?key=K` | 条目全量 + attachments（含 size/isPdf）+ notes + annotations（含 `rects`/`pageIndex`/`pageLabel`/`color`/`sortIndex`/`type`/`tags`） |
| `GET /zotero-workbench/api/citation?id=<12hex>` | 引文登记记录（含 `rects`、quote、题名/作者/年份、`zotero://` 深链） |
| `GET /zotero-workbench/api/citations?itemKey=K` | 同一文献的引文登记列表（角标多引文切换） |
| `GET /zotero-workbench/api/pdf?key=K` | `application/pdf`，支持 GET/HEAD、Range（206/416）、ETag/304 |
| `GET /zotero-workbench/api/citations?keys=K1,K2&format=bibtex\|biblatex\|ris\|csljson\|text&style=apa` | 引用/导出（keys ≤ 200，逐条只读生成） |
| `GET /zotero-workbench/api/maintenance?view=unfiled\|missingDOI\|missingPDF&offset=&limit=` | 信息检查；服务端扫描 + 120s 缓存，返回总数/分页/truncated |
| `POST /zotero-workbench/api/open` | `{kind:'item'\|'pdf', key, attachmentKey?, page?, annotationKey?}` → 打开 `zotero://select/library/items/...` 或 `zotero://open-pdf/library/items/...?page=&annotation=`；`ZOTERO_WORKBENCH_DSH_OPEN=0` 时只返回 URL 不启动（测试用） |
| `POST /zotero-workbench/api/research` | `action=materials\|start\|status\|cancel`；材料读取为只读，启动/取消仅管理本机研究任务并保存私有任务缓存，不写 Zotero；AI 任务调用本机已配置的 Codex CLI |
| `POST /zotero-workbench/api/annotation-comment` | 只支持读取/更新指定个人库 PDF 下的既有批注备注；更新需带短期 editToken、expectedVersion、expectedComment，并写后回读。不会新建笔记或批注；结果未知时不自动重试。只读核对请求不返回编辑 token |
| `GET /zotero-workbench/app/*` | 阅读器静态资源（`web/`） |
| `GET /zotero-workbench/pdfjs/*` | 仓库 `dist/pdfjs/` 的 cmaps/字体/wasm（pdf.js build 缺失时前端回退 `web/vendor/pdfjs/`） |

安全：所有路由先过 `ctx.connection.requestRejection` 围栏（Host/Origin + DSH 会话 cookie），再按 `webServer.getOrigin()` 做 Host 白名单（防 DNS rebinding）；PDF 只从 Zotero 条目 enclosure 读取（realpath 限制在 Zotero storage 内 + `%PDF-` 头校验）；静态路由拒绝 dot-segment/符号链接穿越；`/api/open` 只允许两种 `zotero://` URL 且严格校验 key/page。批注备注接口只对精确 annotation/PDF 身份做版本保护的 `annotationComment` 修改；所有响应 `Cache-Control: no-store`。

## 已知限制

- **只支持个人文库**：`library=g<id>`（组库）返回 501；组库深链格式已在 `zotero://` 研究中记录，后续可扩展。
- **链式文件（linked_file）** 位于 `~/Zotero/storage` 之外时 `/api/pdf` 返回 403；把其根目录加入 `storageRoots`/`ZOTERO_STORAGE_DIR` 后可读。
- **引用格式**：BibTeX/BibLaTeX/RIS/CSL-JSON 为插件内生成（无 CSL 样式引擎）；`text` 为 APA/Chicago/MLA 近似，`style` 仅回显；如需精确样式仍用 MCP 的 `cite`/`export_bib`（Zotero 样式引擎）。
- **信息检查**：单次扫描上限 5000 个 top-level 条目（超大库 `truncated:true`）；首次扫描约 1 秒，缓存 120s。
- **批注叠加**：坐标系公式在 rotate=0/userUnit=1 PDF 上用 28 条真实批注验证（IoU 0.765，pdfplumber F1 0.965）；旋转页/userUnit≠1 走 `viewport.convertToViewportPoint` 通用路径，未用真实文件实测。
- **PDF 阅读器单页渲染**（非连续滚动）；`nextPageRects` 跨页批注不画在当前页。
- **在 Zotero 中显示** 为 macOS `open` 实现（其他平台返回 `open_failed` JSON）；自动化测试中通过 `ZOTERO_WORKBENCH_DSH_OPEN=0` 验证 URL 而不真正唤起 Zotero。
- **对话桥** 依赖 DSH `uiSession`/`conversation` 客户端服务；无当前会话时按钮降级为错误提示/复制。
- 依赖 `dsh-better-sidebar`（仅右栏 tab；全页工作台不依赖它）。
- 阅读器只读：个人高亮写入仍用 MCP 工具 `create_reader_highlight`（Zotero 10 支持），AI 证据高亮必须经 `review_evidence` 审计。

## 验证

```sh
# Host 半侧单元/联调（要求 Zotero 在运行；Zotero 关闭时真实数据用例自动 skip）
node integrations/dsh/test/host-routes.test.mjs      # 34 项

# 浏览器侧（不经过 DSH）：mock 数据 / 真实文库代理
node integrations/dsh/web/dev-server.mjs             # mock（含真实批注 rects）
node integrations/dsh/web/dev-server.mjs --mode live # 真实 Zotero（只读）

# DSH 进程内（已安装后，带会话 cookie 的浏览器）：
curl -H 'Host: 127.0.0.1:<port>' http://127.0.0.1:<port>/zotero-workbench/api/health
```

历史验证（2026-10-28，DSH 0.2.1-rc.3 + Zotero 9.0.6；仅覆盖当时列出的既有工作台、对话桥、PDF 与引用功能，不覆盖 0.12.0 研究任务）：

- Host：34/34 测试通过（原 27 + citations/maintenance/open/批注 rects 7 项）；Zotero 关闭 16 pass / 18 skip / 0 fail。
- 真机 GUI（headless Chrome + 合法会话 cookie）：左栏「Zotero 工作台」→ 全页工作区；多选 3 项 → 加入对话 → 输入框出现 3 条带 `zotero://` 的引用；提问 → 自动发送并切回会话；PDF 第 2 页叠加 36 个批注矩形（28 条批注），点击弹出浮层；引用导出生成真实 BibTeX。截图见 `docs/` 与 `web/docs/`。
- 右侧栏阅读器仍正常（`dsh-better-sidebar` tab）。
