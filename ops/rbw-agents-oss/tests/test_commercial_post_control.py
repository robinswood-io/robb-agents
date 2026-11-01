"""Post-remediation control uses QA files, fake read-only APIs and no real credentials."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from collections.abc import Mapping
from contextlib import ExitStack, redirect_stdout
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import commercial_post_readbacks as readback
import evergreen_offline_test_guard as offline
import robinswood_commercial_post_remediation_control as control
import robinswood_flow_core as core
from flow_contact_evidence_state import Row, object_row
from flow_duplicate_targets import DuplicateTargets, fingerprint
from pydantic import JsonValue


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def targets() -> DuplicateTargets:
    return DuplicateTargets.model_validate_json(
        '{"companies":{"qa":[1001,2001]},"contacts":{"1002":["qa",2002]},"falsePositiveContacts":{}}'
    )


def duplicate_report() -> Row:
    return {
        "ok": True,
        "status": "audited_read_only",
        "generatedAt": datetime.now(UTC).isoformat(),
        "targetFingerprint": fingerprint(targets()),
        "counts": {"objects": 2, "archives": 0, "hardDeletes": 0, "crmMutations": 0},
    }


class QAReadAPI:
    def __init__(self) -> None:
        self.gmail_pages: list[dict[str, JsonValue]] = [
            {"messages": [{"id": "qa-initial"}]}
        ]
        self.gmail_calls: list[str] = []
        self.crm_calls: list[str] = []
        self.repeat_cursor: bool = False
        self.incomplete_opportunities: bool = False

    def gmail(
        self,
        access: str,
        path: str,
        params: Mapping[str, str | list[str]] | None = None,
    ) -> dict[str, JsonValue]:
        if access != "qa-token":
            raise AssertionError("unexpected credential")
        self.gmail_calls.append(path)
        if path != "messages":
            return {
                "threadId": "qa-thread",
                "payload": {
                    "headers": [
                        {"name": "To", "value": "qa@example.org"},
                        {"name": "Subject", "value": "QA"},
                    ]
                },
            }
        if self.repeat_cursor:
            return {"messages": [], "nextPageToken": "same"}
        index = 1 if params is not None and params.get("pageToken") is not None else 0
        return self.gmail_pages[index]

    def crm(
        self, endpoint: str, method: str = "GET", payload: object = None
    ) -> dict[str, JsonValue]:
        if method != "GET" or payload is not None:
            raise AssertionError("CRM mutation forbidden")
        self.crm_calls.append(endpoint)
        if not endpoint.startswith("/opportunities?limit=100"):
            raise AssertionError("unexpected CRM request")
        if self.incomplete_opportunities:
            return {"data": [{"id": 3000 + n} for n in range(100)]}
        return {"data": []}


def fixture(stack: ExitStack, root: Path, api: QAReadAPI) -> None:
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    names = [
        "OUT",
        "OUT_MD",
        "STATE",
        "SYNC",
        "INTEGRITY",
        "HDF_GATE",
        "HDF_MAILER",
        "INCIDENT",
        "HDF_MAILER_LEDGER",
        "HDF_DISPATCH_LEDGER",
        "DUPLICATE_AUDIT",
        "READY_SCHEDULES",
    ]
    for name in names:
        path = root / (name.lower() + ".json")
        if hasattr(control, name):
            _ = stack.enter_context(patch.object(control, name, path))
        _ = stack.enter_context(patch.object(readback, name, path))
    for name in ["CRMSTATE", "EMAILQ", "LEDGER"]:
        _ = stack.enter_context(
            patch.object(core, name, root / (name.lower() + ".json"))
        )
    _ = stack.enter_context(patch.object(core, "token", return_value="qa-token"))
    _ = stack.enter_context(
        patch.object(core, "private_text", return_value="in:sent to:qa@example.org")
    )
    _ = stack.enter_context(
        patch.object(core, "source_message_id", return_value="qa-initial")
    )
    _ = stack.enter_context(patch.object(core, "gh", side_effect=api.gmail))
    _ = stack.enter_context(patch.object(core, "crmreq", side_effect=api.crm))
    _ = stack.enter_context(patch.object(readback, "targets", side_effect=targets))
    counters = {
        name: 0
        for name in [
            "companiesCreatedThisRun",
            "contactsCreatedThisRun",
            "tasksCreatedThisRun",
            "opportunitiesCreated",
            "integrityMutationsFirstReplay",
            "integrityMutationsSecondReplay",
            "hardDeletes",
            "archives",
        ]
    }
    readback.write_json(
        readback.SYNC,
        {
            "ok": True,
            "counts": counters,
            "crmObjects": [
                {
                    "companyId": 2001 + n,
                    "companyReadbackId": 2001 + n,
                    "taskId": 5001 + n,
                    "taskReadbackId": 5001 + n,
                }
                for n in range(13)
            ],
        },
    )
    readback.write_json(readback.INTEGRITY, {"ok": True, "status": "verified"})
    readback.write_json(
        readback.HDF_GATE,
        {"externalSendAllowed": False, "counts": {"effectiveMaxFirstSendsPerRun": 0}},
    )
    readback.write_json(readback.HDF_MAILER, {"sentOrFound": [], "planned": []})
    readback.write_json(
        readback.INCIDENT,
        {
            "status": "contained_no_resend",
            "containment": {"resendAllowed": False},
            "gmailEvidence": {"attachmentCount": 0},
        },
    )
    readback.write_json(
        core.CRMSTATE, {"companies": {"qa": 2001}, "contacts": {"qa": 2002}}
    )
    readback.write_json(readback.DUPLICATE_AUDIT, duplicate_report())
    readback.write_json(
        readback.READY_SCHEDULES,
        {
            "schedules": [
                {
                    "schedule_id": f"sched.robinswood-flow-qa-{n}",
                    "payload": {
                        "legacy_id": "robinswood-flow-sellsy-sync"
                        if n == 0
                        else f"qa-read-{n}"
                    },
                }
                for n in range(8)
            ]
        },
    )


class PostControlTests(unittest.TestCase):
    def test_complete_control_initializes_then_replays_with_zero_mutations(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = QAReadAPI()
            fixture(stack, Path(temp), api)
            first = control.run()
            self.assertFalse(first["ok"])
            second = control.run()
            self.assertTrue(second["ok"])
            counts = object_row(second["counts"])
            self.assertEqual(counts["failed"], 0)
            self.assertEqual(counts["crmMutationsFromControl"], 0)
            self.assertEqual(counts["externalSends"], 0)
            self.assertTrue(readback.read_json(readback.OUT)["ok"])
            self.assertTrue(readback.OUT_MD.exists())
            self.assertEqual(len(api.crm_calls), 2)
            self.assertEqual(api.gmail_calls, ["messages", "messages"])

    def test_forbidden_new_send_remains_visible_on_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = QAReadAPI()
            fixture(stack, Path(temp), api)
            _ = control.run()
            self.assertTrue(control.run()["ok"])
            _ = readback.HDF_MAILER_LEDGER.write_text(
                json.dumps(
                    {
                        "status": "sent_verified",
                        "campaignId": readback.CAMPAIGN_ID,
                        "gmailMessageId": "qa-unexpected",
                        "recipientEmail": "qa@example.org",
                    }
                )
                + "\n"
            )
            for _ in range(2):
                result = control.run()
                self.assertFalse(result["ok"])
                self.assertEqual(
                    object_row(result["counts"])["newHdfSendsWhileBlocked"], 1
                )
            self.assertEqual(readback.read_json(readback.STATE)["hdfSentKeys"], [])

    def test_missing_counts_or_null_readbacks_cannot_certify_a_clean_sync(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = QAReadAPI()
            fixture(stack, Path(temp), api)
            _ = control.run()
            original = readback.read_json(readback.SYNC)
            changes: list[Row] = [
                {"counts": {}},
                {"crmObjects": [{} for _ in range(13)]},
            ]
            for change in changes:
                readback.write_json(readback.SYNC, {**original, **change})
                self.assertFalse(control.run()["ok"])

    def test_gmail_next_page_is_read_and_unknown_message_blocks_control(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = QAReadAPI()
            api.gmail_pages = [
                {"messages": [{"id": "qa-initial"}], "nextPageToken": "next"},
                {"messages": [{"id": "qa-unknown"}]},
            ]
            fixture(stack, Path(temp), api)
            result = readback.gmail_yousign_readback()
            self.assertFalse(result["ok"])
            self.assertEqual(result["unknownMessageIds"], ["qa-unknown"])
            self.assertEqual(result["pages"], 2)
            self.assertEqual(
                api.gmail_calls, ["messages", "messages", "messages/qa-unknown"]
            )

    def test_repeated_gmail_cursor_refuses_incomplete_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = QAReadAPI()
            api.repeat_cursor = True
            fixture(stack, Path(temp), api)
            with self.assertRaisesRegex(ValueError, "gmail_pagination_cursor_invalid"):
                _ = readback.gmail_yousign_readback()
            self.assertEqual(len(api.gmail_calls), 2)

    def test_incomplete_opportunity_scan_cannot_report_no_opportunities(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = QAReadAPI()
            api.incomplete_opportunities = True
            fixture(stack, Path(temp), api)
            result = readback.opportunity_readback()
            self.assertFalse(result["ok"])
            self.assertFalse(object_row(result["scan"])["complete"])

    def test_changed_targets_or_future_timestamp_refresh_duplicate_evidence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            api = QAReadAPI()
            fixture(stack, Path(temp), api)
            with patch.object(
                readback,
                "run_duplicate_audit",
                side_effect=AssertionError("fresh matching evidence must be reused"),
            ):
                self.assertFalse(readback.duplicate_audit_readback()["refreshed"])
            for change in [
                {"targetFingerprint": "old-targets"},
                {"generatedAt": (datetime.now(UTC) + timedelta(days=1)).isoformat()},
            ]:
                readback.write_json(
                    readback.DUPLICATE_AUDIT, {**duplicate_report(), **change}
                )
                with patch.object(
                    readback, "run_duplicate_audit", return_value=duplicate_report()
                ):
                    self.assertTrue(readback.duplicate_audit_readback()["refreshed"])

    def test_corrupt_ledger_is_not_treated_as_zero_sends(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp), QAReadAPI())
            _ = readback.HDF_MAILER_LEDGER.write_text("{broken\n")
            with self.assertRaises(ValueError):
                _ = control.run()
            self.assertFalse(readback.OUT.exists())


if __name__ == "__main__":
    _ = unittest.main()
