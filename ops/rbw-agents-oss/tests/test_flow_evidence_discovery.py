"""Full contact-evidence runs use temporary state and mocked read-only providers."""

from __future__ import annotations

import io
import subprocess
import tempfile
import time
import unittest
from contextlib import ExitStack, nullcontext, redirect_stdout
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_contact_evidence_provider as provider
import flow_contact_evidence_state as state
import robinswood_flow_contact_evidence_discovery as discovery


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def account(key: str = "qa") -> state.Row:
    return {
        "key": key,
        "name": "QA Example",
        "sponsor": "Alex Example",
        "role": "CEO",
        "domain": "example.org",
        "sources": [],
    }


def fixture_paths(stack: ExitStack, root: Path) -> None:
    _ = stack.enter_context(patch.object(discovery, "OPS", root))
    for name in ["REG", "INBOX", "OUT", "STATE", "LEDGER", "ESC", "QP"]:
        _ = stack.enter_context(
            patch.object(discovery, name, root / (name.lower() + ".json"))
        )
    _ = stack.enter_context(redirect_stdout(io.StringIO()))
    _ = stack.enter_context(patch.object(time, "sleep"))
    _ = stack.enter_context(
        patch.object(discovery, "chain_lock", return_value=nullcontext(True))
    )


def providers(stack: ExitStack) -> None:
    _ = stack.enter_context(patch.object(discovery, "load_key", return_value="qa-key"))
    _ = stack.enter_context(
        patch.object(discovery, "capacity", return_value={"ok": True, "allowed": True})
    )
    _ = stack.enter_context(
        patch.object(
            provider,
            "public_company",
            return_value={"ok": True, "url": "https://example.org"},
        )
    )
    _ = stack.enter_context(
        patch.object(
            provider,
            "email_finder",
            return_value={
                "ok": True,
                "statusCode": 200,
                "body": {
                    "data": {
                        "email": "qa@example.org",
                        "score": 100,
                        "position": "CEO",
                        "linkedin": "https://example.org/alex",
                        "sources": ["https://example.org/team"],
                    }
                },
            },
        )
    )
    _ = stack.enter_context(
        patch.object(
            provider,
            "verify_email",
            return_value={
                "ok": True,
                "statusCode": 200,
                "body": {"data": {"result": "valid", "score": 100}},
            },
        )
    )


