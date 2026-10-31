"""Private duplicate mapping uses synthetic identifiers, never a live CRM."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import flow_duplicate_targets as mapping
import sellsy_technical_duplicate_guard as guard
from flow_contact_evidence_state import Row


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


def profile() -> Row:
    return {
        "companies": {"qa": [1001, 2001]},
        "contacts": {"1002": ["qa", 2002]},
        "falsePositiveContacts": {"1003": "qa"},
    }


class PrivateDuplicateTargetsTests(unittest.TestCase):
    def test_private_mapping_filters_only_excluded_rows_and_nested_references(
        self,
    ) -> None:
        with patch.object(mapping, "technical_duplicates", return_value=profile()):
            self.assertEqual(mapping.duplicate_ids(), {1001, 1002, 1003})
            self.assertEqual(
                guard.filter_canonical([{"id": 1001}, {"id": 2001}]), [{"id": 2001}]
            )
            self.assertTrue(
                guard.item_references_duplicate({"metadata": {"contact_id": "1002"}})
            )
            self.assertFalse(
                guard.item_references_duplicate({"metadata": {"contact_id": "2002"}})
            )

    def test_absent_private_profile_cannot_silently_disable_the_guard(self) -> None:
        with (
            patch.object(
                mapping,
                "technical_duplicates",
                side_effect=RuntimeError("flow_profile_missing"),
            ),
            self.assertRaisesRegex(RuntimeError, "flow_profile_missing"),
        ):
            _ = guard.filter_canonical([{"id": 2001}])

    def test_invalid_identifiers_conflicts_and_unknown_accounts_are_rejected(
        self,
    ) -> None:
        cases: list[Row] = [
            {"companies": {}},
            {"companies": {"qa": [True, 2001]}},
            {"companies": {"qa": [0, 2001]}},
            {"companies": {"qa": [1001, 1001]}},
            {"companies": {"qa": [1001, 2001], "qb": [1001, 2003]}},
            {"contacts": {"1002": ["missing", 2002]}},
            {"falsePositiveContacts": {"1002": "qa"}},
            {"falsePositiveContacts": {"1003": "missing"}},
        ]
        for change in cases:
            with (
                self.subTest(change=change),
                patch.object(
                    mapping,
                    "technical_duplicates",
                    return_value={**profile(), **change},
                ),
                self.assertRaises(ValueError),
            ):
                _ = mapping.targets()


if __name__ == "__main__":
    _ = unittest.main()
