# Reader web app（DSH 侧边栏阅读器前端）

纯静态、无构建步骤、无第三方框架的 ES modules 应用。由 DSH 插件 Host half 以同源 iframe 加载
`/zotero-workbench/app/`，数据只来自 Host half 的只读 API（`/zotero-workbench/api/*`），PDF 渲染
使用宿主路由提供的 pdf.js。

两种形态（入口 `app.js` 按 `?mode` 分流）：

- `/zotero-workbench/app/`（默认 sidebar）：DSH 右栏紧凑阅读器；顶栏「打开完整工作台」按钮向宿主
  发送 `open-workspace`（独立打开时新标签页打开 workspace）；
- `/zotero-workbench/app/?mode=workspace`：全页工作区 —— 左侧导航、中间列表/PDF 阅读、
  右侧详情栏，多选后 [加入对话] [提问]，「条目与引用」tab 生成/复制引用；桌面宽屏两栏可折叠、
  可拖拽调宽（≤980px 为 overlay 抽屉）；「紧凑模式」通过宿主 `open-compact-reader` 在右栏打开阅读器。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 应用骨架（顶栏 / 文库 / 阅读区 / 批注面板 / 启动遮罩） |
| `app.css` | 全部样式：三栏布局、DSH 主题变量适配、PDF 舞台与文字层、批注面板、骨架屏/空态/错误态 |
| `app.js` | 入口分流：按 `?mode` 动态加载 sidebar / workspace |
| `lib/sidebar-app.js` | sidebar 模式：状态机、文库树、搜索防抖、分页、条目详情、批注面板、键盘、选中复制、错误处理 |
| `lib/workspace-app.js` | workspace 模式：全页布局、多选操作条、详情栏、引用 tab、PDF 阅读 + 批注浮层、提问弹窗 |
| `lib/host-bridge.js` | DSH 宿主 postMessage 桥：ready 重试握手（500ms × 10）、add-to-chat/ask/open-zotero/open-workspace、ack 回执、独立模式降级 |
| `lib/normalize.js` | Host API 数据归一化（条目/详情/批注 rects/集合）与 zotero:// 深链构造 |
| `lib/theme.js` | 同源 iframe 内读取父页面 `--dsw-alias-*` 主题变量；MutationObserver 跟随 DSH 切换；跨域/读不到时用 `prefers-color-scheme` 兜底 |
| `lib/pdf-viewer.js` | pdf.js 双路径加载（宿主 build → 应用内 vendor 兜底）、worker 同源切换、按页渲染、DPR 适配、文字层、翻页/缩放、批注矩形层、临时引文高亮层（`.pdf-quote-highlight`） |
| `lib/citation-reveal.js` | 角标跳转定位：宿主 `reveal-citation` → 拉引文/同文献列表 → 打开 PDF 页 → 橙色临时高亮 + 浮层（多引文切换、在 Zotero 中显示、复制原文、存为 Zotero 批注占位） |
| `lib/dom.js` | DOM/转义/图标/复制/轻提示等小工具 |
| `dev-server.mjs` | 本地 mock 服务器（Node 标准库），把 `/zotero-workbench/app`、`/api/*`、`/pdfjs/*` 按契约映射出来 |
| `dev-mock.mjs` | mock 数据（12 个条目 / 5 个分类 / 批注 / 笔记，含真实 PDF 文件） |
| `dev-live.mjs` | `--mode live`：代理本机真实 Zotero 本地 API（只读）与 `~/Zotero/storage` 里的 PDF；含 citations/maintenance/open 的 dev 实现 |
| `dev-export.mjs` | dev 用引用生成器（BibTeX/BibLaTeX/RIS/CSL-JSON/近似 APA 文本），mock 与 live 共用 |
| `vendor/pdfjs/` | pdfjs-dist@6.3.289 的 minified 兜底构建（Apache-2.0，详见其 README.txt） |
| `docs/` | 自测截图（600×800 窄侧边栏 / 1100×800 宽屏 / 深色抽屉） |

## 响应式：窄侧边栏（DSH 右栏默认约 600px）

