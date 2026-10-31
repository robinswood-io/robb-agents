#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from lib.config_mutation import atomic_write_json, expected_manifest_count
from pydantic import JsonValue, TypeAdapter

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
JSON_ARRAY = TypeAdapter(list[JsonValue])
NUMBER = TypeAdapter(str | int | float)

LIVE_ROOT = Path("/srv/rbw-agents-oss")
LIVE_OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
EXPECTED_SCHEDULE_FINGERPRINT = "af4879a4875146eb675686ec96a401be6f21ae7a0f2329afcfc22b36335bf647"
EXPECTED_ENV = {
    "robinswood-pme-hdf-sellsy-crm-sync": {"RBW_HDF_SELLSY_SYNC_APPLY": "1"},
    "campaign-history-sellsy-company-sync": {"RBW_CAMPAIGN_HISTORY_SELLSY_SYNC_APPLY": "1"},
}
STALE_RENEWALS = (
    "lp-shooting.robinswood.io.conf",
    "paperbridge.robinswood.io.conf",
    "plan.robinswood.io.conf",
    "rbw.ovh.conf",
)


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: JsonValue = None) -> JsonValue:
    try:
        return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except (OSError, ValueError):
        return default


def atomic_json(path: Path, payload: JsonValue) -> None:
    atomic_write_json(path, payload)


def flatten(data: JsonValue) -> list[dict[str, JsonValue]]:
    return [row for values in data.values() if isinstance(values, list) for row in values if isinstance(row, dict) and row.get("legacy_id")] if isinstance(data, dict) else []


def schedule_legacy(row: dict[str, JsonValue]) -> str | None:
    payload_value = row.get("payload")
    payload = payload_value if isinstance(payload_value, dict) else {}
    value = row.get("legacy_id") or payload.get("legacy_id") or row.get("capability_id")
    return str(value) if value else None


