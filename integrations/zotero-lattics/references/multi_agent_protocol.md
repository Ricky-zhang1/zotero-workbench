# 多 Agent 引用审查协议

## 目录

1. 何时启动
2. 角色与隔离
3. 并行顺序
4. 输出约定
5. 降级与停止

## 1. 何时启动

FAST 不启用。STANDARD 仅在至少存在两篇独立候选且并行能实质减少等待时启用 Source Reader；这是明确的效率边界，不代表普通引用启用多个裁判。STRICT 才启用独立 Claim Judge 和 Challenger。默认同时最多两个 Source Reader，找到充分证据后取消或不再启动其余候选。

## 2. 角色与隔离

- Orchestrator：读取正文语境、拆原子、确定证据角色、分配候选、整合结果和执行工具；不能自行签发语义合格。
- Source Reader：每人处理一篇候选的全部相关引用；不给正文目标结论，使用不继承完整对话的新上下文（支持 fork_turns 时设为 none）。提供中性主题、真实全文阅读入口和文献身份，按原文读取协议读正文/相关完整章节；输出实际阅读范围、来源命题、限定和有依据的 `explicitly_not_established`。摘要未提及只能记为未检查。
- Claim Judge：取得正文原子、固定的来源命题、原始证据上下文及全文读取入口，亲自核对原文后逐维对齐并列出缺失前提；不能只审阅读者的概括。
- Challenger：独立读取正文原子、来源命题和原始上下文，执行 H1—H8；不得看到 Claim Judge 的结论。
- Arbiter：仅在 Judge 与 Challenger 对写入资格冲突时启用，依据原始材料裁决，不做新检索。

所有子 Agent 对 Zotero 和论文只读；允许在 Orchestrator 分配的项目缓存保存全文和独立阅读记录，不覆盖别人文件。高亮、正文写回、审计签发和最终等级由 Orchestrator 在脚本校验后执行。

分工时传入同一研究项目根与登记缓存路径，接手先查看已有同 PDF 指纹的来源阅读基础。`save-reading` 记录互不覆盖；来源理解可以复用，新论断仍重新裁决。独立盲读场景不给旧判断或其他 Reader 的解释，防止共享缓存破坏隔离。

## 3. 并行顺序

```text
Orchestrator生成论证卡和候选
→ 多个Source Reader按文献并行
→ Source claims固定
→ Claim Judge与Challenger并行
→ 有实质冲突才启动Arbiter
→ Orchestrator生成v2判断包并调用审计脚本
```

槽位不足时，Orchestrator可以亲自承担一个角色，但不得把 Source-first 与 Claim Judge 合并成同一步。不要为达到角色数量而创建空任务。

同一上下文无法真正隐藏已经看过的目标论断；降级须如实说明，不能称为盲审。不同文献可并行读取，缓存按文献/PDF 内容隔离；同文献提取和阅读尽量合并，避免多个 Agent 重复处理。

## 4. 输出约定

Source Reader 返回：文献身份、读取范围、来源命题、证据角色、限定、未证明事项、原文片段和页码。

Claim Judge 返回：每个 atom 的 `topic_relevance`、`claim_support`、八维 alignment、missing premises 和可安全改写，不直接给等级或签发许可。

Challenger 返回：每个 atom 的 H1—H8 verdict 与理由；明确哪项会阻止写入。

Arbiter 返回：冲突 atom、Judge 依据、Challenger 依据、建议裁决、剩余证据缺口和是否可进入审计脚本。它不能返回 `S3`、`eligible=true` 或直接调用写入工具。

STANDARD 不创建独立 Claim Judge/Challenger 子 Agent。Source Reader 返回后，Orchestrator 必须把 Source-first 与正文裁决分成先后两步，亲自串行填写 `topic_relevance`、`claim_support`、八维 alignment、missing premises 和 H1—H8；发现有限迁移或高风险项即升级 STRICT。

## 5. 降级与停止

- 子 Agent 无法访问 Zotero MCP 时，由 Orchestrator 先取得真实摘要和上下文，再把只读材料交给它；不得让其凭记忆补文献。
- PDF、版本或上下文不足时返回 U，不用互联网摘要伪装成全文结论。
- 找到充分证据后取消或不再启动剩余低价值候选。
- 多 Agent意见一致不等于事实正确；最终仍须绑定 PDF 原文和用户终审。