- **> 980px**：三栏 —— 282px 文库 + 阅读区 + 批注面板（批注默认展开）。
- **≤ 980px**：批注面板改为右侧 overlay（默认收起，用顶栏批注按钮切换）。
- **≤ 760px**：文库面板改为左侧 drawer（默认收起）：
  - 顶栏左侧出现「文库」图标按钮（`aria-label="展开文库"`，aria-expanded 同步）；
  - 抽屉以 overlay + 半透明遮罩覆盖阅读区，不挤压 PDF；点遮罩 / Esc / 选中条目后自动收起；
  - 阅读区占满 100% 宽度，PDF 始终「适合宽度」，工具栏允许换行；
  - 收起抽屉时给文库面板加 `inert`，不在 Tab 顺序里。
- 用 `@media (max-width: 760px)` 断点实现：iframe 内 viewport 就是 DSH 容器宽度，无需读取父窗口尺寸。
- DOM 诊断：`#app[data-boot="ready"]` 表示启动完成（`loading` / `error` 分别对应连接中 / 启动失败）。

## 本地自测

```sh
# 在仓库根目录
node integrations/dsh/web/dev-server.mjs
# 打开 http://127.0.0.1:8787/  （会跳转到 /zotero-workbench/app/）

# 真实文库（需要 Zotero 已启动）：
node integrations/dsh/web/dev-server.mjs --mode live

# 验证「宿主没有提供 build/ 时前端自动回退 vendor pdf.js」：
DEV_PDFJS_BUILD=missing node integrations/dsh/web/dev-server.mjs

# 指定 mock PDF（默认自动挑选 ~/Zotero/storage 里的一份真实 PDF）：
node integrations/dsh/web/dev-server.mjs --pdf /path/to/file.pdf

# 验证错误态：API 全部 503
MOCK_API_FAIL=1 node integrations/dsh/web/dev-server.mjs

# 验证 DSH 父页面主题同步（同源父页面里嵌入 iframe，可切 light/dark）：
#   http://127.0.0.1:8787/dev/theme-host?theme=dark
```

开发夹具（dev-server）：

- `http://127.0.0.1:8787/dev/host-fixture?mode=workspace|sidebar[&reveal=<12hex>][&early=1][&itemKey=K]`：
  模拟 DSH 父页面（延迟 700ms 回 hello 验证 ready 重试、对四类消息回 ack、记录 `window.__HOST_LOG__`、
  收到 open-workspace 后切换 iframe）；带 `reveal` 时向 iframe 发 `reveal-citation`（`early=1` 在
  app 早期监听就绪后立即发，用于验证早队列），顶部还有「定位引文 1/2」按钮。
- `http://127.0.0.1:8787/dev/theme-host?theme=dark&mode=workspace`：父页面注入 `--dsw-alias-*` 主题
  变量并切换 light/dark，验证 iframe 主题跟随（sidebar / workspace 均支持）。

断点自测（Chrome DevTools 或 headless）：

| 视口 | 期望 | 截图 |
| --- | --- | --- |
| 600×800 | 文库收起，顶栏出现「文库」按钮；阅读区 100%；PDF 适合宽度；无横向溢出 | `docs/screenshot-narrow-600-reading.png`、`docs/screenshot-narrow-600-library.png` |
| 1100×800 | 三栏布局，批注面板展开，PDF 可读 | `docs/screenshot-wide-1100-annotations.png` |
| 600×800 + 深色 | 主题变量跟随父页面 / 系统主题；抽屉与面板颜色协调 | `docs/screenshot-narrow-600-dark-library.png` |
| 1440×900 workspace | 列表 + 详情栏 + 多选操作条 | `docs/workspace-main-1440.png` |
| 1440×900 引用 tab | BibTeX 输出 + 复制 | `docs/workspace-citations-1440.png` |
| 1440×900 批注对齐 | 真实 28 条批注 / 30 个矩形压住文字（放大核对用） | `docs/workspace-annotations-zoom-1440.png`、`docs/workspace-reader-annotations-1440.png` |
| 1440×900 真实文库 | live 模式真实 Zotero 批注 + 矩形（覆盖 99.5%） | `docs/workspace-live-annotations-1440.png` |
| 1440×900 浮层 | 点击批注矩形的浮层与「在 Zotero 中显示」 | `docs/workspace-annotation-popover-1440.png` |
| 1440×900 宿主桥 | DSH 父页面模拟：握手/加入对话/提问 ack | `docs/workspace-bridge-1440.png` |
| 1100×800 workspace | 三栏紧凑布局，无横向溢出 | `docs/workspace-1100.png` |
| 600×800 workspace | 列表 / 阅读 / 导航抽屉 / 详情抽屉 / 深色 | `docs/workspace-600-list.png`、`workspace-600-reading.png`、`workspace-600-nav.png`、`workspace-600-detail.png`、`workspace-600-dark-reading.png`、`workspace-600-dark-theme.png` |
| 角标定位 | 橙色引文高亮 + 浮层 + 多引文切换 + workspace + live | `docs/citation-reveal-highlight-1440.png`、`citation-reveal-popover-1440.png`、`citation-reveal-multi-1440.png`、`citation-reveal-workspace-1440.png`、`citation-reveal-live-1440.png` |
| 角标定位修复（task-19） | 正常定位/浮层、跨条目 reveal 浮层有内容、关闭后重发不弹回 | `docs/citation-reveal-fixed-highlight-1440.png`、`citation-reveal-fixed-popover-1440.png`、`citation-reveal-fixed-cross-item-1440.png`、`citation-reveal-fixed-closed-1440.png` |
| 工作区布局 | 收左栏 / 收右栏 / 左右都收 / 拖拽调宽（320+480） | `docs/workspace-layout-collapsed-left-1440.png`、`workspace-layout-collapsed-right-1440.png`、`workspace-layout-both-collapsed-1440.png`、`workspace-layout-resized-1440.png` |

