"""Complete duplicate relationship audits run against a synthetic read-only CRM."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import robinswood_flow_core as core
import robinswood_flow_duplicate_relationship_audit as audit
from flow_contact_evidence_state import Row, object_row, object_rows
from flow_duplicate_targets import DuplicateTargets


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def mapping() -> DuplicateTargets:
    return DuplicateTargets.model_validate_json(
        json.dumps(
            {
                "companies": {"qa": [1001, 2001]},
                "contacts": {"1002": ["qa", 2002]},
                "falsePositiveContacts": {"1003": "qa"},
            }
        )
    )


class ReadOnlyCRM:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.scan_incomplete: bool = False
        self.detail_failure: bool = False
        self.invoice_links: bool = False

    def request(
        self, endpoint: str, method: str = "GET", payload: object = None
    ) -> Row:
        if method != "GET" or payload is not None:
            raise AssertionError("CRM mutation is forbidden")
        self.calls.append(endpoint)
        if "?limit=" in endpoint:
            if endpoint.startswith("/invoices"):
                if self.scan_incomplete:
                    return {"data": [{"id": 3000 + n} for n in range(100)]}
                if self.invoice_links:
                    return {"data": [{"id": 3001, "company_id": 1001}]}
            return {"data": []}
        if self.detail_failure and endpoint == "/companies/1001":
            raise OSError("QA private credential must not be reported")
        if endpoint.endswith("/companies"):
            return {"data": []}
        identifier = int(endpoint.rsplit("/", 1)[1])
        return {
            "id": identifier,
            "name": "QA object",
            "note": "[TECH DUPLICATE → QA canonical]",
        }


def fixture(stack: ExitStack, root: Path, crm: ReadOnlyCRM) -> Path:
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    _ = stack.enter_context(patch.object(audit, "targets", side_effect=mapping))
    _ = stack.enter_context(patch.object(core, "crmreq", side_effect=crm.request))
    _ = stack.enter_context(patch.object(audit, "OUT", root / "audit.json"))
    _ = stack.enter_context(patch.object(audit, "OUT_MD", root / "audit.md"))
    active = root / "active.json"
    _ = active.write_text('{"unrelated": "11001"}', encoding="utf-8")
    _ = stack.enter_context(patch.object(audit, "ACTIVE_LOCAL_PATHS", (active,)))
    return active


class RelationshipAuditTests(unittest.TestCase):
    def test_complete_audit_preserves_false_positive_and_does_not_write_crm(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = ReadOnlyCRM()
            _ = fixture(stack, Path(temp), crm)
            report = audit.run()
            self.assertIs(report["ok"], True)
            self.assertIs(report["impactOk"], True)
            self.assertEqual(object_row(report["counts"])["objects"], 3)
            self.assertEqual(object_row(report["counts"])["crmMutations"], 0)
            rows = object_rows(report["objects"])
            self.assertEqual(
                [row["classification"] for row in rows],
                ["archive_candidate", "archive_candidate", "keep"],
            )
            self.assertTrue(
                all(
                    row["archiveApplied"] is False and row["hardDeleteApplied"] is False
                    for row in rows
                )
            )
            self.assertEqual(audit.read_json(audit.OUT)["ok"], True)
            self.assertIn("company:1001", audit.OUT_MD.read_text())
            self.assertIn("archive_candidate", audit.OUT_MD.read_text())
            self.assertGreater(len(crm.calls), 6)

    def test_incomplete_scan_and_failed_detail_never_claim_safe_archive_or_no_impact(
        self,
    ) -> None:
        for failure in ["scan", "detail"]:
            with (
                self.subTest(failure=failure),
                tempfile.TemporaryDirectory() as temp,
                ExitStack() as stack,
            ):
                crm = ReadOnlyCRM()
                crm.scan_incomplete = failure == "scan"
                crm.detail_failure = failure == "detail"
                _ = fixture(stack, Path(temp), crm)
                report = audit.run()
                self.assertIs(report["ok"], False)
                self.assertIs(report["impactOk"], False)
                self.assertEqual(
                    [row["classification"] for row in object_rows(report["objects"])],
                    ["manual_review", "manual_review", "keep"],
                )
                self.assertNotIn("credential", json.dumps(report))

    def test_business_document_relation_and_active_reference_prevent_archive_candidate(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = ReadOnlyCRM()
            crm.invoice_links = True
            active = fixture(stack, Path(temp), crm)
            _ = active.write_text('{"contact_id": 1002}', encoding="utf-8")
            report = audit.run()
            rows = object_rows(report["objects"])
            self.assertNotEqual(rows[0]["classification"], "archive_candidate")
            self.assertNotEqual(rows[1]["classification"], "archive_candidate")
            self.assertIs(report["impactOk"], False)

    def test_unreadable_active_state_is_not_accepted_as_absence_of_relations(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = ReadOnlyCRM()
            active = fixture(stack, Path(temp), crm)
            _ = active.write_text("{broken", encoding="utf-8")
            with self.assertRaises(ValueError):
                _ = audit.run()
            self.assertFalse(audit.OUT.exists())


if __name__ == "__main__":
    _ = unittest.main()
