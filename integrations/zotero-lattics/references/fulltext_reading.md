# 原文读取与复用

## 目的

让模型拿到足够的原文，减少片段诱导和重复提取。Markdown 是阅读副本，PDF 是证据真值源；缓存、文本送达记录、模型理解和用户确认是不同状态。程序无法证明模型认真阅读或理解正确。

## 工具入口（Agent 执行，用户不用记命令）

### 项目位置与跨 Agent 接手

先确定论文所属研究项目，读取其已有目录约定。根目录 `.zotero-lattics.json` 是唯一位置登记，只保存项目内相对路径，可随项目移动。优先复用已有文献目录，不硬编码某篇论文或文件夹编号，也不把本 Skill 开发项目误作所有论文缓存的归属。

```bash
python3 scripts/read_zotero_paper.py init-project --project-root 研究项目根 --cache-dir 既有文献目录/Zotero阅读缓存
python3 scripts/read_zotero_paper.py list-papers --project-root 研究项目根
```

没有合适文献目录时省略 `--cache-dir`，使用项目内 `Zotero文献缓存`。已有登记重复初始化会复用；传入另一位置会报冲突，不自行迁移。首次登记后在既有项目 README/PATH 补一条缓存入口，后续 Agent 无需猜位置。没有项目时才明确使用 `--standalone`；研究任务不得静默退回全局缓存。`--cache-root` 保留为测试/旧调用的显式覆盖，不用于绕开已登记的研究项目。

实际文件组织如下（无需预建空目录）：

```text
研究项目/.zotero-lattics.json                 # 登记缓存相对位置
研究项目/既有文献目录/Zotero阅读缓存/
  papers/库ID/父条目KEY/附件KEY/PDF指纹-解析版本/
    paper.json                              # 原文、页码、块和身份
    fulltext.md                             # 完整阅读副本
    readings/独立ID.json                     # 各 Agent 来源理解和阅读进度
```

接手先 `list-papers`，找到对应条目后 `inspect` 看现有阅读记录。列表返回相对缓存根的路径，不会批量读全文或检查全库 PDF；进入 `read`/`inspect` 时才检查该 PDF 指纹。PDF 改变会生成独立版本，旧理解卡保留但不作为新 PDF 的阅读基础。项目移位仍可发现缓存；换机器后若 Zotero PDF 路径变化，通过 MCP 取得新的真实路径再 `prepare`，不能凭缓存绝对路径猜测。

原文提取使用完整文件原子替换；阅读记录使用独立文件名，不靠多人追加一个大索引。两个 Agent 同时准备同一 PDF 可少量重复提取，但不会写入半截结果；并发笔记互不覆盖。不同研究项目的数据默认隔离，不自动把某个项目的论证判断传播给其他项目。

脚本位于本 Skill 的 `scripts/read_zotero_paper.py`，需要 Python 3 和 PyMuPDF。先通过 Zotero 锁定父条目和 PDF 附件，取得真实本地 PDF 路径，不猜附件目录。命令中的标识和路径均须替换为真实值：

```bash
python3 scripts/read_zotero_paper.py prepare --project-root 研究项目根 --pdf PDF路径 --item-key 父条目KEY --attachment-key 附件KEY
python3 scripts/read_zotero_paper.py inspect --paper prepare返回的paper路径
python3 scripts/read_zotero_paper.py read --paper paper路径 --max-chars 16000
python3 scripts/read_zotero_paper.py read --paper paper路径 --cursor 上次next_cursor --max-chars 16000
python3 scripts/read_zotero_paper.py read --paper paper路径 --pages 4-7
python3 scripts/read_zotero_paper.py read --paper paper路径 --section s2
```

有群组库时传实际 `--library-id`。显式项目根最稳妥；在已登记项目的子目录中运行时也可向上自动发现登记。不复制、不改动原始 PDF；同内容再次使用复用缓存，每次读取检查 PDF 内容指纹。只有明确 `--standalone` 才使用 `~/.agents/state/zotero-lattics/papers/`。

`prepare` 返回完整 Markdown 与 `paper.json`。JSON 保留原生文本块 `source_text`、物理页码、块 ID 和参考坐标；Markdown 不做模型改写、OCR 或自动纠错。块不一定等于学术段落。PDF 原生顺序也可能错列，双栏、表格、扫描页和文字异常须检查原页图像。复杂版面可使用已有解析工具辅助阅读，但其结果不能直接替代坐标凭证或原始摘录。

