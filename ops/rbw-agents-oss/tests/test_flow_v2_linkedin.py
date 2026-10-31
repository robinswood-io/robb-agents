"""Queue-to-browser boundary with QA results; no browser or real invitations."""

from __future__ import annotations

import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_linkedin as linkedin
import robinswood_flow_core as core
from flow_contact_evidence_state import OBJECT, Row, object_rows
from flow_v2_rules import approval_scope
from test_flow_v2_delivery import NOW, FakeMailTransport
from test_flow_v2_delivery import fixture as delivery_fixture
from test_flow_v2_reply_router import save


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class FakeBrowser:
    def __init__(self) -> None:
        self.calls: int = 0
        self.status: str = "sent_ui"
        self.wrong_identity: bool = False
        self.checkpoint_seen: bool = False

    def run(
        self, rows: list[Row], *, apply: bool, allow_note: bool, pace_seconds: float
    ) -> Row:
        if not apply or allow_note or pace_seconds != 45 or len(rows) != 1:
            raise AssertionError("unexpected browser dispatch")
        self.calls += 1
        self.checkpoint_seen = (
            object_rows(OBJECT.validate_json(core.LIQ.read_text())["items"])[0][
                "status"
            ]
            == "held_delivery_uncertain"
        )
        return {
            "ok": self.status in {"sent_ui", "skipped_already_connected"},
            "results": [
                {
                    "requestId": "wrong"
                    if self.wrong_identity
                    else rows[0]["requestId"],
                    "status": self.status,
                }
            ],
        }


def fixture(stack: ExitStack, root: Path, browser: FakeBrowser) -> None:
    delivery_fixture(stack, root, FakeMailTransport())
    registry = object_rows(OBJECT.validate_json(core.REG.read_text())["accounts"])
    account = registry[0]
    account.update(
        {
            "linkedin": "https://www.linkedin.com/in/qa-only",
            "costHypothesisEur": 1000,
            "sponsor": "QA Person",
            "role": "CEO",
        }
    )
    scope = approval_scope(account)
    if scope is None:
        raise AssertionError("QA approval scope missing")
    account["approvalScope"] = scope
    save(core.REG, {"accounts": registry})
    request_id = core.stable(
        "linkedin-request", account["campaign_id"], account["key"], account["linkedin"]
    )
    save(core.EMAILQ, {"items": []})
    save(
        core.LIQ,
        {
            "items": [
                {
                    "action_id": "qa-linkedin",
                    "request_id": request_id,
                    "accountKey": "qa",
                    "approvalScope": scope,
                    "type": "linkedin_connection",
                    "status": "scheduled_conditional",
                    "dueAt": "2026-10-30T09:15:00+01:00",
                    "linkedinProfileUrl": "https://www.linkedin.com/in/qa-only",
                    "sellsyCompanyId": 2001,
                    "sellsyContactId": 2002,
                    "officerRoleQualified": True,
                    "officerRoleEvidence": {"role": "CEO", "source": "qa"},
                }
            ]
        },
    )
    _ = stack.enter_context(patch.object(linkedin, "run_browser_provider", browser.run))


class LinkedInQueueTests(unittest.TestCase):
    def test_prepare_and_verified_apply_are_checkpointed_and_not_replayed(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            browser = FakeBrowser()
            fixture(stack, Path(temp), browser)
            self.assertEqual(linkedin.linkedin_queue(reference=NOW), 0)
            self.assertEqual(browser.calls, 0)
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 0)
            self.assertTrue(browser.checkpoint_seen)
            self.assertEqual(
                object_rows(OBJECT.validate_json(core.LIQ.read_text())["items"])[0][
                    "status"
                ],
                "sent_ui_verified",
            )
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 0)
            self.assertEqual(browser.calls, 1)

    def test_wrong_result_identity_and_unknown_outcome_stay_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            browser = FakeBrowser()
            fixture(stack, Path(temp), browser)
            browser.wrong_identity = True
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 1)
            browser.wrong_identity = False
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 1)
            self.assertEqual(browser.calls, 1)

    def test_existing_connection_is_terminal_without_new_invitation(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            browser = FakeBrowser()
            browser.status = "skipped_already_connected"
            fixture(stack, Path(temp), browser)
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 0)
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 0)
            self.assertEqual(browser.calls, 1)
            report = OBJECT.validate_json(
                (Path(temp) / "robinswood-flow-linkedin-queue-last.json").read_text()
            )
            self.assertEqual(report["counts"], {"processed": 0, "sent": 0})

    def test_blocked_browser_is_never_reported_as_completed(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            browser = FakeBrowser()
            browser.status = "blocked_ui"
            fixture(stack, Path(temp), browser)
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 1)
            self.assertEqual(
                object_rows(OBJECT.validate_json(core.LIQ.read_text())["items"])[0][
                    "status"
                ],
                "held_delivery_uncertain",
            )

    def test_stale_profile_or_crm_relation_refuses_before_browser(self) -> None:
        for field, value in (
            ("linkedinProfileUrl", "https://www.linkedin.com/in/other"),
            ("sellsyContactId", 2999),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                browser = FakeBrowser()
                fixture(stack, Path(temp), browser)
                items = object_rows(OBJECT.validate_json(core.LIQ.read_text())["items"])
                items[0][field] = value
                save(core.LIQ, {"items": items})
                self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 1)
                self.assertEqual(browser.calls, 0)

    def test_unapproved_or_missing_relation_refuses_before_browser(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            browser = FakeBrowser()
            fixture(stack, Path(temp), browser)
            items = object_rows(OBJECT.validate_json(core.LIQ.read_text())["items"])
            items[0]["sellsyContactId"] = True
            save(core.LIQ, {"items": items})
            self.assertEqual(linkedin.linkedin_queue(apply=True, reference=NOW), 1)
            self.assertEqual(browser.calls, 0)