## 全页工作区（?mode=workspace）

- **布局**：顶栏（Zotero · [文库与阅读][条目与引用] · 连接状态/刷新/紧凑模式）+ 左侧导航
  （全部文献 / 信息检查：未归类·缺少 DOI·缺少 PDF / 分类树 / 保存的搜索）+ 中间列表或阅读区 + 右侧详情栏。
- **多选与对话**：每行 checkbox、全选本页、底部「已选 N 项」操作条（加入对话 / 提问 / 清除）；
  加入对话文本格式 `标题（作者·年份）— zotero://select/library/items/KEY`（多条目每行一条）；
  提问 context 含标题/作者/年份/期刊/摘要片段 + 当前 PDF 页批注原文。
- **详情栏**：[阅读 PDF] [查看批注] [引用与导出] [在 Zotero 中显示] + 元数据/摘要/批注/笔记；
  点批注会在中心区打开阅读视图并跳到对应页。
- **PDF 阅读**：单页渲染 + 页码/缩放/适合宽度；叠加 Zotero 真实批注矩形（颜色取 `annotation.color`）。
  点击矩形弹出浮层：原文、comment、页码、颜色条、[在 Zotero 中显示]、[复制原文]。
- **批注矩形坐标**（与 `annotation-coords` 的 RECTS.md 一致）：`annotationPosition.rects` 是 PDF
  用户空间坐标（原点左下、y 向上、单位 pt）；用 `viewport.convertToViewportPoint(x1,y1)` /
  `(x2,y2)` 取 min/max 得到 CSS px（canvas 位图 ×DPR，但 DOM overlay 不再乘 DPR）。跨页
  `nextPageRects` 属于 pageIndex+1，不在当前页绘制。
  自测：mock 真实 28 条批注页 30 个矩形 30/30 命中文字，平均水平覆盖 97.6%；live 真实条目
  FNSD5FSA 页 6/6 命中、平均覆盖 99.5%（见 `docs/workspace-annotations-zoom-1440.png`、
  `docs/workspace-live-annotations-1440.png`）。
- **引用与导出**：已选条目 → `/api/citations`，支持 BibTeX / BibLaTeX / RIS / CSL JSON / 纯文本
  （APA 等 style），文本区可复制；未选条目时给出引导。
- **信息检查**：`/api/maintenance` 三视图，服务端分页；条目仍可打开详情/加入对话。
- **响应式**：>980px 三栏；≤980px 详情栏变右侧抽屉；≤760px 导航变左侧抽屉、列表/阅读占满宽度。

### 桌面左右栏：折叠 / 拖拽调宽 / 持久化

- 顶栏「导航」「详情」按钮在**所有宽度可见**（`aria-pressed` 反映展开状态）；>980px 点击折叠对应栏，
  ≤980px 点击切换 overlay 抽屉。
