"""Full local reply handling with fake Gmail/CRM and persistent QA files."""

from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from collections.abc import Mapping
from contextlib import ExitStack, redirect_stdout
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_reply_router as router
import robinswood_flow_core as core
import robinswood_flow_core_support as support
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows
from flow_v2_rules import TZ
from pydantic import JsonValue
from test_flow_v2_reply_crm import ACCOUNT, FakeCRM
from test_flow_v2_reply_crm import fixture as crm_fixture


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def message(
    identifier: str, body: str, sender: str = "qa@example.org"
) -> dict[str, JsonValue]:
    return {
        "id": identifier,
        "internalDate": str(
            int(datetime(2026, 10, 30, 12, tzinfo=TZ).timestamp() * 1000)
        ),
        "payload": {
            "mimeType": "text/plain",
            "headers": [
                {"name": "From", "value": sender},
                {"name": "Subject", "value": "QA reply"},
            ],
            "body": {"data": base64.urlsafe_b64encode(body.encode()).decode()},
        },
    }


class FakeGmail:
    def __init__(self) -> None:
        self.messages: list[JsonValue] = []
        self.calls: int = 0
        self.failure: bool = False

    def get(
        self,
        access: str,
        path: str,
        params: Mapping[str, str | list[str]] | None = None,
    ) -> dict[str, JsonValue]:
        if (
            access != "qa-token"
            or path != "threads/qa-thread"
            or params != {"format": "full"}
        ):
            raise AssertionError("unexpected Gmail request")
        self.calls += 1
        if self.failure:
            raise RuntimeError("private-token-must-not-leak")
        return {"messages": list(self.messages)}


def save(path: Path, value: Row) -> None:
    _ = path.write_text(json.dumps(value), encoding="utf-8")


def fixture(stack: ExitStack, root: Path, gmail: FakeGmail, crm: FakeCRM) -> None:
    crm_fixture(stack, root, crm)
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    for name in ["REG", "EMAILQ", "LIQ", "HUMAN", "REPLY", "EVENTS"]:
        _ = stack.enter_context(patch.object(core, name, root / (name + ".json")))
    for name in ["PROFILE_PATH", "SUPPRESSION"]:
        _ = stack.enter_context(patch.object(support, name, root / (name + ".json")))
    _ = stack.enter_context(patch.object(support, "OPS", root))
    _ = stack.enter_context(patch.object(core, "token", return_value="qa-token"))
    _ = stack.enter_context(patch.object(core, "gh", gmail.get))
    save(
        support.PROFILE_PATH,
        {
            "sender": "sender@example.org",
            "accountKey": "qa",
            "sourceMessageId": "qa-initial",
            "sourceThreadId": "qa-thread",
            "accounts": [{"key": "qa"}] + [{"key": f"qa-{i}"} for i in range(12)],
            "staleMessageIds": [],
            "privateTextValues": {},
        },
    )
    save(
        core.REG,
        {
            "accounts": [
                {**ACCOUNT, "campaign_id": "qa-campaign", "email": "qa@example.org"}
            ]
        },
    )
    save(
        core.EMAILQ,
        {
            "items": [
                {
                    "action_id": "qa-initial",
                    "accountKey": "qa",
                    "threadId": "qa-thread",
                    "status": "sent_verified",
                },
                {
                    "action_id": "qa-next",
                    "accountKey": "qa",
                    "status": "scheduled_conditional",
                    "dueAt": "2026-10-31T09:15:00+01:00",
                },
            ]
        },
    )
    save(
        core.LIQ,
        {
            "items": [
                {
                    "action_id": "qa-linkedin",
                    "accountKey": "qa",
                    "status": "scheduled_conditional",
                    "dueAt": "2026-10-31T09:15:00+01:00",
                }
            ]
        },
    )


def report(root: Path) -> Row:
    return object_row(
        OBJECT.validate_json(
            (root / "robinswood-flow-reply-router-last.json").read_text()
        )
    )


def account_state() -> Row:
    return object_row(
        object_row(OBJECT.validate_json(core.REPLY.read_text())["accounts"])["qa"]
    )


