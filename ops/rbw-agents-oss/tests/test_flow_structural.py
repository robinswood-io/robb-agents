"""Read-only structural audit regression tests on synthetic files only."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from typing import override
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_structural_commerce as commerce
import flow_structural_reports as reports
import flow_structural_runtime as runtime
import robinswood_flow_core as core
import robinswood_flow_duplicate_relationship_audit as duplicate_audit
import robinswood_flow_structural_tests as audit
from flow_duplicate_targets import DuplicateTargets
from flow_structural_checks import Report, canonical_contacts_valid, clean_ids, read
from pydantic import JsonValue
from robinswood_pme_hdf_recovery_cohort import RecoveryConfig


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class StructuralTests(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.stack: ExitStack = ExitStack()
        self.root: Path = Path()
        self.ops: Path = Path()

    @override
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.ops = self.root / "ops"
        self.ops.mkdir()
        for name in ("OPS", "REG", "CRMSTATE", "EMAILQ", "LIQ"):
            _ = self.stack.enter_context(
                patch.object(
                    core,
                    name,
                    self.ops if name == "OPS" else self.ops / (name + ".json"),
                )
            )
        _ = self.stack.enter_context(patch.object(audit, "R", self.root))

    def save(self, name: str, value: Report) -> None:
        _ = (self.ops / name).write_text(json.dumps(value))

    def test_missing_deployment_fails_and_continues_other_stages(self) -> None:
        with redirect_stdout(io.StringIO()):
            code = audit.run_tests()
        report = read(self.ops / "robinswood-flow-guard-tests-last.json")
        self.assertEqual(code, 1)
        self.assertIs(report["ok"], False)
        text = json.dumps(report)
        self.assertIn("compile:robinswood_flow_sellsy_sync.py", text)
        self.assertIn('"name": "retry_dates"', text)
        self.assertIn("FileNotFoundError", text)
        self.assertNotIn(str(self.root), text)
        self.assertTrue((self.ops / "robinswood-flow-guard-tests-last.md").exists())

    def test_empty_or_throwing_stage_cannot_be_green_or_leak_error(self) -> None:
        def broken(_root: Path) -> list[Report]:
            raise ValueError("secret-credential-and-private-url")

        def empty(_root: Path) -> list[Report]:
            return []

        with (
            patch.object(audit, "STAGES", (("broken", broken), ("empty", empty))),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(audit.run_tests(), 1)
        text = (self.ops / "robinswood-flow-guard-tests-last.json").read_text()
        self.assertIn("ValueError", text)
        self.assertIn("no_checks_returned", text)
        self.assertNotIn("secret-credential", text)

    def test_corrupt_json_and_nonobject_are_rejected(self) -> None:
        path = self.ops / "broken.json"
        for content in ("{", "[]", "null"):
            _ = path.write_text(content)
            with self.assertRaises(ValueError):
                _ = read(path)

    def test_verified_registry_binding_rejects_missing_duplicate_boolean(self) -> None:
        accounts: list[Report] = [
            {"key": "qa", "sellsyContactId": 101, "contactVerified": True}
        ]
        self.assertTrue(canonical_contacts_valid({"qa": 101}, accounts))
        self.assertFalse(canonical_contacts_valid({}, accounts))
        self.assertFalse(canonical_contacts_valid({"qa": True}, accounts))
        self.assertFalse(canonical_contacts_valid({"qa": 101}, accounts + accounts))
        accounts[0]["contactVerified"] = False
        self.assertFalse(canonical_contacts_valid({"qa": 101}, accounts))

    def test_duplicate_detection_uses_exact_ids(self) -> None:
        self.assertFalse(clean_ids({"company": {"id": "123"}}, {123}))
        self.assertTrue(
            clean_ids({"company": {"id": "1234", "note": "case-123-text"}}, {123})
        )
        self.assertTrue(clean_ids({"boolean": True}, {1}))

    def test_task_relation_requires_one_matching_target(self) -> None:
        row: Report = {
            "contactId": 101,
            "companyId": 201,
            "checks": {"taskRelationsAfter": [["contact", 101]]},
        }
        self.assertTrue(reports.relation_matches(row))
        relations: list[JsonValue] = [
            [],
            [["company", 201]],
            [["contact", 101], ["company", 201]],
            [["contact", True]],
        ]
        for relation in relations:
            row["checks"] = {"taskRelationsAfter": relation}
            self.assertFalse(reports.relation_matches(row))

    def test_learning_requires_all_outbound_lanes_and_no_auto_promotion(self) -> None:
        report: Report = {
            "contractVersion": "lane-learning-v2-commercial-ledger-bounded",
            "method": {"safety": "no automatic outbound volume increase"},
            "decisions": [],
        }
        self.save("source-lane-learning-governor-last.json", report)
        self.assertIs(commerce.learning(self.root)[1]["ok"], False)
        report["decisions"] = [
            {"laneId": lane, "recommendedAction": "hold"} for lane in commerce.LANES
        ]
        self.save("source-lane-learning-governor-last.json", report)
        self.assertTrue(all(row["ok"] for row in commerce.learning(self.root)))
        report["decisions"] = [
            {"laneId": lane, "recommendedAction": "promote_next_cycle"}
            for lane in commerce.LANES
        ]
        self.save("source-lane-learning-governor-last.json", report)
        self.assertIs(commerce.learning(self.root)[1]["ok"], False)

    def test_hdf_baseline_is_read_from_private_configuration(self) -> None:
        profile = self.root / "qa-profile.json"
        _ = profile.write_text(
            json.dumps(
                {
                    "campaignId": "qa-campaign",
                    "recoveryCohortId": "qa-cohort",
                    "expectedSentCumulative": 20,
                    "expectedLaneHardBounces": 2,
                }
            )
        )
        config = RecoveryConfig.load(profile)
        self.assertEqual(config.expected_sent_cumulative, 20)
        report: Report = {
            "metrics": {
                "sentCumulative": 20,
                "laneHardBounces": 2,
                "hardBounceRate": 0.1,
                "excludedCrossCampaignBounces": 1,
                "scalingAllowed": False,
                "recommendedMaxFirstSendsPerRun": 0,
                "pauseRecommended": True,
            }
        }
        self.save("robinswood-pme-hdf-performance-optimizer-last.json", report)
        self.save(
            "robinswood-pme-hdf-pre-send-gate-last.json",
            {"externalSendAllowed": False, "status": "blocked_qa"},
        )
        with patch.object(commerce, "CONFIG_PATH", profile):
            self.assertTrue(
                all(row["ok"] for row in commerce.hdf_containment(self.root))
            )
            report["metrics"] = {
                "sentCumulative": 21,
                "laneHardBounces": 2,
                "hardBounceRate": 0.1,
                "excludedCrossCampaignBounces": 1,
                "scalingAllowed": False,
                "recommendedMaxFirstSendsPerRun": 0,
                "pauseRecommended": True,
            }
            self.save("robinswood-pme-hdf-performance-optimizer-last.json", report)
            self.assertIs(commerce.hdf_containment(self.root)[0]["ok"], False)

    def test_pure_behavior_checks_run_without_external_calls(self) -> None:
        targets = DuplicateTargets(
            companies={f"qa-{i}": (1000 + i, 2000 + i) for i in range(13)},
            contacts={3000 + i: (f"qa-{i}", 4000 + i) for i in range(10)},
            falsePositiveContacts={5000: "qa-0", 5001: "qa-1"},
        )
        with patch.object(duplicate_audit, "targets", return_value=targets):
            result = runtime.pure_checks(self.root)
        self.assertGreaterEqual(len(result), 7)
        self.assertTrue(all(row["ok"] for row in result), result)


if __name__ == "__main__":
    _ = unittest.main()
