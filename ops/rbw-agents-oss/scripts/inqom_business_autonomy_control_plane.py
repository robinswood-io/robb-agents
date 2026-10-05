#!/usr/bin/env python3
"""Business-level autonomy proof for the Inqom accounting pipeline.

Consolidates execution outcomes, transaction lineage, document provenance,
cash-basis VAT controls, fixed-assets coverage and the exact residual human work.
This wrapper is read-only with respect to Inqom and external systems.
"""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import os
import pathlib
from typing import Any, Iterable

ROOT = pathlib.Path(os.environ.get("RBW_OSS_ROOT", "/srv/rbw-agents-oss"))
CONFIG = pathlib.Path(os.environ.get("RBW_CONFIG_DIR", ROOT / "config"))
OPS = pathlib.Path(os.environ.get("RBW_OPS_DIR", "/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops"))
CONTRACT_PATH = CONFIG / "finance-inqom-business-autonomy-contract.json"

SOURCES = {
    "executionRegistry": "inqom-execution-readiness-registry.json",
    "expertResolver": "inqom-expert-route-autonomous-resolver.json",
    "nativeIdentifierEnricher": "inqom-native-reconciliation-identifier-enricher.json",
    "nativeNoLinkReview": "inqom-native-reconciliation-no-link-candidate-review.json",
    "documentClassifier": "inqom-document-evidence-autonomy-classifier.json",
    "documentRetriever": "inqom-document-evidence-autonomous-retriever.json",
    "balanceResolution": "inqom-balance-sheet-resolution-preparer.json",
    "reviewOnlyControls": "inqom-review-only-controls.json",
    "qualityWorkbench": "inqom-quality-autonomy-workbench.json",
    "vatIssuedInvoices": "finance-inqom-vat-sellsy-issued-invoice-control.json",
    "vatGocardlessReceipts": "finance-inqom-vat-gocardless-cash-receipts.json",
    "vatDirectBankReceipts": "finance-inqom-vat-direct-bank-receipts.json",
    "vatCashBasisAllocator": "finance-inqom-vat-cash-basis-allocator.json",
    "vatDeductibleCrosscheck": "finance-inqom-vat-deductible-crosscheck.json",
    "activeApprovalGuard": "inqom-active-approval-write-guardrail.json",
    "boundedEnvelopeTests": "inqom-bounded-mutation-envelope-tests.json"
}
REQUIRED_CLEAN = set(SOURCES) - {"documentRetriever"}
MUTATION_KEYS = {"mutationattempted", "nativereconciliationattempted", "nativeletteringattempted", "mutations", "mutated", "created", "updated", "deleted"}
IDENTIFIER_KEYS = {
    "entryid", "entryids", "lineid", "lineids", "transactionid", "transactionids",
    "banktransactionid", "banktransactionids", "invoiceid", "invoiceids", "paymentid",
    "paymentids", "payoutid", "payoutids", "sourceid", "sourceids", "matchedid",
    "matchedids", "subaccountid", "thirdpartyid", "folderid", "enterpriseid"
}
DOC_KEYS = {"docref", "docrefs", "reference", "references", "fileref", "fileid", "fileids"}
ACCOUNT_KEYS = {"account", "accounts", "accountname", "accountnames", "accountnumber", "accountnumbers"}
AMOUNT_KEYS = {"amount", "amounts", "expectedamount", "expectedamountsum", "debit", "credit"}


def now_utc() -> dt.datetime:
    raw = os.environ.get("RBW_NOW")
    if raw:
        return parse_iso(raw)
    return dt.datetime.now(dt.timezone.utc)


