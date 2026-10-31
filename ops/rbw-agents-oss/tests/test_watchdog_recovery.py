"""Exercise real recovery modules with all network and process access guarded."""

import asyncio
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import override
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS.parent / "packages"))
sys.path.insert(0, str(SCRIPTS.parent / "apps/orchestrator-temporal"))
import oss_agent_business_gate_classifier as classifier
import oss_runtime_warning_processor as warning
import oss_watchdog_observation as obs
import oss_watchdog_recovery_20261001 as recovery
from evergreen_offline_test_guard import assert_no_external_attempts
from oss_config_mutation_guard import approved_read_only_consumers
from pydantic import JsonValue, TypeAdapter
from robinswood_flow_structural_tests import canonical_contacts_valid
from schedule_drift_report import compact_summary


class RecoveryTests(unittest.TestCase):
    @override
    def tearDown(self) -> None:
        assert_no_external_attempts()

    def test_large_drift_payload_is_artifact_only(self) -> None:
        f = compact_summary
        d: dict[str, JsonValue] = {
            "ok": False,
            "status": "degraded",
            "summary": "drift=8",
            "counts": {"driftCount": 8},
            "blockingReasons": ["schedule_drift"],
            "artifacts": {"reportJson": "/ops/report.json"},
            "rows": [{"huge": "x" * 1000} for _ in range(208)],
            "actionQueue": [{"x": 1} for _ in range(208)],
        }
        payload = f(d)
        self.assertLess(len(json.dumps(payload)), 1000)
        self.assertNotIn("rows", payload)
        self.assertEqual(
            len(TypeAdapter(list[JsonValue]).validate_python(d["rows"])), 208
        )
        self.assertFalse(payload["ok"])

    def test_failed_classification_never_healthy(self) -> None:
        f = classifier.classify
        for aid in (
            "oss-config-mutation-guard",
            "oss-agent-production-health-audit",
            "unknown",
        ):
            self.assertEqual(
                f({"id": aid, "reportStatus": "failed"})["classification"],
                "technical_defect",
            )
        self.assertEqual(
            f(
                {
                    "id": "traid-onchain-liquidation-shadow-monitor",
                    "reportStatus": "blocked",
                    "_bucket": "technicalReportFailures",
                }
            )["classification"],
            "technical_defect",
        )
        self.assertEqual(
            f(
                {
                    "id": "traid-onchain-liquidation-shadow-monitor",
                    "reportStatus": "blocked",
                    "_bucket": "businessGates",
                },
                {
                    "traid-onchain-liquidation-shadow-monitor": {
                        "gateType": "safety_gate",
                        "owner": "domain_owner",
                        "reason": "domain readiness remains blocked",
                    }
                },
            )["classification"],
            "expected_business_gate",
        )

    def test_private_classification_policy_fails_closed(self) -> None:
        f = classifier.load_classification_policy
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "rules.json"
            with self.assertRaises(ValueError):
                _ = f(path)
            _ = path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "oss-business-gate-classification-policy-v1",
                        "expectedBusinessGates": {
                            "monitor": {
                                "gateType": "business",
                                "owner": "domain",
                                "reason": "reviewed gate",
                            }
                        },
                    }
                )
            )
            self.assertEqual(f(path)["monitor"]["owner"], "domain")
            _ = path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "oss-business-gate-classification-policy-v1",
                        "expectedBusinessGates": {"monitor": {"owner": "domain"}},
                    }
                )
            )
            with self.assertRaises(ValueError):
                _ = f(path)

    def test_safety_negations_and_mutations(self) -> None:
        f = warning.is_safe_refresh
        policy: dict[str, JsonValue] = {
            "explicitAllowIds": ["safe"],
            "safeRiskClasses": ["observability"],
            "denySideEffectSubstrings": ["crm_mutation", "delete", "gmail-send"],
        }
        safe: dict[str, JsonValue] = {
            "sideEffects": [
                "filesystem-read:state",
                "filesystem-write:ops-report",
                "no_external_send",
                "no_crm_mutation",
            ],
            "command": "python read_report.py",
            "riskClass": "observability",
        }
        self.assertTrue(f("safe", safe, policy)[0])
        for danger in [
            "crm_mutation",
            "ssh-mutate:firewall",
            "bounded-docker-restart",
            "runtime_restart",
            "systemctl restart",
            "gmail-send",
            "no_crm_mutation_and_crm_mutation",
            "delete_records",
        ]:
            self.assertFalse(
                f(
                    "safe",
                    TypeAdapter(dict[str, JsonValue]).validate_python(
                        {
                            **safe,
                            "sideEffects": TypeAdapter(list[str]).validate_python(
                                safe["sideEffects"]
                            )
                            + [danger],
                        }
                    ),
                    policy,
                )[0],
                danger,
            )
        self.assertFalse(
            f(
                "other",
                {"sideEffects": ["no_external_send", "unreviewed_effect"]},
                policy,
            )[0]
        )

    def test_canonical_growth_is_bound_to_verified_registry(self) -> None:
        f = canonical_contacts_valid
        contacts: dict[str, JsonValue] = {"qa-primary": 101}
        accounts: list[dict[str, JsonValue]] = [
            {"key": "qa-primary", "sellsyContactId": 101, "contactVerified": True}
        ]
        self.assertFalse(f(contacts, []))
        self.assertTrue(f(contacts, accounts))
        self.assertFalse(f({"qa-primary": 999}, accounts))
        self.assertFalse(f({**contacts, "qa-extra": 102}, accounts))
        accounts.append(
            {"key": "qa-extra", "sellsyContactId": 102, "contactVerified": True}
        )
        self.assertTrue(f({**contacts, "qa-extra": 102}, accounts))
        self.assertFalse(f({**contacts, "qa-extra": 101}, accounts))
        self.assertFalse(f({**contacts, "qa-extra": True}, accounts))

    def make_report(self, path: Path, **kw: JsonValue) -> dict[str, JsonValue]:
        d: dict[str, JsonValue] = {
            "capabilityId": "oss-agent-production-health-audit",
            "generatedAt": datetime.now(UTC).isoformat(),
            "ok": False,
            "status": "degraded",
            "blockingReasons": ["technical_report_failures"],
        }
        d.update(kw)
        _ = path.write_text(json.dumps(d))
        return d

    def test_fresh_findings_remain_false_and_bound_to_hash(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "r.json"
            ns = time.time_ns()
            _ = self.make_report(p)
            raw = p.read_bytes()
            found, sha = obs.validate_observation(
                "oss-agent-production-health-audit", p, ns, 1, ""
            )
            self.assertFalse(found["ok"])
            self.assertEqual(p.read_bytes(), raw)
            self.assertEqual(len(sha), 64)
            with self.assertRaises(ValueError):
                _ = obs.validate_observation(
                    "oss-agent-production-health-audit", p, ns, 1, "", sha
                )

    def test_stale_wrong_identity_exception_nonreport_exit_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "r.json"
            ns = time.time_ns()
            aid = "oss-agent-production-health-audit"
            cases: list[tuple[dict[str, JsonValue], int, str]] = [
                ({"capabilityId": "other"}, 1, ""),
                (
                    {
                        "generatedAt": (
                            datetime.now(UTC) - timedelta(hours=1)
                        ).isoformat()
                    },
                    1,
                    "",
                ),
                ({"ok": True}, 1, ""),
                ({}, 2, ""),
                ({}, 1, "Traceback (most recent call last)"),
                ({"status": "timeout"}, 1, ""),
                ({"ok": "false"}, 1, ""),
            ]
            for kwargs, rc, err in cases:
                _ = self.make_report(p, **kwargs)
                with self.assertRaises(ValueError):
                    _ = obs.validate_observation(aid, p, ns, rc, err)
            _ = self.make_report(p)
            os.utime(p, ns=(ns - 2000000000, ns - 2000000000))
            with self.assertRaises(ValueError):
                _ = obs.validate_observation(aid, p, ns, 1, "")

    def test_bad_observer_report_is_technical_failure_not_business_failure(
        self,
    ) -> None:
        aid = "oss-agent-production-health-audit"
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            ops = root / "ops"
            ops.mkdir()

            def child(
                command: list[str],
                *,
                cwd: Path,
                timeout: int,
                text: bool,
                capture_output: bool,
                check: bool,
            ) -> subprocess.CompletedProcess[str]:
                self.assertEqual(cwd, root)
                self.assertGreater(timeout, 0)
                self.assertTrue(text and capture_output)
                self.assertFalse(check)
                _ = self.make_report(ops / obs.SPECS[aid][1], capabilityId="forged")
                return subprocess.CompletedProcess(command, 1, "", "")

            buf = io.StringIO()
            with (
                patch.object(obs, "ROOT", root),
                patch.object(obs, "OPS", ops),
                patch.object(subprocess, "run", child),
                patch("sys.argv", ["observer", "--legacy-id", aid]),
                redirect_stdout(buf),
            ):
                self.assertEqual(obs.main(), 1)
            d = TypeAdapter(dict[str, JsonValue]).validate_json(buf.getvalue())
            self.assertEqual(d["status"], "technical_failed")
            self.assertNotIn("ok", d)

    def test_read_only_review_is_bound_to_exact_source(self) -> None:
        f = approved_read_only_consumers
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            p = root / "scripts/consumer.py"
            p.parent.mkdir()
            _ = p.write_text("read_only")
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            policy: dict[str, JsonValue] = {
                "acceptedReadOnlyProtectedConfigConsumers": ["scripts/consumer.py"],
                "reviewedReadOnlyProtectedConfigConsumers": [
                    {"path": "scripts/consumer.py", "sha256": sha}
                ],
            }
            allowed, errors = f(policy, root)
            self.assertEqual(allowed, {"scripts/consumer.py"})
            self.assertFalse(errors)
            _ = p.write_text("config_mutation")
            allowed, errors = f(policy, root)
            self.assertFalse(allowed)
            self.assertEqual(
                errors[0]["code"], "read_only_consumer_review_hash_mismatch"
            )

    def test_read_only_infra_scope_and_dev_probe_wrapper(self) -> None:
        self.assertEqual(
            obs.SPECS["infra-exposure-autoremediation-guard"][3], ("--no-remediate",)
        )
        source = (SCRIPTS / "oss_infrastructure_observation.py").read_text()
        self.assertIn(
            "/opt/ia-webdev/bin/rbw-docker-guard docker -- ps",
            (SCRIPTS / "infrastructure_probe.py").read_text(),
        )
        self.assertIn("if server.get('alias') == 'dev':", source)
        self.assertNotIn("def remediate(", source)
        self.assertNotIn("docker restart", source)
        self.assertNotIn("iptables -I", source)
        self.assertNotIn("systemctl restart", source)
        self.assertNotIn("OVH_SECRET_ENV", source)

    def test_approved_gate_cannot_hide_technical_failure(self) -> None:
        approved: dict[str, dict[str, JsonValue]] = {
            "monitor": {
                "gateType": "safety_gate",
                "owner": "domain",
                "reason": "reviewed",
            }
        }
        result = classifier.classify(
            {
                "id": "monitor",
                "reportStatus": "blocked",
                "_bucket": "businessGates",
                "reportBlocking": ["business_result_non_ok"],
                "runtimeBlocking": ["missing_runtime"],
            },
            approved,
        )
        self.assertEqual(result["classification"], "technical_defect")

    def test_missing_health_audit_cannot_produce_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(classifier, "HEALTH", root / "missing.json"),
                patch.object(classifier, "OUT", root / "report.json"),
                self.assertRaisesRegex(TypeError, "health_audit_missing_or_invalid"),
            ):
                classifier.main()
            self.assertFalse((root / "report.json").exists())

    def test_read_only_consumer_requires_explicit_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            policy: dict[str, JsonValue] = {
                "acceptedReadOnlyProtectedConfigConsumers": ["consumer.py"]
            }
            allowed, errors = approved_read_only_consumers(policy, Path(directory))
            self.assertFalse(allowed)
            self.assertEqual(errors[0]["code"], "read_only_consumer_review_missing")

    def test_missing_warning_policy_cannot_enable_apply(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / "policy.json"
            with (
                patch.object(warning, "POLICY", policy),
                self.assertRaisesRegex(
                    ValueError, "runtime_warning_policy_missing_or_invalid"
                ),
            ):
                _ = warning.load_policy()
            self.assertFalse(policy.exists())

    def test_resume_rejects_incomplete_or_nonboolean_execution_proof(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            logs.mkdir()
            proof = logs / "oss-watchdog-recovery-20261001-native-proof.json"
            for completed, all_completed in [
                (list(obs.SPECS), "false"),
                (list(obs.SPECS), False),
                ([], True),
            ]:
                _ = proof.write_text(
                    json.dumps({"completed": completed, "allCompleted": all_completed})
                )
                with (
                    patch.object(recovery, "ROOT", root),
                    self.assertRaisesRegex(
                        ValueError, "seven_native_execution_proofs_required"
                    ),
                ):
                    asyncio.run(recovery.resume())


if __name__ == "__main__":
    _ = unittest.main()
