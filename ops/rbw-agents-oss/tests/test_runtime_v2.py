from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(os.getenv("RBW_OSS_ROOT", "/srv/rbw-agents-oss"))
sys.path.insert(0, str(ROOT / "packages"))

from pydantic import ValidationError
from rbw_agent_runtime.execution import execute_argv
from rbw_agent_runtime.models import AgentSpec, ExecutionSpec
from rbw_agent_runtime.policy import PolicyEngine


class RuntimeV2ArgvOnlyTests(unittest.TestCase):
    def base(self, *, env: dict[str, str] | None = None, approval_required: bool = False) -> AgentSpec:
        return AgentSpec.model_validate({
            "id": "unit-agent",
            "name": "Unit Agent",
            "lane": "observability",
            "owner": "ops",
            "runtime_version": "v2",
            "risk_class": "low_observability",
            "side_effects": ["filesystem-write:test-report"],
            "execution": {
                "backend": "argv",
                "timeout_seconds": 30,
                "argv": [sys.executable, "-c", "print('ok')"],
                "cwd": str(ROOT),
                "env": env or {},
            },
            "contract": {"version": "test-v1", "expects_report": True, "json_path": "/tmp/unit-agent-last.json"},
            "policy": {
                "classified": True,
                "policy_class": "test",
                "mutation_mode": "observability_report_only",
                "requires_human_approval_for_apply": approval_required,
                "source": "unit",
            },
            "schedules": [],
            "trigger_types": [],
            "task_queues": ["watchdog"],
            "workflow_ids": [],
            "source_status": {
                "in_manifest": True,
                "in_mapping": False,
                "in_schedules": False,
                "in_ready_schedules": False,
                "manifest_section": "unit",
            },
            "provenance": {"unit": True},
        })

    def test_argv_contract_rejects_missing_argv(self) -> None:
        with self.assertRaises(ValidationError):
            ExecutionSpec(backend="argv", timeout_seconds=30)

    def test_command_field_is_not_representable(self) -> None:
        with self.assertRaises(ValidationError):
            ExecutionSpec(backend="argv", argv=[sys.executable, "-c", "print('ok')"], cwd=str(ROOT), command="echo unsafe")

    def test_legacy_backend_is_not_representable(self) -> None:
        with self.assertRaises(ValidationError):
            ExecutionSpec(backend="legacy_shell", argv=[sys.executable], cwd=str(ROOT))

    def test_relative_executable_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            ExecutionSpec(backend="argv", argv=["python3", "-c", "print('ok')"], cwd=str(ROOT))

    def test_unknown_id_is_fail_closed(self) -> None:
        decision = PolicyEngine("shadow").evaluate({"legacy_id": "missing"}, None, None)
        self.assertFalse(decision.allowed)
        self.assertIn("unknown_automation_id", decision.strict_reasons)

    def test_argv_agent_is_allowed(self) -> None:
        spec = self.base()
        decision = PolicyEngine("shadow").evaluate({"legacy_id": spec.id}, {"legacy_id": spec.id, "mode": "script"}, spec)
        self.assertTrue(decision.allowed)
        self.assertEqual(decision.backend.value, "argv")

    def test_manifest_env_rejects_protected_keys(self) -> None:
        with self.assertRaises(ValidationError):
            ExecutionSpec(backend="argv", argv=[sys.executable, "-c", "print('ok')"], cwd=str(ROOT), env={"LD_PRELOAD": "/tmp/inject.so"})

    def test_manifest_env_reaches_argv_without_shell(self) -> None:
        spec = self.base(env={"RBW_TEST_TYPED_ENV": "typed-ok"})
        decision = PolicyEngine("shadow").evaluate({"legacy_id": spec.id}, {"legacy_id": spec.id, "mode": "script"}, spec)
        decision.argv = [sys.executable, "-c", "import os; print(os.environ['RBW_TEST_TYPED_ENV'])"]
        result = execute_argv(decision)
        self.assertTrue(result["ok"])
        self.assertIn("typed-ok", result["stdout"])

    def test_apply_env_is_seen_by_policy(self) -> None:
        spec = self.base(env={"RBW_SAMPLE_APPLY": "1"}, approval_required=True)
        entry = {"legacy_id": spec.id, "mode": "script"}
        shadow = PolicyEngine("shadow").evaluate({"legacy_id": spec.id}, entry, spec)
        self.assertTrue(shadow.allowed)
        self.assertIn("human_approval_required_for_requested_effect", shadow.shadow_reasons)
        enforced = PolicyEngine("enforce").evaluate({"legacy_id": spec.id}, entry, spec)
        self.assertFalse(enforced.allowed)

    def test_staged_manifest_is_fully_argv_when_required(self) -> None:
        if os.getenv("RBW_REQUIRE_LIVE_MANIFEST_ARGV") != "1":
            self.skipTest("full staged manifest assertion not requested")
        manifest = json.loads((ROOT / "config" / "command-manifest.json").read_text(encoding="utf-8"))
        rows = [row for values in manifest.values() if isinstance(values, list) for row in values if isinstance(row, dict) and row.get("legacy_id")]
        self.assertEqual(len(rows), 193)
        for row in rows:
            execution = row.get("execution") if isinstance(row.get("execution"), dict) else {}
            self.assertEqual(execution.get("backend"), "argv", row.get("legacy_id"))
            self.assertTrue(execution.get("argv"), row.get("legacy_id"))
            self.assertTrue(str(execution["argv"][0]).startswith("/"), row.get("legacy_id"))


if __name__ == "__main__":
    unittest.main()
