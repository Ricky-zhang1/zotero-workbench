#!/usr/bin/env python3
"""Issue and validate claim-evidence audit receipts.

Protocol v2 accepts structured semantic judgments, derives every write-gating
field itself, and emits a receipt compatible with Ricky Zotero MCP's v1 wire
format.  Legacy v1 packages remain supported during the migration window.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import unicodedata
from pathlib import Path
from typing import Any


DEFAULT_LEDGER = Path.home() / ".agents/state/zotero-lattics/audit-ledger.jsonl"
ATOM_STATUSES = {"FULL", "PARTIAL", "NONE", "CONFLICT", "UNKNOWN"}
CORE_STATUSES = {"FULL", "PARTIAL", "ABSENT", "CONFLICT", "UNKNOWN"}
TRANSFER_STATUSES = {"NOT_NEEDED", "JUSTIFIED", "UNJUSTIFIED", "UNKNOWN"}
CHALLENGER_STATUSES = {"PASSED", "NOT_REQUIRED", "PENDING", "CONFLICT"}
PACKAGE_ROUTES = {"FAST", "STANDARD", "STRICT"}
WIRE_ROUTES = {"FAST", "STRICT"}
ALIGNMENT_DIMENSIONS = (
    "subject", "relation", "outcome", "direction",
    "force", "level", "scope", "provenance",
)
ALIGNMENT_STATES = {
    "MATCH", "ACCEPTABLE_TRANSFER", "REQUIRES_BRIDGE",
    "MISMATCH", "CONFLICT", "UNKNOWN",
}
PREMISE_TYPES = {
    "semantic_equivalence", "scope_transfer", "theoretical_bridge",
    "new_empirical_claim", "new_actor", "new_outcome", "new_mechanism",
    "new_time_order", "causal_upgrade", "unknown",
}
PREMISE_STATUSES = {"SUPPORTED", "UNSUPPORTED", "UNKNOWN"}
CHALLENGER_CODES = (
    "H1_RELATION_ABSENT",
    "H2_DIRECTION_CONFLICT",
    "H3_FORCE_OVERREACH",
    "H4_RESULT_STATE_CHANGED",
    "H5_PROVENANCE_MISUSE",
    "H6_QUALIFIER_REMOVED",
    "H7_CROSS_LEVEL_UNBRIDGED",
    "H8_COMPOSITE_COVERAGE_GAP",
)
CHALLENGER_VERDICTS = {"PASS", "FAIL", "UNKNOWN"}
FORBIDDEN_V2_TOP_LEVEL = {
    "grade", "eligible_for_highlight", "core_status", "transfer_status",
    "challenger_status", "receipt_checksum", "claim_hash",
}
HIGH_RISK_CLAIM_TYPES = {"causal", "mechanism", "policy", "statistic"}
DIRECT_CONFLICT_CODES = {"H2_DIRECTION_CONFLICT", "H4_RESULT_STATE_CHANGED"}


def normalize_evidence_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split())


def fnv1a32(value: str) -> str:
    checksum = 2166136261
    for byte in value.encode("utf-8"):
        checksum ^= byte
        checksum = (checksum * 16777619) & 0xFFFFFFFF
    return f"fnv1a32:{checksum:08x}"


def evidence_text_hash(value: str) -> str:
    return fnv1a32(normalize_evidence_text(value))


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def receipt_checksum(receipt: dict[str, Any]) -> str:
    payload = copy.deepcopy(receipt)
    payload.pop("receipt_checksum", None)
    return fnv1a32(canonical_json(payload))


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _require_string(payload: dict[str, Any], field: str, errors: list[str]) -> None:
    if not _nonempty_string(payload.get(field)):
        errors.append(f"missing_{field}")


def derive_decision(package: dict[str, Any]) -> dict[str, Any]:
    """Derive the legacy grade used by the current MCP write gate."""
    atoms = package.get("core_atoms") if isinstance(package.get("core_atoms"), list) else []
    atom_states = [atom.get("status") for atom in atoms if isinstance(atom, dict)]
    core_status = package.get("core_status")
    challenger = package.get("challenger_status")
    transfer = package.get("transfer_status")

    if core_status == "CONFLICT" or "CONFLICT" in atom_states or challenger == "CONFLICT":
        return {"grade": "X", "eligible_for_highlight": False,
                "reasons": ["evidence_conflicts_with_claim"]}
    if (core_status == "UNKNOWN" or "UNKNOWN" in atom_states or transfer == "UNKNOWN"
            or challenger == "PENDING"):
        return {"grade": "U", "eligible_for_highlight": False,
                "reasons": ["support_is_unresolved"]}
    if core_status == "ABSENT" or (atoms and all(status == "NONE" for status in atom_states)):
        return {"grade": "R", "eligible_for_highlight": False,
                "reasons": ["topic_related_but_relation_absent"]}

    incomplete_atoms = not atoms or any(status != "FULL" for status in atom_states)
    strict_challenger_missing = package.get("route") == "STRICT" and challenger != "PASSED"
    standard_challenger_missing = package.get("route") == "STANDARD" and challenger != "PASSED"
    fast_challenger_invalid = package.get("route") == "FAST" and challenger not in {
        "PASSED", "NOT_REQUIRED"
    }
    s2_review_missing = transfer == "JUSTIFIED" and (
        package.get("route") != "STRICT" or challenger != "PASSED"
    )
    vetoes = package.get("hard_vetoes") if isinstance(package.get("hard_vetoes"), list) else []
    if (core_status != "FULL" or incomplete_atoms or transfer == "UNJUSTIFIED" or vetoes
            or strict_challenger_missing or standard_challenger_missing
            or fast_challenger_invalid or s2_review_missing):
        reasons = []
        if core_status != "FULL":
            reasons.append("core_proposition_not_fully_supported")
        if incomplete_atoms:
            reasons.append("required_core_atoms_not_fully_covered")
        if transfer == "UNJUSTIFIED":
            reasons.append("transfer_or_bridge_unjustified")
        if vetoes:
            reasons.append("hard_veto_present")
        if (strict_challenger_missing or standard_challenger_missing
                or fast_challenger_invalid or s2_review_missing):
            reasons.append("challenger_gate_not_passed")
        return {"grade": "S1", "eligible_for_highlight": False, "reasons": reasons}
    if transfer == "NOT_NEEDED":
        return {"grade": "S3", "eligible_for_highlight": True, "reasons": []}
    if transfer == "JUSTIFIED":
        return {"grade": "S2", "eligible_for_highlight": True, "reasons": []}
    return {"grade": "U", "eligible_for_highlight": False,
            "reasons": ["invalid_transfer_status"]}


def _validate_v2_package(package: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if package.get("judgment_package_version") != 2:
        errors.append("unsupported_judgment_package_version")
    if package.get("audit_receipt_version") != 1:
        errors.append("unsupported_receipt_wire_version")
    for field in FORBIDDEN_V2_TOP_LEVEL:
        if field in package:
            errors.append(f"forbidden_derived_field_{field}")
    for field in ("audit_id", "evidence_group_id", "citation_scope", "claim_text",
                  "parent_item_key", "issued_at", "prompt_version", "model_version"):
        _require_string(package, field, errors)
    route = package.get("route")
    if route not in PACKAGE_ROUTES:
        errors.append("invalid_route")
    claim_context = package.get("claim_context")
    if not isinstance(claim_context, dict):
        errors.append("missing_claim_context")
        claim_context = {}
    for field in ("section_role", "argument_role", "claim_type", "required_evidence_role",
                  "route_reason"):
        _require_string(claim_context, field, errors)
    risk_flags = claim_context.get("risk_flags")
    if not isinstance(risk_flags, list) or not all(_nonempty_string(flag) for flag in risk_flags):
        errors.append("invalid_risk_flags")

    attachments = package.get("attachment_keys")
    if not isinstance(attachments, list) or not attachments or not all(
            _nonempty_string(key) for key in attachments):
        errors.append("missing_attachment_keys")
        attachments = []

    fragments = package.get("fragments")
    if not isinstance(fragments, list) or not fragments:
        errors.append("missing_fragments")
        fragments = []
    fragment_ids: set[str] = set()
    for fragment in fragments:
        if not isinstance(fragment, dict):
            errors.append("invalid_fragment")
            continue
        if "text_hash" in fragment:
            errors.append("forbidden_derived_field_fragment_text_hash")
        fragment_id = fragment.get("fragment_id")
        if not _nonempty_string(fragment_id):
            errors.append("invalid_fragment_id")
        elif fragment_id in fragment_ids:
            errors.append("duplicate_fragment_id")
        else:
            fragment_ids.add(fragment_id)
        if fragment.get("attachment_key") not in attachments:
            errors.append("fragment_attachment_not_declared")
        if not _nonempty_string(fragment.get("source_text")):
            errors.append("missing_fragment_source_text")
        if fragment.get("required") is not True:
            errors.append("fragment_must_be_required")

    source_claims = package.get("source_claims")
    if not isinstance(source_claims, list) or not source_claims:
        errors.append("missing_source_claims")
        source_claims = []
    source_claim_ids: set[str] = set()
    for claim in source_claims:
        if not isinstance(claim, dict):
            errors.append("invalid_source_claim")
            continue
        claim_id = claim.get("source_claim_id")
        if not _nonempty_string(claim_id):
            errors.append("invalid_source_claim_id")
        elif claim_id in source_claim_ids:
            errors.append("duplicate_source_claim_id")
        else:
            source_claim_ids.add(claim_id)
        for field in ALIGNMENT_DIMENSIONS:
            if not _nonempty_string(claim.get(field)):
                errors.append(f"source_claim_missing_{field}")
        evidence_ids = claim.get("evidence_fragment_ids")
        if not isinstance(evidence_ids, list) or not evidence_ids:
            errors.append("source_claim_without_evidence")
        elif any(fragment_id not in fragment_ids for fragment_id in evidence_ids):
            errors.append("source_claim_references_unknown_fragment")

    atoms = package.get("core_atoms")
    if not isinstance(atoms, list) or not atoms:
        errors.append("missing_core_atoms")
        atoms = []
    atom_ids: set[str] = set()
    for atom in atoms:
        if not isinstance(atom, dict):
            errors.append("invalid_core_atom")
            continue
        if "status" in atom:
            errors.append("forbidden_derived_field_atom_status")
        atom_id = atom.get("atom_id")
        if not _nonempty_string(atom_id):
            errors.append("invalid_atom_id")
        elif atom_id in atom_ids:
            errors.append("duplicate_atom_id")
        else:
            atom_ids.add(atom_id)
        signature = atom.get("claim_signature")
        if not isinstance(signature, dict):
            errors.append("missing_claim_signature")
        else:
            for field in ALIGNMENT_DIMENSIONS:
                if not _nonempty_string(signature.get(field)):
                    errors.append(f"claim_signature_missing_{field}")
        alignment = atom.get("alignment")
        if not isinstance(alignment, dict):
            errors.append("missing_alignment")
            alignment = {}
        if set(alignment) != set(ALIGNMENT_DIMENSIONS):
            errors.append("alignment_dimensions_incomplete")
        for dimension in ALIGNMENT_DIMENSIONS:
            if alignment.get(dimension) not in ALIGNMENT_STATES:
                errors.append(f"invalid_alignment_{dimension}")
        claim_ids = atom.get("source_claim_ids")
        if not isinstance(claim_ids, list) or not claim_ids:
            errors.append("atom_without_source_claim")
        elif any(claim_id not in source_claim_ids for claim_id in claim_ids):
            errors.append("atom_references_unknown_source_claim")
        evidence_ids = atom.get("evidence_fragment_ids")
        if not isinstance(evidence_ids, list) or not evidence_ids:
            errors.append("core_atom_without_evidence")
        elif any(fragment_id not in fragment_ids for fragment_id in evidence_ids):
            errors.append("core_atom_references_unknown_fragment")
        premises = atom.get("missing_premises")
        if not isinstance(premises, list):
            errors.append("invalid_missing_premises")
            premises = []
        for premise in premises:
            if not isinstance(premise, dict):
                errors.append("invalid_missing_premise")
                continue
            if premise.get("type") not in PREMISE_TYPES:
                errors.append("invalid_premise_type")
            if premise.get("status") not in PREMISE_STATUSES:
                errors.append("invalid_premise_status")
            if not _nonempty_string(premise.get("premise_id")) or not _nonempty_string(premise.get("text")):
                errors.append("incomplete_missing_premise")
            premise_evidence = premise.get("evidence_fragment_ids")
            if not isinstance(premise_evidence, list):
                errors.append("invalid_premise_evidence")
            elif any(fragment_id not in fragment_ids for fragment_id in premise_evidence):
                errors.append("premise_references_unknown_fragment")

    checks = package.get("challenger_checks")
    if not isinstance(checks, list):
        errors.append("invalid_challenger_checks")
        checks = []
    if route in {"STANDARD", "STRICT"}:
        expected = {(atom_id, code) for atom_id in atom_ids for code in CHALLENGER_CODES}
        actual: list[tuple[str, str]] = []
        for check in checks:
            if not isinstance(check, dict):
                errors.append("invalid_challenger_check")
                continue
            pair = (check.get("atom_id"), check.get("code"))
            actual.append(pair)
            if check.get("atom_id") not in atom_ids:
                errors.append("challenger_unknown_atom")
            if check.get("code") not in CHALLENGER_CODES:
                errors.append("invalid_challenger_code")
            if check.get("verdict") not in CHALLENGER_VERDICTS:
                errors.append("invalid_challenger_verdict")
            if not _nonempty_string(check.get("reason")):
                errors.append("missing_challenger_reason")
        if len(actual) != len(set(actual)):
            errors.append("duplicate_challenger_check")
        if set(actual) != expected:
            errors.append("challenger_checks_incomplete")
    elif checks:
        errors.append("fast_route_must_not_include_challenger_checks")

    claim_type = claim_context.get("claim_type")
    if claim_type in HIGH_RISK_CLAIM_TYPES and route != "STRICT":
        errors.append("high_risk_claim_requires_strict")
    if route == "STRICT" and not risk_flags:
        errors.append("strict_route_requires_risk_flag")
    if route != "STRICT" and any(
            "ACCEPTABLE_TRANSFER" in atom.get("alignment", {}).values() for atom in atoms):
        errors.append("acceptable_transfer_requires_strict")

    if route == "FAST":
        if len(atoms) != 1 or len(fragments) != 1:
            errors.append("fast_route_requires_single_atom_and_fragment")
        if claim_type in HIGH_RISK_CLAIM_TYPES:
            errors.append("fast_route_forbidden_for_high_risk_claim")
        for atom in atoms:
            if any(state != "MATCH" for state in atom.get("alignment", {}).values()):
                errors.append("fast_route_requires_all_match")
            if atom.get("missing_premises"):
                errors.append("fast_route_forbids_missing_premises")
    return errors


def _derive_atom_status(atom: dict[str, Any]) -> str:
    states = list(atom["alignment"].values())
    premise_states = [premise["status"] for premise in atom.get("missing_premises", [])]
    if "CONFLICT" in states:
        return "CONFLICT"
    if "UNKNOWN" in states or "UNKNOWN" in premise_states:
        return "UNKNOWN"
    if atom["alignment"].get("relation") == "MISMATCH" or atom["alignment"].get("outcome") == "MISMATCH":
        return "NONE"
    if ("MISMATCH" in states or "REQUIRES_BRIDGE" in states
            or "UNSUPPORTED" in premise_states):
        return "PARTIAL"
    return "FULL"


def _derive_v2_fields(package: dict[str, Any]) -> dict[str, Any]:
    atoms: list[dict[str, Any]] = package["core_atoms"]
    statuses = [_derive_atom_status(atom) for atom in atoms]
    checks = package.get("challenger_checks", [])
    failed = [check for check in checks if check["verdict"] == "FAIL"]
    unknown_checks = [check for check in checks if check["verdict"] == "UNKNOWN"]
    direct_conflict = any(check["code"] in DIRECT_CONFLICT_CODES for check in failed)

    if direct_conflict or "CONFLICT" in statuses:
        core_status = "CONFLICT"
    elif "UNKNOWN" in statuses or unknown_checks:
        core_status = "UNKNOWN"
    elif statuses and all(status == "NONE" for status in statuses):
        core_status = "ABSENT"
    elif statuses and all(status == "FULL" for status in statuses):
        core_status = "FULL"
    else:
        core_status = "PARTIAL"

    all_states = [state for atom in atoms for state in atom["alignment"].values()]
    all_premises = [premise for atom in atoms for premise in atom.get("missing_premises", [])]
    if "UNKNOWN" in all_states or any(premise["status"] == "UNKNOWN" for premise in all_premises):
        transfer_status = "UNKNOWN"
    elif ("REQUIRES_BRIDGE" in all_states or "MISMATCH" in all_states
            or any(premise["status"] == "UNSUPPORTED" for premise in all_premises)):
        transfer_status = "UNJUSTIFIED"
    elif "ACCEPTABLE_TRANSFER" in all_states:
        affected = [atom for atom in atoms if "ACCEPTABLE_TRANSFER" in atom["alignment"].values()]
        if all(_nonempty_string(atom.get("transfer_justification")) for atom in affected):
            transfer_status = "JUSTIFIED"
        else:
            transfer_status = "UNJUSTIFIED"
    else:
        transfer_status = "NOT_NEEDED"

    if package["route"] == "FAST":
        semantic_challenger_status = "NOT_REQUIRED"
    elif unknown_checks:
        semantic_challenger_status = "UNKNOWN"
    elif failed:
        semantic_challenger_status = "FAILED"
    else:
        semantic_challenger_status = "PASSED"
    # The v1 wire schema has no FAILED value.  A completed non-conflict failure
    # is represented by hard_vetoes and PASSED here only for wire compatibility;
    # semantic_challenger_status preserves the real result.
    if semantic_challenger_status == "NOT_REQUIRED":
        challenger_status = "NOT_REQUIRED"
    elif semantic_challenger_status == "UNKNOWN":
        challenger_status = "PENDING"
    elif direct_conflict:
        challenger_status = "CONFLICT"
    else:
        challenger_status = "PASSED"
    hard_vetoes = [f"{check['atom_id']}:{check['code']}" for check in failed]
    return {
        "atom_statuses": statuses,
        "core_status": core_status,
        "transfer_status": transfer_status,
        "challenger_status": challenger_status,
        "semantic_challenger_status": semantic_challenger_status,
        "hard_vetoes": hard_vetoes,
    }


def _issue_v2_receipt(package: dict[str, Any]) -> dict[str, Any]:
    errors = _validate_v2_package(package)
    if errors:
        raise ValueError("invalid v2 judgment package: " + ", ".join(sorted(set(errors))))
    derived = _derive_v2_fields(package)
    fragments = [
        {
            "fragment_id": fragment["fragment_id"],
            "attachment_key": fragment["attachment_key"],
            "required": True,
            "text_hash": evidence_text_hash(fragment["source_text"]),
        }
        for fragment in package["fragments"]
    ]
    core_atoms = []
    for atom, status in zip(package["core_atoms"], derived["atom_statuses"]):
        core_atoms.append({
            "atom_id": atom["atom_id"],
            "status": status,
            "evidence_fragment_ids": copy.deepcopy(atom["evidence_fragment_ids"]),
            "claim_signature_hash": fnv1a32(canonical_json(atom["claim_signature"])),
            "source_claim_ids": copy.deepcopy(atom["source_claim_ids"]),
        })
    receipt = {
        "audit_receipt_version": 1,
        "semantic_protocol_version": 2,
        "audit_id": package["audit_id"],
        "evidence_group_id": package["evidence_group_id"],
        # Ricky Zotero MCP 1.7.1 accepts only FAST/STRICT on the wire.  STANDARD
        # still gets the full challenger gate and is represented as STRICT in
        # the compact receipt; semantic_route preserves the workflow decision.
        "route": "FAST" if package["route"] == "FAST" else "STRICT",
        "semantic_route": package["route"],
        "citation_scope": package["citation_scope"],
        "claim_hash": evidence_text_hash(package["claim_text"]),
        "parent_item_key": package["parent_item_key"],
        "attachment_keys": copy.deepcopy(package["attachment_keys"]),
        "core_status": derived["core_status"],
        "transfer_status": derived["transfer_status"],
        "challenger_status": derived["challenger_status"],
        "semantic_challenger_status": derived["semantic_challenger_status"],
        "hard_vetoes": derived["hard_vetoes"],
        "core_atoms": core_atoms,
        "fragments": fragments,
        "source_claims_hash": fnv1a32(canonical_json(package["source_claims"])),
        "alignment_hash": fnv1a32(canonical_json([
            {"atom_id": atom["atom_id"], "alignment": atom["alignment"]}
            for atom in package["core_atoms"]
        ])),
        "missing_premises_hash": fnv1a32(canonical_json([
            {"atom_id": atom["atom_id"], "missing_premises": atom["missing_premises"]}
            for atom in package["core_atoms"]
        ])),
        "semantic_judgment": {
            "claim_context": copy.deepcopy(package["claim_context"]),
            "source_claims": copy.deepcopy(package["source_claims"]),
            "core_atoms": copy.deepcopy(package["core_atoms"]),
            "challenger_checks": copy.deepcopy(package["challenger_checks"]),
        },
        "issued_at": package["issued_at"],
        "prompt_version": package["prompt_version"],
        "model_version": package["model_version"],
    }
    decision = derive_decision(receipt)
    receipt["grade"] = decision["grade"]
    receipt["eligible_for_highlight"] = decision["eligible_for_highlight"]
    receipt["receipt_checksum"] = receipt_checksum(receipt)
    validation = validate_receipt(receipt)
    if not validation["valid"]:
        raise ValueError("invalid derived receipt: " + ", ".join(validation["errors"]))
    return receipt


def _issue_v1_receipt(package: dict[str, Any]) -> dict[str, Any]:
    receipt = copy.deepcopy(package)
    claim_text = receipt.pop("claim_text", None)
    if isinstance(claim_text, str):
        receipt["claim_hash"] = evidence_text_hash(claim_text)
    compact_fragments = []
    for fragment in receipt.get("fragments", []):
        compact = copy.deepcopy(fragment)
        source_text = compact.pop("source_text", None)
        if isinstance(source_text, str):
            compact["text_hash"] = evidence_text_hash(source_text)
        compact_fragments.append(compact)
    receipt["fragments"] = compact_fragments
    decision = derive_decision(receipt)
    receipt["grade"] = decision["grade"]
    receipt["eligible_for_highlight"] = decision["eligible_for_highlight"]
    receipt["receipt_checksum"] = receipt_checksum(receipt)
    validation = validate_receipt(receipt)
    if not validation["valid"]:
        raise ValueError("invalid audit package: " + ", ".join(validation["errors"]))
    return receipt


def issue_receipt(package: dict[str, Any], *, allow_legacy: bool = False) -> dict[str, Any]:
    if not isinstance(package, dict):
        raise ValueError("judgment_package_not_object")
    if package.get("judgment_package_version") == 2:
        return _issue_v2_receipt(package)
    if allow_legacy and package.get("audit_receipt_version") == 1:
        return _issue_v1_receipt(package)
    raise ValueError("judgment_package_version_2_required; use issue-legacy-v1 only for explicit migration")


def _validate_v2_receipt_semantics(receipt: dict[str, Any]) -> list[str]:
    """Re-derive every semantic gate from the receipt's structured judgment."""
    errors: list[str] = []
    semantic_route = receipt.get("semantic_route")
    if semantic_route not in PACKAGE_ROUTES:
        errors.append("invalid_semantic_route")
    judgment = receipt.get("semantic_judgment")
    if not isinstance(judgment, dict):
        return errors + ["missing_semantic_judgment"]
    receipt_fragments = receipt.get("fragments")
    if not isinstance(receipt_fragments, list):
        receipt_fragments = []
    reconstructed = {
        "judgment_package_version": 2,
        "audit_receipt_version": 1,
        "audit_id": receipt.get("audit_id"),
        "evidence_group_id": receipt.get("evidence_group_id"),
        "route": semantic_route,
        "citation_scope": receipt.get("citation_scope"),
        # The compact receipt intentionally stores only this claim's hash.  A
        # non-empty placeholder is sufficient for structural re-validation.
        "claim_text": f"bound:{receipt.get('claim_hash', '')}",
        "claim_context": judgment.get("claim_context"),
        "parent_item_key": receipt.get("parent_item_key"),
        "attachment_keys": receipt.get("attachment_keys"),
        "source_claims": judgment.get("source_claims"),
        "core_atoms": judgment.get("core_atoms"),
        "challenger_checks": judgment.get("challenger_checks"),
        "fragments": [
            {
                "fragment_id": fragment.get("fragment_id"),
                "attachment_key": fragment.get("attachment_key"),
                "source_text": f"bound:{fragment.get('text_hash', '')}",
                "required": fragment.get("required"),
            }
            for fragment in receipt_fragments if isinstance(fragment, dict)
        ],
        "issued_at": receipt.get("issued_at"),
        "prompt_version": receipt.get("prompt_version"),
        "model_version": receipt.get("model_version"),
    }
    structural_errors = _validate_v2_package(reconstructed)
    errors.extend(f"semantic_{error}" for error in structural_errors)
    if structural_errors:
        return errors

    expected = _derive_v2_fields(reconstructed)
    expected_atoms = [
        {
            "atom_id": atom["atom_id"],
            "status": status,
            "evidence_fragment_ids": copy.deepcopy(atom["evidence_fragment_ids"]),
            "claim_signature_hash": fnv1a32(canonical_json(atom["claim_signature"])),
            "source_claim_ids": copy.deepcopy(atom["source_claim_ids"]),
        }
        for atom, status in zip(reconstructed["core_atoms"], expected["atom_statuses"])
    ]
    if canonical_json(receipt.get("core_atoms")) != canonical_json(expected_atoms):
        errors.append("semantic_core_atoms_mismatch")
    for field in ("core_status", "transfer_status", "challenger_status",
                  "semantic_challenger_status", "hard_vetoes"):
        if receipt.get(field) != expected[field]:
            errors.append(f"semantic_{field}_mismatch")
    expected_wire_route = "FAST" if semantic_route == "FAST" else "STRICT"
    if receipt.get("route") != expected_wire_route:
        errors.append("semantic_wire_route_mismatch")
    if receipt.get("source_claims_hash") != fnv1a32(canonical_json(reconstructed["source_claims"])):
        errors.append("source_claims_hash_mismatch")
    if receipt.get("alignment_hash") != fnv1a32(canonical_json([
        {"atom_id": atom["atom_id"], "alignment": atom["alignment"]}
        for atom in reconstructed["core_atoms"]
    ])):
        errors.append("alignment_hash_mismatch")
    if receipt.get("missing_premises_hash") != fnv1a32(canonical_json([
        {"atom_id": atom["atom_id"], "missing_premises": atom["missing_premises"]}
        for atom in reconstructed["core_atoms"]
    ])):
        errors.append("missing_premises_hash_mismatch")
    return errors


