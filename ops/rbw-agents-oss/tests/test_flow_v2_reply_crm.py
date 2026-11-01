"""Crash/retry and idempotency qualification against an in-memory QA CRM."""

from __future__ import annotations

import os
import tempfile
import unittest
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_reply_crm as reply
import robinswood_flow_core as core
from flow_contact_evidence_state import OBJECT, Row, object_row
from pydantic import JsonValue

ACCOUNT: Row = {
    "key": "qa",
    "name": "QA Company",
    "lead_id": "qa-lead",
    "sellsyCompanyId": 2001,
    "sellsyContactId": 2002,
}
RECEIVED: Row = {"messageId": "qa-message", "threadId": "qa-thread"}


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class FakeCRM:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, JsonValue]] = {}
        self.posts: list[str] = []
        self.calls: list[str] = []
        self.timeout: str = ""
        self.wrong_readback: bool = False
        self.incomplete: bool = False

    def request(
        self,
        endpoint: str,
        method: str = "GET",
        body: dict[str, JsonValue] | None = None,
    ) -> dict[str, JsonValue]:
        self.calls.append(method + " " + endpoint)
        if method == "POST":
            if endpoint not in {"/tasks", "/opportunities"} or body is None:
                raise AssertionError("unexpected mutation")
            self.posts.append(endpoint)
            if self.timeout == "before":
                raise TimeoutError("qa-transport-timeout")
            identifier = 6001 + len(self.rows)
            value = {"id": identifier, **body}
            self.rows[f"{endpoint}/{identifier}"] = value
            if self.timeout == "after":
                raise TimeoutError("qa-transport-timeout")
            return {"id": identifier}
        if method != "GET":
            raise AssertionError("unexpected mutation")
        if endpoint in self.rows:
            row = dict(self.rows[endpoint])
            if self.wrong_readback:
                row["related"] = [{"type": "company", "id": 9999}]
            return row
        path = endpoint.split("?", 1)[0]
        if path == "/opportunities/pipelines":
            return {
                "data": [{"id": 8001, "is_default": True}],
                "pagination": {"total": 1},
            }
        if path == "/opportunities/pipelines/8001/steps":
            return {"data": [{"id": 8101, "rank": 1}], "pagination": {"total": 1}}
        if path in {"/tasks", "/opportunities"}:
            if self.incomplete:
                return {"data": [{"id": 9000 + i} for i in range(100)]}
            rows: list[JsonValue] = [
                dict(value)
                for key, value in self.rows.items()
                if key.rsplit("/", 1)[0] == path
            ]
            return {"data": rows, "pagination": {"total": len(rows)}}
        raise RuntimeError("qa_record_missing")


@contextmanager
def environment(values: dict[str, str]) -> Generator[None]:
    with patch.dict(os.environ, values):
        yield


def fixture(stack: ExitStack, root: Path, crm: FakeCRM) -> None:
    _ = stack.enter_context(patch.object(core, "crmreq", crm.request))
    _ = stack.enter_context(patch.object(core, "CRMSTATE", root / "crm.json"))
    _ = stack.enter_context(patch.object(reply, "REPLY_CRM", root / "reply.json"))
    _ = stack.enter_context(
        patch.object(reply, "OPP_STATE", root / "opportunities.json")
    )
    _ = stack.enter_context(
        patch.object(reply, "is_technical_duplicate", return_value=False)
    )
    _ = stack.enter_context(
        environment(
            {
                "SELLSY_DEFAULT_STAFF_ID": "7001",
                "SELLSY_PROSPECT_TASK_LABEL_ID": "7002",
            },
        )
    )


