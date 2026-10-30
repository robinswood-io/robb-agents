"""Offline queue continuity scenarios; no real external access."""

from __future__ import annotations

import base64
import copy
import json
import sqlite3
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from typing import final
from unittest.mock import patch

import evergreen_offline_test_guard

# isort: split

import evergreen_campaign_data as campaign_data
import evergreen_campaign_data_types as data_types
import evergreen_campaign_prospecting as prospecting
import evergreen_queue_continuity as q
import evergreen_sender_pilot as pilot
import outbound_sender_guard as guard
import robinswood_evergreen_france as e
from evergreen_queue_continuity_test_support import (
    QueueHarness,
    T,
    required_row,
    table_exists,
)


@final
class QueueTests(QueueHarness):
    def test_policy_rejects_arbitrary_replay_caps_or_new_legacy_cohort(self):
        invalid_values: list[tuple[str, object]] = [
            ("historicalFollowupMaximum", 2),
            ("historicalFollowupCampaigns", ["robinswood-pme-hdf-dirigeants-2026-06"]),
            ("paidAllowed", True),
        ]
        for key, value in invalid_values:
            c = copy.deepcopy(self.cfg)
            c[key] = data_types.JSON_ADAPTER.validate_python(value)
            p = self.root / "bad.json"
            _ = p.write_text(json.dumps(c))
            with self.assertRaises(AssertionError):
                _ = self.real_policy(p)

    def test_empty_qualified_supply_is_reported_honestly_and_refill_required(self):
        state = q.coverage(
            self.db,
            "pme",
            T,
            self.c,
            e.audience_counts(self.db, "pme", T, self.c),
            self.cfg,
        )
        if state is None:
            raise AssertionError("coverage report is required")
        self.assertEqual(state.get("readyInitials"), 0)
        self.assertTrue(state.get("refillRequired"))
        self.assertIsNone(e.next_item(self.db, "pme", T, self.c))
        self.assertEqual(state.get("targetReady"), 36)

    def test_refill_uses_low_water_and_bounded_hourly_daily_backoff(self):
        self.assertFalse(q.refill_allowed(self.db, "pme", T, False, self.cfg))
        self.assertTrue(q.refill_allowed(self.db, "pme", T, True, self.cfg))
        self.assertFalse(
            q.refill_allowed(
                self.db, "pme", T + timedelta(seconds=3599), True, self.cfg
            )
        )
        for i in range(1, 8):
            self.assertTrue(
                q.refill_allowed(self.db, "pme", T + timedelta(hours=i), True, self.cfg)
            )
        self.assertFalse(
            q.refill_allowed(self.db, "pme", T + timedelta(hours=8), True, self.cfg)
        )
        self.assertTrue(
            q.refill_allowed(self.db, "pme", T + timedelta(days=1), True, self.cfg)
        )

    def test_failed_proofs_retry_before_seven_days_valid_proofs_do_not(self):
        _ = self.candidate("failed@fixture.invalid", "pme", "Failed")
        _ = self.candidate("valid@fixture.invalid", "pme", "Valid")
        _ = self.candidate("other-lane@fixture.invalid", "eti", "Other")
        _ = self.db.execute(
            "UPDATE candidates SET checked=?",
            (campaign_data.stamp(T - timedelta(days=2)),),
        )
        _ = self.db.execute(
            "UPDATE candidates SET proof=? WHERE email='other-lane@fixture.invalid'",
            (
                json.dumps(
                    {
                        "ok": False,
                        "checkedAt": campaign_data.stamp(T - timedelta(days=2)),
                    }
                ),
            ),
        )
        _ = self.db.execute(
            "UPDATE candidates SET proof=? WHERE email='failed@fixture.invalid'",
            (
                json.dumps(
                    {
                        "ok": False,
                        "checkedAt": campaign_data.stamp(T - timedelta(days=2)),
                    }
                ),
            ),
        )
        _ = self.db.commit()
        seen: list[str] = []

        def refresh(item: data_types.JsonObject, t: datetime) -> data_types.JsonObject:
            email_value = item.get("email")
            if not isinstance(email_value, str):
                raise TypeError("research fixture contact email is missing")
            _ = seen.append(email_value)
            return {
                "ok": False,
                "checkedAt": campaign_data.stamp(t),
                "reason": "still_unproven",
            }

        with patch.object(prospecting, "refresh_proof", side_effect=refresh):
            _ = e.research(self.db, T, batch=10, lane="pme")
        self.assertEqual(seen, ["failed@fixture.invalid"])

    def test_operator_holds_and_hdf_pause_are_not_lifted_for_queue_volume(self):
        _ = self.legacy(state="operator_legacy_hold")
        self.assertEqual(self.audit()["checked"], 0)
        _ = self.db.execute(
            "UPDATE legacy SET state='sent',campaign='robinswood-pme-hdf-dirigeants-2026-06'"
        )
        _ = self.db.commit()
        self.assertEqual(self.audit()["checked"], 0)
        self.assertIsNone(q.historical_parent(self.db, "editor@fixture.invalid"))

    def test_legacy_original_without_custom_headers_is_verified_by_canonical_effect(
        self,
    ):
        row, message = self.legacy()
        result = self.audit()
        self.assertEqual(result["eligible"], 1)
        email = self.row_text(row, "email")
        parent = q.historical_parent(self.db, email)
        if parent is None:
            raise AssertionError("historical parent should be verifiable")
        self.assertTrue(q.validate_parent(message, parent))
        self.assertEqual(self.scalar_int("SELECT count(*) FROM touches"), 0)
        self.assertEqual(self.scalar_text("SELECT state FROM legacy"), "sent")

    def test_sent_original_copy_containing_no_thanks_is_still_verified(self):
        _row, message = self.legacy()
        self.body_of(message)["data"] = base64.urlsafe_b64encode(
            b"No thanks, we do not need an agenda."
        ).decode()
        self.assertEqual(self.audit()["eligible"], 1)

    def test_wrong_original_sender_recipient_missing_body_and_suppression_hold(self):
        for change in ["sender", "recipient", "body", "suppression", "incoming", "cc"]:
            with self.subTest(change=change):
                _ = self.db.execute("DELETE FROM legacy")
                _ = self.db.execute("DELETE FROM historical_threads")
                _ = self.db.commit()
                row, message = self.legacy()
                blocked: set[str] = set()
                if change == "suppression":
                    blocked = {self.row_text(row, "email")}
                elif change == "body":
                    self.body_of(message)["data"] = ""
                else:
                    next(
                        h
                        for h in self.headers_of(message)
                        if h["name"] == ("From" if change == "sender" else "To")
                    )["value"] = "other@fixture.invalid"
                self.assertEqual(
                    q.audit_historical(
                        self.db,
                        self.g,
                        "presse",
                        T,
                        blocked,
                        campaign_data.business_days,
                        self.cfg,
                    )["eligible"],
                    0,
                )

    def test_existing_thread_reply_or_later_touch_stops_legacy_followup(self):
        _row, message = self.legacy()
        other = copy.deepcopy(message)
        other["id"] = "later"
        self.g.messages["later"] = other
        self.assertEqual(self.audit()["eligible"], 0)

    def test_legacy_followup_due_before_new_cold_contact_and_sent_once_in_original_thread(
        self,
    ):
        row, parent = self.legacy()
        _ = self.audit()
        _ = self.candidate("aaa-new@fixture.invalid", company="Other")
        result = self.runit()
        self.assertEqual(result["status"], "sent_verified")
        effect = required_row(self.db.execute("SELECT * FROM touches"))
        self.assertEqual(self.row_text(effect, "email"), self.row_text(row, "email"))
        self.assertEqual(self.row_text(effect, "step"), "followup")
        self.assertEqual(
            self.row_text(effect, "subject"), guard.header(parent, "Subject")
        )
        self.assertEqual(self.row_text(effect, "thread"), "original-thread")
        self.assertEqual(pilot.touch_identity(effect), (pilot.PRIMARY, "legacy"))
        self.assertEqual(self.g.posts, 1)
        _ = self.runit()
        self.assertEqual(self.g.posts, 1)
        self.assertEqual(
            data_types.data_json_object_or_empty(
                data_types.data_json_object_or_empty(
                    e.learning(self.db, "presse", T + timedelta(days=14), self.c).get(
                        "variants"
                    )
                ).get("A")
            ).get("matured"),
            0,
        )

    def test_new_reply_between_audit_and_send_blocks_before_post(self):
        _row, parent = self.legacy()
        _ = self.audit()
        other = copy.deepcopy(parent)
        other["id"] = "reply"
        self.g.messages["reply"] = other
        self.assertEqual(self.runit()["status"], "historical_followup_held")
        self.assertEqual(self.g.posts, 0)
        self.assertEqual(self.scalar_int("select count(*) from touches"), 0)

    def test_original_effect_mutation_after_audit_is_rejected_before_post(self):
        _row, parent = self.legacy()
        _ = self.audit()
        self.body_of(parent)["data"] = base64.urlsafe_b64encode(
            b"Mutated original"
        ).decode()
        self.assertEqual(self.runit()["status"], "historical_followup_held")
        self.assertEqual(self.g.posts, 0)

    def test_legacy_lost_response_reconciles_without_repeating_or_resetting_history(
        self,
    ):
        _ = self.legacy()
        _ = self.audit()
        self.g.fail_after_post = True
        with self.assertRaises(TimeoutError):
            _ = self.runit()
        self.g.fail_after_post = False
        _ = self.runit()
        self.assertEqual(self.g.posts, 1)
        self.assertEqual(self.scalar_int("select count(*) from legacy"), 1)
        self.assertEqual(self.scalar_text("select state from touches"), "verified")

    def test_expired_proof_does_not_make_old_contact_ready(self):
        _row, _ = self.legacy()
        _ = self.audit()
        _ = self.db.execute(
            "UPDATE candidates SET proof=?",
            (
                json.dumps(
                    {
                        "ok": True,
                        "checkedAt": campaign_data.stamp(T - timedelta(days=8)),
                    }
                ),
            ),
        )
        _ = self.db.commit()
        with patch.object(e, "suppressed", return_value=set()):
            self.assertIsNone(e.next_item(self.db, "presse", T, self.c))
        coverage = q.coverage(
            self.db,
            "presse",
            T,
            self.c,
            e.audience_counts(self.db, "presse", T, self.c),
            self.cfg,
        )
        if coverage is None:
            raise AssertionError("coverage report is required")
        self.assertEqual(coverage.get("followupsDueBeforeFreshChecks"), 0)

    def test_additive_snapshot_keeps_history_and_original_touch_schema(self):
        backup_value = self.scalar_text(
            "SELECT value FROM metadata WHERE key='historical_queue_schema_backup'"
        )
        backup = Path(backup_value)
        original: sqlite3.Connection = sqlite3.connect(backup)
        try:
            self.assertTrue(table_exists(original, "sender_bindings"))
            self.assertFalse(table_exists(original, "historical_threads"))
        finally:
            original.close()
        self.assertEqual(
            len(self.db.execute("pragma table_info(touches)").fetchall()), 14
        )




def load_tests(
    loader: unittest.TestLoader,
    tests: unittest.TestSuite,
    pattern: str | None,
) -> unittest.TestSuite:
    _ = pattern
    from evergreen_queue_continuity_additional_tests import AdditionalQueueTests

    _ = tests.addTests(loader.loadTestsFromTestCase(AdditionalQueueTests))
    return tests


def tearDownModule() -> None:
    evergreen_offline_test_guard.assert_no_external_attempts()