def iso_now() -> str:
    return now_utc().isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def file_sha(path: pathlib.Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except Exception:
        return None


def read_json(path: pathlib.Path) -> tuple[Any, list[str]]:
    try:
        return json.loads(path.read_text()), []
    except FileNotFoundError:
        return {}, [f"missing_report:{path.name}"]
    except Exception as exc:
        return {}, [f"corrupt_report:{path.name}:{type(exc).__name__}"]


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def scalar_values(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        out: list[Any] = []
        for item in value:
            out.extend(scalar_values(item))
        return out
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return [value]
    return []


def collect_by_keys(node: Any, keys: set[str]) -> list[Any]:
    found: list[Any] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key.lower() in keys:
                found.extend(scalar_values(value))
            if isinstance(value, (dict, list)):
                found.extend(collect_by_keys(value, keys))
    elif isinstance(node, list):
        for item in node:
            found.extend(collect_by_keys(item, keys))
    seen: set[str] = set(); unique: list[Any] = []
    for item in found:
        marker = f"{type(item).__name__}:{item}"
        if marker not in seen:
            seen.add(marker); unique.append(item)
    return unique


def report_clean(payload: Any) -> bool:
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        return False
    if as_list(payload.get("blockingReasons")):
        return False
    counts = as_dict(payload.get("counts"))
    for key in ("failed", "criticalFailed", "validationIssues", "unsafeItems"):
        try:
            if int(counts.get(key, 0)) > 0:
                return False
        except Exception:
            return False
    return True


def freshness(payload: Any, max_minutes: int) -> tuple[bool, float | None]:
    try:
        generated = parse_iso(as_dict(payload).get("generatedAt"))
        age = max(0.0, (now_utc() - generated).total_seconds() / 60)
        return age <= max_minutes, round(age, 2)
    except Exception:
        return False, None


def recursive_positive_mutations(node: Any, prefix: str = "") -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else key
            if key.lower() in MUTATION_KEYS:
                positive = value is True or (isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0)
                if positive:
                    hits.append({"path": path, "value": value})
            if isinstance(value, (dict, list)):
                hits.extend(recursive_positive_mutations(value, path))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            hits.extend(recursive_positive_mutations(value, f"{prefix}[{index}]"))
    return hits


def choose_records(payload: Any, preferred: Iterable[str]) -> list[dict[str, Any]]:
    data = as_dict(payload)
    for key in preferred:
        value = data.get(key)
        if isinstance(value, list) and all(isinstance(x, dict) for x in value):
            return value
    candidates: list[list[dict[str, Any]]] = []
    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            if node and all(isinstance(x, dict) for x in node):
                candidates.append(node)
            for value in node:
                walk(value)
    walk(payload)
    return max(candidates, key=len, default=[])


def source_meta(name: str, path: pathlib.Path, payload: Any, max_minutes: int) -> dict[str, Any]:
    fresh, age = freshness(payload, max_minutes)
    return {
        "name": name,
        "path": str(path),
        "sha256": file_sha(path),
        "generatedAt": as_dict(payload).get("generatedAt"),
        "ageMinutes": age,
        "fresh": fresh,
        "clean": report_clean(payload)
    }


def current_human_residual_records(resolver: dict[str, Any], registry: dict[str, Any]) -> tuple[list[dict], list[dict], list[dict], list[str]]:
    from inqom_execution_readiness_registry_tests import protected_residuals_consistent
    rows = [r for r in as_list(registry.get("records")) if isinstance(r, dict)]
    residuals = [r for r in as_list(resolver.get("humanResiduals")) if isinstance(r, dict)]
    rc = as_dict(resolver.get("counts"))
    protected = [r for r in rows if r.get("readinessStatus") in {"requires_human_doctrine", "requires_expert_decision", "manual_only"}]
    scope_ok = protected_residuals_consistent(rows, residuals) if protected else (not residuals and bool(rows) and all(r.get("readinessStatus") == "completed_no_action_required" for r in rows))
    valid = (
        registry.get("ok") is True and resolver.get("ok") is True
        and resolver.get("status") == "resolved_with_human_inputs_only"
        and freshness(registry, 60)[0] and freshness(resolver, 60)[0]
        and rc.get("inputRecords") == len(rows) and rc.get("humanResiduals") == len(residuals)
        and rc.get("unrecognizedTechnicalResiduals") == 0
        and all(rc.get(k) == 0 for k in ["mutationAttempted", "externalActionAttempted", "activeApprovalWritten"])
        and scope_ok
    )
    if not valid: return [], [], [], ["current_human_residual_scope_unverified"]
    by_id = {r["registryId"]: r for r in rows}
    indexed = {r["registryId"]: r for r in residuals}
    groups = {"requires_human_doctrine": [], "manual_only": [], "requires_expert_decision": []}
    for row in protected:
        rid = row["registryId"]; src = indexed[rid]; status = row["readinessStatus"]
        owner = ("agent_then_expert_accountant" if row.get("family") == "source_quality" else "expert_accountant")
        if status == "requires_human_doctrine": owner = "human_decision_owner"
        if status == "manual_only" and row.get("family") == "document_evidence": owner = "human_tax_portal_operator"
        groups[status].append({
            "registryId": rid, "classification": status, "family": row.get("family"),
            "title": src.get("title") or row.get("title"), "summary": src.get("summary") or row.get("summary"),
            "reason": src.get("reason") or row.get("readinessReasons"), "owner": owner,
            "technicalExecutionDelegatedToHuman": False, "mutationAllowed": False,
            "sourceFingerprint": digest({"resolver": src, "registry": row}),
        })
    return groups["requires_human_doctrine"], groups["manual_only"], groups["requires_expert_decision"], []


def human_residual_records(resolver: dict[str, Any], registry: dict[str, Any], contract: dict[str, Any]) -> tuple[list[dict], list[dict], list[str]]:
    doctrine, manual, expert, issues = current_human_residual_records(resolver, registry)
    return doctrine, manual, issues


def transaction_registry(enricher: dict[str, Any], no_link: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    rows: list[dict[str, Any]] = []
    issues: list[str] = []
    for pack in as_list(enricher.get("packs")):
        if not isinstance(pack, dict): continue
        path_raw = pack.get("enrichedPackJson")
        if not path_raw: issues.append(f"enriched_pack_path_missing:{pack.get('slug')}"); continue
        path = pathlib.Path(str(path_raw))
        if not path.is_absolute(): path = OPS / path.name
        payload, errors = read_json(path); issues.extend(errors)
        for index, item in enumerate(as_list(as_dict(payload).get("items"))):
            if not isinstance(item, dict): continue
            identifiers = collect_by_keys(item, IDENTIFIER_KEYS)
            entry_ids = [int(x) for x in collect_by_keys(item, {"entryid", "entryids"}) if str(x).isdigit()]
            line_ids = [int(x) for x in collect_by_keys(item, {"lineid", "lineids"}) if str(x).isdigit()]
            transaction_ids = [int(x) for x in collect_by_keys(item, {"transactionid", "transactionids", "banktransactionid", "banktransactionids"}) if str(x).isdigit()]
            native_issues = as_list(item.get("nativeIdentifierIssues"))
            body = {
                "packSlug": pack.get("slug"), "packIndex": index,
                "folderIds": collect_by_keys(item, {"folderid", "enterpriseid"}),
                "entryIds": sorted(set(entry_ids)), "lineIds": sorted(set(line_ids)),
                "transactionIds": sorted(set(transaction_ids)),
                "externalIdentifiers": [x for x in identifiers if x not in entry_ids + line_ids + transaction_ids],
                "docRefs": collect_by_keys(item, DOC_KEYS),
                "accounts": collect_by_keys(item, ACCOUNT_KEYS),
                "amounts": collect_by_keys(item, AMOUNT_KEYS),
                "nativeIdentifierIssues": native_issues,
                "sourcePack": str(path), "sourcePackSha256": file_sha(path),
                "itemFingerprint": digest(item)
            }
            body["lineageId"] = "lineage:" + digest(body)[:24]
            body["status"] = "complete" if not native_issues else "exception"
            rows.append(body)
    exception_rows: list[dict[str, Any]] = []
    for item in as_list(no_link.get("queue")):
        if not isinstance(item, dict): continue
        exception_rows.append({
            "exceptionId": item.get("id") or "lineage-exception:" + digest(item)[:20],
            "classification": as_dict(item.get("data")).get("classification") or item.get("actionType"),
            "blockingReason": item.get("blockingReason"), "owner": item.get("owner"),
            "entryIds": collect_by_keys(item, {"entryid", "entryids"}),
            "lineIds": collect_by_keys(item, {"lineid", "lineids"}),
            "transactionIds": collect_by_keys(item, {"transactionid", "transactionids"}),
            "fingerprint": digest(item), "mutationAllowed": False
        })
    declared = int(as_dict(enricher.get("counts")).get("items", len(rows)))
    if declared != len(rows): issues.append(f"transaction_lineage_count_mismatch:{declared}:{len(rows)}")
    if any(not x.get("sourcePackSha256") for x in rows): issues.append("transaction_lineage_source_hash_missing")
    return rows, exception_rows, issues


def document_registry(classifier: dict[str, Any], retriever: dict[str, Any], cascade: list[str], source_paths: dict[str, pathlib.Path]) -> tuple[list[dict[str, Any]], list[str]]:
    source = retriever if retriever else classifier
    records = choose_records(source, ["evidenceRegistry", "registry", "evidenceRows", "classifiedRows", "rows"])
    source_name = "documentRetriever" if retriever else "documentClassifier"
    path = source_paths[source_name]
    generated = source.get("generatedAt")
    out: list[dict[str, Any]] = []
    issues: list[str] = []
    for index, item in enumerate(records):
        coverage = str(item.get("coverageStatus") or item.get("classification") or item.get("evidenceMode") or "classified")
        inherited = any(token in coverage.lower() for token in ("counterpart", "inherited", "matched", "pair"))
        row = {
            "evidenceId": item.get("evidenceId") or "evidence:" + digest(item)[:24],
            "sourceRowIndex": index, "retrievedAt": generated,
            "sourceReport": str(path), "sourceReportSha256": file_sha(path),
            "evidenceHash": digest(item), "coverageMode": "inherited" if inherited else "direct_or_classified",
            "docRefs": collect_by_keys(item, DOC_KEYS),
            "entryIds": collect_by_keys(item, {"entryid", "entryids"}),
            "lineIds": collect_by_keys(item, {"lineid", "lineids"}),
            "matchedGroupIds": collect_by_keys(item, {"matchedid", "matchedids"}),
            "counterpartIdentifiers": collect_by_keys(item, {"paymentid", "paymentids", "invoiceid", "invoiceids", "transactionid", "transactionids"}),
            "accounts": collect_by_keys(item, ACCOUNT_KEYS),
            "classification": coverage, "humanQuestionRequired": item.get("humanQuestionRequired") is True,
            "cascadeApplied": cascade, "original": item
        }
        out.append(row)
    classifier_counts = as_dict(classifier.get("counts"))
    if int(classifier_counts.get("humanQuestionRows", 0)) > 0: issues.append("document_human_question_before_full_autonomous_closure")
    for row in out:
        if row["humanQuestionRequired"]: issues.append(f"document_human_question:{row['evidenceId']}")
        if not row["sourceReportSha256"]: issues.append("document_source_hash_missing")
    return out, sorted(set(issues))


def fixed_asset_registry(workbench: dict[str, Any], balance: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, int], list[str]]:
    raw_fixed = as_dict(as_dict(workbench.get("rawOutputs")).get("fixedAssets"))
    lines = as_list(raw_fixed.get("topFixedAssetLines"))
    expected = int(as_dict(balance.get("counts")).get("sourceFixedAssetReviewGroups", len(lines)))
    out: list[dict[str, Any]] = []
    for index, item in enumerate(lines):
        if not isinstance(item, dict): continue
        out.append({
            "assetGroupId": "fixed-asset-line:" + digest(item)[:24], "index": index,
            "representedSourceGroups": 1, "coverageMode": "row_level",
            "folderIds": collect_by_keys(item, {"folderid", "enterpriseid"}) or [raw_fixed.get("folderId")],
            "entryIds": collect_by_keys(item, {"entryid", "entryids"}), "lineIds": collect_by_keys(item, {"lineid", "lineids"}),
            "accounts": collect_by_keys(item, ACCOUNT_KEYS), "amounts": collect_by_keys(item, AMOUNT_KEYS),
            "docRefs": collect_by_keys(item, DOC_KEYS), "sourceFingerprint": digest(item),
            "status": "review_pack_ready", "mutationAllowed": False, "original": item
        })
    represented = len(out)
    remaining = max(0, expected - represented)
    if remaining:
        account_summaries = []
        for key in ("fixedAssetAccounts", "depreciationAccounts", "depreciationExpenseAccounts", "disposalAccounts"):
            account_summaries.extend(as_list(raw_fixed.get(key)))
        aggregate = {
            "assetGroupId": "fixed-asset-aggregate-tail:" + digest({"expected": expected, "summaries": account_summaries})[:20],
            "representedSourceGroups": remaining, "coverageMode": "aggregate_source_coverage",
            "folderIds": [raw_fixed.get("folderId")], "entryIds": [], "lineIds": [],
            "accounts": collect_by_keys(account_summaries, ACCOUNT_KEYS), "amounts": collect_by_keys(account_summaries, AMOUNT_KEYS),
            "docRefs": [], "sourceFingerprint": digest(account_summaries),
            "status": "aggregate_review_pack_ready", "mutationAllowed": False,
            "note": "Le producteur source plafonne topFixedAssetLines; le reliquat est couvert honnêtement par les agrégats de comptes, sans inventer d’identifiants de ligne.",
            "accountSummaries": account_summaries
        }
        out.append(aggregate); represented += remaining
    issues: list[str] = []
    if represented != expected: issues.append(f"fixed_asset_registry_count_mismatch:{expected}:{represented}")
    if int(as_dict(balance.get("counts")).get("coveredFixedAssetReviewGroups", -1)) != expected: issues.append("fixed_asset_coverage_not_complete")
    stats = {"sourceGroups": expected, "representedGroups": represented, "rowLevelGroups": len(lines), "aggregateTailGroups": remaining, "registryRecords": len(out)}
    return out, stats, issues


def vat_controls(payloads: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    keys = ["vatIssuedInvoices", "vatGocardlessReceipts", "vatDirectBankReceipts", "vatCashBasisAllocator", "vatDeductibleCrosscheck"]
    issues: list[str] = []
    summaries: dict[str, Any] = {}
    payment_links: dict[str, dict[str, Any]] = {}
    for key in keys:
        payload = as_dict(payloads.get(key))
        if not report_clean(payload): issues.append(f"vat_source_not_clean:{key}")
        summaries[key] = {"status": payload.get("status"), "counts": payload.get("counts"), "totals": payload.get("totals"), "sha256": file_sha(OPS / SOURCES[key])}
        for payment_id in collect_by_keys(payload, {"paymentid", "paymentids"}):
            payment_links.setdefault(str(payment_id), {"paymentId": payment_id, "sources": []})["sources"].append(key)
    for value in payment_links.values(): value["sources"] = sorted(set(value["sources"]))
    issued = as_dict(payloads.get("vatIssuedInvoices"))
    if as_list(issued.get("mismatchRows")): issues.append("vat_issued_invoice_mismatch")
    if as_list(issued.get("missingAfterGraceRows")): issues.append("vat_invoice_missing_after_grace")
    return {
        "calculationOwner": "agent", "filingAndPaymentOwner": "human_tax_portal_operator",
        "filingAndPaymentAutomated": False, "sourceSummaries": summaries,
        "paymentLineage": sorted(payment_links.values(), key=lambda x: str(x["paymentId"])),
        "status": "agent_calculation_verified_manual_filing_only" if not issues else "review"
    }, issues


def main() -> int:
    contract, contract_errors = read_json(CONTRACT_PATH)
    max_minutes = int(as_dict(as_dict(contract).get("reportFreshnessMinutes", 180)) if False else as_dict(contract).get("reportFreshnessMinutes", 180))
    paths = {key: OPS / name for key, name in SOURCES.items()}
    payloads: dict[str, Any] = {}
    blocking: list[str] = list(contract_errors)
    for key, path in paths.items():
        payload, errors = read_json(path)
        if key == "documentRetriever" and errors:
            payload, errors = {}, []
        payloads[key] = payload; blocking.extend(errors)
    source_reports = [source_meta(k, paths[k], payloads[k], max_minutes) for k in SOURCES]
    for item in source_reports:
        if item["name"] in REQUIRED_CLEAN and not item["clean"]: blocking.append(f"source_not_clean:{item['name']}")
        if item["name"] in REQUIRED_CLEAN and not item["fresh"]: blocking.append(f"source_stale:{item['name']}")

    registry = as_dict(payloads["executionRegistry"]); resolver = as_dict(payloads["expertResolver"])
    records = as_list(registry.get("records")); status_counts = as_dict(registry.get("statusCounts"))
    derived_counts: dict[str, int] = {}
    for row in records:
        if isinstance(row, dict):
            status = str(row.get("readinessStatus") or "unknown")
            derived_counts[status] = derived_counts.get(status, 0) + 1
    if sum(int(v) for v in status_counts.values() if isinstance(v, (int, float))) != len(records): blocking.append("execution_status_declared_total_mismatch")
    for key, count in derived_counts.items():
        if int(status_counts.get(key, -1)) != count: blocking.append(f"execution_status_count_mismatch:{key}")

    doctrine, manual, expert, human_issues = current_human_residual_records(resolver, registry); blocking.extend(human_issues)
    tx_rows, tx_exceptions, tx_issues = transaction_registry(as_dict(payloads["nativeIdentifierEnricher"]), as_dict(payloads["nativeNoLinkReview"])); blocking.extend(tx_issues)
    doc_rows, doc_issues = document_registry(as_dict(payloads["documentClassifier"]), as_dict(payloads["documentRetriever"]), as_list(as_dict(contract).get("documentEvidenceCascade")), paths); blocking.extend(doc_issues)
    fixed_rows, fixed_stats, fixed_issues = fixed_asset_registry(as_dict(payloads["qualityWorkbench"]), as_dict(payloads["balanceResolution"])); blocking.extend(fixed_issues)
    vat, vat_issues = vat_controls(payloads); blocking.extend(vat_issues)
    try:
        if parse_iso(as_dict(payloads["nativeNoLinkReview"]).get("generatedAt")) < parse_iso(as_dict(payloads["nativeIdentifierEnricher"]).get("generatedAt")):
            blocking.append("native_no_link_review_older_than_identifier_enricher")
    except Exception:
        blocking.append("native_reconciliation_cross_report_timestamp_invalid")

    mutation_hits: list[dict[str, Any]] = []
    for key in REQUIRED_CLEAN:
        mutation_hits.extend({"source": key, **hit} for hit in recursive_positive_mutations(payloads[key]))
    # Explicitly allowed observability: a no-link report can expose zero-valued attempted counters only.
    if mutation_hits: blocking.append("unexpected_mutation_signal")
    guard = as_dict(payloads["activeApprovalGuard"])
    guard_text = json.dumps(guard, ensure_ascii=False).lower()
    if '"activeapprovalexists": true' in guard_text or '"activeapprovalpresent": true' in guard_text:
        blocking.append("active_approval_present_at_terminal_control")

    completed = int(derived_counts.get("completed_no_action_required", 0))
    agent_decided = int(as_dict(registry.get("counts")).get("autonomousResolutionsApplied", 0))
    doctrine_count, manual_count = len(doctrine), len(manual)
    technical_denominator = max(0, len(records) - doctrine_count - manual_count)
    # Resolved decisions are already included in completed post-resolution rows: do not double count.
    agent_executed_verified = 0
    numerator = min(technical_denominator, completed + agent_executed_verified)
    rate = 1.0 if technical_denominator == 0 else numerator / technical_denominator
    unresolved_technical = sum(derived_counts.get(x, 0) for x in ("ready_for_autonomous_preflight", "blocked_by_live_drift", "blocked_by_missing_native_tool", "unknown"))
    platform_ready = not blocking and unresolved_technical == 0
    target = float(as_dict(as_dict(contract).get("businessMetric")).get("targetRate", 1.0))
    business_status = "complete_verified" if platform_ready and rate >= target else "review_required"
    metric_cfg = as_dict(as_dict(contract).get("businessMetric"))
    metrics = {
        "businessAutonomyRate": round(rate, 6), "businessAutonomyTarget": target,
        "registryRecords": len(records), "technicalDenominator": technical_denominator,
        "completedNoActionRequired": completed, "agentDecided": agent_decided,
        "agentExecutedVerified": agent_executed_verified, "expertDecisionRemaining": int(derived_counts.get("requires_expert_decision", 0)),
        "humanDoctrine": doctrine_count, "manualIncompressible": manual_count,
        "unresolvedTechnical": unresolved_technical, "reworkOrDriftEvents": int(derived_counts.get("blocked_by_live_drift", 0)),
        "mutationAttempts": len(mutation_hits), "mutationSuccessesVerified": agent_executed_verified,
        "estimatedHumanMinutes": len(expert) * int(metric_cfg.get("estimatedHumanMinutesPerExpert", 15)) + doctrine_count * int(metric_cfg.get("estimatedHumanMinutesPerDoctrine", 15)) + manual_count * int(metric_cfg.get("estimatedHumanMinutesPerManualIncompressible", 20)),
        "estimatedRunCostEur": float(metric_cfg.get("estimatedRunCostEur", 0)),
        "costQualification": metric_cfg.get("costQualification")
    }

    artifacts = {
        "businessScore": OPS / "inqom-business-autonomy-score.json",
        "transactionLineage": OPS / "inqom-transaction-lineage-registry.json",
        "documentProvenance": OPS / "inqom-document-provenance-registry.json",
        "fixedAssets": OPS / "inqom-fixed-assets-subledger.json",
        "vatControls": OPS / "inqom-vat-cash-basis-controls.json",
        "humanResiduals": OPS / "inqom-human-residuals-register.json",
        "main": OPS / "inqom-business-autonomy-control-plane.json"
    }
    generated = iso_now()
    child_payloads = {
        "businessScore": {"generatedAt": generated, "ok": platform_ready, "status": business_status, "platformReady": platform_ready, "businessAutonomyStatus": business_status, "metrics": metrics, "blockingReasons": sorted(set(blocking)), "sourceReports": source_reports},
        "transactionLineage": {"generatedAt": generated, "ok": not tx_issues, "status": "complete" if not tx_issues else "review", "counts": {"lineages": len(tx_rows), "exceptions": len(tx_exceptions), "missingNativeTransactionIdExceptions": len(tx_exceptions)}, "lineages": tx_rows, "exceptions": tx_exceptions, "blockingReasons": tx_issues},
        "documentProvenance": {"generatedAt": generated, "ok": not doc_issues, "status": "complete" if not doc_issues else "review", "counts": {"evidenceRecords": len(doc_rows), "directOrClassified": sum(x["coverageMode"] == "direct_or_classified" for x in doc_rows), "inherited": sum(x["coverageMode"] == "inherited" for x in doc_rows), "humanQuestions": sum(x["humanQuestionRequired"] for x in doc_rows)}, "cascade": as_list(as_dict(contract).get("documentEvidenceCascade")), "records": doc_rows, "blockingReasons": doc_issues},
        "fixedAssets": {"generatedAt": generated, "ok": not fixed_issues, "status": "subledger_ready" if not fixed_issues else "review", "counts": {**fixed_stats, "covered": int(as_dict(as_dict(payloads["balanceResolution"]).get("counts")).get("coveredFixedAssetReviewGroups", 0))}, "groups": fixed_rows, "mutationAttempted": 0, "blockingReasons": fixed_issues},
        "vatControls": {"generatedAt": generated, "ok": not vat_issues, **vat, "blockingReasons": vat_issues},
        "humanResiduals": {"generatedAt": generated, "ok": not human_issues, "status": "exact_residual_scope_verified" if not human_issues else "drift", "counts": {"humanDoctrine": len(doctrine), "manualIncompressible": len(manual), "expertDecision": len(expert), "technicalOperationsDelegatedToHuman": 0}, "humanDoctrine": doctrine, "manualIncompressible": manual, "expertDecision": expert, "blockingReasons": human_issues}
    }
    for key, payload in child_payloads.items():
        artifacts[key].write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    main_report = {
        "generatedAt": generated, "contractVersion": as_dict(contract).get("contractVersion"),
        "capabilityId": "inqom-business-autonomy-control-plane", "ok": platform_ready,
        "status": "processed", "platformReady": platform_ready, "businessAutonomyStatus": business_status,
        "metrics": metrics, "counts": {"sourceReports": len(source_reports), "transactionLineages": len(tx_rows), "documentEvidenceRecords": len(doc_rows), "fixedAssetGroups": fixed_stats["representedGroups"], "humanDoctrine": len(doctrine), "manualIncompressible": len(manual), "expertDecision": len(expert), "failed": len(set(blocking))},
        "blockingReasons": sorted(set(blocking)), "sourceReports": source_reports,
        "mutationEnvelope": as_dict(as_dict(contract).get("mutationEnvelope")),
        "guardrails": {"readOnlyControlPlane": True, "noInqomMutation": True, "noExternalSend": True, "noTaxFiling": True, "activeApprovalMustBeAbsent": True, "humanNeverTechnicalFallback": True},
        "artifacts": {k: str(v) for k, v in artifacts.items()}
    }
    artifacts["main"].write_text(json.dumps(main_report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(main_report, ensure_ascii=False))
    return 0 if main_report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