class ReplyCRMTests(unittest.TestCase):
    def test_preparation_needs_no_credentials_and_performs_no_io(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(temp), crm)
            result = reply.crm_action_for_signal(
                ACCOUNT, RECEIVED, "referral", dry_run=True
            )
            self.assertTrue(result["referralApprovalRequired"])
            self.assertFalse(result["createReferralContact"])
            self.assertEqual(result["taskCreates"], 1)
            self.assertEqual(crm.calls, [])
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_complete_positive_reply_creates_once_and_rechecks_cached_records(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(temp), crm)
            first = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "positive")
            self.assertEqual(crm.posts, ["/tasks", "/opportunities"])
            second = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "positive")
            self.assertEqual(second, first)
            self.assertEqual(crm.posts, ["/tasks", "/opportunities"])
            self.assertEqual(
                OBJECT.validate_json(core.CRMSTATE.read_text())["opportunitiesCreated"],
                1,
            )
            self.assertTrue(
                all(row.get("amount", "0") == "0" for row in crm.rows.values())
            )
            crm.wrong_readback = True
            with self.assertRaisesRegex(RuntimeError, "readback_failed"):
                _ = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "positive")
            self.assertEqual(len(crm.posts), 2)

    def test_timeout_after_commit_reconciles_by_marker_without_recreating(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(temp), crm)
            crm.timeout = "after"
            with self.assertRaises(TimeoutError):
                _ = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "ambiguous")
            state = OBJECT.validate_json(reply.REPLY_CRM.read_text())
            self.assertEqual(list(object_row(state["attempts"]).values()), ["started"])
            crm.timeout = ""
            result = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "ambiguous")
            self.assertIsInstance(result["taskId"], int)
            self.assertEqual(crm.posts, ["/tasks"])
            self.assertIsNone(result["opportunityId"])

    def test_timeout_without_visible_result_never_blindly_retries_creation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(temp), crm)
            crm.timeout = "before"
            with self.assertRaises(TimeoutError):
                _ = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "ambiguous")
            crm.timeout = ""
            with self.assertRaisesRegex(RuntimeError, "outcome_unknown"):
                _ = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "ambiguous")
            self.assertEqual(crm.posts, ["/tasks"])

    def test_incomplete_lookup_and_duplicate_markers_block_creation(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(temp), crm)
            crm.incomplete = True
            with self.assertRaisesRegex(RuntimeError, "incomplete_crm_lookup"):
                _ = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "ambiguous")
            self.assertEqual(crm.posts, [])
            crm.incomplete = False
            marker = str(
                reply.crm_action_plan(ACCOUNT, RECEIVED, "ambiguous")["taskMarker"]
            )
            for identifier in [6001, 6002]:
                crm.rows[f"/tasks/{identifier}"] = {
                    "id": identifier,
                    "description": marker,
                    "related": [{"id": 2001}],
                }
            with self.assertRaisesRegex(RuntimeError, "duplicate_reply_crm_marker"):
                _ = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "ambiguous")
            self.assertEqual(crm.posts, [])

    def test_missing_assignment_and_invalid_relation_refuse_before_write(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(temp), crm)
            _ = stack.enter_context(environment({"SELLSY_DEFAULT_STAFF_ID": ""}))
            with self.assertRaisesRegex(ValueError, "assignment_identifier"):
                _ = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "positive")
            with self.assertRaisesRegex(RuntimeError, "canonical_crm_relation"):
                _ = reply.crm_action_for_signal(
                    {**ACCOUNT, "sellsyCompanyId": True}, RECEIVED, "positive"
                )
            self.assertEqual(crm.posts, [])

    def test_original_task_cache_is_preserved_and_read_back(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            crm = FakeCRM()
            fixture(stack, Path(temp), crm)
            marker = str(
                reply.crm_action_plan(ACCOUNT, RECEIVED, "ambiguous")["taskMarker"]
            )
            core.save(reply.REPLY_CRM, {"tasks": {marker: 6001}})
            crm.rows["/tasks/6001"] = {
                "id": 6001,
                "description": marker,
                "related": [{"id": 2001}],
            }
            result = reply.crm_action_for_signal(ACCOUNT, RECEIVED, "ambiguous")
            self.assertEqual(result["taskId"], 6001)
            self.assertEqual(crm.posts, [])
            self.assertEqual(
                OBJECT.validate_json(reply.REPLY_CRM.read_text())["tasks"],
                {marker: 6001},
            )