- 两栏内侧各有一条 6px 拖拽条（`role="separator"`、`aria-orientation="vertical"`、`tabindex=0`、
  `aria-valuenow/min/max`）：Pointer Events 拖动调整宽度（左栏 160–420px，右栏 240–560px），
  双击恢复默认 224/304，键盘 `←/→` 16px、`Home/End` 到极限；导航底部「重置布局」恢复全部默认。
- 宽度由 `--ws-nav-width` / `--ws-detail-width` CSS 变量驱动 grid（5 列：导航 | 手柄 | 中间 | 手柄 | 详情），
  折叠时列宽/手柄列归零并隐藏内容，grid-template-columns 平滑过渡。
- 拖拽时 `body.resizing`：禁用面板/中间区 pointer-events（避免画布/iframe 抢事件）、全局
  col-resize 光标、禁止选中文字；Pointer Capture 保证快速拖到边缘也不丢事件。
- localStorage `zotero-workbench:workspace-layout:v1` 保存 `{navWidth, detailWidth, navCollapsed,
  detailCollapsed}`，刷新/重开恢复；窗口 resize 时自动把两栏宽度限制在可视区（中心至少 300px），
  `view-citations` 切回 library 保留原宽度与折叠状态。
- ≤980px 不渲染拖拽条，回到 overlay 抽屉（900/760 宽按钮可打开导航与详情抽屉）。

验证（headless Chrome 1440 宽）：默认 224/304、收左栏、收右栏、左右都收、拖拽到左 320 / 右 480、
键盘 ArrowRight 与 End、双击/重置布局、刷新后恢复 300/460、citations 往返（折叠态与展开态都恢复）、
600/900/1100 窄屏抽屉、无横向溢出、无 console error。截图：
`docs/workspace-layout-collapsed-left-1440.png`、`docs/workspace-layout-collapsed-right-1440.png`、
`docs/workspace-layout-resized-1440.png`、`docs/workspace-layout-both-collapsed-1440.png`。

## 与 DSH 宿主通信（postMessage）

iframe 加载后向 parent 发 `{source:'zotero-workbench', type:'ready'}`，每 500ms 重试最多 10 次，
收到 `{source:'zotero-workbench-host', type:'hello', mode:'dsh', capabilities:[...]}` 后停止并标记「对话已连接」。
每条请求带唯一 `id`，宿主回 `{type:'ack', id, ok, message}`：

| 请求 | payload | 用途 |
| --- | --- | --- |
| `add-to-chat` | `{text}` | 追加到当前会话输入框（不自动发送） |
| `ask` | `{question, context}` | 追加并自动提交提问 |
| `open-zotero` | `{kind:'item'\|'pdf', key, attachmentKey?, page?, annotationKey?}` | 宿主打开 zotero:// 深链 |
| `open-workspace` | `{}` | sidebar 模式切到全页工作区 |
| `open-compact-reader` | `{}` | workspace 模式请求宿主在右栏打开紧凑阅读器（不再在 iframe 内直接跳 `?mode=sidebar`） |

非 DSH / 独立打开（dev-server、浏览器直开）没有 hello：相关按钮文案追加「（复制）」，
点击后把文本 / zotero:// 深链复制到剪贴板并 toast，不报错。
深链格式：条目 `zotero://select/library/items/<itemKey>`；
批注 `zotero://open-pdf/library/items/<attachmentKey>?page=<1-based>&annotation=<annotationKey>`。

## 角标跳转定位（reveal-citation）

宿主父页面发送 `{source:'zotero-workbench-host', type:'reveal-citation', payload:{id, nonce}}`
（`id` 为 12hex 引文 id；`nonce` 可选，client 对同一角标重试时必须复用同一 nonce），
sidebar 与 workspace 都会：

1. 拉取 `GET /api/citation?id=` 与 `GET /api/citations?itemKey=`（同文献多处引文）；
2. 打开对应条目的 PDF 到 `pageIndex + 1`（跳页等待该页渲染完成）；
3. 用记录里的 `rects`（PDF 用户空间，和批注同一套 `viewport.convertToViewportPoint` 公式）画
   `.pdf-quote-highlight` 橙色半透明高亮（3 次闪烁动画 + 滚动到首个矩形），与 Zotero 批注颜色区分；