class EvidenceDiscoveryTests(unittest.TestCase):
    def test_complete_run_preserves_manual_evidence_and_reuses_same_day(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture_paths(stack, Path(temp))
            providers(stack)
            _ = stack.enter_context(
                patch.object(
                    discovery, "gate", return_value={"ok": True, "returnCode": 0}
                )
            )
            discovery.save(
                discovery.REG, {"accounts": [account(), account("yousign-youtrust")]}
            )
            discovery.save(
                discovery.INBOX,
                {"items": [{"accountKey": "manual", "source": "human", "proof": "qa"}]},
            )
            self.assertEqual(discovery.main([]), 0)
            report = discovery.load(discovery.OUT, {})
            counts = state.object_row(report["counts"])
            self.assertEqual(counts["accounts"], 1)
            self.assertEqual(counts["evidencePassed"], 1)
            self.assertEqual(counts["externalSends"], 0)
            self.assertEqual(counts["crmMutations"], 0)
            items = state.object_rows(discovery.load(discovery.INBOX, {})["items"])
            self.assertEqual([row["accountKey"] for row in items], ["manual", "qa"])
            self.assertEqual(len(discovery.LEDGER.read_text().splitlines()), 1)
            with patch.object(
                discovery,
                "discover",
                side_effect=AssertionError("fresh proof must not call provider"),
            ):
                self.assertEqual(discovery.main([]), 0)
            reused = discovery.load(discovery.OUT, {})
            self.assertIs(reused["reusedFreshDailyEvidence"], True)
            self.assertEqual(len(discovery.LEDGER.read_text().splitlines()), 1)

    def test_failed_validation_is_not_reported_as_success(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture_paths(stack, Path(temp))
            providers(stack)
            _ = stack.enter_context(
                patch.object(
                    discovery, "gate", return_value={"ok": False, "returnCode": 1}
                )
            )
            discovery.save(discovery.REG, {"accounts": [account()]})
            self.assertEqual(discovery.main([]), 1)
            self.assertIs(discovery.load(discovery.OUT, {})["ok"], False)
            with patch.object(
                discovery,
                "discover",
                side_effect=AssertionError("retry must reuse prepared evidence"),
            ):
                self.assertEqual(discovery.main([]), 1)
            self.assertEqual(
                discovery.load(discovery.OUT, {})["status"], "evidence_gate_failed"
            )

    def test_unknown_or_exhausted_capacity_blocks_provider_calls(self) -> None:
        limits: provider.Quota = {
            "minHeadroom": 60,
            "searches": 12,
            "verifications": 12,
            "policyPath": "qa",
        }
        for calls, expected in [
            ({}, False),
            ({"available": 83, "used": 0}, False),
            ({"available": 84, "used": 0}, True),
        ]:
            with (
                self.subTest(calls=calls),
                patch("contact_provider.configured", return_value=False),
                patch.object(
                    provider,
                    "hunter_get",
                    return_value={"ok": True, "body": {"data": {"calls": calls}}},
                ),
            ):
                self.assertIs(provider.capacity("qa-key", limits)["allowed"], expected)
        self.assertIs(
            provider.discover(account(), "qa-key", {"allowed": False})["passed"], False
        )

    def test_exact_identity_and_evidence_requirements(self) -> None:
        with ExitStack() as stack:
            providers(stack)
            good = provider.discover(account(), "qa-key", {"allowed": True})
            self.assertIs(good["passed"], True)
            with patch.object(
                provider,
                "verify_email",
                return_value={
                    "ok": True,
                    "body": {"data": {"result": "valid", "score": 89}},
                },
            ):
                self.assertIn(
                    "email_verification_0_90",
                    state.strings(
                        provider.discover(account(), "qa-key", {"allowed": True})[
                            "gaps"
                        ]
                    ),
                )
            with patch.object(
                provider,
                "email_finder",
                return_value={
                    "ok": True,
                    "body": {
                        "data": {
                            "email": "qa@elsewhere.example",
                            "position": "Intern",
                            "sources": ["https://google.com/search?q=qa"],
                        }
                    },
                },
            ):
                failed = provider.discover(account(), "qa-key", {"allowed": True})
                self.assertIs(failed["passed"], False)
                self.assertTrue(
                    {
                        "professional_email_exact_domain",
                        "email_evidence_url",
                        "professional_profile_url",
                        "verified_role_match",
                    }.issubset(state.strings(failed["gaps"]))
                )

    def test_invalid_or_zero_provider_scores_cannot_become_verified(self) -> None:
        with ExitStack() as stack:
            providers(stack)
            for score in [float("nan"), float("inf"), -1, 500, 0, "invalid", True]:
                with (
                    self.subTest(score=score),
                    patch.object(
                        provider,
                        "verify_email",
                        return_value={
                            "ok": True,
                            "statusCode": 200,
                            "data": {"result": "deliverable", "score": score},
                        },
                    ),
                ):
                    result = provider.discover(
                        account(), "qa-key", {"ok": True, "allowed": True}
                    )
                    self.assertFalse(result["passed"])
                    self.assertIn(
                        "email_verification_0_90", state.strings(result["gaps"])
                    )

    def test_retry_window_is_account_scoped_and_malformed_dates_block(self) -> None:
        moment = datetime(2026, 10, 30, 12, tzinfo=UTC)
        with patch.object(state, "now", return_value=moment):
            self.assertEqual(
                state.retry_at("person_role_not_proven", 1),
                datetime(2026, 11, 2, 7, 20, tzinfo=UTC),
            )
            self.assertEqual(
                state.retry_at("person_role_not_proven", 2),
                datetime(2026, 11, 6, 7, 20, tzinfo=UTC),
            )
            records: state.Row = {
                "accounts": {
                    "bad": {"nextRetryAt": "invalid"},
                    "future": {"nextRetryAt": "2026-11-02T07:20:00Z"},
                    "passed": {"passed": True},
                }
            }
            self.assertFalse(state.due(records, "bad"))
            self.assertFalse(state.due(records, "future"))
            self.assertFalse(state.retry_due_for_reuse(records, "passed"))
            self.assertTrue(state.retry_due_for_reuse(records, "new"))

    def test_failed_child_validation_cannot_reuse_old_green_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            fixture_paths(stack, root)
            discovery.save(
                root / "robinswood-flow-contact-enrichment-last.json", {"ok": True}
            )
            _ = stack.enter_context(
                patch.object(
                    subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        ["qa-validator"], 1, "", "qa failure"
                    ),
                )
            )
            self.assertIs(discovery.gate()["ok"], False)

    def test_zero_budget_and_invalid_budget_are_respected(self) -> None:
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture_paths(stack, Path(temp))
            discovery.save(
                discovery.QP,
                {"globalSearchBudgetPerRun": 0, "globalVerificationBudgetPerRun": 0},
            )
            self.assertEqual(discovery.quota()["searches"], 0)
            self.assertEqual(discovery.quota()["verifications"], 0)
            discovery.save(discovery.QP, {"minRequestsHeadroom": -1})
            with self.assertRaises(ValueError):
                _ = discovery.quota()

    def test_pure_source_filters_and_selftest(self) -> None:
        self.assertEqual(
            state.source_urls(
                {
                    "sources": [
                        "https://example.org/team",
                        {"uri": "https://example.org/team"},
                        "https://bing.com/search?q=qa",
                    ]
                }
            ),
            ["https://example.org/team"],
        )
        self.assertTrue(state.role_ok("COO", "Chief Operating Officer"))
        self.assertFalse(state.role_ok("COO", "CEO"))
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            fixture_paths(stack, Path(temp))
            self.assertIs(discovery.selftest()["ok"], True)
