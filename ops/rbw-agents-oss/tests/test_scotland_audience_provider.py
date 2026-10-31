"""Offline provider contract tests: approvals, reserves and whole-run limits."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import override
from unittest.mock import patch

import evergreen_offline_test_guard as guard
import scotland_conference_audience as audience
from scotland_audience_types import JsonObject, obj

COMPANY: JsonObject = {
    "name": "QA Scotland", "companyType": "privately held",
    "metrics": {"employeesCount": 40},
    "geo": {"countryCode": "GB", "stateCode": "GB-SCT", "city": "Edinburgh"},
}

def person(domain: str) -> JsonObject:
    return {
        "value": "alex@" + domain, "first_name": "Alex", "last_name": "QA",
        "position": "CEO", "source_type": "found", "sources": [{"uri": "https://" + domain}],
    }

class AudienceProviderTests(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.root: Path = Path(".")
        self.verified: list[str] = []
        self.searches: int = 20
        self.verifications: int = 10

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        _ = self.enterContext(patch.object(audience, "ROOT", self.root))
        _ = self.enterContext(patch.object(audience, "cache", side_effect=self.provider))
        _ = self.enterContext(patch.object(audience, "call", side_effect=self.account))
        _ = self.enterContext(patch("scotland_conference_audience.time.sleep"))
        audience.save(self.root / "campaign-contract.json", {
            "providerTransfer": {"hunterAuthorized": True, "maxContacts": 300},
        })
        audience.save(self.root / "hunter-discovery-page-0.json", {"filters": {}})

    def account(self, endpoint: str, params: JsonObject) -> JsonObject:
        self.assertEqual(endpoint, "account")
        self.assertEqual(params, {})
        return {"body": {"data": {"requests": {
            "searches": {"remaining": self.searches},
            "verifications": {"remaining": self.verifications},
        }}}}

    def provider(self, endpoint: str, params: JsonObject, post: JsonObject | None = None) -> JsonObject:
        if endpoint == "discover":
            return {"ok": True, "body": {"data": [
                {"domain": "first.example", "organization": "QA First"},
                {"domain": "second.example", "organization": "QA Second"},
            ] if post is not None and post.get("offset") == 0 else []}}
        if endpoint == "companies/find":
            return {"body": {"data": COMPANY}}
        if endpoint == "domain-search":
            domain = params["domain"]
            self.assertIsInstance(domain, str)
            if not isinstance(domain, str):
                raise TypeError("fixture requires a domain")
            return obj({"checkedAt": audience.stamp(), "body": {"data": {"emails": [person(domain)]}}})
        if endpoint == "email-verifier":
            email = params["email"]
            if not isinstance(email, str):
                raise TypeError("fixture requires an address")
            self.verified.append(email)
            return {"ok": True, "checkedAt": audience.stamp(), "body": {"data": {
                "result": "deliverable", "status": "valid", "score": 90, "accept_all": False,
            }}}
        raise AssertionError("unexpected provider endpoint: " + endpoint)

    def test_complete_preparation_stops_at_target_across_company_batch(self) -> None:
        counts = audience.run(1)
        self.assertEqual(counts["verifiedAddresses"], 1)
        self.assertEqual(self.verified, ["alex@first.example"])
        state = audience.state_read()
        self.assertEqual(state["items"][0]["email"], "alex@first.example")
        self.assertEqual(state["items"][0].get("roleCheckedAt"), None)
        self.assertEqual(state["items"][0].get("qualification"),
                         "provider_candidate_requires_current_public_role_and_legal_evidence")
        self.assertEqual(audience.run(1), counts)
        self.assertEqual(len(self.verified), 1)

    def test_approval_and_authorized_target_fail_before_provider_access(self) -> None:
        for authorized, target in [(False, 1), (True, 301)]:
            audience.save(self.root / "campaign-contract.json", {
                "providerTransfer": {"hunterAuthorized": authorized, "maxContacts": 300},
            })
            with patch.object(audience, "call") as call, patch.object(audience, "cache") as cache:
                for operation in [audience.run, audience.verify_cached]:
                    with self.assertRaises(RuntimeError):
                        _ = operation(target)
                call.assert_not_called()
                cache.assert_not_called()

    def test_credit_reserve_is_checked_before_company_verification(self) -> None:
        for searches, verifications in [(19, 10), (20, 9)]:
            self.searches, self.verifications = searches, verifications
            with self.subTest(searches=searches, verifications=verifications):
                counts = audience.run(2)
                self.assertEqual(counts["verifiedAddresses"], 0)
                self.assertEqual(self.verified, [])
                self.assertEqual(audience.state_read().get("stopReason"), "existing_credit_reserve_reached")

    def test_request_cap_is_global_across_company_batch(self) -> None:
        audience.save(self.root / "audience-preparation.json", {
            "items": [], "companies": {},
            "verifications": {f"prior-{i}@fixture.invalid": {"qa": True} for i in range(499)},
        })
        counts = audience.run(2)
        self.assertEqual(counts["verificationRequests"], 500)
        self.assertEqual(len(self.verified), 1)
        self.assertEqual(audience.state_read().get("stopReason"), "authorized_verification_bound_reached")
        with patch.object(audience, "call") as call, patch.object(audience, "cache") as cache:
            self.assertEqual(audience.verify_cached(2)["verificationRequests"], 500)
            self.assertEqual(audience.run(2)["verificationRequests"], 500)
            call.assert_not_called()
            cache.assert_not_called()

    def test_cached_preparation_keeps_verified_identity_and_stops_at_target(self) -> None:
        audience.save(self.root / "audience-preparation.json", {
            "items": [], "companies": {"first.example": {"domain": "first.example", "company": COMPANY}},
            "verifications": {},
        })
        audience.save(self.root / "hunter-cache" / "domain.json", {
            "checkedAt": audience.stamp(), "body": {"data": {
                "domain": "first.example", "emails": [person("first.example")],
            }},
        })
        result = audience.verify_cached(1)
        self.assertEqual(result["verifiedAddresses"], 1)
        self.assertEqual(self.verified, ["alex@first.example"])
        self.assertEqual(audience.verify_cached(1), result)
        self.assertEqual(len(self.verified), 1)


def tearDownModule() -> None:
    guard.assert_no_external_attempts()
