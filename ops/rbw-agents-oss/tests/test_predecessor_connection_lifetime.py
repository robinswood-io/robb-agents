"""Real predecessor SQLite connections close after both success and read failure."""
from __future__ import annotations

import sqlite3
import unittest
from unittest.mock import patch

import evergreen_offline_test_guard as offline
import robinswood_evergreen_france_ramp_cases as fixtures


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


class PredecessorConnectionTests(unittest.TestCase):
    def test_connection_closes_after_success_and_read_error(self) -> None:
        for fail in [False, True]:
            with self.subTest(fail=fail):
                case = fixtures.PostScotlandRampTests()
                case.setUp()
                try:
                    path = case.prior.root / "campaign-state.sqlite3"
                    connection = sqlite3.connect(path)
                    if fail:
                        _ = connection.execute("DROP TABLE touches")
                        connection.commit()
                    with patch.object(sqlite3, "connect", return_value=connection):
                        report = case.old_ramp(case.db, case.t, case.c, case.prior.root)
                    if fail:
                        self.assertEqual(report["reason"], "predecessor_completion_unproven:OperationalError")
                    else:
                        self.assertEqual(report["predecessorUnknownEffects"], 0)
                    with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed"):
                        _ = connection.execute("SELECT 1")
                finally:
                    case.tearDown()
