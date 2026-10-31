from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import uuid
from datetime import UTC, datetime
from pathlib import Path

from lib.config_mutation import PROTECTED_CONFIG_FILES, ConfigMutation
from pydantic import JsonValue, TypeAdapter, ValidationError

type JsonObject = dict[str, JsonValue]
JSON_ADAPTER = TypeAdapter(JsonValue)
OBJECT_ADAPTER = TypeAdapter(JsonObject)
ROWS_ADAPTER = TypeAdapter(list[JsonObject])

def _policy_rows(value: JsonValue) -> list[JsonObject]:
    return ROWS_ADAPTER.validate_python(value) if isinstance(value, list) else []

ROOT = Path("/srv/rbw-agents-oss")

CONFIG = ROOT / "config"

SCRIPTS = ROOT / "scripts"

APPS = ROOT / "apps" / "orchestrator-temporal"

OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")

MANIFEST = CONFIG / "command-manifest.json"

MAPPING = CONFIG / "automation-mapping.json"

SCHEDULES = CONFIG / "temporal" / "schedules.json"

SIDE_EFFECTS = CONFIG / "registry" / "side-effects-policy.json"

MANIFEST_ONLY = CONFIG / "registry" / "manifest-only-policy.json"

SCRIPT_COVERAGE = CONFIG / "registry" / "script-coverage-policy.json"

BASELINE = CONFIG / "agents-v2" / "baseline.json"

ACTIVITIES = APPS / "activities.py"

RELEASE_GATE = SCRIPTS / "oss_release_gate.py"

SLO_WRAPPER = SCRIPTS / "temporal_performance_slo_guard.py"

README = ROOT / "README.md"

MAKEFILE = ROOT / "Makefile"

P0_SCRIPT = SCRIPTS / "oss_p0_structural_patch.py"

REPORT_JSON = OPS / "oss-architecture-v2-install-last.json"

REPORT_MD = OPS / "oss-architecture-v2-install-last.md"

STAMP = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")

ARCHIVE = ROOT / "archive" / "2026-07" / "architecture-v2" / STAMP

NEW_HELPERS = {
    "scripts/oss_architecture_v2_install.py": "one_shot_structural_migration",
    "scripts/oss_architecture_v2_catalog.py": "manual_observability_or_builder_tool",
    "scripts/oss_architecture_v2_guard.py": "manual_observability_or_builder_tool",
    "scripts/oss_architecture_v2_selftest.py": "test_wrapper_or_regression_tool",
    "scripts/temporal_performance_slo_core.py": "shared_observability_component",
    "scripts/oss_p0_structural_patch.py": "one_shot_structural_migration",
}

CONSERVATIVE_MANUAL_HELPERS: dict[str, tuple[str, str, list[str]]] = {
    "scripts/drive_audio_transcription_autopilot.original.py": ("retained_original_reference", "medium_manual_reference", ["manual_direct_after_review"]),
    "scripts/oss_security_audit_guard.py": ("manual_observability_or_builder_tool", "low_observability", ["manual_direct", "parent_observability_pipeline"]),
    "scripts/speaker_voice_profile_tool.py": ("manual_editorial_audio_helper", "medium_human_approval_required", ["manual_direct_after_explicit_review", "approved_content_pipeline"]),
    **{
        path: ("high_risk_manual_or_retired_tool", "high_human_approval_required", ["manual_direct_after_explicit_review"])
        for path in (
            "scripts/linkedin_connection_browser_provider.py",
            "scripts/linkedin_connection_browser_provider_core.py",
            "scripts/linkedin_dispatch_report_finalize.py",
            "scripts/linkedin_known_profile_evidence.py",
            "scripts/linkedin_login_verify.py",
            "scripts/linkedin_novnc_auth.py",
            "scripts/linkedin_playwright_auth_link.py",
            "scripts/linkedin_playwright_auth_web.py",
            "scripts/linkedin_profile_action_probe.py",
            "scripts/linkedin_qualified_queue_guard.py",
            "scripts/linkedin_selector_false_negative_migrate.py",
            "scripts/linkedin_sellsy_evidence_normalize.py",
            "scripts/linkedin_sellsy_officer_enrichment.py",
            "scripts/linkedin_sellsy_trace_reconcile.py",
            "scripts/linkedin_vnc_install_preflight.py",
            "scripts/linkedin_vnc_preflight.py",
            "scripts/sellsy_linkedin_connection_dispatch_core.py",
            "scripts/sellsy_linkedin_officer_revalidation.py",
        )
    },
}

