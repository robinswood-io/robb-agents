#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path("/srv/rbw-agents-oss")
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "scripts"))

from lib.agent_runtime import OPS, standard_report, write_report_and_history
from lib.config_mutation import atomic_write_text
from rbw_agent_runtime.catalog import CatalogCompiler, flatten_manifest, read_json
from rbw_agent_runtime.policy import PolicyEngine

OUT_JSON = OPS / "oss-architecture-v2-guard-last.json"
OUT_MD = OPS / "oss-architecture-v2-guard-last.md"
HISTORY = OPS / "oss-architecture-v2-guard-history.jsonl"
BASELINE = ROOT / "config" / "agents-v2" / "baseline.json"
MANIFEST = ROOT / "config" / "command-manifest.json"
SCHEDULES = ROOT / "config" / "temporal" / "schedules.json"
ACTIVITIES = ROOT / "apps" / "orchestrator-temporal" / "activities.py"
SELFTEST = OPS / "oss-architecture-v2-selftest-last.json"
QUEUE_CANARIES = {queue: OPS / f"oss-runtime-v2-queue-canary-{queue}-last.json" for queue in ("default", "watchdog", "campaigns", "sync", "ao")}

CRITICAL_AGENT_TASK_CRONS = {
    "agent-task-google-tasks-intake-day": "0 9,13,17 * * 1-5",
    "agent-task-google-tasks-intake-evening": "0 19 * * 1-5",
    "agent-task-google-tasks-intake-overnight": "0 3 * * 2-6",
    "agent-task-inbox-router": "5 9,13,17,19 * * 1-5",
    "agent-task-inbox-router-overnight": "5 3 * * 2-6",
    "agent-task-temporal-openrouter-executor": "10 9,13,17,19 * * 1-5",
    "agent-task-temporal-openrouter-executor-overnight": "10 3 * * 2-6",
    "agent-task-context-enriched-campaign-executor": "10 9,13,17,19 * * 1-5",
    "agent-task-context-enriched-campaign-executor-overnight": "10 3 * * 2-6",
    "agent-task-campaign-activation-loop": "15 9,13,17,19 * * 1-5",
    "agent-task-campaign-activation-loop-overnight": "15 3 * * 2-6",
}


def schedule_rows() -> list[dict[str, Any]]:
    data = read_json(SCHEDULES, {})
    rows = data.get("schedules", []) if isinstance(data, dict) else []
    return [row for row in rows if isinstance(row, dict)]


def schedule_legacy(row: dict[str, Any]) -> str | None:
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    value = row.get("legacy_id") or payload.get("legacy_id") or row.get("capability_id")
    return str(value) if value else None


def schedule_fingerprint(rows: list[dict[str, Any]]) -> str:
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


def active_backup_files() -> list[str]:
    roots = [ROOT / "config", ROOT / "scripts", ROOT / "apps" / "orchestrator-temporal", ROOT / "compose"]
    out: list[str] = []
    for base in roots:
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or "archive" in path.parts:
                continue
            if ".bak" in path.name or path.name.endswith("~") or path.name.endswith(".old"):
                out.append(str(path.relative_to(ROOT)))
    return sorted(set(out))


def sensitive_permission_issues() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    roots = [ROOT / "secrets", ROOT / "config" / "secrets"]
    for base in roots:
        if not base.exists():
            continue
        for path in base.rglob("*"):
            try:
                mode = path.stat().st_mode & 0o777
            except Exception:
                continue
            if path.is_dir() and mode & 0o077:
                out.append({"path": str(path.relative_to(ROOT)), "mode": oct(mode), "type": "directory"})
            elif path.is_file() and mode & 0o077:
                out.append({"path": str(path.relative_to(ROOT)), "mode": oct(mode), "type": "file"})
    for path in (ROOT / "config" / "litellm" / "config.yaml", ROOT / "compose" / ".env"):
        if path.exists() and path.stat().st_mode & 0o077:
            out.append({"path": str(path.relative_to(ROOT)), "mode": oct(path.stat().st_mode & 0o777), "type": "file"})
    return out


