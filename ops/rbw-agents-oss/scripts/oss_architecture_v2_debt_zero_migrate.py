#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import sys
from datetime import UTC, datetime
from pathlib import Path

from lib.config_mutation import atomic_write_json, expected_manifest_count
from pydantic import JsonValue, TypeAdapter

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
NUMBER = TypeAdapter(str | int | float)

LIVE_ROOT = Path("/srv/rbw-agents-oss")
LIVE_OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
WORKSPACE_CWD = "/home/craft/.craft-agent/workspaces/my-workspace-2"
VENV_PYTHON = "/srv/rbw-agents-oss/.venv/bin/python"
NODE = "/usr/bin/node"
DRIVE_TRIGGER = "/srv/rbw-agents-oss/scripts/drive_audio_transcription_service_trigger.py"
ALLOWED_ENV = {
    "robinswood-pme-hdf-sellsy-crm-sync": {"RBW_HDF_SELLSY_SYNC_APPLY": "1"},
    "campaign-history-sellsy-company-sync": {"RBW_CAMPAIGN_HISTORY_SELLSY_SYNC_APPLY": "1"},
}
NEW_MANUAL_HELPERS = {
    "scripts/oss_architecture_v2_debt_zero_migrate.py": ("one_shot_structural_migration", "medium_admin_manual"),
    "scripts/oss_architecture_v2_debt_zero_guard.py": ("manual_observability_or_builder_tool", "low_observability"),
    "scripts/oss_runtime_v2_queue_canary.py": ("test_wrapper_or_regression_tool", "low_manual_test"),
    "scripts/oss_runtime_v2_queue_canary_manage.py": ("one_shot_structural_migration", "medium_admin_manual"),
}
SHELL_MARKERS = re.compile(r"(?:&&|\|\||(?<!\\)[|;<>`]|\$\(|\$\{|\$[A-Za-z_]|(?<!\\)[*?\[])")


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict[str, JsonValue]:
    return JSON_OBJECT.validate_json(path.read_bytes())


def atomic_json(path: Path, payload: JsonValue) -> None:
    atomic_write_json(path, payload)


