"""Real registry/queue materialization on disposable files and explicit QA approvals."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_materializer as materializer
import robinswood_flow_core as core
import robinswood_flow_core_support as support
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows
from flow_v2_rules import TZ, approval_scope
from linkedin_connection_browser_rules import normalize, validate
from pydantic import JsonValue

NOW = datetime(2026, 10, 30, 18, tzinfo=TZ)


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def save(path: Path, value: Row) -> None:
    _ = path.write_text(json.dumps(value), encoding="utf-8")


def fixture(stack: ExitStack, root: Path) -> None:
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    for name in ["REG", "APPROVAL", "EMAILQ", "LIQ", "REPLY"]:
        _ = stack.enter_context(patch.object(core, name, root / (name + ".json")))
    _ = stack.enter_context(patch.object(core, "OPS", root))
    _ = stack.enter_context(patch.object(support, "OPS", root))
    _ = stack.enter_context(patch.object(materializer, "STATEQ", root / "state.json"))
    _ = stack.enter_context(
        patch.object(materializer, "DECISIONS", root / "decisions.json")
    )
    accounts: list[dict[str, JsonValue]] = [
        {
            "key": "qa",
            "name": "QA Company",
            "campaign_id": "qa-campaign",
            "domain": "example.org",
            "wave": 1,
            "costHypothesisEur": 1000,
        }
    ]
    _ = stack.enter_context(patch.object(core, "accounts", return_value=accounts))
    _ = stack.enter_context(patch.object(core, "account_key", return_value="qa"))
    # Pure exclusion classification; private IDs are not needed to exercise materialization.
    _ = stack.enter_context(
        patch.object(materializer, "item_references_duplicate", return_value=False)
    )


def approve() -> None:
    seed: Row = dict(core.accounts()[0])
    previous = materializer.keyed_rows(core.REG, "accounts", "key").get("qa", {})
    account = materializer.account_row(seed, previous, {}, NOW)
    scope = approval_scope(account)
    if scope is None:
        raise AssertionError("QA approval scope missing")
    save(
        materializer.DECISIONS,
        {
            "items": [
                {
                    "accountKey": "qa",
                    "approvedForSequence": True,
                    "approvedAt": (NOW - timedelta(days=1)).isoformat(),
                    "approvedBy": "QA",
                    "approvalScope": scope,
                    "status": "approved",
                }
            ]
        },
    )


def verify_contact() -> None:
    save(
        core.REG,
        {
            "accounts": [
                {
                    "key": "qa",
                    "contactVerified": True,
                    "email": "qa@example.org",
                    "linkedin": "https://www.linkedin.com/in/qa-only",
                    "sponsor": "QA Person",
                    "role": "CEO",
                    "sellsyCompanyId": 2001,
                    "sellsyContactId": 2002,
                }
            ]
        },
    )


def read_items(path: Path) -> list[Row]:
    return object_rows(OBJECT.validate_json(path.read_text())["items"])


class MaterializerTests(unittest.TestCase):
    def test_primary_account_without_current_decision_stays_prepare_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp))
            verify_contact()
            self.assertEqual(materializer.materialize(NOW), 0)
            registry = OBJECT.validate_json(core.REG.read_text())
            account = object_rows(registry["accounts"])[0]
            self.assertFalse(account["approvedForSequence"])
            self.assertFalse(account["externalFirstContactAllowed"])
            self.assertEqual(read_items(core.EMAILQ), [])
            self.assertEqual(read_items(core.LIQ), [])
            self.assertEqual(
                OBJECT.validate_json(materializer.DECISIONS.read_text())["items"], []
            )

    def test_explicit_approval_builds_business_day_actions_without_fake_sends(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp))
            verify_contact()
            approve()
            self.assertEqual(materializer.materialize(NOW), 0)
            emails = read_items(core.EMAILQ)
            linkedin = read_items(core.LIQ)
            self.assertEqual(len(emails), 4)
            self.assertEqual(len(linkedin), 1)
            for item in emails + linkedin:
                self.assertEqual(item["status"], "scheduled_conditional")
                self.assertNotIn("providerMessageId", item)
                self.assertNotIn("send_id", item)
                due = datetime.fromisoformat(str(item["dueAt"]))
                self.assertGreater(due, NOW)
                self.assertLess(due.weekday(), 5)
            self.assertFalse(linkedin[0]["allowNote"])
            self.assertEqual(
                validate(
                    normalize({**linkedin[0], "requestId": linkedin[0]["request_id"]})
                ),
                (True, "ok"),
            )
            self.assertEqual(linkedin[0]["sellsyCompanyId"], 2001)
            account = object_rows(OBJECT.validate_json(core.REG.read_text())["accounts"])[0]
            self.assertEqual(account["sponsor"], "QA Person")
            report = OBJECT.validate_json(
                (Path(temp) / "robinswood-flow-materializer-last.json").read_text()
            )
            self.assertEqual(object_row(report["counts"])["externalSends"], 0)

    def test_replay_preserves_due_dates_and_sent_or_uncertain_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp))
            verify_contact()
            approve()
            _ = materializer.materialize(NOW)
            emails = read_items(core.EMAILQ)
            emails[0].update(
                {
                    "status": "sent_verified",
                    "providerMessageId": "qa-sent",
                    "threadId": "qa-thread",
                    "sentAt": "2026-11-02T09:15:00+01:00",
                }
            )
            emails[1].update(
                {
                    "status": "held_delivery_uncertain",
                    "pauseUntil": "2026-11-10T09:15:00+01:00",
                }
            )
            save(core.EMAILQ, {"items": emails})
            before = list(emails)
            _ = materializer.materialize(NOW + timedelta(days=7))
            self.assertEqual(read_items(core.EMAILQ), before)
            self.assertEqual(len(read_items(core.LIQ)), 1)

    def test_revocation_holds_actions_and_reapproval_resumes_only_gate_holds(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp))
            verify_contact()
            approve()
            _ = materializer.materialize(NOW)
            emails = read_items(core.EMAILQ)
            emails[0]["status"] = "held_delivery_uncertain"
            save(core.EMAILQ, {"items": emails})
            due = emails[1]["dueAt"]
            save(materializer.DECISIONS, {"items": []})
            _ = materializer.materialize(NOW)
            held = read_items(core.EMAILQ)
            self.assertEqual(held[0]["status"], "held_delivery_uncertain")
            self.assertEqual(
                held[1]["status"], "held_approval_contact_or_duplicate_gate"
            )
            approve()
            _ = materializer.materialize(NOW + timedelta(days=1))
            resumed = read_items(core.EMAILQ)
            self.assertEqual(resumed[0]["status"], "held_delivery_uncertain")
            self.assertEqual(resumed[1]["status"], "scheduled_conditional")
            self.assertEqual(resumed[1]["dueAt"], due)
            self.assertEqual(read_items(core.LIQ)[0]["status"], "scheduled_conditional")

    def test_changed_copy_needs_new_scope_and_rebuilds_only_unsent_actions(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp))
            verify_contact()
            approve()
            _ = materializer.materialize(NOW)
            original = read_items(core.EMAILQ)
            original_due = original[0]["dueAt"]
            original_scope = original[0]["approvalScope"]
            core.accounts()[0]["trigger"] = "new verified trigger"

            _ = materializer.materialize(NOW + timedelta(days=1))
            held = read_items(core.EMAILQ)
            self.assertEqual(held[0]["status"], "held_approval_contact_or_duplicate_gate")
            self.assertEqual(held[0]["approvalScope"], original_scope)
            approval_queue = OBJECT.validate_json(core.APPROVAL.read_text())
            required_scope = object_rows(approval_queue["items"])[0][
                "requiredApprovalScope"
            ]
            self.assertNotEqual(required_scope, original_scope)

            approve()
            _ = materializer.materialize(NOW + timedelta(days=2))
            resumed = read_items(core.EMAILQ)
            self.assertEqual(resumed[0]["status"], "scheduled_conditional")
            self.assertEqual(resumed[0]["dueAt"], original_due)
            self.assertIn("new verified trigger", str(resumed[0]["body"]))
            self.assertEqual(
                resumed[0]["approvalScope"],
                object_rows(OBJECT.validate_json(core.REG.read_text())["accounts"])[0][
                    "approvalScope"
                ],
            )

    def test_missing_contact_or_duplicate_never_activates_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp))
            _ = materializer.materialize(NOW)
            self.assertEqual(read_items(core.EMAILQ), [])
            verify_contact()
            approve()
            _ = stack.enter_context(
                patch.object(
                    materializer, "item_references_duplicate", return_value=True
                )
            )
            _ = materializer.materialize(NOW)
            self.assertEqual(read_items(core.EMAILQ), [])
            self.assertFalse(
                read_items(materializer.STATEQ)[0]["externalOutboundAllowed"]
            )

    def test_missing_cost_and_duplicate_decision_refuse_before_registry_write(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture(stack, Path(temp))
            verify_contact()
            approve()
            original = core.REG.read_bytes()
            decisions = read_items(materializer.DECISIONS)
            save(materializer.DECISIONS, {"items": [decisions[0], decisions[0]]})
            with self.assertRaisesRegex(ValueError, "duplicate_row_identifier"):
                _ = materializer.materialize(NOW)
            self.assertEqual(core.REG.read_bytes(), original)
            with self.assertRaisesRegex(ValueError, "cost_hypothesis"):
                _ = materializer.message_templates({"key": "qa", "name": "QA"})