4. 显示底部浮层：`已定位：第 N 页 · 原文已核对`、引文（截断可滚动）、题名/作者/年份/期刊、
   `[在 Zotero 中显示]`（payload `{kind:'pdf', key:itemKey, attachmentKey, page:pageIndex+1}`）、
   `[复制原文]`、`[存为 Zotero 批注]`（默认 disabled，title 说明需要 Zotero 10；
   `health.writes.annotations=true` 时启用，调用 `POST /api/citation/<id>/annotation` 占位并展示错误）；
5. 同文献多处引文：浮层右侧显示「该文献共 N 处引文」下拉 + 上一处/下一处，切换时重画高亮并跳页；
6. 关闭按钮清高亮；切换到其它文献或关闭阅读视图也会自动清理（reveal 自己的加载流程传
   `preserveCitationReveal`，浮层生命周期由控制器管理，不会被 `closeReader` 误 hide）。

**可靠性状态机（task-19 修复，核心）**
- 单调 `requestSeq`：`reveal`/`switchTo` 开头 `++seq`，每个 `await` 后 token 不匹配立即返回；
  `hide()` 同样 `++seq`，因此关闭浮层/切换条目后，在途请求不会重新弹回浮层。
- `nonce` 去重：最近 50 个 nonce；同一 nonce 的重发消息只处理一次，新 nonce 可重新定位；
  用户关闭后 5s 内，同 id 的**无 nonce** 旧式重发也会被忽略。
- 单状态源：`isVisible()` 直接由 `visible && bar && !bar.hidden` 推导；`#activate` 在画高亮、
  滚动的每个 await 后再次校验 token。
- 打开流程串行化：`openCitationInReader` 串成 Promise 链，避免两个并发 reveal 互相 abort
  `selectItem`/`openPdf`；sidebar/workspace 都 `await openPdf()/openReader()` 的真实结果，
  不再用 `state.pdfStatus` 事后判断。
- 越界页：先校验 `pageIndex < viewer.numPages` 再跳页；越界立即报
  「登记页码 N 超出 PDF 共 M 页，请重新登记」，不再轮询 30s，也不会出现「已定位第 999 页」
  但 0 高亮的假成功。`waitForReaderPage` 改为可取消（AbortSignal + 定时器清理）。
- 引用导出竞态：`loadCitations` 返回后比较请求快照与当前 `state.selection`；选择变化会
  abort 在途请求并清空旧输出/提示。`clearSelection` 不再留下旧引用。
- 附件回退：登记 `attachmentKey` 不属于当前条目时回退第一个 PDF，并同步
  `state.reader.attachmentKey`（工具栏下拉与真实加载一致）。
- `visibility` 消息：父页面发 `{source:'zotero-workbench-host', type:'visibility',
  payload:{visible:false}}` 时暂停高亮闪烁等动画（`html.is-page-hidden`）。

**早期消息排队**：`app.js` 在动态 import 之前就安装 host message 早队列；父页面若在
`bridge.start()` 之前发送 `reveal-citation`/`hello` 也会被暂存、启动后回放；若消息在 bridge 已启动但
应用还没 boot 完成时到达，会进入应用层 pending 队列，boot 完成后自动执行（dev 自测用 1200ms 网络延迟
验证：`earlyQueueDrained=1`、`appQueuedFlushed=1`，定位仍成功）。

验证（headless Chrome + `/dev/host-fixture?reveal=<id>&early=1`）：

| 场景 | 结果 |
| --- | --- |
| mock sidebar（真实 PDF + 真实批注 rects） | 打开第 5 页、4 个高亮、文字覆盖 4/4、平均覆盖 97.4%、浮层按钮齐全 |
| 多引文切换 | 第 5 页 → 第 4 页，浮层文案与高亮同步更新 |
| 复制原文 / 在 Zotero 中显示 | 复制 109 字原文；宿主 ack payload `{kind:'pdf', key, attachmentKey, page}` |
| 存为 Zotero 批注 | 默认 disabled（title 需 Zotero 10）；强制 writes=true 时点击返回可读错误 toast |
| workspace 模式 | reveal 自动进入阅读视图并定位（同 sidebar 逻辑） |
| live 真实 Zotero | 真实条目 FNSD5FSA 4 处引文、22 个矩形，物理页 2 / 印刷页 121 |
| 600 / 1100 宽度 | 无横向溢出、浮层可见、无 console error |
| 真机审计回归（task-19） | 原脚本 bug 断言全部 FAIL（不复现）；反转断言全 PASS：并发 reveal 最终 ready/current/highlight 正确、跨条目浮层有内容且 `bar.hidden=false`、关闭后 1.6s 重发不弹回、越界 0.9–3.1s 明确报错无假成功、clear-selection 输出清空；annotation 正确路径命中 501；normal 用例（boot/pick/pdf/reveal-when-closed/rapid nav/tab）全 PASS |

