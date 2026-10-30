"""Persisted send/recovery workflow uses fake HTTP responses and disposable queues."""

from __future__ import annotations

import io
import tempfile
import unittest
from collections.abc import Mapping
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_delivery as delivery
import flow_v2_materializer as materializer
import requests
import robinswood_flow_core as core
from flow_contact_evidence_state import OBJECT, Row, object_rows
from flow_v2_rules import TZ, approval_scope
from pydantic import JsonValue
from requests import Response
from test_flow_v2_reply_crm import ACCOUNT, FakeCRM
from test_flow_v2_reply_router import FakeGmail, save
from test_flow_v2_reply_router import fixture as router_fixture
from urllib3 import HTTPResponse

NOW = datetime(2026, 10, 30, 14, tzinfo=TZ)


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class FakeMailTransport:
    def __init__(self) -> None:
        self.posts: int = 0
        self.timeout: bool = False
        self.readback_failure: bool = False
        self.attachment: bool = False
        self.wrong_thread: bool = False
        self.wrong_recipient: bool = False
        self.checkpoint_seen: bool = False

    def post(
        self, url: str, *, headers: Mapping[str, str], json: object, timeout: int
    ) -> Response:
        if (
            url != "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
            or headers.get("Authorization") != "Bearer qa-token"
            or timeout != 30
        ):
            raise AssertionError("unexpected transport")
        _ = OBJECT.validate_python(json, strict=True)
        self.checkpoint_seen = any(
            row.get("status") == "held_delivery_uncertain"
            for row in object_rows(
                OBJECT.validate_json(core.EMAILQ.read_text())["items"]
            )
        )
        self.posts += 1
        if self.timeout:
            raise TimeoutError("private-token-must-not-leak")
        result = Response()
        result.status_code = 200
        result.raw = HTTPResponse(
            body=io.BytesIO(b'{"id":"qa-sent","threadId":"qa-thread"}'),
            status=200,
            preload_content=False,
        )
        return result

    def get(
        self,
        access: str,
        path: str,
        params: Mapping[str, str | list[str]] | None = None,
    ) -> dict[str, JsonValue]:
        if access != "qa-token":
            raise AssertionError("unexpected credential")
        if path == "threads/qa-thread":
            return {"messages": []}
        if (
            path == "messages/qa-initial"
            and params is not None
            and params.get("format") == "metadata"
        ):
            return {
                "payload": {
                    "headers": [
                        {"name": "Message-ID", "value": "<qa-original@example.org>"}
                    ]
                }
            }
        if path != "messages/qa-sent":
            raise AssertionError("unexpected Gmail request")
        if self.readback_failure:
            self.readback_failure = False
            raise RuntimeError("qa-readback-temporarily-unavailable")
        return {
            "id": "qa-sent",
            "threadId": "qa-wrong" if self.wrong_thread else "qa-thread",
            "labelIds": ["SENT"],
            "payload": {
                "headers": [
                    {
                        "name": "To",
                        "value": "wrong@example.org"
                        if self.wrong_recipient
                        else "qa@example.org",
                    }
                ],
                "parts": [{"filename": "forbidden.pdf"}] if self.attachment else [],
            },
        }


def fixture(stack: ExitStack, root: Path, transport: FakeMailTransport) -> None:
    router_fixture(stack, root, FakeGmail(), FakeCRM())
    _ = stack.enter_context(patch.object(core, "LEDGER", root / "ledger.jsonl"))
    _ = stack.enter_context(patch.object(core, "gh", transport.get))
    _ = stack.enter_context(
        patch.object(
            core,
            "identity",
            return_value={
                "sender": "sender@example.org",
                "from": "QA <sender@example.org>",
                "sig": "<p>QA signature</p>",
                "sigText": "QA signature",
            },
        )
    )
    _ = stack.enter_context(patch.object(requests, "post", transport.post))
    _ = stack.enter_context(
        patch.object(delivery, "item_references_duplicate", return_value=False)
    )
    account: Row = {
        **ACCOUNT,
        "campaign_id": "qa-campaign",
        "domain": "example.org",
        "email": "qa@example.org",
        "linkedin": "https://www.linkedin.com/in/qa-only",
        "approvedForSequence": True,
        "contactVerified": True,
        "costHypothesisEur": 1000,
        "sponsor": "QA Person",
        "role": "CEO",
    }
    scope = approval_scope(account)
    if scope is None:
        raise AssertionError("QA approval scope missing")
    account["approvalScope"] = scope
    template = materializer.message_templates(account)["email_d0"]
    save(core.REG, {"accounts": [account]})
    save(
        core.EMAILQ,
        {
            "items": [
                {
                    "action_id": "qa-outbound",
                    "accountKey": "qa",
                    "type": "email_d0",
                    "status": "scheduled_conditional",
                    "dueAt": "2026-10-30T09:15:00+01:00",
                    "recipientEmail": "qa@example.org",
                    "attachmentsAllowed": False,
                    "approvalScope": scope,
                    **template,
                }
            ]
        },
    )


