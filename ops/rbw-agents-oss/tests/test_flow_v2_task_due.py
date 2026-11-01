"""Deadline repair is simulated and must not postpone valid tasks on every run."""

from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_task_due as due
import robinswood_flow_core as core
from flow_contact_evidence_state import Row, object_row
from flow_v2_rules import TZ
from pydantic import JsonValue

NOW = datetime(2026, 10, 30, 18, tzinfo=TZ)


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class FakeTasks:
    def __init__(self) -> None:
        self.value: dict[str, JsonValue] = {
            "id": 5001,
            "due_date": "2026-10-20T09:00:00+02:00",
            "status": "todo",
        }
        self.writes: int = 0
        self.ignore_write: bool = False

    def request(
        self,
        endpoint: str,
        method: str = "GET",
        body: dict[str, JsonValue] | None = None,
    ) -> dict[str, JsonValue]:
        if endpoint != "/tasks/5001":
            raise AssertionError("unexpected endpoint")
        if method == "PUT" and body is not None:
            self.writes += 1
            if not self.ignore_write:
                self.value.update(body)
        elif method != "GET":
            raise AssertionError("unexpected mutation")
        return dict(self.value)


def fixture(stack: ExitStack, root: Path, api: FakeTasks) -> None:
    for name in ["CRMSTATE", "REG"]:
        _ = stack.enter_context(patch.object(core, name, root / (name + ".json")))
    _ = stack.enter_context(patch.object(due, "DUE_REPORT", root / "report.json"))
    _ = stack.enter_context(patch.object(core, "crmreq", api.request))
    accounts: list[dict[str, JsonValue]] = [{"key": "qa", "wave": 1}]
    _ = stack.enter_context(patch.object(core, "accounts", return_value=accounts))
    _ = stack.enter_context(patch.object(core, "account_key", return_value="qa"))
    _ = core.REG.write_text(json.dumps({"accounts": accounts}))
    _ = core.CRMSTATE.write_text('{"tasks":{"rbw:task:qa":5001}}')


class TaskDueTests(unittest.TestCase):
    def test_prepare_apply_replay_keeps_future_deadline_fixed(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = FakeTasks()
            fixture(stack, Path(temp), api)
            prepared = due.task_due_manager(False, NOW)
            self.assertTrue(prepared["ok"])
            self.assertEqual(api.writes, 0)
            sor = object_row(object_row(prepared["systemsOfRecord"])["sellsy"])
            self.assertFalse(sor["verifiedByReadback"])
            result = due.task_due_manager(True, NOW)
            self.assertTrue(result["ok"])
            self.assertEqual(api.value["due_date"], "2026-11-02T09:40:00+01:00")
            self.assertEqual(api.writes, 1)
            replay = due.task_due_manager(True, NOW + timedelta(days=1))
            self.assertTrue(replay["ok"])
            self.assertEqual(object_row(replay["counts"])["updated"], 0)
            self.assertEqual(api.writes, 1)
            self.assertEqual(api.value["due_date"], "2026-11-02T09:40:00+01:00")

    def test_closed_task_is_not_reopened_or_rescheduled(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = FakeTasks()
            api.value["status"] = "completed"
            fixture(stack, Path(temp), api)
            before = dict(api.value)
            self.assertTrue(due.task_due_manager(True, NOW)["ok"])
            self.assertEqual(api.value, before)
            self.assertEqual(api.writes, 0)

    def test_failed_readback_never_certifies_update(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = FakeTasks()
            api.ignore_write = True
            fixture(stack, Path(temp), api)
            result = due.task_due_manager(True, NOW)
            self.assertFalse(result["ok"])
            self.assertEqual(result["status"], "blocked_fail_closed")
            sor: Row = object_row(object_row(result["systemsOfRecord"])["sellsy"])
            self.assertFalse(sor["verifiedByReadback"])

    def test_missing_tasks_and_boolean_identifier_are_not_valid_empty_success(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = FakeTasks()
            fixture(stack, Path(temp), api)
            for state in ['{"tasks":{}}', '{"tasks":{"rbw:task:qa":true}}']:
                _ = core.CRMSTATE.write_text(state)
                self.assertFalse(due.task_due_manager(True, NOW)["ok"])
            self.assertEqual(api.writes, 0)
