from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(os.getenv("RBW_OSS_ROOT", "/srv/rbw-agents-oss"))
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "scripts"))

from lib.config_mutation import expected_manifest_count
from pydantic import BaseModel, JsonValue, TypeAdapter, ValidationError
from rbw_agent_runtime.execution import execute_argv
from rbw_agent_runtime.models import (
    AgentSpec,
    ExecutionResult,
    ExecutionSpec,
    Invocation,
    ReportEnvelope,
)
from rbw_agent_runtime.policy import PolicyEngine


class RuntimeV2ArgvOnlyTests(unittest.TestCase):
    def test_wire_models_preserve_nested_json_values(self) -> None:
        nested: dict[str, JsonValue] = {"items": [None, True, 3, 2.5, "texte", {"ok": False}]}
        spec: dict[str, object] = dict(TypeAdapter(dict[str, JsonValue]).validate_json(self.base().model_dump_json()))
        spec["provenance"] = nested
        models: list[tuple[BaseModel, str]] = [
            (AgentSpec.model_validate(spec), "provenance"),
            (Invocation(legacy_id="qa", event=nested, approval=nested), "event"),
            (Invocation(legacy_id="qa", approval=nested), "approval"),
            (ExecutionResult(ok=True, exitCode=0, durationSeconds=0, jsonStatus=nested), "jsonStatus"),
        ]
        for field in ("counts", "artifacts", "checks"):
            payload: dict[str, JsonValue] = {
                'generatedAt': 'qa', 'capabilityId': 'qa', 'ok': True,
                'status': 'ok', 'summary': 'qa', field: nested}
            models.append((ReportEnvelope.model_validate(payload), field))
        for model, field in models:
            with self.subTest(model=type(model).__name__, field=field):
                self.assertEqual(TypeAdapter(dict[str, JsonValue]).validate_json(model.model_dump_json())[field], nested)

    def test_wire_models_reject_opaque_objects_before_execution(self) -> None:
        spec: dict[str, object] = dict(TypeAdapter(dict[str, JsonValue]).validate_json(self.base().model_dump_json()))
        spec["provenance"] = {"opaque": object()}
        with self.assertRaises(ValidationError):
            _ = AgentSpec.model_validate(spec)
        cases: list[tuple[type[BaseModel], tuple[str, ...], dict[str, object]]] = [
            (Invocation, ('event', 'approval'), {'legacy_id': 'qa'}),
            (ExecutionResult, ('jsonStatus',), {'ok': True, 'exitCode': 0, 'durationSeconds': 0}),
            (ReportEnvelope, ('counts', 'artifacts', 'checks'), {
                'generatedAt': 'qa', 'capabilityId': 'qa', 'ok': True, 'status': 'ok', 'summary': 'qa'}),
        ]
        for model, fields, valid_base in cases:
            for field in fields:
                payload = {**valid_base, field: {'opaque': object()}}
                with self.subTest(model=model.__name__, field=field), self.assertRaises(ValidationError):
                    _ = model.model_validate(payload)

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
            _ = ExecutionSpec.model_validate({"backend": "argv", "timeout_seconds": 30})

    def test_command_field_is_not_representable(self) -> None:
        with self.assertRaises(ValidationError):
            _ = ExecutionSpec.model_validate({"backend": "argv", "argv": [sys.executable, "-c", "print('ok')"], "cwd": str(ROOT), "command": "echo unsafe"})

    def test_legacy_backend_is_not_representable(self) -> None:
        with self.assertRaises(ValidationError):
            _ = ExecutionSpec.model_validate({"backend": "legacy_shell", "argv": [sys.executable], "cwd": str(ROOT)})

    def test_relative_executable_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            _ = ExecutionSpec.model_validate({"backend": "argv", "argv": ["python3", "-c", "print('ok')"], "cwd": str(ROOT)})

    def test_unknown_id_is_fail_closed(self) -> None:
        decision = PolicyEngine("shadow").evaluate({"legacy_id": "missing"}, None, None)
        self.assertFalse(decision.allowed)
        self.assertIn("unknown_automation_id", decision.strict_reasons)

    def test_argv_agent_is_allowed(self) -> None:
        spec = self.base()
        decision = PolicyEngine("shadow").evaluate({"legacy_id": spec.id}, {"legacy_id": spec.id, "mode": "script"}, spec)
        self.assertTrue(decision.allowed)
        self.assertIsNotNone(decision.backend)
        if decision.backend is None:
            self.fail("allowed execution requires a backend")
        self.assertEqual(decision.backend.value, "argv")

    def test_manifest_env_rejects_protected_keys(self) -> None:
        with self.assertRaises(ValidationError):
            _ = ExecutionSpec.model_validate({"backend": "argv", "argv": [sys.executable, "-c", "print('ok')"], "cwd": str(ROOT), "env": {"LD_PRELOAD": "/tmp/inject.so"}})

    def test_manifest_env_reaches_argv_without_shell(self) -> None:
        spec = self.base(env={"RBW_TEST_TYPED_ENV": "typed-ok"})
        decision = PolicyEngine("shadow").evaluate({"legacy_id": spec.id}, {"legacy_id": spec.id, "mode": "script"}, spec)
        decision.argv = [sys.executable, "-c", "import os; print(os.environ['RBW_TEST_TYPED_ENV'])"]
        result = execute_argv(decision)
        self.assertTrue(result["ok"])
        self.assertIn("typed-ok", TypeAdapter(str).validate_python(result["stdout"]))

    def test_apply_env_is_seen_by_policy(self) -> None:
        spec = self.base(env={"RBW_SAMPLE_APPLY": "1"}, approval_required=True)
        entry: dict[str, JsonValue] = {"legacy_id": spec.id, "mode": "script"}
        shadow = PolicyEngine("shadow").evaluate({"legacy_id": spec.id}, entry, spec)
        self.assertTrue(shadow.allowed)
        self.assertIn("human_approval_required_for_requested_effect", shadow.shadow_reasons)
        enforced = PolicyEngine("enforce").evaluate({"legacy_id": spec.id}, entry, spec)
        self.assertFalse(enforced.allowed)

    def test_staged_manifest_is_fully_argv_when_required(self) -> None:
        if os.getenv("RBW_REQUIRE_LIVE_MANIFEST_ARGV") != "1":
            self.skipTest("full staged manifest assertion not requested")
        manifest = TypeAdapter(dict[str, JsonValue]).validate_json((ROOT / "config" / "command-manifest.json").read_bytes())
        rows = [row for values in manifest.values() if isinstance(values, list) for row in values if isinstance(row, dict) and row.get("legacy_id")]
        self.assertEqual(len(rows), expected_manifest_count(ROOT))
        for row in rows:
            execution = TypeAdapter(dict[str, JsonValue]).validate_python(row.get("execution") or {})
            self.assertEqual(execution.get("backend"), "argv", row.get("legacy_id"))
            self.assertTrue(execution.get("argv"), row.get("legacy_id"))
            self.assertTrue(TypeAdapter(list[str]).validate_python(execution["argv"])[0].startswith("/"), row.get("legacy_id"))


if __name__ == "__main__":
    _ = unittest.main()
