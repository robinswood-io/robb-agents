#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

SPEC = importlib.util.spec_from_file_location(
    "robb_packaged_smoke",
    SCRIPTS_DIR / "robinswood-packaged-smoke.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load robinswood-packaged-smoke.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CodesignInspectionTests(unittest.TestCase):
    def test_unsigned_cross_architecture_smoke_build_is_accepted(self) -> None:
        mode = MODULE.validate_codesign_inspection(
            1,
            "code object is not signed at all\nIn architecture: x86_64",
            require_release_signing=False,
        )

        self.assertEqual(mode, "unsigned")

    def test_unsigned_release_build_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_codesign_inspection(
                1,
                "code object is not signed at all",
                require_release_signing=True,
            )

    def test_unknown_codesign_failure_is_rejected_for_smoke_build(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_codesign_inspection(
                1,
                "codesign failed because the bundle could not be read",
                require_release_signing=False,
            )

    def test_adhoc_signature_is_accepted_only_for_smoke_build(self) -> None:
        self.assertEqual(
            MODULE.validate_codesign_inspection(
                0,
                "Identifier=io.robinswood.robbagents\nSignature=adhoc\nTeamIdentifier=not set",
                require_release_signing=False,
            ),
            "adhoc",
        )

        with self.assertRaises(SystemExit):
            MODULE.validate_codesign_inspection(
                0,
                "Identifier=io.robinswood.robbagents\nSignature=adhoc\nTeamIdentifier=not set",
                require_release_signing=True,
            )

    def test_developer_id_signature_requires_expected_identifier(self) -> None:
        self.assertEqual(
            MODULE.validate_codesign_inspection(
                0,
                "Identifier=io.robinswood.robbagents\nTeamIdentifier=ABCDE12345",
                require_release_signing=True,
            ),
            "developer-id",
        )

        with self.assertRaises(SystemExit):
            MODULE.validate_codesign_inspection(
                0,
                "Identifier=com.example.other\nTeamIdentifier=ABCDE12345",
                require_release_signing=False,
            )


if __name__ == "__main__":
    unittest.main()