class ReplyRouterTests(unittest.TestCase):
    def test_opt_out_cancels_future_and_suppresses_once_without_crm_or_send(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            gmail, crm = FakeGmail(), FakeCRM()
            fixture(stack, Path(temp), gmail, crm)
            gmail.messages = [
                message("qa-optout", "unsubscribe"),
                message("qa-optout", "unsubscribe"),
                message("qa-own", "hello", "sender@example.org"),
            ]
            self.assertEqual(router.reply_router(apply=True), 0)
            self.assertEqual(router.reply_router(apply=True), 0)
            emails = object_rows(OBJECT.validate_json(core.EMAILQ.read_text())["items"])
            self.assertEqual(emails[0]["status"], "sent_verified")
            self.assertEqual(emails[1]["status"], "cancelled_by_signal")
            self.assertTrue(account_state()["sequenceStopped"])
            self.assertEqual(account_state()["processedMessageIds"], ["qa-optout"])
            self.assertEqual(
                len(
                    object_rows(
                        OBJECT.validate_json(support.SUPPRESSION.read_text())["records"]
                    )
                ),
                1,
            )
            self.assertEqual(len(core.EVENTS.read_text().splitlines()), 1)
            self.assertEqual(crm.posts, [])
            self.assertEqual(
                object_row(report(Path(temp))["counts"])["externalSends"], 0
            )

    def test_out_of_office_reschedules_both_channels_and_never_revokes_prior_stop(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            gmail, crm = FakeGmail(), FakeCRM()
            fixture(stack, Path(temp), gmail, crm)
            gmail.messages = [message("qa-ooo", "De retour le 2026-11-01")]
            self.assertEqual(router.reply_router(), 0)
            for path in [core.EMAILQ, core.LIQ]:
                pending = [
                    row
                    for row in object_rows(
                        OBJECT.validate_json(path.read_text())["items"]
                    )
                    if row["status"] != "sent_verified"
                ]
                self.assertEqual(pending[0]["pauseUntil"], "2026-11-02T09:15:00+01:00")
            gmail.messages = [
                message("qa-stop", "unsubscribe"),
                message("qa-ooo-later", "De retour le 2026-11-03"),
            ]
            self.assertEqual(router.reply_router(), 0)
            self.assertTrue(account_state()["sequenceStopped"])
            self.assertEqual(account_state()["stopReason"], "opt_out")

    def test_prepare_apply_and_replay_complete_one_positive_mission(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            gmail, crm = FakeGmail(), FakeCRM()
            fixture(stack, Path(temp), gmail, crm)
            gmail.messages = [message("qa-positive", "Avec plaisir, disponible")]
            self.assertEqual(router.reply_router(), 0)
            self.assertEqual(crm.posts, [])
            self.assertEqual(account_state()["processedMessageIds"], [])
            self.assertEqual(report(Path(temp))["status"], "prepared_crm_actions")
            self.assertEqual(router.reply_router(apply=True), 0)
            self.assertEqual(crm.posts, ["/tasks", "/opportunities"])
            self.assertEqual(account_state()["processedMessageIds"], ["qa-positive"])
            human = object_rows(OBJECT.validate_json(core.HUMAN.read_text())["items"])
            self.assertEqual(len(human), 1)
            self.assertIsInstance(object_row(human[0]["crmAction"])["taskId"], int)
            self.assertEqual(router.reply_router(apply=True), 0)
            self.assertEqual(len(crm.posts), 2)
            self.assertEqual(len(core.EVENTS.read_text().splitlines()), 1)

    def test_gmail_failure_is_visible_and_redacted(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            gmail, crm = FakeGmail(), FakeCRM()
            fixture(stack, Path(temp), gmail, crm)
            before = core.EMAILQ.read_bytes()
            gmail.failure = True
            self.assertEqual(router.reply_router(apply=True), 1)
            result = report(Path(temp))
            self.assertEqual(result["status"], "blocked_fail_closed")
            self.assertNotIn("private-token", json.dumps(result))
            self.assertEqual(core.EMAILQ.read_bytes(), before)
            self.assertEqual(crm.posts, [])

    def test_malformed_message_blocks_and_does_not_acknowledge_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            gmail, crm = FakeGmail(), FakeCRM()
            fixture(stack, Path(temp), gmail, crm)
            bad = message("qa-bad", "hello")
            bad["internalDate"] = True
            gmail.messages = [bad]
            self.assertEqual(router.reply_router(), 1)
            self.assertEqual(account_state()["processedMessageIds"], [])
            self.assertFalse(core.EVENTS.exists())

    def test_referral_is_detected_but_never_approves_a_new_contact(self) -> None:
        result = router.detect_referral_identity(
            "Contactez plutôt QA2@example.org, copie qa@example.org", "qa@example.org"
        )
        self.assertTrue(result["approvalRequired"])
        self.assertEqual(result["emails"], ["qa2@example.org"])

    def test_empty_threads_need_no_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            gmail, crm = FakeGmail(), FakeCRM()
            fixture(stack, Path(temp), gmail, crm)
            save(core.EMAILQ, {"items": []})
            _ = stack.enter_context(
                patch.object(
                    core, "token", side_effect=AssertionError("no token needed")
                )
            )
            self.assertEqual(router.reply_router(), 0)
            self.assertEqual(gmail.calls, 0)
            self.assertEqual(crm.calls, [])
