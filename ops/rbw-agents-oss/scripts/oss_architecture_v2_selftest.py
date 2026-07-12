#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path("/srv/rbw-agents-oss")
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "scripts"))

from pydantic import ValidationError
from lib.agent_runtime import OPS, standard_report, write_report_and_history
from rbw_agent_runtime.catalog import CatalogCompiler
from rbw_agent_runtime.execution import execute_argv
from rbw_agent_runtime.models import AgentSpec, ExecutionSpec, PolicyDecision
from rbw_agent_runtime.policy import PolicyEngine

OUT_JSON = OPS / "oss-architecture-v2-selftest-last.json"
OUT_MD = OPS / "oss-architecture-v2-selftest-last.md"
HISTORY = OPS / "oss-architecture-v2-selftest-history.jsonl"


def sample_spec(*, env: dict[str, str] | None = None) -> AgentSpec:
    return AgentSpec.model_validate({
        "id": "selftest-agent", "name": "Selftest Agent", "lane": "observability", "owner": "ops",
        "runtime_version": "v2", "risk_class": "low_observability", "side_effects": ["filesystem-write:test-report"],
        "execution": {"backend": "argv", "argv": [sys.executable, "-c", "print('ok')"], "timeout_seconds": 30, "cwd": str(ROOT), "env": env or {}},
        "contract": {"version": "test-v1", "expects_report": True, "json_path": "/tmp/selftest-agent-last.json"},
        "policy": {"classified": True, "policy_class": "test", "mutation_mode": "observability_report_only", "source": "selftest"},
        "schedules": [], "trigger_types": [], "task_queues": ["watchdog"], "workflow_ids": [],
        "source_status": {"in_manifest": True, "in_mapping": False, "in_schedules": False, "in_ready_schedules": False, "manifest_section": "selftest"},
        "provenance": {"test": True},
    })


def main() -> None:
    tests: list[dict] = []
    try:
        sample_spec(); tests.append({"id": "valid_v2_argv_spec", "ok": True})
    except Exception as exc:
        tests.append({"id": "valid_v2_argv_spec", "ok": False, "error": repr(exc)})
    for test_id, kwargs in (
        ("missing_argv_rejected", {"backend": "argv", "timeout_seconds": 30}),
        ("legacy_backend_rejected", {"backend": "legacy_shell", "argv": [sys.executable], "cwd": str(ROOT)}),
        ("relative_executable_rejected", {"backend": "argv", "argv": ["python3", "-c", "print('ok')"], "cwd": str(ROOT)}),
        ("protected_env_rejected", {"backend": "argv", "argv": [sys.executable, "-c", "print('ok')"], "cwd": str(ROOT), "env": {"LD_PRELOAD": "/tmp/inject.so"}}),
        ("command_field_rejected", {"backend": "argv", "argv": [sys.executable], "cwd": str(ROOT), "command": "echo unsafe"}),
    ):
        try:
            ExecutionSpec(**kwargs); tests.append({"id": test_id, "ok": False, "error": "validation unexpectedly passed"})
        except ValidationError:
            tests.append({"id": test_id, "ok": True})
    engine = PolicyEngine("shadow")
    unknown = engine.evaluate({"legacy_id": "does-not-exist"}, None, None)
    tests.append({"id": "unknown_id_fail_closed", "ok": unknown.allowed is False and "unknown_automation_id" in unknown.strict_reasons, "decision": unknown.model_dump(mode="json")})
    spec = sample_spec(env={"RBW_SELFTEST_TYPED_ENV": "typed-ok"})
    decision = engine.evaluate({"legacy_id": spec.id}, {"legacy_id": spec.id, "mode": "script"}, spec)
    decision.argv = [sys.executable, "-c", "import os,json; print(json.dumps({'ok': True, 'status': os.environ['RBW_SELFTEST_TYPED_ENV']}))"]
    try:
        execution = execute_argv(decision)
        tests.append({"id": "structured_argv_env_exec", "ok": execution.get("ok") is True and execution.get("executionBackend") == "argv" and "typed-ok" in execution.get("stdout", ""), "result": execution})
    except Exception as exc:
        tests.append({"id": "structured_argv_env_exec", "ok": False, "error": repr(exc)})
    compiler = CatalogCompiler(ROOT)
    catalog_validation = compiler.validate()
    cc = catalog_validation.get("counts") or {}
    tests.append({"id": "live_catalog_193_argv_only", "ok": bool(catalog_validation.get("ok")) and int(cc.get("manifest") or 0) == 193 and int(cc.get("argv") or 0) == 193 and int(cc.get("legacyShell") or 0) == 0, "validation": catalog_validation})
    runtime_files = [ROOT / "packages/rbw_agent_runtime/models.py", ROOT / "packages/rbw_agent_runtime/catalog.py", ROOT / "packages/rbw_agent_runtime/policy.py", ROOT / "apps/orchestrator-temporal/activities.py"]
    forbidden = [str(path.relative_to(ROOT)) for path in runtime_files if "legacy_shell" in path.read_text(encoding="utf-8") or "def _run_shell" in path.read_text(encoding="utf-8")]
    tests.append({"id": "legacy_runtime_removed", "ok": not forbidden, "files": forbidden})
    failed = [test for test in tests if not test.get("ok")]
    worker_backend = os.getenv("RBW_RUNTIME_V2_BACKEND") or "direct_validation"
    counts = {"tests": len(tests), "passed": len(tests) - len(failed), "failed": len(failed), "catalogArgv": int(cc.get("argv") or 0), "catalogLegacyShell": int(cc.get("legacyShell") or 0)}
    report = standard_report(
        capability_id="oss-architecture-v2-selftest", ok=not failed, status="passed" if not failed else "failed",
        summary=f"architecture_v2_selftest: passed={counts['passed']} failed={counts['failed']} catalogArgv={counts['catalogArgv']} legacy={counts['catalogLegacyShell']}",
        counts=counts, blocking_reasons=[str(test.get("id")) for test in failed], warning_reasons=[],
        artifacts={"reportJson": str(OUT_JSON), "reportMd": str(OUT_MD), "historyJsonl": str(HISTORY)},
        checks={"tests": tests, "invocationBackend": worker_backend, "catalogValidation": catalog_validation}, updated_by="oss-architecture-v2-selftest-argv-only",
    )
    write_report_and_history(OUT_JSON, HISTORY, report)
    OUT_MD.write_text(f"# OSS Architecture v2 Selftest\n\n- status: {report['status']}\n- passed: {counts['passed']} / {counts['tests']}\n- catalog argv / legacy: {counts['catalogArgv']} / {counts['catalogLegacyShell']}\n", encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "status": report["status"], "summary": report["summary"], "counts": counts, "reportJson": str(OUT_JSON)}, ensure_ascii=False))
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
