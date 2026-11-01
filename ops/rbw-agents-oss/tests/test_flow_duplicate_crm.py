"""Duplicate safety scans must prove complete pagination, using only fake responses."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_duplicate_crm as crm
import robinswood_flow_core as core
from flow_contact_evidence_state import Row
from pydantic import JsonValue


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def page(
    start: int, count: int, *, cursor: str | None = None, total: int | None = None
) -> Row:
    pagination: Row = {}
    if cursor is not None:
        pagination["offset"] = cursor
    if total is not None:
        pagination["total"] = total
    return {
        "data": [{"id": index} for index in range(start, start + count)],
        "pagination": pagination,
    }


class DuplicateReadbackTests(unittest.TestCase):
    def test_full_page_without_total_requires_next_page(self) -> None:
        calls: list[str] = []
        responses = iter([page(1, 100, cursor="next /?"), page(101, 3)])

        def request(endpoint: str) -> Row:
            calls.append(endpoint)
            return next(responses)

        with patch.object(core, "crmreq", side_effect=request):
            rows, meta = crm.list_endpoint("/invoices")
        self.assertEqual(len(rows), 103)
        self.assertIs(meta["complete"], True)
        self.assertEqual(meta["pages"], 2)
        self.assertEqual(
            calls, ["/invoices?limit=100", "/invoices?limit=100&offset=next%20%2F%3F"]
        )

    def test_short_page_with_cursor_is_not_assumed_complete(self) -> None:
        with patch.object(
            core, "crmreq", side_effect=[page(1, 2, cursor="next"), page(3, 1)]
        ):
            rows, meta = crm.list_endpoint("/contacts")
        self.assertEqual(len(rows), 3)
        self.assertIs(meta["complete"], True)
        self.assertEqual(meta["pages"], 2)

    def test_missing_repeated_cursor_and_page_budget_fail_closed(self) -> None:
        cases: list[tuple[list[Row], int, str]] = [
            ([page(1, 100)], 100, "missing_or_repeated_cursor"),
            (
                [page(1, 100, cursor="same"), page(101, 100, cursor="same")],
                100,
                "missing_or_repeated_cursor",
            ),
            ([page(1, 100, cursor="next")], 1, "max_pages_exceeded"),
        ]
        for responses, budget, reason in cases:
            with (
                self.subTest(reason=reason),
                patch.object(core, "crmreq", side_effect=responses),
            ):
                _, meta = crm.list_endpoint("/invoices", budget)
                self.assertIs(meta["complete"], False)
                self.assertEqual(meta["error"], reason)

    def test_inconsistent_totals_invalid_rows_and_repeated_records_are_not_complete(
        self,
    ) -> None:
        cases: list[list[Row]] = [
            [page(1, 3, total=4)],
            [page(1, 3, total=2)],
            [page(1, 100, cursor="next", total=101), page(101, 1, total=102)],
            [{"data": "invalid"}],
            [{"data": [{}]}],
            [page(1, 100, cursor="next"), page(1, 1)],
        ]
        for responses in cases:
            with (
                self.subTest(responses=len(responses)),
                patch.object(core, "crmreq", side_effect=responses),
            ):
                _, meta = crm.list_endpoint("/tasks")
                self.assertIs(meta["complete"], False)
                self.assertIsNotNone(meta["error"])

    def test_reported_total_and_empty_endpoint_are_complete(self) -> None:
        for response in [page(1, 100, total=100), page(1, 0, total=0), page(1, 0)]:
            with patch.object(core, "crmreq", return_value=response):
                _, meta = crm.list_endpoint("/tasks")
                self.assertIs(meta["complete"], True)

    def test_api_failure_is_redacted_and_zero_budget_makes_no_request(self) -> None:
        with patch.object(core, "crmreq", side_effect=OSError("private-token-in-url")):
            _, meta = crm.list_endpoint("/tasks")
        self.assertEqual(meta["error"], "OSError")
        self.assertNotIn("private-token", str(meta))
        with patch.object(core, "crmreq", side_effect=AssertionError("no request")):
            _, meta = crm.list_endpoint("/tasks", 0)
        self.assertEqual(meta["error"], "invalid_page_budget")

    def test_exact_identifiers_cannot_match_booleans_fractions_or_substrings(
        self,
    ) -> None:
        cases: list[JsonValue] = [True, 123.9, "prefix123", "123suffix", "01230", None]
        for value in cases:
            self.assertFalse(crm.has_exact_id(value, 123))
        self.assertTrue(crm.has_exact_id({"nested": [{"id": "123"}]}, 123))
        self.assertEqual(crm.ident({"object": {"id": "123"}}), 123)
        self.assertIsNone(crm.ident({"id": True}))
        self.assertIsNone(crm.ident(None))

    def test_marker_replacement_is_idempotent_and_preserves_literal_backslashes(
        self,
    ) -> None:
        first = crm.append_marker("Existing note", r"QA C:\new\1")
        second = crm.append_marker(first, r"QA C:\new\1")
        self.assertEqual(first, second)
        self.assertTrue(first.startswith("Existing note"))
        self.assertIn(r"QA C:\new\1", first)
        self.assertEqual(first.count(":START]"), 1)

    def test_search_filters_object_type_and_deduplicates_identifiers(self) -> None:
        response: Row = {
            "data": [
                {"object": {"id": "123", "type": "company"}},
                {"object": {"id": 123, "type": "company"}},
                {"object": {"id": 124, "type": "contact"}},
            ]
        }
        with patch.object(core, "crmreq", return_value=response):
            self.assertEqual(crm.exact_search("QA / company", "company"), [123])


if __name__ == "__main__":
    _ = unittest.main()