def fingerprint(rows: list[dict[str, JsonValue]]) -> str:
    shaped = [{"schedule_id": r.get("schedule_id"), "workflow_id": r.get("workflow_id"), "task_queue": r.get("task_queue"), "cron": r.get("cron"), "timezone": r.get("timezone", "Europe/Paris"), "enabled": bool(r.get("enabled", True)), "legacy_id": schedule_legacy(r)} for r in rows]
    return hashlib.sha256(json.dumps(sorted(shaped, key=lambda x: str(x.get("schedule_id"))), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def systemctl_state(unit: str) -> str:
    proc = subprocess.run(["/usr/bin/systemctl", "is-active", unit], text=True, capture_output=True, check=False)
    return (proc.stdout or proc.stderr).strip()


class Arguments(argparse.Namespace):
    root: str = str(LIVE_ROOT)
    ops: str = str(LIVE_OPS)
    include_systemd: bool = False


def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("--root", default=str(LIVE_ROOT))
    _ = parser.add_argument("--ops", default=str(LIVE_OPS))
    _ = parser.add_argument("--include-systemd", action="store_true")
    args = parser.parse_args(namespace=Arguments())
    root = Path(args.root); ops = Path(args.ops)
    errors: list[str] = []
    warnings: list[str] = []
    approved_count: int | None = None
    try:
        approved_count = expected_manifest_count(root)
    except (OSError, ValueError, TypeError):
        errors.append('approved_manifest_baseline_missing_or_invalid')
    manifest = read_json(root / "config/command-manifest.json", {})
    schedules = read_json(root / "config/temporal/schedules.json", {})
    policy = read_json(root / "config/registry/report-contract-coverage-policy.json", {})
    catalog = read_json(root / "config/agents-v2/catalog-v2.json", {})
    rows = flatten(manifest)
    srows = [r for r in JSON_ARRAY.validate_python(schedules.get("schedules", [])) if isinstance(r, dict)] if isinstance(schedules, dict) else []
    by_id = {str(r.get("legacy_id")): r for r in rows}
    if len(rows) != approved_count: errors.append(f"manifest_count:{len(rows)}")
    if len(srows) != 139: errors.append(f"schedule_count:{len(srows)}")
    fp = fingerprint(srows)
    if fp != EXPECTED_SCHEDULE_FINGERPRINT: errors.append(f"schedule_fingerprint:{fp}")
    non_argv: list[str] = []
    relative: list[str] = []
    shell_commands: list[str] = []
    env_mismatch: list[str] = []
    missing_contract: list[str] = []
    shell_re = re.compile(r"(?:/bin/bash|\bbash\s+-|&&|\|\||(?<!\\)[|;<>`]|\$\(|\$\{|\$[A-Za-z_])")
    for row in rows:
        legacy_id=str(row.get("legacy_id"))
        execution_value = row.get("execution")
        execution = execution_value if isinstance(execution_value, dict) else {}
        argv=execution.get("argv")
        if execution.get("backend") != "argv" or not isinstance(argv,list) or not argv: non_argv.append(legacy_id)
        elif not str(argv[0]).startswith("/"): relative.append(legacy_id)
        if shell_re.search(str(row.get("command") or "")): shell_commands.append(legacy_id)
        actual_env: JsonValue = execution.get("env") if isinstance(execution.get("env"),dict) else {}
        if actual_env != EXPECTED_ENV.get(legacy_id,{}): env_mismatch.append(legacy_id)
        if not row.get("expectsReport") or not row.get("reportJsonPath"): missing_contract.append(legacy_id)
    if non_argv: errors.append(f"non_argv:{','.join(non_argv[:20])}")
    if relative: errors.append(f"relative_executable:{','.join(relative[:20])}")
    if shell_commands: errors.append(f"shell_command:{','.join(shell_commands[:20])}")
    if env_mismatch: errors.append(f"env_mismatch:{','.join(env_mismatch[:20])}")
    if missing_contract: errors.append(f"missing_report_contract:{','.join(missing_contract[:20])}")
    for sched in srows:
        legacy_id=schedule_legacy(sched); row=by_id.get(str(legacy_id),{})
        if not row.get("expectsReport") or not row.get("reportJsonPath"): errors.append(f"scheduled_contract_missing:{sched.get('schedule_id')}")
    accepted=JSON_ARRAY.validate_python(policy.get("acceptedScheduledWithoutReport",[])) if isinstance(policy,dict) else []
    if accepted: errors.append(f"accepted_report_debt:{len(accepted)}")
    counts=JSON_OBJECT.validate_python(catalog.get("counts",{})) if isinstance(catalog,dict) else {}
    for key,value in {"agents":approved_count,"cards":approved_count,"argv":approved_count,"legacyShell":0,"policyGaps":0}.items():
        if int(NUMBER.validate_python(counts.get(key,-1))) != value: errors.append(f"catalog_{key}:{counts.get(key)}")
    runtime_files=[root/"packages/rbw_agent_runtime/models.py",root/"packages/rbw_agent_runtime/catalog.py",root/"packages/rbw_agent_runtime/policy.py",root/"apps/orchestrator-temporal/activities.py"]
    forbidden_runtime: list[str] = []
    for path in runtime_files:
        text=path.read_text(encoding="utf-8")
        if "legacy_shell" in text or "def _run_shell" in text or "['bash', '-lc'" in text: forbidden_runtime.append(str(path.relative_to(root)))
    if forbidden_runtime: errors.append(f"legacy_runtime_code:{','.join(forbidden_runtime)}")
    seeds=list((ops/"runtime-v2").glob("*-last.json")) if (ops/"runtime-v2").exists() else []
    if approved_count is None or len(seeds) < approved_count: errors.append(f"runtime_report_artifacts:{len(seeds)}")
    systemd_checks: dict[str, JsonValue] = {}
    if args.include_systemd:
        workers=["rbw-agents-oss-worker.service","rbw-agents-oss-worker-watchdog.service","rbw-agents-oss-worker-campaigns.service","rbw-agents-oss-worker-sync.service","rbw-agents-oss-worker-ao.service"]
        worker_states={u:systemctl_state(u) for u in workers}; systemd_checks["workers"]=dict(worker_states)
        if any(v!="active" for v in worker_states.values()): errors.append("worker_not_active")
        stale_present=[name for name in STALE_RENEWALS if (Path("/etc/letsencrypt/renewal")/name).exists()]
        systemd_checks["staleRenewalsPresent"]=list(stale_present)
        if stale_present: errors.append(f"stale_certbot_renewals:{','.join(stale_present)}")
        nightly_timer=subprocess.run(["/usr/bin/systemctl","is-enabled","nightly-agents.timer"],text=True,capture_output=True,check=False)
        systemd_checks["nightlyTimerEnabled"]=(nightly_timer.stdout or nightly_timer.stderr).strip()
        if nightly_timer.returncode==0: errors.append("obsolete_nightly_timer_enabled")
        failed=subprocess.run(["/usr/bin/systemctl","--failed","--no-legend","--plain"],text=True,capture_output=True,check=False)
        failed_lines=[line for line in failed.stdout.splitlines() if line.strip()]
        systemd_checks["failedUnits"]=list(failed_lines)
        if failed_lines: errors.append(f"failed_systemd_units:{len(failed_lines)}")
        cert_timer=systemctl_state("certbot.timer"); systemd_checks["certbotTimer"]=cert_timer
        if cert_timer!="active": errors.append(f"certbot_timer:{cert_timer}")
    report=JSON_OBJECT.validate_python({
        "generatedAt":now_iso(),"contractVersion":"oss-agent-report-envelope-v2","capabilityId":"oss-architecture-v2-debt-zero-guard",
        "ok":not errors,"status":"passed" if not errors else "failed",
        "summary":f"debt_zero_guard: manifest={len(rows)} argv={counts.get('argv')} legacy={counts.get('legacyShell')} schedules={len(srows)} reportDebt={len(accepted)} runtimeReports={len(seeds)} errors={len(errors)}",
        "counts":{"manifest":len(rows),"argv":int(NUMBER.validate_python(counts.get('argv',0))),"legacyShell":int(NUMBER.validate_python(counts.get('legacyShell',0))),"schedules":len(srows),"acceptedReportDebt":len(accepted),"runtimeReports":len(seeds),"shellCommands":len(shell_commands),"errors":len(errors),"warnings":len(warnings)},
        "blockingReasons":errors,"warningReasons":warnings,
        "artifacts":{"reportJson":str(ops/"oss-architecture-v2-debt-zero-guard-last.json")},
        "checks":{"scheduleFingerprint":fp,"typedEnvRows":sorted(EXPECTED_ENV),"systemd":systemd_checks,"forbiddenRuntimeFiles":forbidden_runtime},
        "data":{},"updatedBy":"oss-architecture-v2-debt-zero-guard",
    })
    atomic_json(ops/"oss-architecture-v2-debt-zero-guard-last.json",report)
    print(json.dumps({"ok":report["ok"],"status":report["status"],"summary":report["summary"],"blockingReasons":errors,"reportJson":str(ops/"oss-architecture-v2-debt-zero-guard-last.json")},ensure_ascii=False))
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