def validate_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(receipt, dict):
        return {"valid": False, "errors": ["receipt_not_object"]}
    if receipt.get("audit_receipt_version") != 1:
        errors.append("unsupported_receipt_version")
    if receipt.get("semantic_protocol_version") not in {None, 2}:
        errors.append("unsupported_semantic_protocol_version")
    for field in ("audit_id", "evidence_group_id", "citation_scope", "claim_hash", "parent_item_key"):
        if not _nonempty_string(receipt.get(field)):
            errors.append(f"missing_{field}")
    if receipt.get("route") not in WIRE_ROUTES:
        errors.append("invalid_route")
    if receipt.get("core_status") not in CORE_STATUSES:
        errors.append("invalid_core_status")
    if receipt.get("transfer_status") not in TRANSFER_STATUSES:
        errors.append("invalid_transfer_status")
    if receipt.get("challenger_status") not in CHALLENGER_STATUSES:
        errors.append("invalid_challenger_status")
    attachments = receipt.get("attachment_keys")
    if not isinstance(attachments, list) or not attachments:
        errors.append("missing_attachment_keys")
        attachments = []
    atoms = receipt.get("core_atoms")
    if not isinstance(atoms, list) or not atoms:
        errors.append("missing_core_atoms")
        atoms = []
    fragments = receipt.get("fragments")
    if not isinstance(fragments, list) or not fragments:
        errors.append("missing_fragments")
        fragments = []

    fragment_ids: set[str] = set()
    for fragment in fragments:
        fragment_id = fragment.get("fragment_id") if isinstance(fragment, dict) else None
        if not _nonempty_string(fragment_id):
            errors.append("invalid_fragment_id")
        elif fragment_id in fragment_ids:
            errors.append("duplicate_fragment_id")
        else:
            fragment_ids.add(fragment_id)
        if not isinstance(fragment, dict) or fragment.get("attachment_key") not in attachments:
            errors.append("fragment_attachment_not_declared")
        text_hash = fragment.get("text_hash") if isinstance(fragment, dict) else None
        if not isinstance(text_hash, str) or not text_hash.startswith("fnv1a32:") or len(text_hash) != 16:
            errors.append("invalid_fragment_text_hash")
    for atom in atoms:
        if (not isinstance(atom, dict) or not _nonempty_string(atom.get("atom_id"))
                or atom.get("status") not in ATOM_STATUSES):
            errors.append("invalid_core_atom")
            continue
        evidence_ids = atom.get("evidence_fragment_ids")
        if not isinstance(evidence_ids, list) or not evidence_ids:
            errors.append("core_atom_without_evidence")
            continue
        for fragment_id in evidence_ids:
            if fragment_id not in fragment_ids:
                errors.append("core_atom_references_unknown_fragment")
    if receipt.get("semantic_protocol_version") == 2:
        errors.extend(_validate_v2_receipt_semantics(receipt))
    decision = derive_decision(receipt)
    if receipt.get("grade") != decision["grade"]:
        errors.append("grade_mismatch")
    if receipt.get("eligible_for_highlight") is not decision["eligible_for_highlight"]:
        errors.append("eligibility_mismatch")
    if receipt.get("receipt_checksum") != receipt_checksum(receipt):
        errors.append("checksum_mismatch")
    return {"valid": not errors, "errors": errors}


