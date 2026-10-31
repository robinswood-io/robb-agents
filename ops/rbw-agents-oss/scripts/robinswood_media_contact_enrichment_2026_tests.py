"""Offline tests for media-contact enrichment contracts and fail-closed outcomes."""

from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta, tzinfo
from typing import override
from unittest.mock import patch

import evergreen_offline_test_guard
import requests
import robinswood_media_contact_enrichment_2026 as enrichment
import robinswood_media_contact_enrichment_service as service
from robinswood_media_contact_enrichment_types import (
    EnrichedCandidate,
    JsonObject,
    WikiEnrichment,
)


class FakeResponse:
    status_code: int = 200
    text: str = ""

    def json(self) -> object:
        return {"data": {"result": "deliverable", "score": 97, "smtp_check": True}}

    def raise_for_status(self) -> None:
        return None


class MediaContactEnrichmentTests(unittest.TestCase):
    def test_domain_filter_rejects_platform_subdomains(self) -> None:
        self.assertFalse(enrichment.domain_allowed("news.linkedin.com"))
        self.assertFalse(enrichment.domain_allowed("gmail.com"))
        self.assertTrue(enrichment.domain_allowed("local-news.example"))
        self.assertEqual(
            enrichment.domain_from_url("https://www.example.org/story"), "example.org"
        )

    def test_domain_helpers_preserve_empty_input_behavior(self) -> None:
        self.assertFalse(enrichment.domain_allowed(None))
        self.assertEqual(enrichment.split_name(None), (None, None))

    def test_domain_policies_match_the_preserved_snapshot(self) -> None:
        self.assertSetEqual(
            enrichment.EXCLUDED_DOMAINS,
            {
                "babelio.com",
                "bnf.fr",
                "data.bnf.fr",
                "facebook.com",
                "google.com",
                "imdb.com",
                "instagram.com",
                "linkedin.com",
                "twitter.com",
                "viaf.org",
                "wikimedia.org",
                "wikipedia.org",
                "worldcat.org",
                "x.com",
                "youtube.com",
            },
        )
        self.assertSetEqual(
            enrichment.WEBMAIL,
            {
                "free.fr",
                "gmail.com",
                "hotmail.com",
                "icloud.com",
                "orange.fr",
                "outlook.com",
                "proton.me",
                "protonmail.com",
                "wanadoo.fr",
                "yahoo.com",
            },
        )

    def test_recent_email_verification_and_suppression_are_skipped(self) -> None:
        recent: EnrichedCandidate = {
            "recordType": "email_contact",
            "email": "press@example.org",
            "emailVerification": {"checkedAt": "2026-10-29T10:00:00Z"},
        }
        suppressed: EnrichedCandidate = {"outreachStatus": "not_eligible_suppressed"}
        legacy_hold: EnrichedCandidate = {
            "outreachStatus": "not_eligible_legacy_pr_hold"
        }
        self.assertFalse(enrichment.eligible_for_processing(recent))
        self.assertFalse(enrichment.eligible_for_processing(suppressed))
        self.assertFalse(enrichment.eligible_for_processing(legacy_hold))

    def test_email_verification_freshness_boundary_is_seven_days(self) -> None:
        fixed_now = datetime(2026, 10, 30, 12, tzinfo=UTC)

        class FrozenDateTime(datetime):
            @override
            @classmethod
            def now(cls, tz: tzinfo | None = None) -> datetime:
                return fixed_now if tz is None else fixed_now.astimezone(tz)

        cases = (
            (timedelta(days=6, hours=23), False),
            (timedelta(days=7), True),
            (timedelta(days=8), True),
        )
        with patch.object(service, "datetime", FrozenDateTime):
            for age, eligible in cases:
                row: EnrichedCandidate = {
                    "recordType": "email_contact",
                    "email": "press@example.org",
                    "emailVerification": {
                        "checkedAt": (fixed_now - age)
                        .isoformat()
                        .replace("+00:00", "Z"),
                    },
                }
                with self.subTest(age=age):
                    self.assertEqual(enrichment.eligible_for_processing(row), eligible)

    def test_verification_candidate_stays_review_only(self) -> None:
        row: EnrichedCandidate = {
            "id": "synthetic-email-1",
            "recordType": "email_contact",
            "email": "press@example.org",
            "outreachEligible": True,
        }
        response: JsonObject = {
            "statusCode": 200,
            "body": {
                "data": {
                    "result": "deliverable",
                    "score": 97,
                    "smtp_check": True,
                    "accept_all": False,
                    "block": False,
                }
            },
        }
        with patch.object(service, "verify_email", return_value=response) as verify:
            outcome, remaining, event = enrichment.row_outcome(row, "fake-key", 2)
        verify.assert_called_once_with("fake-key", "press@example.org")
        self.assertEqual(remaining, 1)
        self.assertEqual(event["hunterCalls"], 1)
        self.assertEqual(
            outcome.get("enrichmentStatus"), "email_verified_review_required"
        )
        self.assertIs(outcome.get("outreachEligible"), False)

    def test_missing_verification_flags_remain_unknown_and_fail_closed(self) -> None:
        row: EnrichedCandidate = {
            "recordType": "email_contact",
            "email": "press@example.org",
        }
        response: JsonObject = {
            "statusCode": 200,
            "body": {"data": {"result": "deliverable", "score": 97}},
        }
        with patch.object(service, "verify_email", return_value=response):
            outcome, _, _ = enrichment.row_outcome(row, "fake-key", 1)
        verification = outcome.get("emailVerification")
        if verification is None:
            raise AssertionError("verification metadata must be present")
        self.assertIsNone(verification.get("smtpCheck"))
        self.assertIsNone(verification.get("acceptAll"))
        self.assertEqual(
            outcome.get("enrichmentStatus"), "email_not_verified_review_or_replace"
        )
        self.assertIs(outcome.get("outreachEligible"), False)

    def test_profile_candidate_requires_domain_match_and_manual_review(self) -> None:
        row: EnrichedCandidate = {
            "id": "synthetic-profile-1",
            "recordType": "profile",
            "contactName": "Ada Example",
            "outreachEligible": True,
        }
        wiki: WikiEnrichment = {
            "ok": True,
            "extract": "Synthetic public bio.",
            "externalLinks": [
                {"url": "https://example.org/about", "domain": "example.org"}
            ],
        }
        found: JsonObject = {
            "body": {"data": {"email": "ada@example.org", "score": 80}},
            "statusCode": 200,
        }
        with (
            patch.object(service, "wiki_enrich", return_value=wiki),
            patch.object(service, "email_finder", return_value=found) as finder,
        ):
            outcome, remaining, event = enrichment.row_outcome(row, "fake-key", 1)
        finder.assert_called_once_with("fake-key", "example.org", "Ada", "Example")
        self.assertEqual(remaining, 0)
        self.assertEqual(event["hunterCalls"], 1)
        self.assertEqual(outcome.get("enrichedEmail"), "ada@example.org")
        self.assertEqual(
            outcome.get("enrichmentStatus"), "candidate_email_found_review_required"
        )
        self.assertIs(outcome.get("outreachEligible"), False)

    def test_hunter_http_boundary_is_fully_stubbed(self) -> None:
        with patch.object(requests, "get", return_value=FakeResponse()) as get:
            result = enrichment.hunter("email-verifier", {"email": "press@example.org"})
        get.assert_called_once()
        self.assertIs(result["ok"], True)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(
            result["body"],
            {"data": {"result": "deliverable", "score": 97, "smtp_check": True}},
        )

    @classmethod
    @override
    def tearDownClass(cls) -> None:
        super().tearDownClass()
        evergreen_offline_test_guard.assert_no_external_attempts()


if __name__ == "__main__":
    _ = unittest.main()