截图：`docs/citation-reveal-highlight-1440.png`、`docs/citation-reveal-popover-1440.png`、
`docs/citation-reveal-multi-1440.png`、`docs/citation-reveal-workspace-1440.png`、
`docs/citation-reveal-live-1440.png`。

## 与 Host half 的契约要点

- `GET /zotero-workbench/api/health` → `{ok, zotero:{reachable, version?}}`；Zotero 不可达时 health 仍 200，
  前端显示「Zotero 未启动」警示但仍保留界面。
- `GET /api/collections?library=user` → `{libraries, collections:[{key,name,parentCollection,itemCount,depth}], savedSearches}`。
- `GET /api/items?...` → `{items:[{key,title,creators:{authors:[名],year},date,itemType,tags,collectionKeys,pdf,numChildren}], nextStart, total}`；
  前端按 `nextStart` 判断是否显示「加载更多」。
- `GET /api/item?key=K` → 扁平 Zotero item JSON（`key/version/meta/data`）+ `attachments/notes/annotations/collectionNames`；
  前端兼容 `item` 别名与顶层两种形状。
- `GET /api/pdf?key=K` → `application/pdf`，支持 HEAD/Range(206)；前端交给 pdf.js 自行按 Range 分块取页。
- `GET /api/citations?keys=K1,K2&format=bibtex|biblatex|ris|csljson|text&style=apa&locale=zh-CN`
  → `{format, style, entries:[{key,itemType,citation?|bib?|ris?|csljson?}], text}`。
- `GET /api/maintenance?view=unfiled|missingDOI|missingPDF&offset=&limit=`
  → `{view,total,offset,limit,items:[{key,title,creators,itemType,hasPdf,hasDOI,collectionsCount}],truncated}`。
- `GET /api/citation?id=<12hex>` → 单条引文记录（`itemKey/attachmentKey/pageIndex/pageLabel/quote/rects/title/authors/year/venue/doi/verifiedAt/zoteroItemUrl/zoteroPdfUrl`）。
- `GET /api/citations?itemKey=<key>&limit=20` → `{itemKey,total,records}`（同一文献多处引文）；
  同一路径不带 itemKey 时仍是导出格式接口（keys+format+style）。
- `POST /api/citation/annotation` → 占位写批注接口（需要 Zotero 10；仅在 `health.writes.annotations=true` 时调用）。
- `health` 可含 `writes:{annotations:false,reason:'requires-zotero-10'}`，前端据此禁用「存为 Zotero 批注」。
- `POST /api/open`（JSON `{kind:'item'|'pdf', key, attachmentKey?, page?, annotationKey?}`）
  → `{ok, url, opened}`；web 在 DSH 内不直接调用它，而是由宿主 ack 后自行打开。
- 非 2xx 一律按 `{error:{code,message}}` 解析并显示可读错误；503 显示 Zotero 未启动提示。

## 安全与边界

- 文库、PDF 和批注浏览只读；全页工作台的批注浮层可编辑既有 Zotero 批注 `annotationComment`，需精确 PDF 身份、短期凭证及版本/旧备注保护，写后回读核实。不会新建笔记或批注，未知结果不重发。右栏紧凑阅读器仍只读。
- 不引用任何外部 CDN / 第三方库；唯一依赖是宿主提供的 pdf.js（以及应用内同版本兜底构建）。
- 所有文库字符串在插入 DOM 前统一 HTML 转义；批注颜色经白名单校验后才写入 CSS 变量；不渲染 Zotero 笔记 HTML（只显示纯文本）。
- 选中 PDF 文字后只提供「复制」气泡（`navigator.clipboard`，失败回退 `execCommand`）。
- 主题：优先父页面 DSH 变量；跨文档访问失败时静默回退，不影响功能。
