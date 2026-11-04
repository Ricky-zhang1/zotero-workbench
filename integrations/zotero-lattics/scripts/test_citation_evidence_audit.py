#!/usr/bin/env python3
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("citation_evidence_audit.py")
SPEC = importlib.util.spec_from_file_location("citation_evidence_audit", MODULE_PATH)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def signature(subject="universities", relation="transfer", outcome="transactions"):
    return {
        "subject": subject, "relation": relation, "outcome": outcome,
        "direction": "positive", "force": "association", "level": "organization",
        "scope": "sample", "provenance": "author_empirical_result",
    }


def alignment(default="MATCH", **overrides):
    result = {dimension: default for dimension in audit.ALIGNMENT_DIMENSIONS}
    result.update(overrides)
    return result


def checks(atom_ids, verdict="PASS", override=None):
    override = override or {}
    return [
        {
            "atom_id": atom_id, "code": code,
            "verdict": override.get((atom_id, code), verdict),
            "reason": "checked against the complete source claim and context",
        }
        for atom_id in atom_ids for code in audit.CHALLENGER_CODES
    ]


def v2_package(route="FAST"):
    text = "The study finds that university incentives increase completed technology-transfer transactions."
    package = {
        "judgment_package_version": 2, "audit_receipt_version": 1,
        "audit_id": "AUD-v2-001", "evidence_group_id": "EG-v2-001",
        "route": route, "citation_scope": "产权和收益安排有助于促成高校技术转移交易",
        "claim_text": "产权和收益安排有助于促成高校技术转移交易。",
        "claim_context": {
            "section_role": "literature review", "argument_role": "establish prior finding",
            "claim_type": "association", "required_evidence_role": "author empirical result",
            "risk_flags": ["strict_review"] if route == "STRICT" else [],
            "route_reason": "high-risk independent review" if route == "STRICT" else "ordinary direct support",
        },
        "parent_item_key": "PARENT1", "attachment_keys": ["PDF1"],
        "source_claims": [{
            "source_claim_id": "SC1", **signature(),
            "qualifiers": ["university sample"],
            "explicitly_not_established": ["recipient's later inventive activity"],
            "evidence_fragment_ids": ["f1"],
        }],
        "core_atoms": [{
            "atom_id": "a1", "claim_signature": signature(), "source_claim_ids": ["SC1"],
            "alignment": alignment(), "missing_premises": [],
            "transfer_justification": None, "evidence_fragment_ids": ["f1"],
        }],
        "challenger_checks": [],
        "fragments": [{
            "fragment_id": "f1", "attachment_key": "PDF1",
            "source_text": text, "required": True,
        }],
        "issued_at": "2026-09-04T09:00:00+08:00",
        "prompt_version": "zotero-lattics-semantic-v2", "model_version": "test-model",
    }
    if route != "FAST":
        package["challenger_checks"] = checks(["a1"])
    return package


