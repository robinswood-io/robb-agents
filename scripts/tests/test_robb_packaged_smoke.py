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
    def test_inspection_requests_full_certificate_metadata(self) -> None:
        self.assertEqual(
            MODULE.codesign_inspection_command(Path("/tmp/Robb Agents.app")),
            ["codesign", "-dv", "--verbose=4", "/tmp/Robb Agents.app"],
        )

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
                "Identifier=io.robinswood.robbagents\n"
                "Authority=Developer ID Application: Robinswood (ABCDE12345)\n"
                "TeamIdentifier=ABCDE12345",
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

    def test_release_rejects_an_apple_development_signature(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.validate_codesign_inspection(
                0,
                "Identifier=io.robinswood.robbagents\n"
                "Authority=Apple Development: Developer (ABCDE12345)\n"
                "TeamIdentifier=ABCDE12345",
                require_release_signing=True,
            )

    def test_release_verification_requires_codesign_gatekeeper_and_stapler(self) -> None:
        valid = (0, "valid on disk", 0, "source=Notarized Developer ID", 0, "The validate action worked!")
        MODULE.validate_release_verification_results(*valid)

        failures = (
            (1, "invalid signature", 0, "source=Notarized Developer ID", 0, "ok"),
            (0, "valid", 1, "rejected", 0, "ok"),
            (0, "valid", 0, "source=Developer ID", 0, "ok"),
            (0, "valid", 0, "source=Notarized Developer ID", 1, "ticket missing"),
        )
        for values in failures:
            with self.subTest(values=values), self.assertRaises(SystemExit):
                MODULE.validate_release_verification_results(*values)


if __name__ == "__main__":
    unittest.main()