def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")

def load_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        return JSON_ADAPTER.validate_json(path.read_bytes())
    except (OSError, UnicodeError, ValidationError):
        return default

def archive_copy(path: Path, label: str = "before") -> str | None:
    if not path.exists():
        return None
    relative = path.relative_to(ROOT)
    target = ARCHIVE / label / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    _ = shutil.copy2(path, target)
    return str(target)

def atomic_write(path: Path, content: str, changes: list[dict[str, JsonValue]], *, archive_label: str = "before") -> bool:
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == content:
        changes.append({"action": "unchanged", "path": str(path)})
        return False
    backup = archive_copy(path, archive_label)
    if path in PROTECTED_CONFIG_FILES:
        with ConfigMutation("oss-architecture-v2-install") as mutation:
            mutation.write_text(path, content)
        helper_backup = mutation.backups.get(str(path))
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        _ = tmp.write_text(content, encoding="utf-8")
        _ = tmp.replace(path)
        helper_backup = None
    changes.append({"action": "write", "path": str(path), "bytes": len(content.encode("utf-8")), "archive": backup, "configMutationArchive": helper_backup})
    return True

def write_json(path: Path, payload: JsonValue, changes: list[dict[str, JsonValue]], *, archive_label: str = "before") -> bool:
    return atomic_write(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n", changes, archive_label=archive_label)

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"patch {label} expected one match, found {count}")
    return text.replace(old, new, 1)

def run(command: list[str], timeout: int = 180, env: dict[str, str] | None = None) -> dict[str, JsonValue]:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    try:
        proc = subprocess.run(command, cwd=str(ROOT), env=merged, text=True, capture_output=True, timeout=timeout, check=False)
        return {"ok": proc.returncode == 0, "returnCode": proc.returncode, "command": list[JsonValue](command), "stdout": proc.stdout[-2500:], "stderr": proc.stderr[-2500:]}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "returnCode": None, "command": list[JsonValue](command), "stdout": "", "stderr": repr(exc)}

def manifest_rows(data: JsonValue) -> list[dict[str, JsonValue]]:
    if not isinstance(data, dict):
        return []
    return [row for values in data.values() if isinstance(values, list) for row in values if isinstance(row, dict) and row.get("legacy_id")]

def mapping_rows(data: JsonValue) -> list[dict[str, JsonValue]]:
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        return [row for values in data.values() if isinstance(values, list) for row in values if isinstance(row, dict)]
    return []

def schedule_rows(data: JsonValue) -> list[dict[str, JsonValue]]:
    rows: JsonValue = data.get("schedules", []) if isinstance(data, dict) else []
    return _policy_rows(rows)

def schedule_legacy(row: dict[str, JsonValue]) -> str | None:
    raw_payload = row.get("payload")
    payload = raw_payload if isinstance(raw_payload, dict) else {}
    value = row.get("legacy_id") or payload.get("legacy_id") or row.get("capability_id")
    return str(value) if value else None