`inspect` 提供 PDF 书签章节。章节读取覆盖边界整页，可能含下一节开头，以免漏掉同页结尾。没有书签时诚实使用页码/块导航；不把猜测的章节结构当成已识别。无文字/少文字页显式告警，不能把空输出当作已读完扫描页。

## 怎样读才有用

1. 已明确引用的文献：直接锁定，不先全库语义搜索。尚在选文献：多路召回后读候选摘要，优先读有希望的少量文献；摘要未提及不等于正文不存在，也不能仅因研究对象不同就否定理论用途。
2. 首次正式采用普通论文：先看全篇结构，分批读正文，包括研究问题、方法、结果、讨论和限制；参考文献列表不必逐条精读。长篇报告/书籍：读目录、摘要/导言/结论和完整相关章节，记录未读部分，不声称通读全书。正文与候选段矛盾时继续回查，不选最顺眼的一句。
3. `read` 按整块分页，可能超过预算以免切断原文。沿 `next_cursor` 继续，保持相同 pages/section 参数；工具外层也可能截断，须确认实际返回的块已完整可见。`selection_end_reached=true` 只表示该次选择到末尾，不表示之前的块都被读过。为理解卡记录实际见到的页/块范围、遗漏及版面问题。
4. 阅读后用自己的话概括作者研究什么、主要发现、限定和证据性质，再单独评估正文论断。保存的概括不能替代 Judge/Challenger 回读必要原文。没有读到的内容标“未检查”；“明确未证明”须有范围依据或作者明确限定。
5. 同篇文献在一篇稿中出现多次：全文提取和来源理解可复用，逐处核对正文责任及原文。不同论文、不同论断不能复用“支持”的旧结论。

### 保存可接手的阅读基础

阅读一篇或一个有意义的阶段后，用以下入口保存理解卡；不要每次工具调用就生成一份笔记：

```bash
python3 scripts/read_zotero_paper.py save-reading --paper paper路径 --input 阅读卡JSON --agent 当前Agent标识
```

输入必含 `summary`（来源自身的研究问题/主要命题）与 `read_block_ids`（实际读到的块 ID 列表），可补 `main_findings`、`limitations`、`unread_ranges`、`open_questions`、`source_claims`、`model`、`supersedes`（明确纠正哪份记录）。方法、限定和摘录关联具体页/块，不把目标论文结论塞进来源卡。

工具自动绑定文献身份、PDF SHA-256、解析版本、Agent、时间和 `ai_unverified` 状态；只检查标识存在，不证明读过或判断正确。引用裁决和人工确认不混入来源理解卡。相互矛盾的记录按原文解决，不以更新时间较新或 Agent 较多投票决定；要做盲读的 Source Reader 不加载旧目标裁决或其他 Reader 的解释，只加载原文。其他 Agent 可读取这些普通 JSON/Markdown，不依赖 Codex 的私有会话记忆。

本次引用的判断包、locator 和完成/未完成状态按已有项目任务记录位置保存；通用审计脚本的全局运行台账保留兼容，不作为跨 Agent 研究基础的唯一入口。历史全局文件不自动搬移或删除。

## 从原文块回到 PDF

选定证据后，直接从 JSON 的 `source_text` 复制连续原文作为 `fragment.source_text`，可去首尾空白，不能重新翻译、补字或改标点。再调用：

```bash
python3 scripts/read_zotero_paper.py locate --paper paper路径 --block-id p0004-b0002 --text 判断包中完全相同的原文
```

脚本验证摘录确属该块，再调用原有精确定位器，返回原格式凭证，不写 Zotero、不签发语义许可。多块/多页证据分别建立片段，不能拼接成假的连续引语。完整证据跨句段时保留所有必要片段，高亮应覆盖限定，不为缩短摘录丢失转折、否定和条件。定位失败检查原页及抽取质量，不用近似文本强行通过。

此后保持既有 `issue → preflight-bind → MCP dryRun → 授权写入 → 回读 annotation → 回链` 流程。PDF 指纹、来源原文、审计与 locator 始终对应同一份材料。

## 效果验收

机械测试只证明读取、分页、缓存和定位接口可用。真实语义效果另测：相同模型、相同题目分别采用片段、全文和全文加独立复核；包括错误引用和合理改写/理论引用，预先由用户确认可接受范围。记录误放行、误拒绝、修复质量、总耗时、冷/热缓存差异和人工核查负担，不用模型自评百分数充当准确率。保留未参与规则设计的新案例。
