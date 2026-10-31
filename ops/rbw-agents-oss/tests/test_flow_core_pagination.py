"""Cursor recovery scans must never silently truncate or accept partial CRM data."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import robinswood_flow_core_sellsy as sellsy
from flow_structural_checks import Report
from flow_structural_runtime import recovery_scans_guarded
from pydantic import JsonValue


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def page(start: int, count: int, total: JsonValue, cursor: str | None = None) -> Report:
    pagination: Report = {"total": total}
    if cursor is not None:
        pagination["offset"] = cursor
    return {
        "items": [{"id": start + i} for i in range(count)],
        "pagination": pagination,
    }


class PaginationTests(unittest.TestCase):
    def test_complete_cursor_scan_preserves_all_rows_and_encodes_cursor(self) -> None:
        with (
            patch.object(sellsy, "profile"),
            patch.object(
                sellsy,
                "crmreq",
                side_effect=[page(1, 100, 101, "qa +/"), page(101, 1, 101)],
            ) as request,
        ):
            result = sellsy.listall("/companies")
        self.assertEqual(len(result), 101)
        self.assertEqual(result[-1], {"id": 101})
        self.assertEqual(
            request.call_args_list[1].args, ("/companies?limit=100&offset=qa%20%2B%2F",)
        )

    def test_invalid_total_is_rejected(self) -> None:
        invalid: list[JsonValue] = [True, -1, 1.5, "101"]
        for total in invalid:
            with (
                self.subTest(total=total),
                patch.object(sellsy, "profile"),
                patch.object(sellsy, "crmreq", return_value=page(1, 1, total)),
                self.assertRaisesRegex(RuntimeError, "total_invalid"),
            ):
                _ = sellsy.listall("/companies")

    def test_inconsistent_total_or_extra_rows_never_truncated(self) -> None:
        cases = [[page(1, 2, 1)], [page(1, 100, 101, "next"), page(101, 1, 102)]]
        for pages in cases:
            with (
                self.subTest(pages=len(pages)),
                patch.object(sellsy, "profile"),
                patch.object(sellsy, "crmreq", side_effect=pages),
                self.assertRaisesRegex(RuntimeError, "total_(exceeded|changed)"),
            ):
                _ = sellsy.listall("/companies")

    def test_short_page_with_unread_total_fails(self) -> None:
        with (
            patch.object(sellsy, "profile"),
            patch.object(sellsy, "crmreq", return_value=page(1, 1, 2)),
            self.assertRaisesRegex(RuntimeError, "short_read"),
        ):
            _ = sellsy.listall("/companies")

    def test_missing_or_repeated_cursor_fails(self) -> None:
        cases = [
            [page(1, 100, 201)],
            [page(1, 100, 201, "same"), page(101, 100, 201, "same")],
        ]
        for pages in cases:
            with (
                self.subTest(pages=len(pages)),
                patch.object(sellsy, "profile"),
                patch.object(sellsy, "crmreq", side_effect=pages),
                self.assertRaisesRegex(RuntimeError, "incomplete"),
            ):
                _ = sellsy.listall("/companies")

    def test_empty_complete_collection_is_valid(self) -> None:
        with (
            patch.object(sellsy, "profile"),
            patch.object(sellsy, "crmreq", return_value=page(1, 0, 0)),
        ):
            self.assertEqual(sellsy.listall("/companies"), [])

    def test_recovery_scans_require_matching_guards(self) -> None:
        source = "if need_companies:\n listall('/companies')\nif need_contacts:\n listall('/contacts')\n"
        self.assertTrue(recovery_scans_guarded(source))
        self.assertFalse(
            recovery_scans_guarded("listall('/companies')\nlistall('/contacts')\n")
        )
        self.assertFalse(
            recovery_scans_guarded(
                source.replace("if need_companies:", "if unrelated:")
            )
        )


if __name__ == "__main__":
    _ = unittest.main()
