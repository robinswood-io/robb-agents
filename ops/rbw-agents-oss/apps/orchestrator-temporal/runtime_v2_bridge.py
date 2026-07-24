from __future__ import annotations

import fcntl
import json
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path("/srv/rbw-agents-oss")
PACKAGES = ROOT / "packages"
if str(PACKAGES) not in sys.path:
    sys.path.insert(0, str(PACKAGES))

from rbw_agent_runtime.catalog import CatalogRepository
from rbw_agent_runtime.execution import execute_argv
from rbw_agent_runtime.policy import PolicyEngine
from rbw_agent_runtime.telemetry import append_event, runtime_attributes

_REPOSITORY = CatalogRepository(ROOT)
_POLICY = PolicyEngine()
_TELEMETRY = ROOT / "logs" / "runtime-v2-events.jsonl"
_OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
_RUNTIME_REPORTS = _OPS / "runtime-v2"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def runtime_report_path(legacy_id: str) -> Path:
    safe_id = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in legacy_id).strip("-")
    return _RUNTIME_REPORTS / f"{safe_id or 'unknown'}-last.json"


def _write_runtime_report(decision: dict[str, Any], result: dict[str, Any], *, stage: str) -> dict[str, Any]:
    legacy_id = str(decision.get("legacy_id") or "unknown")
    report_path = runtime_report_path(legacy_id)
    history_path = report_path.with_name(report_path.name.replace("-last.json", "-history.jsonl"))
    generated_at = _now_iso()
    ok = result.get("ok") is True
    timeout = bool(result.get("timeout"))
    business_failure = bool(result.get("businessFailure"))
    if ok:
        status = "passed"
    elif timeout:
        status = "timeout"
    elif business_failure:
        status = "business_failed"
    elif stage == "preflight":
        status = "blocked"
    else:
        status = "technical_failed"
    technical_reason = str(result.get("errorType") or result.get("error") or "nonzero_exit")
    report = {
        "generatedAt": generated_at,
        "contractVersion": "runtime-v2-execution-report-v1",
        "capabilityId": legacy_id,
        "ok": ok,
        "status": status,
        "summary": f"runtime_v2_execution: id={legacy_id} stage={stage} backend={decision.get('backend')} status={status} exitCode={result.get('exitCode')}",
        "counts": {
            "runs": 1,
            "exitCode": int(result.get("exitCode") or 0),
            "timeouts": int(timeout),
            "businessFailures": int(business_failure),
            "technicalFailures": int(not ok and not timeout and not business_failure),
            "stdoutBytes": int(result.get("stdoutBytes") or 0),
            "stderrBytes": int(result.get("stderrBytes") or 0),
        },
        "blockingReasons": [] if ok or business_failure else [technical_reason],
        "warningReasons": ["business_result_non_ok"] if business_failure else [],
        "artifacts": {"reportJson": str(report_path), "historyJsonl": str(history_path)},
        "checks": {
            "stage": stage,
            "executionBackend": decision.get("backend"),
            "policyMode": decision.get("policy_mode"),
            "policyDecision": decision.get("decision"),
            "specHash": decision.get("spec_hash"),
            "manifestEnvKeys": sorted((decision.get("env") or {}).keys()),
            "timeout": timeout,
            "businessFailure": business_failure,
            "durationSeconds": result.get("durationSeconds"),
        },
        "data": {},
        "updatedBy": "runtime-v2-bridge",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = report_path.with_name(f".{report_path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))
    tmp.replace(report_path)
    line = json.dumps({"ts": generated_at, "capabilityId": legacy_id, "ok": ok, "status": status, "counts": report["counts"]}, ensure_ascii=False) + "\n"
    with history_path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.write(line)
        handle.flush()
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return report


def load_manifest_entries() -> dict[str, dict[str, Any]]:
    """Return an mtime-cached, duplicate-checked manifest index."""
    return _REPOSITORY.manifest_entries()


def preflight_invocation(payload: dict[str, Any], entry: dict[str, Any] | None) -> dict[str, Any]:
    legacy_id = payload.get("legacy_id")
    spec = _REPOSITORY.spec(str(legacy_id)) if legacy_id else None
    decision = _POLICY.evaluate(payload, entry, spec, spec_hash=_REPOSITORY.spec_hash(str(legacy_id)) if legacy_id else None)
    data = decision.model_dump(mode="json")
    append_event(
        _TELEMETRY,
        "rbw.agent.preflight",
        runtime_attributes(
            legacy_id=data.get("legacy_id"),
            backend=data.get("backend"),
            policy_mode=data.get("policy_mode") or "shadow",
            decision=data.get("decision") or "block",
            risk_class=data.get("risk_class"),
        ),
        strictReasons=data.get("strict_reasons", []),
        shadowReasons=data.get("shadow_reasons", []),
        specHash=data.get("spec_hash"),
        cache=_REPOSITORY.cache_state(),
    )
    if not data.get("allowed") and data.get("legacy_id"):
        _write_runtime_report(data, {
            "ok": False,
            "exitCode": 2,
            "timeout": False,
            "businessFailure": False,
            "errorType": "RuntimeV2PreflightBlocked",
            "error": ",".join(data.get("strict_reasons") or ["preflight_blocked"]),
            "durationSeconds": 0.0,
        }, stage="preflight")
    return data


def run_structured_invocation(decision: dict[str, Any], extra_env: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        result = execute_argv(decision, extra_env=extra_env)
    except Exception as exc:
        result = {
            "ok": False,
            "exitCode": 127,
            "timeout": False,
            "businessFailure": False,
            "durationSeconds": 0.0,
            "stdout": "",
            "stderr": "",
            "stdoutPreview": "",
            "stderrPreview": str(exc)[:1600],
            "stdoutBytes": 0,
            "stderrBytes": len(str(exc).encode("utf-8", errors="ignore")),
            "stdoutTruncated": False,
            "stderrTruncated": False,
            "jsonStatus": {},
            "executionBackend": "argv",
            "errorType": exc.__class__.__name__,
            "error": str(exc),
        }
    _write_runtime_report(decision, result, stage="execution")
    append_event(
        _TELEMETRY,
        "rbw.agent.execution.completed",
        runtime_attributes(
            legacy_id=decision.get("legacy_id"),
            backend="argv",
            policy_mode=decision.get("policy_mode") or "shadow",
            decision=decision.get("decision") or "allow",
            risk_class=decision.get("risk_class"),
        ),
        ok=result.get("ok"),
        exitCode=result.get("exitCode"),
        timeout=result.get("timeout"),
        durationSeconds=result.get("durationSeconds"),
        stdoutBytes=result.get("stdoutBytes"),
        stderrBytes=result.get("stderrBytes"),
    )
    return result
