"""Exercise the actual canary CLI in temporary directories without a scheduler."""
from __future__ import annotations

import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import evergreen_offline_test_guard as guard
import oss_runtime_v2_queue_canary as canary
from scotland_audience_types import OBJECT


class QueueCanaryReportTests(unittest.TestCase):
    def test_each_supported_queue_writes_a_passing_report(self) -> None:
        for queue in sorted(canary.ALLOWED_QUEUES):
            with self.subTest(queue=queue), tempfile.TemporaryDirectory() as directory:
                args = ["queue-canary", "--queue", queue, "--ops", directory]
                env = {"RBW_RUNTIME_V2_BACKEND": "argv", "RBW_RUNTIME_V2_SPEC_HASH": "qa-spec",
                       "RBW_RUNTIME_V2_POLICY_MODE": "enforce"}
                with patch("sys.argv", args), patch.dict(os.environ, env), redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit_context:
                    canary.main()
                self.assertEqual(exit_context.exception.code, 0)
                path = Path(directory) / f"oss-runtime-v2-queue-canary-{queue}-last.json"
                report = OBJECT.validate_json(path.read_bytes())
                self.assertIs(report["ok"], True)
                self.assertEqual(report["status"], "passed")
                self.assertEqual(report["counts"], {"checks": 3, "passed": 3, "failed": 0})
                self.assertEqual(report["capabilityId"], f"oss-runtime-v2-queue-canary-{queue}")
                self.assertEqual(list(Path(directory).glob(".*.tmp")), [])

    def test_missing_runtime_evidence_fails_and_persists_reason(self) -> None:
        for missing in ["RBW_RUNTIME_V2_BACKEND", "RBW_RUNTIME_V2_SPEC_HASH", "RBW_RUNTIME_V2_POLICY_MODE"]:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                env = {"RBW_RUNTIME_V2_BACKEND": "argv", "RBW_RUNTIME_V2_SPEC_HASH": "qa-spec",
                       "RBW_RUNTIME_V2_POLICY_MODE": "shadow"}
                env[missing] = ""
                with patch("sys.argv", ["queue-canary", "--queue", "default", "--ops", directory]), \
                        patch.dict(os.environ, env), redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit_context:
                    canary.main()
                self.assertEqual(exit_context.exception.code, 1)
                report = OBJECT.validate_json((Path(directory) / "oss-runtime-v2-queue-canary-default-last.json").read_bytes())
                self.assertIs(report["ok"], False)
                self.assertEqual(report["blockingReasons"], ["runtime_v2_environment_missing"])
                self.assertEqual(report["counts"], {"checks": 3, "passed": 2, "failed": 1})


def tearDownModule() -> None:
    guard.assert_no_external_attempts()