class CitationEvidenceAuditV2Tests(unittest.TestCase):
    def test_fast_direct_support_is_s3_and_wire_v1_compatible(self):
        receipt = audit.issue_receipt(v2_package())
        self.assertEqual(receipt["audit_receipt_version"], 1)
        self.assertEqual(receipt["semantic_protocol_version"], 2)
        self.assertEqual(receipt["grade"], "S3")
        self.assertTrue(receipt["eligible_for_highlight"])
        self.assertTrue(audit.validate_receipt(receipt)["valid"])

    def test_agent_cannot_self_declare_gate_fields_or_hashes(self):
        for field, value in (
            ("grade", "S3"), ("eligible_for_highlight", True),
            ("core_status", "FULL"), ("transfer_status", "NOT_NEEDED"),
            ("challenger_status", "PASSED"), ("claim_hash", "forged"),
            ("receipt_checksum", "forged"),
        ):
            package = v2_package()
            package[field] = value
            with self.assertRaisesRegex(ValueError, "forbidden_derived_field"):
                audit.issue_receipt(package)
        package = v2_package()
        package["core_atoms"][0]["status"] = "FULL"
        with self.assertRaisesRegex(ValueError, "forbidden_derived_field_atom_status"):
            audit.issue_receipt(package)
        package = v2_package()
        package["fragments"][0]["text_hash"] = "fnv1a32:00000000"
        with self.assertRaisesRegex(ValueError, "forbidden_derived_field_fragment_text_hash"):
            audit.issue_receipt(package)

    def test_compact_v2_receipt_rederives_semantic_gates(self):
        receipt = audit.issue_receipt(v2_package())
        receipt["semantic_judgment"]["core_atoms"][0]["alignment"]["relation"] = "MISMATCH"
        receipt["receipt_checksum"] = audit.receipt_checksum(receipt)
        validation = audit.validate_receipt(receipt)
        self.assertFalse(validation["valid"])
        self.assertTrue(any("semantic_" in error or "alignment_hash" in error
                            for error in validation["errors"]))

    def test_acceptable_transfer_requires_strict_route_and_justification(self):
        package = v2_package("STRICT")
        package["core_atoms"][0]["alignment"]["scope"] = "ACCEPTABLE_TRANSFER"
        package["core_atoms"][0]["transfer_justification"] = (
            "正文只把来源的样本范围收窄到同一类高校，不新增主体、关系或结果。"
        )
        receipt = audit.issue_receipt(package)
        self.assertEqual(receipt["grade"], "S2")
        self.assertTrue(receipt["eligible_for_highlight"])
        package["core_atoms"][0]["transfer_justification"] = None
        receipt = audit.issue_receipt(package)
        self.assertEqual(receipt["grade"], "S1")
        self.assertFalse(receipt["eligible_for_highlight"])

    def test_fast_route_rejects_high_risk_or_semantic_transfer(self):
        package = v2_package()
        package["claim_context"]["claim_type"] = "causal"
        with self.assertRaisesRegex(ValueError, "fast_route_forbidden_for_high_risk_claim"):
            audit.issue_receipt(package)
        package = v2_package()
        package["core_atoms"][0]["alignment"]["scope"] = "ACCEPTABLE_TRANSFER"
        with self.assertRaisesRegex(ValueError, "fast_route_requires_all_match"):
            audit.issue_receipt(package)

        package = v2_package("STANDARD")
        package["claim_context"]["claim_type"] = "mechanism"
        package["claim_context"]["risk_flags"] = ["mechanism"]
        with self.assertRaisesRegex(ValueError, "high_risk_claim_requires_strict"):
            audit.issue_receipt(package)

    def test_bozeman_like_case_is_partial_not_permission(self):
        package = v2_package("STANDARD")
        package["claim_text"] = "技术转移成效既包括市场表征，也包括受让主体后续技术活动。"
        package["core_atoms"] = [
            {
                "atom_id": "a1", "claim_signature": signature(outcome="multidimensional impacts"),
                "source_claim_ids": ["SC1"], "alignment": alignment(),
                "missing_premises": [], "transfer_justification": None,
                "evidence_fragment_ids": ["f1"],
            },
            {
                "atom_id": "a2", "claim_signature": signature(outcome="recipient later technology activity"),
                "source_claim_ids": ["SC1"],
                "alignment": alignment(outcome="MISMATCH", relation="REQUIRES_BRIDGE"),
                "missing_premises": [{
                    "premise_id": "p1", "text": "impact on personnel means recipient later technology activity",
                    "type": "new_outcome", "status": "UNSUPPORTED", "evidence_fragment_ids": [],
                }],
                "transfer_justification": None, "evidence_fragment_ids": ["f1"],
            },
        ]
        package["challenger_checks"] = checks(["a1", "a2"], override={
            ("a2", "H1_RELATION_ABSENT"): "FAIL",
            ("a2", "H8_COMPOSITE_COVERAGE_GAP"): "FAIL",
        })
        receipt = audit.issue_receipt(package)
        self.assertEqual(receipt["grade"], "S1")
        self.assertFalse(receipt["eligible_for_highlight"])
        self.assertIn("a2:H1_RELATION_ABSENT", receipt["hard_vetoes"])

    def test_standard_is_encoded_as_strict_for_current_mcp(self):
        receipt = audit.issue_receipt(v2_package("STANDARD"))
        self.assertEqual(receipt["semantic_route"], "STANDARD")
        self.assertEqual(receipt["route"], "STRICT")
        self.assertTrue(audit.validate_receipt(receipt)["valid"])

    def test_lane_lubatkin_like_case_cannot_support_transaction_arrangements(self):
        package = v2_package("STANDARD")
        package["claim_text"] = "产权制度和组织安排促进技术转移交易。"
        atom = package["core_atoms"][0]
        atom["alignment"] = alignment(relation="MISMATCH", outcome="MISMATCH")
        atom["missing_premises"] = [{
            "premise_id": "p1", "text": "interorganizational learning ability causes a transfer transaction",
            "type": "new_outcome", "status": "UNSUPPORTED", "evidence_fragment_ids": [],
        }]
        package["challenger_checks"] = checks(["a1"], override={
            ("a1", "H1_RELATION_ABSENT"): "FAIL",
        })
        receipt = audit.issue_receipt(package)
        self.assertEqual(receipt["grade"], "R")
        self.assertFalse(receipt["eligible_for_highlight"])

    def test_unknown_and_direction_conflict_stop_writes(self):
        package = v2_package("STANDARD")
        package["core_atoms"][0]["alignment"]["scope"] = "UNKNOWN"
        package["challenger_checks"] = checks(["a1"], override={
            ("a1", "H6_QUALIFIER_REMOVED"): "UNKNOWN",
        })
        receipt = audit.issue_receipt(package)
        self.assertEqual(receipt["grade"], "U")
        self.assertFalse(receipt["eligible_for_highlight"])
        package = v2_package("STRICT")
        package["core_atoms"][0]["alignment"]["direction"] = "CONFLICT"
        package["challenger_checks"] = checks(["a1"], override={
            ("a1", "H2_DIRECTION_CONFLICT"): "FAIL",
        })
        receipt = audit.issue_receipt(package)
        self.assertEqual(receipt["grade"], "X")

    def test_challenger_matrix_must_be_complete(self):
        package = v2_package("STANDARD")
        package["challenger_checks"].pop()
        with self.assertRaisesRegex(ValueError, "challenger_checks_incomplete"):
            audit.issue_receipt(package)

    def test_preflight_binds_exact_locator_once(self):
        package = v2_package()
        receipt = audit.issue_receipt(package)
        locator = {
            "locator_receipt_version": 1, "ok": True, "confidence": "high", "match_kind": "exact",
            "attachment_key": "PDF1", "source_text": package["fragments"][0]["source_text"],
            "page_index": 3, "page_label": "4", "rects": [[72.0, 120.0, 480.0, 138.0]],
            "sort_index": "00003|000120|00072", "occurrence_count": 1,
            "pdf_path": "/tmp/paper.pdf", "pdf_size": 1234, "pdf_mtime_ms": 1730000000000,
            "zotero_url": "zotero://open-pdf/library/items/PDF1?page=4",
        }
        locator["receipt_checksum"] = audit.locator_receipt_checksum(locator)
        result = audit.preflight_bind(package, receipt, [json.dumps(locator)])
        self.assertTrue(result["valid"])
        self.assertEqual(result["bindings"][0]["fragment_id"], "f1")
        wrong = copy.deepcopy(locator)
        wrong["source_text"] = "A semantically similar paraphrase is not the audited quotation."
        wrong["receipt_checksum"] = audit.locator_receipt_checksum(wrong)
        result = audit.preflight_bind(package, receipt, [wrong])
        self.assertFalse(result["valid"])
        self.assertIn("locator_not_in_audited_fragments", result["errors"])
        self.assertIn("required_fragment_missing_locator", result["errors"])
        result = audit.preflight_bind(package, receipt, [locator, locator])
        self.assertFalse(result["valid"])
        self.assertIn("duplicate_locator_for_fragment", result["errors"])

        blocked_package = v2_package("STANDARD")
        blocked_package["core_atoms"][0]["alignment"]["relation"] = "MISMATCH"
        blocked_package["challenger_checks"] = checks(["a1"], override={
            ("a1", "H1_RELATION_ABSENT"): "FAIL",
        })
        blocked_receipt = audit.issue_receipt(blocked_package)
        blocked = audit.preflight_bind(blocked_package, blocked_receipt, [locator])
        self.assertFalse(blocked["valid"])
        self.assertIn("receipt_not_eligible_for_highlight", blocked["errors"])

        incomplete = copy.deepcopy(locator)
        incomplete.pop("rects")
        result = audit.preflight_bind(package, receipt, [incomplete])
        self.assertFalse(result["valid"])
        self.assertIn("locator_missing_rects", result["errors"])

    def test_preflight_rejects_duplicate_required_fragment_identity(self):
        package = v2_package("STANDARD")
        duplicate = copy.deepcopy(package["fragments"][0])
        duplicate["fragment_id"] = "f2"
        package["fragments"].append(duplicate)
        package["source_claims"][0]["evidence_fragment_ids"].append("f2")
        package["core_atoms"][0]["evidence_fragment_ids"].append("f2")
        receipt = audit.issue_receipt(package)
        source = package["fragments"][0]["source_text"]
        locator = {
            "locator_receipt_version": 1, "ok": True, "confidence": "high", "match_kind": "exact",
            "attachment_key": "PDF1", "source_text": source, "page_index": 3, "page_label": "4",
            "rects": [[72.0, 120.0, 480.0, 138.0]], "sort_index": "00003|000120|00072",
            "occurrence_count": 1, "pdf_path": "/tmp/paper.pdf", "pdf_size": 1234,
            "pdf_mtime_ms": 1730000000000,
            "zotero_url": "zotero://open-pdf/library/items/PDF1?page=4",
        }
        locator["receipt_checksum"] = audit.locator_receipt_checksum(locator)
        result = audit.preflight_bind(package, receipt, [locator])
        self.assertFalse(result["valid"])
        self.assertIn("duplicate_required_fragment_binding", result["errors"])

    def test_v2_ledger_preserves_full_local_evidence_packet(self):
        package = v2_package()
        receipt = audit.issue_receipt(package)
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = Path(temp_dir) / "audit-ledger.jsonl"
            audit.append_ledger_record(ledger, package, receipt)
            row = json.loads(ledger.read_text(encoding="utf-8"))
            self.assertEqual(row["ledger_record_version"], 2)
            self.assertEqual(row["judgment_package"]["source_claims"][0]["source_claim_id"], "SC1")


class LegacyCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.package = {
            "audit_receipt_version": 1, "audit_id": "AUD-legacy-001",
            "evidence_group_id": "EG-legacy-001", "route": "STRICT",
            "citation_scope": "clause", "claim_text": "The assigned clause.",
            "parent_item_key": "PARENT1", "attachment_keys": ["PDF1"],
            "core_status": "FULL", "transfer_status": "NOT_NEEDED",
            "challenger_status": "PASSED", "hard_vetoes": [],
            "core_atoms": [{"atom_id": "a1", "status": "FULL", "evidence_fragment_ids": ["f1"]}],
            "fragments": [{
                "fragment_id": "f1", "attachment_key": "PDF1",
                "source_text": "The evidence supports the claim.", "required": True,
            }],
            "issued_at": "2026-08-31T09:00:00+08:00",
            "prompt_version": "zotero-lattics-audit-v1", "model_version": "test-model",
        }

    def test_v1_package_still_works(self):
        self.assertEqual(audit.evidence_text_hash("技术  转化 evidence"), "fnv1a32:68256b61")
        with self.assertRaisesRegex(ValueError, "judgment_package_version_2_required"):
            audit.issue_receipt(self.package)
        receipt = audit.issue_receipt(self.package, allow_legacy=True)
        self.assertEqual(receipt["grade"], "S3")
        self.assertTrue(audit.validate_receipt(receipt)["valid"])

    def test_tampering_fails_validation(self):
        receipt = audit.issue_receipt(self.package, allow_legacy=True)
        receipt["grade"] = "S2"
        self.assertFalse(audit.validate_receipt(receipt)["valid"])


if __name__ == "__main__":
    unittest.main()
