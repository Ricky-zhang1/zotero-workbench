# 证据协议 v2

## 目录

1. 论文与论证卡
2. 论文理解卡
3. 来源命题
4. v2 判断包
5. 八项反向检查
6. 路由规则

## 1. 论文与论证卡

论文论证地图保持轻量，只保存当前有效的研究问题、核心论点、理论链、经验单位和解释边界。当前论证卡记录：`section_role`、`argument_role`、`citation_scope`、`required_evidence_role`、`claim_type`、`claim_force`、`source_core`、`author_synthesis`、`risk_flags` 和 `route_reason`。

不要为了单条引用新建整篇论文地图；已有地图则复用，没有时从小节和相邻段落即时生成。

## 2. 论文理解卡

`L1` 轻卡字段：

```json
{
  "card_version": 1,
  "parent_item_key": "PARENT",
  "attachment_key": "PDF",
  "pdf_fingerprint": "size+mtime或更强指纹",
  "title": "...",
  "research_question": "...",
  "study_object": "...",
  "unit_of_analysis": "...",
  "scope": "...",
  "research_design": "...",
  "causal_strength": "description|association|prediction|causal|mechanism",
  "main_relationships": [],
  "main_findings": [],
  "explicitly_not_established": [],
  "source_type": "metadata_and_abstract|fulltext_reviewed"
}
```

`L2` 完整卡再增加：`mechanisms`、`heterogeneity`、`boundary_conditions`、`section_map`、`source_claims`、`verified_fragments`，以及实际 `read_ranges`、`unread_ranges`、`extraction_warnings`。正式采用前必须升级 L2，执行 [原文读取协议](fulltext_reading.md)。全文复制或提取成功不等于全文已读；阅读范围记录只是可检查的交付记录，不能证明理解正确。卡片绑定 PDF SHA-256，复用来源理解，不复用不同论断的支持裁决。

`explicitly_not_established` 仅记作者明确限定或经过充分范围检查可说明的缺口。摘要/部分正文没有提到的内容标“未检查”，不得冒充全文排除。机器生成卡片是筛选缓存；用户确认状态单独记录。

## 3. 来源命题

```json
{
  "source_claim_id": "SC1",
  "subject": "...",
  "relation": "...",
  "outcome": "...",
  "direction": "...",
  "force": "...",
  "level": "...",
  "scope": "...",
  "provenance": "author_empirical_result",
  "qualifiers": [],
  "explicitly_not_established": [],
  "evidence_fragment_ids": ["f1"]
}
```

`provenance` 可为：`author_empirical_result`、`author_theory`、`review_of_other_study`、`discussion`、`speculation`、`policy_text`、`descriptive_data`。

## 4. v2 判断包

主 Agent 不得提供 `grade`、`eligible_for_highlight`、`core_status`、`transfer_status`、`challenger_status`，也不得在 atom 中提供 `status`。脚本检测到即拒绝。

这只能防止手填聚合结果，不能防止模型把不相干原文误填成 MATCH。审计程序不执行语义阅读；机械回归通过不能作为语义准确性验收。

```json
{
  "judgment_package_version": 2,
  "audit_receipt_version": 1,
  "audit_id": "AUD-...",
  "evidence_group_id": "EG-...",
  "route": "FAST|STANDARD|STRICT",
  "citation_scope": "具体从句",
  "claim_text": "正文完整论断",
  "claim_context": {
    "section_role": "...",
    "argument_role": "...",
    "claim_type": "theory|definition|descriptive|association|causal|mechanism|policy|statistic",
    "required_evidence_role": "...",
    "risk_flags": [],
    "route_reason": "..."
  },
  "parent_item_key": "PARENT",
  "attachment_keys": ["PDF"],
  "source_claims": [],
  "core_atoms": [
    {
      "atom_id": "a1",
      "claim_signature": {
        "subject": "...",
        "relation": "...",
        "outcome": "...",
        "direction": "...",
        "force": "...",
        "level": "...",
        "scope": "...",
        "provenance": "..."
      },
      "source_claim_ids": ["SC1"],
      "alignment": {
        "subject": "MATCH",
        "relation": "MATCH",
        "outcome": "MATCH",
        "direction": "MATCH",
        "force": "MATCH",
        "level": "MATCH",
        "scope": "MATCH",
        "provenance": "MATCH"
      },
      "missing_premises": [],
      "transfer_justification": null,
      "evidence_fragment_ids": ["f1"]
    }
  ],
  "challenger_checks": [],
  "fragments": [
    {
      "fragment_id": "f1",
      "attachment_key": "PDF",
      "source_text": "PDF中的连续原文",
      "required": true
    }
  ],
  "issued_at": "ISO-8601",
  "prompt_version": "zotero-lattics-semantic-v2",
  "model_version": "..."
}
```