def queued_items() -> list[Row]:
    queue = OBJECT.validate_json(core.EMAILQ.read_text())
    return object_rows(queue["items"])


class DeliveryTests(unittest.TestCase):
    def test_prepare_does_not_resolve_credentials_or_send(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            _ = stack.enter_context(
                patch.object(
                    core, "token", side_effect=AssertionError("no credential needed")
                )
            )
            self.assertEqual(delivery.email_sequencer(reference=NOW), 0)
            self.assertEqual(transport.posts, 0)
            self.assertEqual(queued_items()[0]["status"], "scheduled_conditional")

    def test_send_readback_and_replay_are_idempotent_and_checkpointed(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 0)
            self.assertTrue(transport.checkpoint_seen)
            self.assertEqual(queued_items()[0]["status"], "sent_verified")
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 0)
            self.assertEqual(transport.posts, 1)
            self.assertEqual(len(core.LEDGER.read_text().splitlines()), 1)
            self.assertEqual(len(core.EVENTS.read_text().splitlines()), 1)

    def test_readback_failure_recovers_known_send_without_second_post(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            transport.readback_failure = True
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertEqual(queued_items()[0]["status"], "sent_pending_verification")
            self.assertEqual(queued_items()[0]["providerMessageId"], "qa-sent")
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 0)
            self.assertEqual(transport.posts, 1)
            self.assertEqual(queued_items()[0]["status"], "sent_verified")

    def test_unknown_send_outcome_remains_visible_and_is_never_retried_blindly(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            transport.timeout = True
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertEqual(queued_items()[0]["status"], "held_delivery_uncertain")
            transport.timeout = False
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertEqual(transport.posts, 1)
            self.assertNotIn(
                "private-token",
                (Path(temp) / "robinswood-flow-email-sequencer-last.json").read_text(),
            )

    def test_attachment_and_wrong_recipient_fail_verification_without_resend(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            transport.attachment = True
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertFalse(core.LEDGER.exists())
            transport.attachment = False
            transport.wrong_recipient = True
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertEqual(transport.posts, 1)
            self.assertFalse(core.LEDGER.exists())

    def test_followup_requires_original_thread_and_verifies_same_thread(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            followup = queued_items()[0]
            followup["type"] = "email_d5"
            account = object_rows(OBJECT.validate_json(core.REG.read_text())["accounts"])[0]
            followup.update(materializer.message_templates(account)["email_d5"])
            save(core.EMAILQ, {"items": [followup]})
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertEqual(transport.posts, 0)
            original: Row = {
                "action_id": "qa-first",
                "accountKey": "qa",
                "type": "email_d0",
                "status": "sent_verified",
                "providerMessageId": "qa-initial",
                "threadId": "qa-thread",
            }
            save(core.EMAILQ, {"items": [original, followup]})
            transport.wrong_thread = True
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertEqual(transport.posts, 1)
            self.assertEqual(queued_items()[1]["status"], "sent_verification_failed")

    def test_stale_scope_or_modified_copy_refuses_before_transport(self) -> None:
        for change in ("scope", "body"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                transport = FakeMailTransport()
                fixture(stack, Path(temp), transport)
                queue = OBJECT.validate_json(core.EMAILQ.read_text())
                items = object_rows(queue["items"])
                items[0]["approvalScope" if change == "scope" else "body"] = "stale-qa-value"
                save(core.EMAILQ, {"items": items})
                self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
                self.assertEqual(transport.posts, 0)
                current = object_rows(OBJECT.validate_json(core.EMAILQ.read_text())["items"])
                self.assertEqual(current[0]["status"], "scheduled_conditional")

    def test_email_boundary_rejects_unsafe_salutation_even_when_template_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            account = object_rows(
                OBJECT.validate_json(core.REG.read_text())["accounts"]
            )[0]
            items = queued_items()
            item = items[0]
            unsafe_body = "Bonjour QA Person,\n\nQA approved copy"
            item["body"] = unsafe_body
            matching_template = {"subject": item["subject"], "body": unsafe_body}
            with (
                patch.object(
                    delivery,
                    "message_templates",
                    return_value={"email_d0": matching_template},
                ),
                self.assertRaisesRegex(
                    ValueError, "recipient_copy_or_attachment_contract_invalid"
                ),
            ):
                _ = delivery.email_payload("qa-access", {}, account, item, items)
            self.assertEqual(transport.posts, 0)

    def test_unapproved_account_and_nonbusiness_window_never_send(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            transport = FakeMailTransport()
            fixture(stack, Path(temp), transport)
            self.assertEqual(
                delivery.email_sequencer(apply=True, reference=NOW.replace(hour=22)), 0
            )
            registry = OBJECT.validate_json(core.REG.read_text())
            accounts = object_rows(registry["accounts"])
            accounts[0]["approvedForSequence"] = False
            save(core.REG, {"accounts": accounts})
            self.assertEqual(delivery.email_sequencer(apply=True, reference=NOW), 1)
            self.assertEqual(transport.posts, 0)