def _parse_locators(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict) and isinstance(payload.get("locatorResults"), list):
        payload = payload["locatorResults"]
    if not isinstance(payload, list):
        raise ValueError("locators_must_be_array")
    results = []
    for value in payload:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError as error:
                raise ValueError("invalid_locator_json_string") from error
        if not isinstance(value, dict):
            raise ValueError("locator_not_object")
        results.append(value)
    return results


def locator_receipt_checksum(locator: dict[str, Any]) -> str:
    rects = ";".join(
        ",".join(f"{float(value):.3f}" for value in rect)
        for rect in locator["rects"]
    )
    fields = [
        str(locator["locator_receipt_version"]), str(locator["attachment_key"]),
        str(locator["page_index"]), str(locator["page_label"]),
        str(locator["source_text"]), str(locator["pdf_path"]),
        str(locator["pdf_size"]), str(locator["pdf_mtime_ms"]),
        str(locator["match_kind"]), str(locator["sort_index"]), rects,
    ]
    framed = "|".join(f"{len(field)}:{field}" for field in fields)
    checksum = 2166136261
    for char in framed:
        checksum ^= ord(char)
        checksum = (checksum * 16777619) & 0xFFFFFFFF
    return f"fnv1a32:{checksum:08x}"


def _validate_locator_receipt(locator: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if locator.get("locator_receipt_version") != 1:
        errors.append("unsupported_locator_receipt_version")
    if locator.get("ok") is not True:
        errors.append("locator_not_ok")
    if locator.get("confidence") != "high":
        errors.append("locator_not_high_confidence")
    if locator.get("match_kind") not in {"exact", "normalised"}:
        errors.append("locator_not_exact")
    if not _nonempty_string(locator.get("attachment_key")) or not _nonempty_string(locator.get("source_text")):
        errors.append("locator_missing_identity")
    if not isinstance(locator.get("page_index"), int) or locator["page_index"] < 0:
        errors.append("locator_missing_page_index")
    if not _nonempty_string(locator.get("page_label")):
        errors.append("locator_missing_page_label")
    if not _nonempty_string(locator.get("sort_index")):
        errors.append("locator_missing_sort_index")
    if not _nonempty_string(locator.get("pdf_path")):
        errors.append("locator_missing_pdf_path")
    if not isinstance(locator.get("pdf_size"), int) or locator["pdf_size"] <= 0:
        errors.append("locator_missing_pdf_size")
    if not isinstance(locator.get("pdf_mtime_ms"), int) or locator["pdf_mtime_ms"] <= 0:
        errors.append("locator_missing_pdf_mtime")
    rects = locator.get("rects")
    if (not isinstance(rects, list) or not rects
            or any(not isinstance(rect, list) or len(rect) != 4
                   or any(not isinstance(value, (int, float)) for value in rect)
                   for rect in rects)):
        errors.append("locator_missing_rects")
    if locator.get("occurrence_count") != 1:
        errors.append("locator_not_unique")
    if not _nonempty_string(locator.get("zotero_url")):
        errors.append("locator_missing_zotero_url")
    if not errors:
        try:
            if locator.get("receipt_checksum") != locator_receipt_checksum(locator):
                errors.append("locator_checksum_mismatch")
        except (KeyError, TypeError, ValueError):
            errors.append("locator_checksum_inputs_invalid")
    return errors


def preflight_bind(package: dict[str, Any], receipt: dict[str, Any], locators_payload: Any) -> dict[str, Any]:
    """Bind exact locator results to the audited fragments before an MCP call."""
    errors: list[str] = []
    validation = validate_receipt(receipt)
    if not validation["valid"]:
        errors.extend(f"invalid_receipt:{error}" for error in validation["errors"])
    if receipt.get("eligible_for_highlight") is not True:
        errors.append("receipt_not_eligible_for_highlight")
    if package.get("audit_id") != receipt.get("audit_id"):
        errors.append("package_receipt_audit_id_mismatch")
    if package.get("evidence_group_id") != receipt.get("evidence_group_id"):
        errors.append("package_receipt_evidence_group_mismatch")
    if not _nonempty_string(package.get("claim_text")) or (
            evidence_text_hash(package.get("claim_text", "")) != receipt.get("claim_hash")):
        errors.append("package_receipt_claim_mismatch")
    package_fragments = package.get("fragments") if isinstance(package.get("fragments"), list) else []
    receipt_fragments = receipt.get("fragments") if isinstance(receipt.get("fragments"), list) else []
    package_by_id = {
        fragment.get("fragment_id"): fragment for fragment in package_fragments
        if isinstance(fragment, dict) and _nonempty_string(fragment.get("fragment_id"))
    }
    receipt_by_id = {
        fragment.get("fragment_id"): fragment for fragment in receipt_fragments
        if isinstance(fragment, dict) and _nonempty_string(fragment.get("fragment_id"))
    }
    required_pairs: dict[tuple[str, str], str] = {}
    for fragment_id, fragment in package_by_id.items():
        receipt_fragment = receipt_by_id.get(fragment_id)
        if receipt_fragment is None:
            errors.append("package_fragment_missing_from_receipt")
            continue
        text_hash = evidence_text_hash(fragment.get("source_text", ""))
        if text_hash != receipt_fragment.get("text_hash"):
            errors.append("package_fragment_hash_mismatch")
        if fragment.get("attachment_key") != receipt_fragment.get("attachment_key"):
            errors.append("package_fragment_attachment_mismatch")
        if fragment.get("required") is True:
            pair = (fragment["attachment_key"], text_hash)
            if pair in required_pairs:
                errors.append("duplicate_required_fragment_binding")
            else:
                required_pairs[pair] = fragment_id
    if set(package_by_id) != set(receipt_by_id):
        errors.append("package_receipt_fragment_set_mismatch")

    locators = _parse_locators(locators_payload)
    seen: set[tuple[str, str]] = set()
    bindings = []
    for locator in locators:
        locator_errors = _validate_locator_receipt(locator)
        errors.extend(locator_errors)
        attachment_key = locator.get("attachment_key")
        source_text = locator.get("source_text")
        if not _nonempty_string(attachment_key) or not _nonempty_string(source_text):
            errors.append("locator_missing_identity")
            continue
        pair = (attachment_key, evidence_text_hash(source_text))
        if pair in seen:
            errors.append("duplicate_locator_for_fragment")
            continue
        seen.add(pair)
        fragment_id = required_pairs.get(pair)
        if fragment_id is None:
            errors.append("locator_not_in_audited_fragments")
            continue
        bindings.append({
            "fragment_id": fragment_id,
            "attachment_key": attachment_key,
            "text_hash": pair[1],
            "page_index": locator.get("page_index"),
        })
    missing = set(required_pairs) - seen
    if missing:
        errors.append("required_fragment_missing_locator")
    return {
        "valid": not errors,
        "audit_id": receipt.get("audit_id"),
        "evidence_group_id": receipt.get("evidence_group_id"),
        "grade": receipt.get("grade"),
        "eligible_for_highlight": receipt.get("eligible_for_highlight"),
        "bindings": bindings,
        "errors": sorted(set(errors)),
    }


def append_ledger_record(path: Path, judgment_package: dict[str, Any], receipt: dict[str, Any]) -> None:
    validation = validate_receipt(receipt)
    if not validation["valid"]:
        raise ValueError("refusing to append invalid receipt: " + ", ".join(validation["errors"]))
    record = {
        "ledger_record_version": 2 if receipt.get("semantic_protocol_version") == 2 else 1,
        "audit_id": receipt["audit_id"],
        "evidence_group_id": receipt["evidence_group_id"],
        "recorded_at": receipt.get("issued_at"),
        "judgment_package": copy.deepcopy(judgment_package),
        "receipt": copy.deepcopy(receipt),
    }
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(canonical_json(record) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _read_json(path: str) -> Any:
    if path == "-":
        return json.load(sys.stdin)
    with Path(path).expanduser().open(encoding="utf-8") as handle:
        return json.load(handle)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create and validate Zotero citation evidence audit receipts.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    issue = subparsers.add_parser("issue", help="Issue a compact receipt from a judgment package.")
    issue.add_argument("input", help="JSON file, or - for stdin")
    issue.add_argument("--ledger", default=str(DEFAULT_LEDGER), help="Append-only JSONL ledger")
    issue.add_argument("--no-ledger", action="store_true", help="Do not append the issued receipt")
    legacy = subparsers.add_parser(
        "issue-legacy-v1", help="Explicit migration-only issuance for an old v1 package."
    )
    legacy.add_argument("input", help="Legacy JSON file, or - for stdin")
    legacy.add_argument("--ledger", default=str(DEFAULT_LEDGER), help="Append-only JSONL ledger")
    legacy.add_argument("--no-ledger", action="store_true", help="Do not append the issued receipt")
    validate = subparsers.add_parser("validate", help="Validate a compact receipt.")
    validate.add_argument("input", help="JSON file, or - for stdin")
    bind = subparsers.add_parser("preflight-bind", help="Bind locators to audited fragments.")
    bind.add_argument("judgment_package", help="Full v1/v2 judgment package JSON")
    bind.add_argument("audit_receipt", help="Compact audit receipt JSON")
    bind.add_argument("locators", help="Locator result array JSON")
    args = parser.parse_args()

    try:
        if args.command in {"issue", "issue-legacy-v1"}:
            payload = _read_json(args.input)
            receipt = issue_receipt(payload, allow_legacy=args.command == "issue-legacy-v1")
            if not args.no_ledger:
                append_ledger_record(Path(args.ledger), payload, receipt)
            print(canonical_json(receipt))
            return 0
        if args.command == "validate":
            result = validate_receipt(_read_json(args.input))
            print(canonical_json(result))
            return 0 if result["valid"] else 2
        result = preflight_bind(
            _read_json(args.judgment_package),
            _read_json(args.audit_receipt),
            _read_json(args.locators),
        )
        print(canonical_json(result))
        return 0 if result["valid"] else 2
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(canonical_json({"ok": False, "error": str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