def flatten_manifest(data: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    return [row for values in data.values() if isinstance(values, list) for row in values if isinstance(row, dict) and row.get("legacy_id")]


def schedule_rows(data: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    return [row for row in TypeAdapter(list[JsonValue]).validate_python(data.get("schedules", [])) if isinstance(row, dict)]


def schedule_legacy(row: dict[str, JsonValue]) -> str | None:
    payload_value = row.get("payload")
    payload = payload_value if isinstance(payload_value, dict) else {}
    value = row.get("legacy_id") or payload.get("legacy_id") or row.get("capability_id")
    return str(value) if value else None


def schedule_fingerprint(rows: list[dict[str, JsonValue]]) -> str:
    shaped = [{
        "schedule_id": row.get("schedule_id"),
        "workflow_id": row.get("workflow_id"),
        "task_queue": row.get("task_queue"),
        "cron": row.get("cron"),
        "timezone": row.get("timezone", "Europe/Paris"),
        "enabled": bool(row.get("enabled", True)),
        "legacy_id": schedule_legacy(row),
    } for row in rows]
    raw = json.dumps(sorted(shaped, key=lambda item: str(item.get("schedule_id"))), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def runtime_report_path(legacy_id: str) -> str:
    return str(LIVE_OPS / "runtime-v2" / f"{legacy_id}-last.json")


def parse_direct_command(row: dict[str, JsonValue]) -> tuple[list[str], dict[str, str], str]:
    legacy_id = str(row["legacy_id"])
    command = str(row.get("command") or "").strip()
    if legacy_id == "drive-audio-transcription-autopilot":
        expected = "/bin/bash -lc 'sudo -n systemctl start rbw-drive-audio-transcription.service && systemctl show rbw-drive-audio-transcription.service --property=ActiveState,SubState,MainPID --no-pager'"
        if command != expected:
            raise ValueError(f"unexpected drive transcription shell command: {command}")
        argv = [VENV_PYTHON, DRIVE_TRIGGER]
        return argv, {}, shlex.join(argv)
    if SHELL_MARKERS.search(command):
        raise ValueError(f"shell semantics forbidden for {legacy_id}: {command}")
    tokens = shlex.split(command, posix=True)
    env: dict[str, str] = {}
    while tokens and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[0]):
        key, value = tokens.pop(0).split("=", 1)
        env[key] = value
    if env != ALLOWED_ENV.get(legacy_id, {}) and (env or legacy_id in ALLOWED_ENV):
        raise ValueError(f"unexpected manifest environment for {legacy_id}: {sorted(env)}")
    if not tokens:
        raise ValueError(f"empty command for {legacy_id}")
    executable = tokens[0]
    if executable == "python3":
        tokens[0] = VENV_PYTHON
    elif executable == "node":
        tokens[0] = NODE
    elif not executable.startswith("/"):
        raise ValueError(f"unresolved executable for {legacy_id}: {executable}")
    if any(token in {"&&", "||", "|", ";", ">", ">>", "<", "&"} for token in tokens):
        raise ValueError(f"shell operator token for {legacy_id}")
    return tokens, env, shlex.join(tokens)


def seed_pending_report(ops: Path, legacy_id: str, live_path: str) -> Path:
    out = ops / "runtime-v2" / f"{legacy_id}-last.json"
    if out.exists():
        return out
    generated = now_iso()
    report: dict[str, JsonValue] = {
        "generatedAt": generated,
        "contractVersion": "runtime-v2-execution-report-v1",
        "capabilityId": legacy_id,
        "ok": False,
        "status": "pending_first_scheduled_run",
        "summary": f"runtime_v2_execution: id={legacy_id} pending first post-cutover Temporal invocation",
        "counts": {"runs": 0, "exitCode": 0, "timeouts": 0, "businessFailures": 0, "technicalFailures": 0, "stdoutBytes": 0, "stderrBytes": 0},
        "blockingReasons": [],
        "warningReasons": ["pending_first_post_cutover_run"],
        "artifacts": {"reportJson": live_path},
        "checks": {"stage": "migration_seed", "executionBackend": "argv", "policyDecision": "not_executed"},
        "data": {},
        "updatedBy": "oss-architecture-v2-debt-zero-migrate",
    }
    atomic_json(out, report)
    return out


def migrate(root: Path, ops: Path) -> dict[str, JsonValue]:
    approved_count = expected_manifest_count(root)
    manifest_path = root / "config" / "command-manifest.json"
    schedules_path = root / "config" / "temporal" / "schedules.json"
    policy_path = root / "config" / "registry" / "report-contract-coverage-policy.json"
    script_coverage_path = root / "config" / "registry" / "script-coverage-policy.json"
    manifest = read_json(manifest_path)
    schedules = read_json(schedules_path)
    policy = read_json(policy_path)
    script_coverage = read_json(script_coverage_path)
    rows = flatten_manifest(manifest)
    srows = schedule_rows(schedules)
    if len(rows) != approved_count:
        raise ValueError(f"expected {approved_count} manifest rows, got {len(rows)}")
    if len(srows) != 139:
        raise ValueError(f"expected 139 schedules, got {len(srows)}")
    ids = [str(row["legacy_id"]) for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate manifest IDs")
    before_fp = schedule_fingerprint(srows)
    converted = 0
    env_rows = 0
    report_backfilled = 0
    parity: list[dict[str, JsonValue]] = []
    for row in rows:
        legacy_id = str(row["legacy_id"])
        original = str(row.get("command") or "")
        argv, env, display = parse_direct_command(row)
        execution: dict[str, JsonValue] = {
            "backend": "argv",
            "argv": list(argv),
            "cwd": WORKSPACE_CWD,
            "timeout_seconds": int(NUMBER.validate_python(row.get("timeout_seconds") or 600)),
        }
        if env:
            execution["env"] = dict(env)
            env_rows += 1
        row["execution"] = execution
        row["runtimeVersion"] = "v2"
        row["command"] = display
        _ = row.pop("transientRuntimeV2Canary", None)
        live_runtime_report = runtime_report_path(legacy_id)
        row["runtimeReportJsonPath"] = live_runtime_report
        row["expectsReport"] = True
        previous_json = str(row.get("reportJsonPath") or "")
        previous_md = str(row.get("reportMdPath") or "")
        previous_contract = str(row.get("contractVersion") or "")
        if previous_json and previous_json != live_runtime_report:
            _ = row.setdefault("businessReportJsonPath", previous_json)
        if previous_md:
            _ = row.setdefault("businessReportMdPath", previous_md)
        if previous_contract and previous_contract != "runtime-v2-execution-report-v1":
            _ = row.setdefault("businessContractVersion", previous_contract)
        if previous_json != live_runtime_report or previous_md:
            report_backfilled += 1
        row["reportJsonPath"] = live_runtime_report
        _ = row.pop("reportMdPath", None)
        row["contractVersion"] = "runtime-v2-execution-report-v1"
        _ = seed_pending_report(ops, legacy_id, live_runtime_report)
        parity.append({
            "legacyId": legacy_id,
            "originalCommandSha256": hashlib.sha256(original.encode()).hexdigest(),
            "argv": list(argv),
            "envKeys": TypeAdapter(list[JsonValue]).validate_python(sorted(env)),
            "displayCommand": display,
        })
        converted += 1
    manifest["updatedAt"] = now_iso()
    manifest["updatedBy"] = "oss-architecture-v2-debt-zero-migrate"
    policy["acceptedScheduledWithoutReport"] = []
    policy_counts = policy.setdefault("counts", {})
    if not isinstance(policy_counts, dict):
        raise TypeError("policy counts must be an object")
    policy_counts["acceptedScheduledWithoutReport"] = 0
    policy["updatedAt"] = now_iso()
    policy["updatedBy"] = "oss-architecture-v2-debt-zero-migrate"
    policy["debtClosure"] = {
        "closedAt": now_iso(),
        "reason": "All scheduled manifest entries now declare either a business report or a canonical runtime-v2 execution report.",
        "previousAcceptedScheduleEntries": 96,
        "remainingAcceptedScheduleEntries": 0,
    }
    coverage_key = "acceptedOrphanScripts" if isinstance(script_coverage.get("acceptedOrphanScripts"), list) else "rows"
    coverage_rows = TypeAdapter(list[dict[str, JsonValue]]).validate_python(script_coverage.setdefault(coverage_key, []))
    known_paths = {str(item.get("path")) for item in coverage_rows if item.get("path")}
    for helper_path, (policy_class, risk_class) in NEW_MANUAL_HELPERS.items():
        if helper_path in known_paths:
            continue
        coverage_rows.append({
            "path": helper_path, "accepted": True, "manifestCommandExpected": False, "scheduleAllowed": False,
            "requiresManifestBeforeScheduling": True, "requiresExplicitReviewBeforeAutomation": True,
            "policyClass": policy_class, "riskClass": risk_class,
            "allowedInvocation": ["manual_direct", "ci_or_guard_harness"], "updatedAt": now_iso(),
            "updatedBy": "oss-architecture-v2-debt-zero-migrate",
            "rationale": "Debt-zero migration/guard/canary helper; never directly scheduled in the approved final manifest.",
        })
    sorted_coverage_rows = sorted(coverage_rows, key=lambda item: str(item.get("path")))
    script_coverage[coverage_key] = list(sorted_coverage_rows)
    script_coverage["updatedAt"] = now_iso()
    script_coverage["updatedBy"] = "oss-architecture-v2-debt-zero-migrate"
    coverage_counts = script_coverage.setdefault("counts", {})
    if not isinstance(coverage_counts, dict):
        raise TypeError("coverage counts must be an object")
    coverage_counts["acceptedOrphanScripts"] = len(sorted_coverage_rows)
    atomic_json(manifest_path, manifest)
    atomic_json(policy_path, policy)
    atomic_json(script_coverage_path, script_coverage)

    sys.path.insert(0, str(root / "packages"))
    from rbw_agent_runtime.catalog import CatalogCompiler
    compiler = CatalogCompiler(root)
    catalog_result = compiler.build(write_fragments=True)
    validation = compiler.validate()
    final_schedules = read_json(schedules_path)
    after_fp = schedule_fingerprint(schedule_rows(final_schedules))
    if before_fp != after_fp:
        raise ValueError(f"schedule fingerprint drift: {before_fp} != {after_fp}")
    expected = {"agents": approved_count, "cards": approved_count, "argv": approved_count, "legacyShell": 0, "policyGaps": 0}
    catalog_counts = JSON_OBJECT.validate_python(catalog_result.get("counts", {}))
    for key, value in expected.items():
        if int(NUMBER.validate_python(catalog_counts.get(key, -1))) != value:
            raise ValueError(f"catalog count mismatch {key}: {catalog_counts.get(key)} != {value}")
    if not validation.get("ok"):
        raise ValueError(f"catalog validation failed: {validation.get('errors')}")
    report: dict[str, JsonValue] = {
        "generatedAt": now_iso(),
        "contractVersion": "oss-agent-report-envelope-v2",
        "capabilityId": "oss-architecture-v2-debt-zero-migration",
        "ok": True,
        "status": "staged",
        "summary": f"debt_zero_migration: manifest={approved_count} argv={approved_count} legacy=0 schedules=139 reportDebt=0 envRows={env_rows} shellWrappers=0",
        "counts": {
            "manifest": approved_count,
            "convertedToArgv": converted,
            "argv": approved_count,
            "legacyShell": 0,
            "typedEnvRows": env_rows,
            "serviceTriggerWrappers": 1,
            "schedules": 139,
            "reportPathsBackfilled": report_backfilled,
            "acceptedReportDebt": 0,
            "policyGaps": 0,
        },
        "blockingReasons": [],
        "warningReasons": [],
        "artifacts": {
            "manifest": str(manifest_path),
            "catalog": str(root / "config" / "agents-v2" / "catalog-v2.json"),
            "parity": str(ops / "oss-architecture-v2-debt-zero-command-parity.json"),
        },
        "checks": {
            "scheduleFingerprintBefore": before_fp,
            "scheduleFingerprintAfter": after_fp,
            "catalogBuild": catalog_result,
            "catalogValidation": validation,
            "dangerousShellMarkers": 0,
        },
        "data": {},
        "updatedBy": "oss-architecture-v2-debt-zero-migrate",
    }
    atomic_json(ops / "oss-architecture-v2-debt-zero-command-parity.json", {"generatedAt": now_iso(), "rows": list(parity), "counts": report["counts"]})
    atomic_json(ops / "oss-architecture-v2-debt-zero-migration-last.json", report)
    return report


class Arguments(argparse.Namespace):
    root: str = ""
    ops: str = str(LIVE_OPS)


def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("--root", required=True, help="Staging root; direct live-root migration is forbidden")
    _ = parser.add_argument("--ops", default=str(LIVE_OPS))
    args = parser.parse_args(namespace=Arguments())
    root = Path(args.root).resolve()
    if root == LIVE_ROOT.resolve():
        raise SystemExit("fail-closed: debt-zero migrator is staging-only; use ConfigMutation for live cutover")
    report = migrate(root, Path(args.ops))
    print(json.dumps({"ok": report["ok"], "status": report["status"], "summary": report["summary"], "counts": report["counts"], "reportJson": str(Path(args.ops) / "oss-architecture-v2-debt-zero-migration-last.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