对齐状态：`MATCH`、`ACCEPTABLE_TRANSFER`、`REQUIRES_BRIDGE`、`MISMATCH`、`CONFLICT`、`UNKNOWN`。

缺失前提：

```json
{
  "premise_id": "p1",
  "text": "...",
  "type": "semantic_equivalence|scope_transfer|theoretical_bridge|new_empirical_claim|new_actor|new_outcome|new_mechanism|new_time_order|causal_upgrade|unknown",
  "status": "SUPPORTED|UNSUPPORTED|UNKNOWN",
  "evidence_fragment_ids": []
}
```

## 5. 八项反向检查

STANDARD/STRICT 必须为每个必要原子提供八项：

| 代码 | 检查 |
| --- | --- |
| `H1_RELATION_ABSENT` | 来源是否缺少正文需要的关系 |
| `H2_DIRECTION_CONFLICT` | 方向是否相反 |
| `H3_FORCE_OVERREACH` | 是否把描述/相关/预测写成因果或机制 |
| `H4_RESULT_STATE_CHANGED` | 是否把无显著、混合或局部结果写成稳定结果 |
| `H5_PROVENANCE_MISUSE` | 是否把建议、假设、讨论或二手转述当成作者实证结果 |
| `H6_QUALIFIER_REMOVED` | 是否删除改变原意的条件或限定 |
| `H7_CROSS_LEVEL_UNBRIDGED` | 是否跨层级且没有桥接 |
| `H8_COMPOSITE_COVERAGE_GAP` | 是否只覆盖复合论断的一部分 |

格式：

```json
{"atom_id":"a1","code":"H1_RELATION_ABSENT","verdict":"PASS|FAIL|UNKNOWN","reason":"..."}
```

`FAIL` 形成硬否决并阻止写入；`UNKNOWN` 使结论为 `U`。方向或结果状态直接冲突时为 `X`；关系/覆盖缺口通常为 `R/S1`。

## 6. 路由规则

- FAST：单原子、单片段、无迁移、所有维度 MATCH、低风险证据类型。
- STANDARD：多原子、多片段、普通经验关系及有限差异的初审；必须由主 Agent 完成八项检查。若判断为有限迁移或 S2 候选，签发前升级 STRICT。
- STRICT：因果、机制、中介、调节、政策、统计、跨层级、二手转述、异质性、无显著或跨文献推理；必须隔离审查。

找到一个最小充分证据组即可停止。候选不足时主动修复，不降低等级门槛。

当前 Ricky Zotero MCP 的 v1 线协议只识别 `FAST/STRICT`。审计脚本把 v2 的 `STANDARD` 安全映射为线协议 `STRICT`，同时在回执保留 `semantic_route=STANDARD`；这是兼容层，不会绕过挑战者检查。

缺失前提的 `status` 与对齐状态不要混用：对齐中的 `REQUIRES_BRIDGE` 表示需要另一个明确前提；该前提在 `missing_premises` 中只能标为 `SUPPORTED/UNSUPPORTED/UNKNOWN`。`UNSUPPORTED` 阻止写入，`UNKNOWN` 使结论为 U；若原文直接相反，应在对应对齐维度标 `CONFLICT`，而不是把前提伪装成已支持。
