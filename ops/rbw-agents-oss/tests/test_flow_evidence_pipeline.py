"""Discovery feeds the real validation gate using QA-only files and providers."""

from __future__ import annotations

import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_contact_evidence_provider as provider
import robinswood_flow_contact_enrichment as enrichment
import robinswood_flow_contact_evidence_discovery as discovery
import robinswood_flow_core as core
import test_flow_contact_enrichment as validation_fixture
import test_flow_evidence_discovery as discovery_fixture
from flow_contact_evidence_state import Row, object_row, object_rows


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def real_gate() -> Row:
    code = enrichment.main(["--validate-only"])
    report = discovery.load(enrichment.REPORT, {})
    return {
        "invoked": True,
        "returnCode": code,
        "ok": code == 0 and report.get("ok") is True,
        "status": report.get("status"),
        "counts": report.get("counts"),
    }


class EvidencePipelineTests(unittest.TestCase):
    def test_discovery_validation_and_cached_resume_preserve_registry_and_approval(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            crm = validation_fixture.FakeCRM()
            validation_fixture.fixture(
                stack, root, crm, [validation_fixture.account()], []
            )
            discovery_fixture.fixture_paths(stack, root)
            discovery_fixture.providers(stack)
            _ = stack.enter_context(patch.object(discovery, "REG", core.REG))
            _ = stack.enter_context(
                patch.object(discovery, "INBOX", enrichment.EVIDENCE)
            )
            _ = stack.enter_context(
                patch.object(discovery, "gate", side_effect=real_gate)
            )
            original = core.REG.read_bytes()
            self.assertEqual(discovery.main([]), 0)
            validated = discovery.load(enrichment.REPORT, {})
            self.assertEqual(object_row(validated["counts"])["evidencePassed"], 1)
            self.assertEqual(object_row(validated["counts"])["contactsCreated"], 0)
            self.assertTrue(validated["validateOnly"])
            self.assertEqual(crm.calls, [])
            self.assertEqual(core.REG.read_bytes(), original)
            registry = discovery.load(core.REG, {})
            self.assertIs(
                object_rows(registry["accounts"])[0]["approvedForSequence"], False
            )
            with patch.object(
                discovery,
                "discover",
                side_effect=AssertionError("cached proof must be reused"),
            ):
                self.assertEqual(discovery.main([]), 0)
            self.assertEqual(crm.calls, [])
            self.assertEqual(len(discovery.LEDGER.read_text().splitlines()), 1)

    def test_invalid_provider_score_never_reaches_approval_or_crm(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            crm = validation_fixture.FakeCRM()
            validation_fixture.fixture(
                stack, root, crm, [validation_fixture.account()], []
            )
            discovery_fixture.fixture_paths(stack, root)
            discovery_fixture.providers(stack)
            _ = stack.enter_context(patch.object(discovery, "REG", core.REG))
            _ = stack.enter_context(
                patch.object(discovery, "INBOX", enrichment.EVIDENCE)
            )
            _ = stack.enter_context(
                patch.object(discovery, "gate", side_effect=real_gate)
            )
            _ = stack.enter_context(
                patch.object(
                    provider,
                    "verify_email",
                    return_value={
                        "ok": True,
                        "statusCode": 200,
                        "data": {"result": "deliverable", "score": float("inf")},
                    },
                )
            )
            original = core.REG.read_bytes()
            self.assertEqual(discovery.main([]), 0)
            report = discovery.load(enrichment.REPORT, {})
            self.assertEqual(object_row(report["counts"])["evidencePassed"], 0)
            self.assertEqual(object_row(report["counts"])["needsEvidence"], 1)
            self.assertEqual(crm.calls, [])
            self.assertEqual(core.REG.read_bytes(), original)


if __name__ == "__main__":
    _ = unittest.main()
