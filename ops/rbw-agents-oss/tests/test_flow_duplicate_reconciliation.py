"""Reconciliation against a synthetic CRM: no real reads, changes or messages."""

from __future__ import annotations

import fcntl
import io
import json
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import robinswood_flow_core as core
import robinswood_flow_duplicate_reconciliation as reconciliation
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows, strings
from flow_duplicate_targets import DuplicateTargets
from pydantic import JsonValue


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def targets() -> DuplicateTargets:
    return DuplicateTargets.model_validate_json(
        '{"companies":{"qa":[1001,2001]},"contacts":{"1002":["qa",2002]},"falsePositiveContacts":{}}'
    )


class FakeCRM:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, JsonValue]] = {
            "/companies/1001": {
                "id": 1001,
                "name": "QA Duplicate",
                "note": "Keep original",
            },
            "/companies/2001": {
                "id": 2001,
                "name": "QA Canonical",
                "note": "Keep canonical",
            },
            "/contacts/1002": {
                "id": 1002,
                "first_name": "QA",
                "last_name": "Duplicate",
                "email": "qa@example.org",
            },
            "/contacts/2002": {
                "id": 2002,
                "first_name": "QA",
                "last_name": "Canonical",
                "email": "qa@example.org",
            },
            "/tasks/5001": {"id": 5001, "due_date": "2026-11-03"},
        }
        self.writes: list[str] = []
        self.reads: list[str] = []
        self.incomplete: bool = False
        self.linked: bool = False
        self.ignore_write: bool = False
        self.fail_write: bool = False

    def request(
        self, path: str, method: str = "GET", body: dict[str, JsonValue] | None = None
    ) -> dict[str, JsonValue]:
        if method == "PUT":
            if path not in {"/companies/1001", "/contacts/1002"} or body is None:
                raise AssertionError("unexpected mutation")
            self.writes.append(path)
            if self.fail_write:
                raise RuntimeError("private-token-must-not-appear")
            if not self.ignore_write:
                self.rows[path].update(body)
            return dict(self.rows[path])
        if method != "GET":
            raise AssertionError("unsupported mutation")
        self.reads.append(path)
        if path in self.rows:
            return dict(self.rows[path])
        endpoint = path.split("?", 1)[0]
        if endpoint not in reconciliation.SAFETY_ENDPOINTS:
            raise AssertionError("unexpected endpoint")
        if self.incomplete and endpoint == "/invoices":
            return {"data": [{"id": 7000 + i} for i in range(100)]}
        if self.linked and endpoint == "/opportunities":
            return {
                "data": [{"id": 8001, "company_id": 2001}],
                "pagination": {"total": 1},
            }
        return {"data": [], "pagination": {"total": 0}}


def fixture(stack: ExitStack, root: Path, crm: FakeCRM) -> None:
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    _ = stack.enter_context(patch.object(reconciliation, "targets", targets))
    _ = stack.enter_context(patch.object(core, "crmreq", crm.request))
    for name in ["CRMSTATE", "REG", "EMAILQ", "LIQ", "APPROVAL"]:
        path = root / (name + ".json")
        data: Row = (
            {"companies": {"qa": 2001}, "contacts": {"qa": 2002}, "tasks": {"qa": 5001}}
            if name == "CRMSTATE"
            else {}
        )
        _ = path.write_text(json.dumps(data))
        _ = stack.enter_context(patch.object(core, name, path))
    _ = stack.enter_context(patch.object(reconciliation, "OUT", root / "report.json"))
    _ = stack.enter_context(patch.object(reconciliation, "LOCK", root / "sync.lock"))


