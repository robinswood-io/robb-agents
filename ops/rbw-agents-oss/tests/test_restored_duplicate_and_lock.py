"""Offline regressions for recovered duplicate filtering and the real POSIX lock."""

from __future__ import annotations

import fcntl
import os
import tempfile
import unittest
from pathlib import Path
from typing import override
from unittest.mock import patch

import evergreen_offline_test_guard as guard
import robinswood_flow_lock as lock
import sellsy_technical_duplicate_guard as duplicate


class DuplicateGuardTests(unittest.TestCase):
    @override
    def setUp(self) -> None:
        _ = self.enterContext(
            patch.object(duplicate, "duplicate_ids", return_value={1001, 1002})
        )

    def test_known_duplicate_ids_and_canonical_ids_remain_distinct(self) -> None:
        for ident in [1001, 1002]:
            self.assertTrue(duplicate.is_technical_duplicate({"id": ident}))
            self.assertTrue(
                duplicate.is_technical_duplicate({"object": {"id": str(ident)}})
            )
        for ident in [2001, 2002, 42]:
            self.assertFalse(duplicate.is_technical_duplicate({"id": ident}))

    def test_nested_relationships_and_markers_are_rejected(self) -> None:
        self.assertTrue(
            duplicate.item_references_duplicate(
                {"metadata": {"recipient": {"contact_id": "1002"}}}
            )
        )
        self.assertTrue(
            duplicate.item_references_duplicate(
                {"company": {"name": "[TECH DUPLICATE → 42] QA"}}
            )
        )
        self.assertTrue(
            duplicate.is_technical_duplicate({"note": "[TECH FALSE POSITIVE → 42] QA"})
        )
        self.assertTrue(
            duplicate.is_technical_duplicate(
                {"note": "rbw_flow_technical_duplicate_20260715"}
            )
        )
        self.assertFalse(
            duplicate.item_references_duplicate(
                {"sellsyCompanyId": 2001, "sellsyContactId": 2002}
            )
        )

    def test_malformed_identifiers_are_not_treated_as_duplicate_ids(self) -> None:
        cases: list[duplicate.JsonValue] = [
            None,
            "not an object",
            ["not an object"],
            {"id": "invalid"},
            {"id": []},
        ]
        for item in cases:
            self.assertIsNone(duplicate.object_id(item))
            self.assertFalse(duplicate.is_technical_duplicate(item))
        self.assertEqual(
            duplicate.filter_canonical([None, {"id": 42}, {"id": 1002}]), [{"id": 42}]
        )


class ChainLockTests(unittest.TestCase):
    def test_nested_owner_and_exception_release_the_actual_file_lock(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(lock, "LOCK", Path(directory) / "qa.lock"),
            patch.dict(os.environ, {"RBW_FLOW_CHAIN_LOCK_HELD": ""}),
        ):
            with (
                self.assertRaisesRegex(RuntimeError, "fixture failure"),
                lock.chain_lock() as acquired,
            ):
                self.assertTrue(acquired)
                self.assertEqual(os.environ["RBW_FLOW_CHAIN_LOCK_HELD"], "1")
                with lock.chain_lock() as nested:
                    self.assertTrue(nested)
                raise RuntimeError("fixture failure")
            self.assertEqual(os.environ["RBW_FLOW_CHAIN_LOCK_HELD"], "")
            with lock.LOCK.open("a+") as other:
                fcntl.flock(other.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(other.fileno(), fcntl.LOCK_UN)

    def test_competing_file_descriptor_blocks_without_claiming_ownership(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(lock, "LOCK", Path(directory) / "qa.lock"),
            patch.dict(os.environ, {"RBW_FLOW_CHAIN_LOCK_HELD": ""}),
        ):
            with lock.LOCK.open("a+") as owner:
                fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with lock.chain_lock() as acquired:
                    self.assertFalse(acquired)
                    self.assertEqual(os.environ["RBW_FLOW_CHAIN_LOCK_HELD"], "")
                fcntl.flock(owner.fileno(), fcntl.LOCK_UN)
            with lock.chain_lock() as acquired:
                self.assertTrue(acquired)


def tearDownModule() -> None:
    guard.assert_no_external_attempts()