def main() -> None:
    errors: list[str] = []
    warnings: list[str] = []
    compiler = CatalogCompiler(ROOT)
    validation = compiler.validate()
    errors.extend(validation.get("errors") or [])

    manifest_rows = flatten_manifest(read_json(MANIFEST, {}))
    ids = {str(row.get("legacy_id")) for row in manifest_rows}
    rows = schedule_rows()
    baseline = read_json(BASELINE, {})
    current_fp = schedule_fingerprint(rows)
    expected_fp = baseline.get("scheduleFingerprint") if isinstance(baseline, dict) else None
    expected_count = baseline.get("scheduleCount") if isinstance(baseline, dict) else None
    if expected_count is None or expected_fp is None:
        errors.append("architecture_v2_baseline_missing")
    else:
        if len(rows) != int(expected_count):
            errors.append(f"schedule_count_drift:{len(rows)}!={expected_count}")
        if current_fp != expected_fp:
            errors.append("schedule_fingerprint_drift")

    by_legacy: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        legacy_id = schedule_legacy(row)
        if legacy_id:
            by_legacy.setdefault(legacy_id, []).append(row)
    for legacy_id, cron in CRITICAL_AGENT_TASK_CRONS.items():
        enabled = [row for row in by_legacy.get(legacy_id, []) if row.get("enabled", True) is not False]
        if not enabled:
            errors.append(f"agent_task_schedule_missing:{legacy_id}")
        for row in enabled:
            if row.get("cron") != cron:
                errors.append(f"agent_task_cron_drift:{legacy_id}:{row.get('cron')}!={cron}")

    activity_text = ACTIVITIES.read_text(encoding="utf-8", errors="ignore") if ACTIVITIES.exists() else ""
    for marker in ("runtime_v2_bridge", "preflight_invocation", "run_structured_invocation", "unknown_automation_id"):
        if marker not in activity_text:
            errors.append(f"runtime_bridge_marker_missing:{marker}")
    if "skeleton dispatch only" in activity_text or "No direct dispatcher yet" in activity_text:
        errors.append("silent_skeleton_success_still_present")
    if "def _run_shell" in activity_text or "legacy_shell" in activity_text or "['bash', '-lc'" in activity_text:
        errors.append("legacy_shell_runtime_still_present")

    unknown = PolicyEngine("shadow").evaluate({"legacy_id": "__unknown_arch_v2_guard__"}, None, None)
    if unknown.allowed or "unknown_automation_id" not in unknown.strict_reasons:
        errors.append("unknown_id_not_fail_closed")

    selftest = read_json(SELFTEST, {})
    if selftest.get("ok") is not True or int((selftest.get("counts") or {}).get("catalogArgv") or 0) != 193:
        errors.append("runtime_v2_selftest_not_verified")
    queue_canaries = {queue: read_json(path, {}) for queue, path in QUEUE_CANARIES.items()}
    canary_ok = all(report.get("ok") is True and (report.get("checks") or {}).get("executionBackend") == "argv" for report in queue_canaries.values())
    if not canary_ok:
        errors.append("runtime_v2_five_queue_argv_canary_not_verified")

    backups = active_backup_files()
    if backups:
        errors.append(f"active_backup_files:{len(backups)}")
    permission_issues = sensitive_permission_issues()
    if permission_issues:
        errors.append(f"sensitive_permission_issues:{len(permission_issues)}")

    catalog_counts = validation.get("counts") or {}
    if int(catalog_counts.get("agents") or 0) != len(manifest_rows):
        errors.append("catalog_manifest_parity_failed")
    if int(catalog_counts.get("cards") or 0) != len(manifest_rows):
        errors.append("agent_card_coverage_failed")
    if int(catalog_counts.get("argv") or 0) != 193 or int(catalog_counts.get("legacyShell") or 0) != 0:
        errors.append(f"catalog_not_argv_only:{catalog_counts.get('argv')}/{catalog_counts.get('legacyShell')}")
    if len(manifest_rows) != 193:
        warnings.append(f"manifest_count_changed_from_approved_baseline:{len(manifest_rows)}")

    ok = not errors
    counts = {
        "manifestAgents": len(manifest_rows),
        "catalogAgents": int(catalog_counts.get("agents") or 0),
        "agentCards": int(catalog_counts.get("cards") or 0),
        "schedules": len(rows),
        "activeBackups": len(backups),
        "sensitivePermissionIssues": len(permission_issues),
        "workerArgvCanary": int(canary_ok),
        "queueArgvCanaries": sum(1 for report in queue_canaries.values() if report.get("ok") is True and (report.get("checks") or {}).get("executionBackend") == "argv"),
        "catalogArgv": int(catalog_counts.get("argv") or 0),
        "catalogLegacyShell": int(catalog_counts.get("legacyShell") or 0),
        "errors": len(errors),
        "warnings": len(warnings),
    }
    report = standard_report(
        capability_id="oss-architecture-v2-guard",
        ok=ok,
        status="passed" if ok else "blocked",
        summary=f"architecture_v2_guard: manifest={counts['manifestAgents']} catalog={counts['catalogAgents']} cards={counts['agentCards']} schedules={counts['schedules']} canary={counts['workerArgvCanary']} errors={counts['errors']}",
        counts=counts,
        blocking_reasons=errors,
        warning_reasons=warnings,
        artifacts={"reportJson": str(OUT_JSON), "reportMd": str(OUT_MD), "historyJsonl": str(HISTORY), "catalog": str(ROOT / "config" / "agents-v2" / "catalog-v2.json")},
        checks={
            "catalogValidation": validation,
            "baseline": baseline,
            "currentScheduleFingerprint": current_fp,
            "unknownIdDecision": unknown.model_dump(mode="json"),
            "selftest": {"ok": selftest.get("ok"), "status": selftest.get("status"), "counts": selftest.get("counts"), "summary": selftest.get("summary")},
            "queueCanaries": {queue: {"ok": report.get("ok"), "status": report.get("status"), "summary": report.get("summary"), "checks": report.get("checks")} for queue, report in queue_canaries.items()},
            "activeBackupSample": backups[:50],
            "permissionIssueSample": permission_issues[:50],
        },
        updated_by="oss-architecture-v2-guard",
    )
    write_report_and_history(OUT_JSON, HISTORY, report)
    atomic_write_text(
        OUT_MD,
        "# OSS Architecture v2 Guard\n\n"
        f"- status: {report['status']}\n"
        f"- manifest / catalog / cards: {counts['manifestAgents']} / {counts['catalogAgents']} / {counts['agentCards']}\n"
        f"- schedules: {counts['schedules']}\n"
        f"- argv canary: {bool(counts['workerArgvCanary'])}\n"
        f"- errors: {', '.join(errors) or 'none'}\n",
    )
    print(json.dumps({"ok": report["ok"], "status": report["status"], "summary": report["summary"], "counts": counts, "reportJson": str(OUT_JSON)}, ensure_ascii=False))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
