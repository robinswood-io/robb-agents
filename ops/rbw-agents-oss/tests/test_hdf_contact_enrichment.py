"""Prepare-only contact enrichment on QA records with both providers mocked."""
from __future__ import annotations

import io
import tempfile
import time
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import robinswood_pme_hdf_hunter_contact_enrichment as enrichment


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def paths(stack: ExitStack, root: Path) -> None:
    for name in ["INPUT", "OUT", "OUT_MD", "LEDGER"]:
        _ = stack.enter_context(patch.object(enrichment, name, root / (name.lower() + ".json")))
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    _ = stack.enter_context(patch.object(time, "sleep"))


def account(index: int) -> enrichment.Row:
    return {"accountName": f"QA {index}", "verifiedDomain": "example.org",
            "officialLeaderFromRegistry": "Alex Exemple — Dirigeant", "sourceUrls": []}


class ContactEnrichmentTests(unittest.TestCase):
    def test_candidate_thresholds_never_authorize_send(self) -> None:
        finder: enrichment.Row = {"body": {"data": {"email": "qa@example.org", "score": 0}}}
        cases = [("valid", 0, False, "verified_candidate_needs_quality_gate"),
                 ("unknown", 85, False, "verified_candidate_needs_quality_gate"),
                 ("unknown", 84, False, "email_found_but_not_verified_enough"),
                 ("unknown", 65, True, "accept_all_candidate_needs_quality_gate"),
                 ("unknown", 64, True, "email_found_but_not_verified_enough")]
        for result, score, accept_all, expected in cases:
            with self.subTest(score=score, result=result):
                verification: enrichment.Row = {"body": {"data": {"result": result, "score": score, "accept_all": accept_all}}}
                self.assertEqual(enrichment.verdict(finder, verification), expected)
        self.assertEqual(enrichment.verdict({}, None), "no_email_found")

    def test_leader_parsing_preserves_historical_names(self) -> None:
        self.assertEqual(enrichment.parse_leader("ALEX EXEMPLE (Président) — Dirigeant"), ("Alex", "Exemple", "ALEX EXEMPLE"))
        self.assertEqual(enrichment.parse_leader("Solo"), (None, None, "Solo"))

    def test_complete_preparation_stops_at_four_and_persists_results(self) -> None:
        calls: list[str] = []
        def provider(path: str, params: dict[str, str | int | None], timeout: int = 14, campaign: str | None = None) -> enrichment.Row:
            _ = params, timeout, campaign
            calls.append(path)
            data: enrichment.Row = {"email": "qa@example.org", "score": 100, "sources": [], "linkedin": "https://example.org/qa"} if path == "email-finder" else {"result": "valid", "score": 100, "accept_all": False}
            return {"ok": True, "statusCode": 200, "body": {"data": data}}
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = stack.enter_context(patch.object(enrichment, "load_key", return_value="qa-key"))
            _ = stack.enter_context(patch.object(enrichment, "hunter_get", side_effect=provider))
            enrichment.write_json(enrichment.INPUT, {"accounts": [account(i) for i in range(6)]})
            self.assertEqual(enrichment.main(), 0)
            report = enrichment.read_json(enrichment.OUT, {})
            counts = enrichment.object_row(report["counts"])
            self.assertEqual(counts, {"accountsReviewed": 4, "verifiedCandidates": 4, "readyForOutbound": 0, "hunterRequestsApprox": 8, "errors": 0})
            self.assertIs(report["externalSendAllowed"], False)
            self.assertIs(report["humanApprovalRequiredBeforeOutbound"], True)
            self.assertEqual(calls, ["email-finder", "email-verifier"] * 4)
            self.assertEqual(len(enrichment.LEDGER.read_text().splitlines()), 1)
            self.assertIn("contact_quality_gate ok", enrichment.OUT_MD.read_text())

    def test_domain_fallback_produces_only_a_contact_signal(self) -> None:
        def provider(path: str, params: dict[str, str | int | None], timeout: int = 14, campaign: str | None = None) -> enrichment.Row:
            _ = params, timeout, campaign
            data: enrichment.Row = {} if path == "email-finder" else {"emails": [{"last_name": "Exemple", "linkedin_url": "https://example.org/person"}]}
            return {"ok": True, "statusCode": 200, "body": {"data": data}}
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = stack.enter_context(patch.object(enrichment, "load_key", return_value="qa-key"))
            _ = stack.enter_context(patch.object(enrichment, "hunter_get", side_effect=provider))
            enrichment.write_json(enrichment.INPUT, {"accounts": [account(1)]})
            self.assertEqual(enrichment.main(), 0)
            row = enrichment.object_rows(enrichment.read_json(enrichment.OUT, {})["results"])[0]
            self.assertEqual(row["hunterVerdict"], "no_email_found")
            self.assertEqual(row["linkedinSignal"], "https://example.org/person")
            self.assertIs(row["externalSendAllowed"], False)

    def test_missing_key_records_degraded_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = stack.enter_context(patch.object(enrichment, "load_key", return_value=None))
            self.assertEqual(enrichment.main(), 0)
            report = enrichment.read_json(enrichment.OUT, {})
            self.assertEqual(report["status"], "dependency_degraded")
            self.assertEqual(report["blockingReasons"], ["hunter_key_missing"])
            self.assertFalse(enrichment.LEDGER.exists())

    def test_request_error_never_persists_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = stack.enter_context(patch.object(enrichment, "load_key", return_value="qa-key"))
            _ = stack.enter_context(patch.object(enrichment, "hunter_get", side_effect=OSError("https://example.org/?api_key=private-qa-token")))
            enrichment.write_json(enrichment.INPUT, {"accounts": [account(1)]})
            self.assertEqual(enrichment.main(), 0)
            report = enrichment.read_json(enrichment.OUT, {})
            error = enrichment.object_rows(report["errors"])[0]
            self.assertEqual(error["error"], "OSError")
            self.assertNotIn("private-qa-token", enrichment.OUT.read_text())

    def test_corrupt_input_is_rejected_without_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            paths(stack, Path(temp))
            _ = stack.enter_context(patch.object(enrichment, "load_key", return_value="qa-key"))
            _ = enrichment.INPUT.write_text("{broken")
            with self.assertRaises(ValueError):
                _ = enrichment.main()
            self.assertFalse(enrichment.OUT.exists())
