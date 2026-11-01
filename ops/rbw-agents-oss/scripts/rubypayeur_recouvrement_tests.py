from __future__ import annotations

import socket
import subprocess
import unittest
from collections.abc import Callable
from contextlib import ExitStack
from unittest.mock import patch

import rubypayeur_recouvrement_queue as queue
import rubypayeur_recouvrement_sellsy as sellsy
from rubypayeur_recouvrement_client import safe_public_debt_summary, validate_debt
from rubypayeur_recouvrement_support import (
    JSON_OBJECT_ADAPTER,
    JsonObject,
    parse_amount,
)

_external_attempts: list[str] = []
_offline_guard = ExitStack()


def _blocked_attempt(name: str) -> Callable[..., None]:
    def fail(*_args: object, **_kwargs: object) -> None:
        _external_attempts.append(name)
        raise RuntimeError(f"offline_test_blocked:{name}")
    return fail


def setUpModule() -> None:
    _external_attempts.clear()
    for target, attribute, label in (
        (socket.socket, "connect", "socket.connect"),
        (socket, "create_connection", "socket.create_connection"),
        (subprocess, "Popen", "subprocess.Popen"),
    ):
        _ = _offline_guard.enter_context(
            patch.object(target, attribute, side_effect=_blocked_attempt(label))
        )


def tearDownModule() -> None:
    _offline_guard.close()
    if _external_attempts:
        raise AssertionError(f"unexpected_external_attempts:{_external_attempts}")


class RubyPayeurOfflineTests(unittest.TestCase):
    def debt(self) -> JsonObject:
        return JSON_OBJECT_ADAPTER.validate_python({
            "siren": "123456789",
            "gender": "female",
            "first_name": "QA",
            "last_name": "Debtor",
            "email": "qa@example.test",
            "items": [
                {
                    "amount": "125.00",
                    "invoice_number": "QA-INV-01",
                    "invoiced_on": "2026-01-01",
                    "due_date": "2026-02-01",
                    "billing_proof_remote_url": "https://example.test/qa-invoice.pdf",
                }
            ],
        })

    def test_amount_parsing_and_validation_contract(self) -> None:
        self.assertEqual(parse_amount("1234,56"), 1234.56)
        debt = self.debt()
        self.assertEqual(validate_debt(debt), [])
        debt["gender"] = "unknown"
        self.assertIn("invalid_gender_must_be_male_or_female", validate_debt(debt))

    def test_public_summary_keeps_only_email_domain(self) -> None:
        summary = safe_public_debt_summary({
            "siren": "123456789",
            "gender": "female",
            "email": "private.person@example.test",
            "items": [{"invoice_number": "QA-INV"}],
        })
        self.assertEqual(summary["emailDomain"], "example.test")
        self.assertNotIn("private.person", str(summary))
        self.assertEqual(summary["itemsCount"], 1)

    def test_candidate_is_unapproved_and_keeps_guardrail_metadata(self) -> None:
        candidate = sellsy.candidate_from_invoice(
            JSON_OBJECT_ADAPTER.validate_python({
                "id": 17,
                "number": "QA-INV-17",
                "status": "late",
                "due_date": "2020-01-01",
                "amounts": {"total_remaining_due_incl_tax": "180.50"},
                "company_name": "Synthetic QA Ltd",
                "parent": {"type": "estimate", "id": 12},
                "pdf_link": "https://example.test/invoice.pdf",
            }),
            min_overdue_days=30,
            min_amount=100.0,
        )
        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertIs(candidate["approvedForRubypayeur"], False)
        candidate_meta = candidate.get("candidateMeta")
        sellsy_data = candidate.get("sellsy")
        assert isinstance(candidate_meta, dict)
        assert isinstance(sellsy_data, dict)
        self.assertEqual(candidate_meta.get("source"), "sellsy_late_invoice_scan")
        self.assertEqual(sellsy_data.get("estimate_ids"), [12])
        self.assertIs(candidate_meta.get("hasPdfLink"), True)

    def test_candidate_filters_paid_and_thresholds(self) -> None:
        invoice = JSON_OBJECT_ADAPTER.validate_python({
            "id": 18,
            "status": "paid",
            "due_date": "2020-01-01",
            "amounts": {"total_remaining_due_incl_tax": "200"},
        })
        self.assertIsNone(sellsy.candidate_from_invoice(
            invoice, min_overdue_days=30, min_amount=100.0,
        ))
        invoice["status"] = "late"
        self.assertIsNone(sellsy.candidate_from_invoice(
            invoice, min_overdue_days=30, min_amount=250.0,
        ))

    def test_queue_dry_run_records_only_synthetic_rows(self) -> None:
        row = JSON_OBJECT_ADAPTER.validate_python({
            "requestId": "qa-request-1",
            "action": "create_debt",
            "approvedForRubypayeur": True,
            "debt": self.debt(),
        })
        with (
            patch.object(queue, "load_processed_ids", return_value=set()),
            patch.object(queue, "append_jsonl") as append,
            patch.object(queue, "rubypayeur_auth", side_effect=AssertionError("dry-run auth")),
        ):
            report = queue.process_queue([row], apply=False, max_items=5)
        counts = report.get("counts")
        results = report.get("results")
        assert isinstance(counts, dict)
        assert isinstance(results, list) and results
        first_result = results[0]
        assert isinstance(first_result, dict)
        self.assertEqual(counts.get("dryRunValidated"), 1)
        self.assertEqual(first_result.get("status"), "dry_run_validated")
        self.assertEqual(append.call_count, 1)

    def test_sellsy_auth_fails_closed_without_credentials(self) -> None:
        with (
            patch.object(sellsy, "load_dotenv"),
            patch.dict("os.environ", {"SELLSY_CLIENT_ID": "", "SELLSY_CLIENT_SECRET": ""}),
            patch.object(sellsy, "_sellsy_access_token", None),
            patch.object(sellsy, "http_json") as request,
            self.assertRaisesRegex(RuntimeError, "sellsy_credentials_missing"),
        ):
            _ = sellsy.sellsy_auth()
        request.assert_not_called()
