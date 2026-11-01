from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    import robinswood_packaged_smoke as MODULE
finally:
    _ = sys.path.pop(0)


class CodesignInspectionTests(unittest.TestCase):
    def test_packaged_smoke_requires_the_platform_uv_runtime(self) -> None:
        source = (SCRIPTS_DIR / "robinswood_packaged_smoke.py").read_text(encoding="utf-8")
        after_pack = (SCRIPTS_DIR.parent / "apps" / "electron" / "scripts" / "afterPack.ts").read_text(encoding="utf-8")
        self.assertIn('require(packaged_uv, "packaged uv runtime")', source)
        self.assertNotIn('sha256(packaged_uv) != sha256(SOURCE_UV)', source)
        self.assertIn('uv_version_parts[:2] != ["uv", expected_uv_version()]', source)
        self.assertIn('run([str(packaged_uv), "--version"])', source)
        self.assertIn('run(["codesign", "--verify", "--strict", "--verbose=2", str(packaged_uv)])', source)
        self.assertIn("verifyPackagedUvMatchesStaged(context, resourcesDir);", after_pack)

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
            _ = MODULE.validate_codesign_inspection(
                1,
                "code object is not signed at all",
                require_release_signing=True,
            )

    def test_unknown_codesign_failure_is_rejected_for_smoke_build(self) -> None:
        with self.assertRaises(SystemExit):
            _ = MODULE.validate_codesign_inspection(
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
            _ = MODULE.validate_codesign_inspection(
                0,
                "Identifier=io.robinswood.robbagents\nSignature=adhoc\nTeamIdentifier=not set",
                require_release_signing=True,
            )

    def test_developer_id_signature_requires_expected_identifier(self) -> None:
        self.assertEqual(
            MODULE.validate_codesign_inspection(
                0,
                "Identifier=io.robinswood.robbagents\n"
                + "Authority=Developer ID Application: Robinswood (ABCDE12345)\n"
                + "TeamIdentifier=ABCDE12345",
                require_release_signing=True,
            ),
            "developer-id",
        )

        with self.assertRaises(SystemExit):
            _ = MODULE.validate_codesign_inspection(
                0,
                "Identifier=com.example.other\nTeamIdentifier=ABCDE12345",
                require_release_signing=False,
            )

    def test_release_rejects_an_apple_development_signature(self) -> None:
        with self.assertRaises(SystemExit):
            _ = MODULE.validate_codesign_inspection(
                0,
                "Identifier=io.robinswood.robbagents\n"
                + "Authority=Apple Development: Developer (ABCDE12345)\n"
                + "TeamIdentifier=ABCDE12345",
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
    _ = unittest.main()
