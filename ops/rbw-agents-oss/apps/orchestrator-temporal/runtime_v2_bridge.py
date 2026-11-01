from __future__ import annotations

import fcntl
import json
import logging
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue, TypeAdapter

ROOT = Path("/srv/rbw-agents-oss")
PACKAGES = ROOT / "packages"
if str(PACKAGES) not in sys.path:
    sys.path.insert(0, str(PACKAGES))

from rbw_agent_runtime.catalog import CatalogRepository
from rbw_agent_runtime.execution import execute_argv
from rbw_agent_runtime.json_support import _integer, _optional_string, _to_json_object
from rbw_agent_runtime.policy import PolicyEngine
from rbw_agent_runtime.telemetry import append_event, runtime_attributes

logger = logging.getLogger(__name__)
_REPOSITORY = CatalogRepository(ROOT)
_POLICY = PolicyEngine()
_TELEMETRY = ROOT / "logs" / "runtime-v2-events.jsonl"
_OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
_RUNTIME_REPORTS = _OPS / "runtime-v2"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def runtime_report_path(legacy_id: str) -> Path:
    safe_id = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in legacy_id).strip("-")
    return _RUNTIME_REPORTS / f"{safe_id or 'unknown'}-last.json"


def _write_runtime_report(decision: dict[str, JsonValue], result: dict[str, JsonValue], *, stage: str) -> dict[str, JsonValue]:
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
    sorted_env_keys = sorted(TypeAdapter(dict[str, JsonValue]).validate_python(decision.get("env") or {}))
    env_keys: list[JsonValue] = list(sorted_env_keys)
    report: dict[str, JsonValue] = {
        "generatedAt": generated_at,
        "contractVersion": "runtime-v2-execution-report-v1",
        "capabilityId": legacy_id,
        "ok": ok,
        "status": status,
        "summary": f"runtime_v2_execution: id={legacy_id} stage={stage} backend={decision.get('backend')} status={status} exitCode={result.get('exitCode')}",
        "counts": {
            "runs": 1,
            "exitCode": _integer(result.get("exitCode") or 0),
            "timeouts": int(timeout),
            "businessFailures": int(business_failure),
            "technicalFailures": int(not ok and not timeout and not business_failure),
            "stdoutBytes": _integer(result.get("stdoutBytes") or 0),
            "stderrBytes": _integer(result.get("stderrBytes") or 0),
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
            "manifestEnvKeys": env_keys,
            "timeout": timeout,
            "businessFailure": business_failure,
            "durationSeconds": result.get("durationSeconds"),
        },
        "data": {},
        "updatedBy": "runtime-v2-bridge",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = report_path.with_name(f".{report_path.name}.{uuid.uuid4().hex}.tmp")
    _ = tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _ = _to_json_object(tmp.read_text(encoding="utf-8"))
    _ = tmp.replace(report_path)
    line = json.dumps({"ts": generated_at, "capabilityId": legacy_id, "ok": ok, "status": status, "counts": report["counts"]}, ensure_ascii=False) + "\n"
    with history_path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        _ = handle.write(line)
        handle.flush()
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return report


def load_manifest_entries() -> dict[str, dict[str, JsonValue]]:
    """Return an mtime-cached, duplicate-checked manifest index."""
    return _REPOSITORY.manifest_entries()


def preflight_invocation(payload: dict[str, JsonValue], entry: dict[str, JsonValue] | None) -> dict[str, JsonValue]:
    legacy_id = payload.get("legacy_id")
    spec = _REPOSITORY.spec(str(legacy_id)) if legacy_id else None
    decision = _POLICY.evaluate(payload, entry, spec, spec_hash=_REPOSITORY.spec_hash(str(legacy_id)) if legacy_id else None)
    data = _to_json_object(decision.model_dump_json())
    append_event(
        _TELEMETRY,
        "rbw.agent.preflight",
        runtime_attributes(
            legacy_id=_optional_string(data.get("legacy_id")),
            backend=_optional_string(data.get("backend")),
            policy_mode=_optional_string(data.get("policy_mode")) or "shadow",
            decision=_optional_string(data.get("decision")) or "block",
            risk_class=_optional_string(data.get("risk_class")),
        ),
        strictReasons=data.get("strict_reasons", []),
        shadowReasons=data.get("shadow_reasons", []),
        specHash=data.get("spec_hash"),
        cache=_REPOSITORY.cache_state(),
    )
    if not data.get("allowed") and data.get("legacy_id"):
        _ = _write_runtime_report(data, {
            "ok": False,
            "exitCode": 2,
            "timeout": False,
            "businessFailure": False,
            "errorType": "RuntimeV2PreflightBlocked",
            "error": ",".join(TypeAdapter(list[str]).validate_python(data.get("strict_reasons") or ["preflight_blocked"])),
            "durationSeconds": 0.0,
        }, stage="preflight")
    return data


def run_structured_invocation(decision: dict[str, JsonValue], extra_env: dict[str, JsonValue] | None = None) -> dict[str, JsonValue]:
    result: dict[str, JsonValue]
    try:
        result = execute_argv(decision, extra_env=extra_env)
    except Exception as exc:
        logger.exception("Structured invocation failed")
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
    _ = _write_runtime_report(decision, result, stage="execution")
    append_event(
        _TELEMETRY,
        "rbw.agent.execution.completed",
        runtime_attributes(
            legacy_id=_optional_string(decision.get("legacy_id")),
            backend="argv",
            policy_mode=_optional_string(decision.get("policy_mode")) or "shadow",
            decision=_optional_string(decision.get("decision")) or "allow",
            risk_class=_optional_string(decision.get("risk_class")),
        ),
        ok=result.get("ok"),
        exitCode=result.get("exitCode"),
        timeout=result.get("timeout"),
        durationSeconds=result.get("durationSeconds"),
        stdoutBytes=result.get("stdoutBytes"),
        stderrBytes=result.get("stderrBytes"),
    )
    return result

__all__ = ["_write_runtime_report", "load_manifest_entries", "preflight_invocation", "run_structured_invocation", "runtime_report_path"]
