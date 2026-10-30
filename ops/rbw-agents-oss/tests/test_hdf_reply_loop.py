"""End-to-end reply routing on temporary files; no Gmail or CRM access."""
from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import robinswood_pme_hdf_reply_unsubscribe_loop as loop


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def paths(stack: ExitStack, root: Path) -> None:
    for name in ["INBOX", "SUPPRESSION", "OUT", "OUT_MD", "LEDGER", "STATE", "HUMAN", "PROPOSALS", "CHALLENGES"]:
        _ = stack.enter_context(patch.object(loop, name, root / (name.lower() + ".json")))
    _ = stack.enter_context(patch.object(loop, "SEND_LEDGERS", (root / "sent.jsonl",)))


class ReplyLoopTests(unittest.TestCase):
    def test_classification_precedence_and_human_reply(self) -> None:
        cases = [
            ({"fromEmail": "qa@invitations.mailinblack.com"}, "Mailinblack stop disponible", "delivery_challenge"),
            ({"fromEmail": "mailer-daemon@example.org"}, "permanent error stop disponible", "hard_bounce_auto_suppression"),
            ({"fromEmail": "qa@example.org"}, "Non merci, pas intéressé", "unsubscribe_or_negative"),
            ({"fromEmail": "qa@example.org"}, "Disponible pour un rendez-vous", "positive_interest_human_required"),
            ({"fromEmail": "qa@example.org"}, "Merci pour votre message", "ambiguous_reply_human_required"),
            ({"fromEmail": "qa@example.org"}, "", "empty"),
        ]
        for row, body, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(loop.classify(row, body), expected)

    def test_actual_mime_payload_and_bounce_recipient(self) -> None:
        encoded = base64.urlsafe_b64encode(b"<p>Bonjour<br>QA</p>").decode().rstrip("=")
        payload: loop.Row = {"parts": [{"mimeType": "text/html", "body": {"data": encoded}}]}
        self.assertEqual(loop.body(payload), "Bonjour QA")
        self.assertEqual(loop.bounced_to({}, "Final-Recipient: rfc822; qa@example.org"), "qa@example.org")
        self.assertEqual(loop.bounced_to({"recipientEmail": "fallback@example.org"}, "opaque"), "fallback@example.org")

    def test_full_route_and_resume_does_not_duplicate_effects(self) -> None:
        replies: list[loop.Row] = [
            {"messageId": "challenge", "fromEmail": "qa@invitations.mailinblack.com", "bodyText": "Mailinblack"},
            {"messageId": "bounce", "fromEmail": "mailer-daemon@example.org", "bodyText": "Final-Recipient: rfc822; bounce@example.org"},
            {"messageId": "stop", "fromEmail": "stop@example.org", "bodyText": "Merci de me désabonner"},
            {"messageId": "positive", "fromEmail": "positive@example.org", "bodyText": "Disponible pour un rendez-vous"},
            {"messageId": "ambiguous", "fromEmail": "ambiguous@example.org", "bodyText": "Merci pour votre message"},
            {"messageId": "empty", "fromEmail": "empty@example.org", "bodyText": ""},
        ]
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = stack.enter_context(patch.object(loop, "ingest", return_value=replies))
            _ = stack.enter_context(redirect_stdout(io.StringIO()))
            loop.write(loop.INBOX, {"replies": [replies[3]]})
            self.assertEqual(loop.main(), 0)
            report = loop.read(loop.OUT, {})
            counts = loop.object_row(report["counts"])
            self.assertEqual(counts["newMessagesProcessed"], 6)
            self.assertEqual(counts["humanActionsNew"], 2)
            self.assertEqual(counts["suppressionApplied"], 2)
            self.assertEqual(counts["deliveryChallenges"], 1)
            challenge = loop.object_rows(loop.read(loop.CHALLENGES, {})["challenges"])[0]
            self.assertIs(challenge["automaticChallengeResponseAllowed"], False)
            self.assertIs(report["externalSendAllowed"], False)
            self.assertEqual(loop.main(), 0)
            resumed = loop.object_row(loop.read(loop.OUT, {})["counts"])
            self.assertEqual(resumed["newMessagesProcessed"], 0)
            self.assertEqual(len(loop.object_rows(loop.read(loop.HUMAN, {})["actions"])), 2)
            self.assertEqual(len(loop.object_rows(loop.read(loop.SUPPRESSION, {})["records"])), 2)
            self.assertEqual(len(loop.LEDGER.read_text().splitlines()), 2)

    def test_corrupt_state_is_rejected_without_reinitialization(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = loop.STATE.write_text("{broken")
            _ = stack.enter_context(redirect_stdout(io.StringIO()))
            with self.assertRaises(ValueError):
                _ = loop.main()
            self.assertEqual(loop.STATE.read_text(), "{broken")
            self.assertFalse(loop.SUPPRESSION.exists())

    def test_read_failure_reports_error_and_keeps_manual_queue(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = stack.enter_context(patch.object(loop, "ingest", side_effect=OSError("private-qa-token")))
            _ = stack.enter_context(redirect_stdout(io.StringIO()))
            loop.write(loop.INBOX, {"replies": [{"messageId": "manual", "fromEmail": "qa@example.org", "bodyText": "Disponible"}]})
            self.assertEqual(loop.main(), 1)
            report = loop.read(loop.OUT, {})
            self.assertIs(report["ok"], False)
            self.assertEqual(report["gmailError"], "OSError")
            self.assertNotIn("private-qa-token", loop.OUT.read_text())
            self.assertEqual(len(loop.object_rows(loop.read(loop.HUMAN, {})["actions"])), 1)

    def test_sent_ledger_nested_identifiers_and_status_filter(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            rows = [
                {"status": "sent_verified", "recipientEmail": "qa@example.org", "postSendVerification": {"metadata": {"threadId": "qa-thread", "messageId": "qa-sent"}}},
                {"status": "planned", "threadId": "must-not-be-read"},
            ]
            _ = loop.SEND_LEDGERS[0].write_text("invalid\n" + "\n".join(json.dumps(row) for row in rows))
            threads = loop.sent_threads()
            self.assertEqual(list(threads), ["qa-thread"])
            self.assertEqual(threads["qa-thread"]["gmailMessageId"], "qa-sent")
