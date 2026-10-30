"""Deterministic QA of dates, approvals and reply classifications; no delivery."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_v2_rules as rules
import robinswood_flow_core as core
from flow_contact_evidence_state import Row
from pydantic import JsonValue


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class FlowRulesTests(unittest.TestCase):
    def test_weekend_zero_offset_and_elapsed_slot_are_advanced(self) -> None:
        saturday = datetime(2026, 10, 31, 8, tzinfo=rules.TZ)
        self.assertEqual(
            rules.next_business(saturday, 0, 9, 15).isoformat(),
            "2026-11-02T09:15:00+01:00",
        )
        friday = datetime(2026, 10, 30, 18, tzinfo=rules.TZ)
        self.assertEqual(
            rules.future_slot(friday).isoformat(), "2026-11-02T09:15:00+01:00"
        )
        with self.assertRaises(ValueError):
            _ = rules.next_business(friday, -1, 9, 0)
        with self.assertRaises(ValueError):
            _ = rules.next_business(datetime(2026, 10, 30), 1, 9, 0)

    def test_business_slots_preserve_local_time_across_dst(self) -> None:
        friday = datetime(2026, 10, 23, 18, tzinfo=rules.TZ)
        monday = rules.next_business(friday, 1, 9, 15)
        self.assertEqual(monday.isoformat(), "2026-10-26T09:15:00+01:00")
        self.assertEqual(friday.utcoffset(), timedelta(hours=2))

    def test_account_waves_are_future_and_keep_spacing(self) -> None:
        accounts: list[dict[str, JsonValue]] = [
            {"key": "qa-primary", "wave": 1},
            {"key": "qa-a", "wave": 1},
            {"key": "qa-b", "wave": 1},
            {"key": "qa-c", "wave": 2},
        ]
        ref = datetime(2026, 10, 30, 18, tzinfo=rules.TZ)
        with (
            patch.object(core, "accounts", return_value=accounts),
            patch.object(core, "account_key", return_value="qa-primary"),
        ):
            slots = [rules.task_due(dict(account), ref) for account in accounts]
        self.assertEqual(slots[0].isoformat(), "2026-11-02T09:40:00+01:00")
        self.assertEqual(slots[1].isoformat(), "2026-11-02T09:30:00+01:00")
        self.assertEqual(slots[2] - slots[1], timedelta(minutes=20))
        self.assertEqual(slots[3].isoformat(), "2026-11-03T13:30:00+01:00")
        self.assertTrue(all(value > ref and value.weekday() < 5 for value in slots))

    def test_no_account_inherits_historical_or_incomplete_approval(self) -> None:
        account: Row = {
            "key": "qa-primary",
            "campaign_id": "qa-campaign",
            "name": "QA Company",
            "domain": "example.org",
            "email": "qa@example.org",
            "linkedin": "https://www.linkedin.com/in/qa-primary",
            "sellsyCompanyId": 2001,
            "sellsyContactId": 2002,
            "contactVerified": True,
            "costHypothesisEur": 1000,
        }
        scope = rules.approval_scope(account)
        self.assertIsNotNone(scope)
        if scope is None:
            self.fail("QA approval scope was not generated")
        decision: Row = {
            "accountKey": "qa-primary",
            "approvedForSequence": True,
            "approvedAt": "2026-10-30T14:00:00+02:00",
            "approvedBy": "QA",
            "approvalScope": scope,
            "status": "approved",
        }
        historical = {**decision, "approvedAt": "2026-07-15T14:10:00Z"}
        self.assertFalse(rules.approval_for(account, historical, {})[0])
        for field in decision:
            incomplete = dict(decision)
            _ = incomplete.pop(field)
            self.assertFalse(rules.approval_for(account, {}, incomplete)[0])
        invalid = {**decision, "approvedAt": "not-a-date"}
        self.assertFalse(rules.approval_for(account, {}, invalid)[0])
        future = {**decision, "approvedAt": "2026-10-30T19:00:00+01:00"}
        self.assertFalse(
            rules.approval_for(
                account, {}, future, datetime(2026, 10, 30, 18, tzinfo=rules.TZ)
            )[0]
        )
        self.assertTrue(
            rules.approval_for(
                account, {}, decision, datetime(2026, 10, 30, 18, tzinfo=rules.TZ)
            )[0]
        )

    def test_scope_binds_identity_contact_and_action_inputs(self) -> None:
        account: Row = {
            "key": "qa-primary",
            "campaign_id": "qa-campaign",
            "name": "QA Company",
            "domain": "example.org",
            "email": "qa@example.org",
            "linkedin": "https://www.linkedin.com/in/qa-primary",
            "sellsyCompanyId": 2001,
            "sellsyContactId": 2002,
            "contactVerified": True,
            "costHypothesisEur": 1000,
            "sponsor": "QA Person",
            "role": "CEO",
            "flow": "critical flow",
            "trigger": "verified trigger",
            "budget": "approved budget",
        }
        original = rules.approval_scope(account)
        self.assertIsNotNone(original)
        for field, value in (
            ("campaign_id", "another-campaign"),
            ("email", "other@example.org"),
            ("linkedin", "https://www.linkedin.com/in/other"),
            ("sellsyCompanyId", 3001),
            ("sellsyContactId", 3002),
            ("name", "Other Company"),
            ("sponsor", "Other Person"),
            ("role", "CFO"),
            ("flow", "other flow"),
            ("trigger", "other trigger"),
            ("costHypothesisEur", 2000),
            ("budget", "other budget"),
        ):
            with self.subTest(field=field):
                changed = {**account, field: value}
                self.assertNotEqual(rules.approval_scope(changed), original)

    def test_due_requires_a_valid_explicit_timezone_and_pause(self) -> None:
        now = datetime(2026, 10, 30, 12, tzinfo=rules.TZ)
        item: Row = {"dueAt": "2026-10-30T09:15:00+01:00"}
        self.assertTrue(rules.is_due(item, now))
        self.assertFalse(rules.is_due({**item, "pauseUntil": "invalid"}, now))
        self.assertFalse(
            rules.is_due({**item, "pauseUntil": "2026-11-02T09:15:00+01:00"}, now)
        )
        self.assertFalse(rules.is_due({"dueAt": "2026-10-30T09:15:00"}, now))
        self.assertFalse(rules.is_due({"dueAt": False}, now))
        self.assertFalse(rules.is_due(item, datetime(2026, 10, 30)))

    def test_explicit_return_dates_are_unique_future_and_business_days(self) -> None:
        ref = datetime(2026, 10, 30, 12, tzinfo=rules.TZ)
        result = rules.extract_return_date("De retour le 2026-10-31", ref)
        self.assertTrue(result["reliable"])
        self.assertEqual(result["returnAt"], "2026-11-02T09:15:00+01:00")
        for text in [
            "de retour le 2026-10-29",
            "de retour le 31/02/2026",
            "de retour demain",
            "de retour le 2027-08-01",
            "de retour le 2026-11-03 ou retour le 2026-11-04",
        ]:
            self.assertFalse(rules.extract_return_date(text, ref)["reliable"])

    def test_explicit_past_year_is_not_silently_rolled_forward(self) -> None:
        ref = datetime(2026, 12, 30, 12, tzinfo=rules.TZ)
        self.assertFalse(
            rules.extract_return_date("back 5 january 2026", ref)["reliable"]
        )
        self.assertEqual(
            rules.extract_return_date("back 5 january", ref)["returnAt"],
            "2027-01-05T09:15:00+01:00",
        )

    def test_negative_intent_takes_precedence_over_positive_words(self) -> None:
        cases = {
            "unsubscribe, disponible": "opt_out",
            "pas intéressé": "refusal",
            "mailbox full": "soft_bounce",
            "status: 5. permanent error": "hard_bounce",
            "out of office": "out_of_office",
            "contactez plutôt QA": "referral",
            "avec plaisir": "positive",
            "message sans signal": "ambiguous",
        }
        for text, expected in cases.items():
            self.assertEqual(rules.classify(text), expected)
