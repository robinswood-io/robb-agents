"""Offline queue continuity scenarios; no real external access."""

from __future__ import annotations

import base64
import copy
import json
from datetime import timedelta
from typing import final
from unittest.mock import patch

import evergreen_offline_test_guard

# isort: split

import evergreen_campaign_data as campaign_data
import evergreen_campaign_data_types as data_types
import evergreen_campaign_prospecting as prospecting
import evergreen_queue_continuity as q
import evergreen_sender_pilot as pilot
import robinswood_evergreen_france as e
import robinswood_evergreen_france_tests as fixture
from evergreen_queue_continuity_test_support import QueueHarness, T, required_rows


@final
class AdditionalQueueTests(QueueHarness):
    def test_replies_to_legacy_followup_are_scanned_and_do_not_become_fake_bookings(
        self,
    ):
        row, _parent = self.legacy()
        _ = self.audit()
        _ = self.runit()
        incoming = fixture.message(
            fixture.raw("incoming", lane="presse", email=pilot.PRIMARY),
            "incoming",
            "original-thread",
            T + timedelta(hours=1),
        )
        incoming["labelIds"] = []
        next(h for h in self.headers_of(incoming) if h["name"] == "From")["value"] = (
            row["email"]
        )
        self.body_of(incoming)["data"] = base64.urlsafe_b64encode(
            "Merci, pouvez-vous envoyer une note d’angle pour notre article ?".encode()
        ).decode()
        self.g.messages["incoming"] = incoming
        with patch.object(e, "suppress"):
            self.assertEqual(
                e.reply_scan(self.db, self.g, "presse", T + timedelta(hours=1)), 1
            )
        self.assertEqual(
            self.scalar_text("select kind from replies"),
            "editorial_request",
        )
        self.assertFalse(
            e.learning(self.db, "presse", T + timedelta(days=14), self.c)[
                "bookingsInferred"
            ]
        )

    def test_immutable_other_sender_assignment_holds_historical_company(self):
        row, _ = self.legacy()
        _ = self.audit()
        _ = pilot.bind(self.db, row, pilot.ROBB, pilot.VERSION, T)
        self.assertEqual(
            pilot.plan(self.db, row, "followup", self.c, T, {"dailyCap": 10}),
            (None, None),
        )

    def test_historical_batch_paginates_by_rowid_without_duplicates(self):
        emails = [
            "first@fixture.invalid",
            "second@fixture.invalid",
            "third@fixture.invalid",
        ]
        for index, email in enumerate(emails):
            _ = self.legacy(email=email, message_id=f"legacy-{index}")
        first = self.audit()
        self.assertEqual(first["checked"], 2)
        self.assertEqual(
            [
                self.row_text(row, "email")
                for row in required_rows(
                    self.db.execute(
                        "SELECT email FROM historical_threads ORDER BY rowid"
                    )
                )
            ],
            emails[:2],
        )
        self.assertEqual(self.audit()["checked"], 1)
        self.assertEqual(self.audit()["checked"], 0)

    def test_transient_history_read_retries_after_bounded_backoff(self):
        _row, _ = self.legacy()
        with patch.object(self.g, "get", side_effect=TimeoutError):
            self.assertEqual(self.audit()["held"], 1)
        self.assertEqual(self.audit()["checked"], 0)
        self.assertEqual(
            q.audit_historical(
                self.db,
                self.g,
                "presse",
                T + timedelta(hours=23),
                set(),
                campaign_data.business_days,
                self.cfg,
            )["checked"],
            0,
        )
        self.assertEqual(
            q.audit_historical(
                self.db,
                self.g,
                "presse",
                T + timedelta(hours=24),
                set(),
                campaign_data.business_days,
                self.cfg,
            )["checked"],
            0,
        )
        retry = q.audit_historical(
            self.db,
            self.g,
            "presse",
            T + timedelta(hours=25),
            set(),
            campaign_data.business_days,
            self.cfg,
        )
        self.assertEqual(retry["eligible"], 1)

    def test_changed_old_thread_does_not_starve_next_eligible_new_contact(self):
        _row, parent = self.legacy()
        _ = self.audit()
        _ = self.candidate("aaa-new@fixture.invalid", company="Other")
        other = copy.deepcopy(parent)
        other["id"] = "later"
        self.g.messages["later"] = other
        self.assertEqual(self.runit()["status"], "historical_followup_held")
        self.assertEqual(self.runit()["status"], "sent_verified")
        self.assertEqual(self.g.posts, 1)
        self.assertEqual(
            self.scalar_text("SELECT email FROM touches"),
            "aaa-new@fixture.invalid",
        )

    def test_old_optout_suppresses_globally_without_resetting_or_contaminating_new_metrics(
        self,
    ):
        row, parent = self.legacy()
        incoming = copy.deepcopy(parent)
        incoming["id"] = "old-optout"
        incoming["labelIds"] = []
        next(h for h in self.headers_of(incoming) if h["name"] == "From")["value"] = (
            row["email"]
        )
        self.body_of(incoming)["data"] = base64.urlsafe_b64encode(
            b"STOP, ne plus me contacter"
        ).decode()
        self.g.messages["old-optout"] = incoming
        with patch.object(e, "suppress") as suppress:
            _ = q.audit_historical(
                self.db,
                self.g,
                "presse",
                T,
                set(),
                campaign_data.business_days,
                self.cfg,
                e.observe_historical_negative,
            )
            suppress.assert_called_once_with(row["email"], "opposition", "old-optout")
        self.assertEqual(self.scalar_int("SELECT count(*) FROM replies"), 0)
        self.assertEqual(self.scalar_text("SELECT state FROM legacy"), "sent")

    def test_discovery_is_lane_specific_and_search_terms_come_from_public_registry(
        self,
    ):
        for siren, category in [("111111111", "PME"), ("222222222", "ETI")]:
            payload = {
                "nom_complet": "Private renamed label",
                "sourceUrl": "https://recherche-entreprises.api.gouv.fr/search?categorie_entreprise="
                + category
                + "&page=1",
                "categorie_entreprise": category,
                "leaders": [{"nom": "Martin", "prenoms": "Alice"}],
            }
            _ = self.db.execute(
                "INSERT INTO research VALUES(?,?,?,?)",
                (
                    siren,
                    json.dumps(payload),
                    campaign_data.stamp(T - timedelta(days=2)),
                    "needs_official_domain_and_exact_contact",
                ),
            )
        _ = self.db.commit()
        urls: list[str] = []

        def fetch(url: str) -> tuple[str, str]:
            _ = urls.append(url)
            if "api.gouv.fr" in url:
                return json.dumps(
                    {
                        "results": [
                            {
                                "siren": "111111111",
                                "nom_complet": "Public Registry Company",
                                "statut_diffusion": "O",
                            }
                        ]
                    }
                ), url
            return '<a href="https://fixture.invalid/">Official</a>', url

        def page(url: str) -> data_types.JsonObject:
            return data_types.data_json_object(
                data_types.JSON_ADAPTER.validate_python(
                    {
                        "url": url,
                        "text": "SIREN 111111111 Public Registry Company Alice Martin",
                        "sha256": "x",
                        "emails": ["alice.martin@fixture.invalid"],
                        "contactLinks": [],
                    }
                )
            )

        with patch.object(prospecting, "fetch", side_effect=fetch):
            result = e.discover_company(
                self.db, T, fetch_page=page, lane="pme", retry_hours=24
            )
        self.assertEqual(result["addedContacts"], 1)
        self.assertTrue(any("Public+Registry+Company" in url for url in urls))
        self.assertFalse(any("Private" in url for url in urls))
        self.assertEqual(
            self.db.execute(
                "SELECT reason FROM research WHERE siren='222222222'"
            ).fetchone()[0],
            "needs_official_domain_and_exact_contact",
        )

    def test_later_manual_outbound_in_another_thread_holds_historical_audit(self):
        _row, parent = self.legacy()
        later = copy.deepcopy(parent)
        _ = later.update(
            id="manual-later",
            threadId="new-manual-thread",
            internalDate=str(int(T.timestamp() * 1000)),
        )
        self.g.messages["manual-later"] = later
        self.assertEqual(self.audit()["eligible"], 0)
        self.assertEqual(self.g.posts, 0)

    def test_later_separate_thread_outbound_after_audit_blocks_before_post(self):
        _row, parent = self.legacy()
        _ = self.audit()
        later = copy.deepcopy(parent)
        _ = later.update(
            id="manual-later",
            threadId="new-manual-thread",
            internalDate=str(int(T.timestamp() * 1000)),
        )
        self.g.messages["manual-later"] = later
        self.assertEqual(self.runit()["status"], "historical_followup_held")
        self.assertEqual(self.g.posts, 0)

    def test_completed_discovery_is_not_counted_as_pending_refill_work(self):
        for i, reason in enumerate(
            [
                "needs_official_domain_and_exact_contact",
                "official_domain_or_public_executive_email_not_found",
                "public_exact_contacts_discovered",
            ]
        ):
            _ = self.db.execute(
                "INSERT INTO research VALUES(?,?,?,?)",
                (
                    str(i),
                    json.dumps({"categorie_entreprise": "PME"}),
                    campaign_data.stamp(T - timedelta(days=8 if i < 2 else 2)),
                    reason,
                ),
            )
        _ = self.db.commit()
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
        self.assertEqual(state.get("researchReserve"), 2)


def tearDownModule() -> None:
    evergreen_offline_test_guard.assert_no_external_attempts()