class ReconciliationTests(unittest.TestCase):
    def test_default_prepares_without_mutation_or_false_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            self.assertEqual(reconciliation.main(), 0)
            result = OBJECT.validate_json(reconciliation.OUT.read_text())
            self.assertEqual(result["status"], "prepared_no_mutations")
            self.assertFalse(result["applied"])
            self.assertEqual(crm.writes, [])
            self.assertEqual(object_row(result["counts"])["crmMutations"], 0)

    def test_apply_readback_and_replay_are_complete_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            before = {
                key: dict(row)
                for key, row in crm.rows.items()
                if "200" in key or "tasks" in key
            }
            fixture(stack, Path(tmp), crm)
            self.assertEqual(reconciliation.main(apply=True), 0)
            first = OBJECT.validate_json(reconciliation.OUT.read_text())
            self.assertEqual(first["status"], "reconciled_annotated_no_hard_delete")
            self.assertEqual(object_row(first["counts"])["crmMutations"], 2)
            self.assertEqual(crm.writes, ["/companies/1001", "/contacts/1002"])
            self.assertTrue(
                str(crm.rows["/companies/1001"]["note"]).startswith("Keep original")
            )
            snapshot = dict(crm.rows["/companies/1001"])
            self.assertEqual(reconciliation.main(apply=True), 0)
            second = OBJECT.validate_json(reconciliation.OUT.read_text())
            self.assertEqual(object_row(second["counts"])["crmMutations"], 0)
            self.assertEqual(crm.rows["/companies/1001"], snapshot)
            self.assertEqual(len(crm.writes), 2)
            for key, row in before.items():
                self.assertEqual(crm.rows[key], row)
            self.assertEqual(object_row(second["counts"])["archives"], 0)
            self.assertEqual(object_row(second["counts"])["hardDeletes"], 0)

    def test_incomplete_scan_blocks_every_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            crm.incomplete = True
            fixture(stack, Path(tmp), crm)
            result = reconciliation.reconcile(apply=True)
            self.assertFalse(result["ok"])
            self.assertEqual(crm.writes, [])
            self.assertIn(
                "incomplete_safety_scan:/invoices", strings(result["preflightErrors"])
            )

    def test_invalid_canonical_task_blocks_before_first_write(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            crm.rows["/tasks/5001"] = {"id": 5001}
            fixture(stack, Path(tmp), crm)
            self.assertFalse(reconciliation.reconcile(apply=True)["ok"])
            self.assertEqual(crm.writes, [])

    def test_opportunity_and_local_duplicate_are_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            crm.linked = True
            self.assertFalse(reconciliation.reconcile(apply=True)["ok"])
            crm.linked = False
            _ = core.EMAILQ.write_text('{"items":[{"companyId":1001}]}')
            self.assertFalse(reconciliation.reconcile(apply=True)["ok"])
            self.assertEqual(crm.writes, [])
            _ = core.EMAILQ.write_text('{"items":[{"unrelated":"910019"}]}')
            self.assertTrue(reconciliation.reconcile()["ok"])

    def test_failed_readback_stops_further_mutations_and_can_resume(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            crm.ignore_write = True
            result = reconciliation.reconcile(apply=True)
            self.assertFalse(result["ok"])
            self.assertEqual(crm.writes, ["/companies/1001"])
            self.assertEqual(object_row(result["counts"])["crmMutations"], 1)
            crm.ignore_write = False
            self.assertTrue(reconciliation.reconcile(apply=True)["ok"])

    def test_exception_is_redacted_and_failed_attempt_counted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            crm.fail_write = True
            result = reconciliation.reconcile(apply=True)
            self.assertFalse(result["ok"])
            self.assertNotIn("private-token", json.dumps(result))
            self.assertEqual(
                object_rows(result["companyActions"])[0]["error"], "RuntimeError"
            )
            self.assertEqual(object_row(result["counts"])["crmMutations"], 1)

    def test_real_lock_prevents_parallel_run_and_preserves_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            _ = reconciliation.OUT.write_text("preserve")
            with reconciliation.LOCK.open("a+") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(reconciliation.main(apply=True), 2)
            self.assertEqual(reconciliation.OUT.read_text(), "preserve")
            self.assertEqual(crm.reads, [])
            self.assertEqual(crm.writes, [])
            self.assertEqual(reconciliation.main(), 0)

    def test_missing_profile_fails_before_creating_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            _ = stack.enter_context(
                patch.object(
                    reconciliation, "targets", side_effect=ValueError("profile_missing")
                )
            )
            with self.assertRaisesRegex(ValueError, "profile_missing"):
                _ = reconciliation.main(apply=True)
            self.assertFalse(reconciliation.LOCK.exists())
            self.assertFalse(reconciliation.OUT.exists())
            self.assertEqual(crm.reads, [])

    def test_invalid_boolean_state_identifier_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            state = OBJECT.validate_json(core.CRMSTATE.read_text())
            state["companies"] = {"qa": True}
            _ = core.CRMSTATE.write_text(json.dumps(state))
            self.assertFalse(reconciliation.reconcile(apply=True)["ok"])
            self.assertEqual(crm.writes, [])

    def test_missing_or_corrupt_active_data_never_certifies_exclusion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(tmp), crm)
            core.EMAILQ.unlink()
            with self.assertRaisesRegex(ValueError, "required_active_data_missing"):
                _ = reconciliation.reconcile(apply=True)
            _ = core.EMAILQ.write_text("not-json")
            with self.assertRaises(ValueError):
                _ = reconciliation.reconcile(apply=True)
            self.assertEqual(crm.writes, [])