def schedule_fingerprint(rows: list[dict[str, JsonValue]]) -> str:
    shaped = [
        {
            "schedule_id": row.get("schedule_id"),
            "workflow_id": row.get("workflow_id"),
            "task_queue": row.get("task_queue"),
            "cron": row.get("cron"),
            "timezone": row.get("timezone", "Europe/Paris"),
            "enabled": bool(row.get("enabled", True)),
            "legacy_id": schedule_legacy(row),
        }
        for row in rows
    ]
    raw = json.dumps(sorted(shaped, key=lambda item: str(item.get("schedule_id"))), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()

def classify_side_effect(row: dict[str, JsonValue], scheduled: bool) -> dict[str, JsonValue]:
    legacy_id = str(row.get("legacy_id"))
    risk = str(row.get("riskClass") or "medium_unclassified")
    command = str(row.get("command") or "").lower()
    raw_effects = row.get("sideEffects", [])
    if not isinstance(raw_effects, list):
        raise TypeError("sideEffects must be an array")
    effects = [str(value) for value in raw_effects if value]
    text = " ".join([legacy_id, risk, command] + effects).lower()
    is_test = "test" in legacy_id or "guardrail_tests" in risk
    is_finance_apply = any(token in text for token in ("inqom", "rubypayeur", "financial")) and any(token in text for token in ("--apply", "mutation", "executor", "dispatch"))
    is_outbound = any(token in text for token in ("linkedin", "external-communication", "gmail-send", "whatsapp-send", "mailer", "reply-scan"))
    if is_test:
        policy_class = "test_guardrail"
        mutation_mode = "observability_report_only"
        normalized_risk = "low_test_guardrail"
    elif is_finance_apply:
        policy_class = "finance_governance"
        mutation_mode = "human_approved_apply_only"
        normalized_risk = "high_human_approval_required"
    elif is_outbound:
        policy_class = "outbound_governance"
        mutation_mode = "guarded_external_prepare_or_send"
        normalized_risk = "high_guarded_campaign_or_outbound"
    elif legacy_id.startswith("traid-"):
        policy_class = "investment_lab_governance_fail_closed"
        mutation_mode = "sandbox_fail_closed_governance_prepare_only"
        normalized_risk = "medium_sandbox_fail_closed"
    else:
        policy_class = "business_or_observability_wrapper"
        mutation_mode = "prepare_only_or_read_only"
        normalized_risk = risk
    return {
        "legacy_id": legacy_id,
        "accepted": True,
        "policyClass": policy_class,
        "riskClass": normalized_risk,
        "mutationMode": mutation_mode,
        "scheduleAllowed": bool(scheduled),
        "requiresExplicitReviewBeforeRiskIncrease": True,
        "requiresHumanApprovalForApply": bool(is_finance_apply or is_outbound),
        "requiresHumanApprovalForExternalSend": bool(is_outbound),
        "sideEffects": list[JsonValue](effects) or ["filesystem-write:ops-report"],
        "updatedAt": now_iso(),
        "updatedBy": "oss-architecture-v2-install",
        "rationale": "Conservative runtime-v2 classification generated from live manifest metadata; external, CRM, LinkedIn and finance effects remain gated.",
    }

def update_side_effect_policy(manifest: dict[str, JsonValue], schedules: list[dict[str, JsonValue]], changes: list[dict[str, JsonValue]]) -> None:
    data = OBJECT_ADAPTER.validate_python(load_json(SIDE_EFFECTS, {}))
    rows = _policy_rows(data.get("capabilities", []))
    by_id = {str(row.get("legacy_id") or row.get("capability_id")): row for row in rows if (row.get("legacy_id") or row.get("capability_id"))}
    scheduled_ids = {schedule_legacy(row) for row in schedules}
    for row in manifest_rows(manifest):
        legacy_id = str(row["legacy_id"])
        if legacy_id not in by_id:
            classified = classify_side_effect(row, legacy_id in scheduled_ids)
            rows.append(classified)
            by_id[legacy_id] = classified
    ordered: list[JsonObject] = sorted(rows, key=lambda row: str(row.get("legacy_id") or row.get("capability_id")))
    data["capabilities"] = list[JsonValue](ordered)
    data["updatedAt"] = now_iso()
    data["updatedBy"] = "oss-architecture-v2-install"
    data["counts"] = {
        "manifestRows": len(manifest_rows(manifest)),
        "classifiedCapabilities": len({str(row.get('legacy_id') or row.get('capability_id')) for row in rows}),
        "highRisk": sum(1 for row in rows if str(row.get("riskClass", "")).startswith("high")),
        "requiresHumanApprovalForApply": sum(1 for row in rows if row.get("requiresHumanApprovalForApply")),
    }
    _ = write_json(SIDE_EFFECTS, data, changes)

def update_manifest_only_policy(manifest: dict[str, JsonValue], mapping: JsonValue, schedules: list[dict[str, JsonValue]], changes: list[dict[str, JsonValue]]) -> None:
    data = OBJECT_ADAPTER.validate_python(load_json(MANIFEST_ONLY, {}))
    rows = _policy_rows(data.get("acceptedManifestOnly", []))
    by_id = {str(row.get("legacy_id")): row for row in rows if row.get("legacy_id")}
    mapped = {str(row.get("legacy_id")) for row in mapping_rows(mapping) if row.get("legacy_id")}
    _ = schedules  # Manual-only entries remain unscheduled regardless of live schedules.
    for manifest_row in manifest_rows(manifest):
        legacy_id = str(manifest_row["legacy_id"])
        if legacy_id in mapped or legacy_id in by_id:
            continue
        is_test = "test" in legacy_id or "guardrail_tests" in str(manifest_row.get("riskClass") or "")
        is_outbound = "linkedin" in legacy_id or "dispatch" in legacy_id
        row: JsonObject = {
            "legacy_id": legacy_id,
            "accepted": True,
            "mappingExpectation": "manifest_only_manual_or_test",
            "temporalMappingRequired": False,
            "scheduleAllowed": False,
            "requiresExplicitReviewBeforeScheduling": True,
            "reviewAfter": "2026-10-31",
            "updatedAt": now_iso(),
            "updatedBy": "oss-architecture-v2-install",
            "policyClass": "test_wrapper" if is_test else "manual_guarded_outbound_tool" if is_outbound else "manual_prepare_only_tool",
            "riskClass": "low_manual_test" if is_test else "high_human_approval_required" if is_outbound else "medium_prepare_only",
            "allowedInvocation": ["manual_direct", "ci_or_guard_harness"] if is_test else ["manual_direct_after_explicit_review"] if is_outbound else ["manual_direct", "parent_pipeline"],
            "rationale": "Explicitly classified during runtime-v2 migration; no schedule or mapping is added.",
        }
        rows.append(row)
        by_id[legacy_id] = row
    current_manifest_only = {str(row["legacy_id"]) for row in manifest_rows(manifest)} - mapped
    ordered: list[JsonObject] = sorted(rows, key=lambda row: str(row.get("legacy_id")))
    data["acceptedManifestOnly"] = list[JsonValue](ordered)
    data["updatedAt"] = now_iso()
    data["updatedBy"] = "oss-architecture-v2-install"
    data["counts"] = {"acceptedManifestOnly": len(rows), "currentManifestOnly": len(current_manifest_only), "staleRetainedForAudit": len(set(by_id) - current_manifest_only)}
    _ = write_json(MANIFEST_ONLY, data, changes)

def update_script_coverage(changes: list[dict[str, JsonValue]]) -> None:
    data = OBJECT_ADAPTER.validate_python(load_json(SCRIPT_COVERAGE, {}))
    key = "acceptedOrphanScripts" if isinstance(data.get("acceptedOrphanScripts"), list) else "rows"
    rows = _policy_rows(data.get(key, []))
    by_path = {str(row.get("path")): row for row in rows if row.get("path")}
    for path, policy_class in NEW_HELPERS.items():
        if path in by_path:
            continue
        is_test = "selftest" in path
        row: JsonObject = {
            "path": path,
            "accepted": True,
            "manifestCommandExpected": False,
            "scheduleAllowed": False,
            "requiresManifestBeforeScheduling": True,
            "requiresExplicitReviewBeforeAutomation": True,
            "policyClass": policy_class,
            "riskClass": "low_manual_test" if is_test else "medium_admin_manual" if "install" in path or "p0_" in path else "low_observability",
            "allowedInvocation": ["manual_direct", "ci_or_guard_harness"] if is_test else ["manual_direct", "parent_observability_pipeline"],
            "updatedAt": now_iso(),
            "updatedBy": "oss-architecture-v2-install",
            "rationale": "Runtime-v2 package helper; invoked by the release gate, installer or controlled canary, never directly scheduled.",
        }
        rows.append(row)
        by_path[path] = row
    for path, (policy_class, risk_class, allowed_invocation) in CONSERVATIVE_MANUAL_HELPERS.items():
        if path in by_path:
            continue
        row = {
            "path": path,
            "accepted": True,
            "manifestCommandExpected": False,
            "scheduleAllowed": False,
            "requiresManifestBeforeScheduling": True,
            "requiresExplicitReviewBeforeAutomation": True,
            "policyClass": policy_class,
            "riskClass": risk_class,
            "allowedInvocation": list[JsonValue](allowed_invocation),
            "updatedAt": now_iso(),
            "updatedBy": "oss-architecture-v2-install",
            "rationale": "Classified conservatively during runtime-v2 migration; browser/dispatch helpers remain manual, unscheduled and review-gated.",
        }
        rows.append(row)
        by_path[path] = row
    ordered: list[JsonObject] = sorted(rows, key=lambda row: str(row.get("path")))
    data[key] = list[JsonValue](ordered)
    data["updatedAt"] = now_iso()
    data["updatedBy"] = "oss-architecture-v2-install"
    counts = OBJECT_ADAPTER.validate_python(data.setdefault("counts", {}))
    counts["acceptedOrphanScripts"] = len(rows)
    data["counts"] = counts
    _ = write_json(SCRIPT_COVERAGE, data, changes)
