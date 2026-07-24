#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

from robb_package_audit import audit_package, artifact_size_finding  # noqa: E402


class PackageAuditTests(unittest.TestCase):
    def test_clean_package_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "Contents" / "Resources" / "app"
            payload.mkdir(parents=True)
            (payload / "main.js").write_text("console.log('Robb')", encoding="utf-8")

            report = audit_package(root, max_bytes=1024)

            self.assertTrue(report.ok)
            self.assertEqual(report.file_count, 1)
            self.assertEqual(report.total_bytes, 19)

    def test_release_artifacts_directory_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release_artifacts = root / "Contents" / "Resources" / "release-artifacts"
            release_artifacts.mkdir(parents=True)
            (release_artifacts / "notes.txt").write_text("recursive", encoding="utf-8")

            report = audit_package(root, max_bytes=None)

            self.assertFalse(report.ok)
            self.assertTrue(
                any(
                    finding.path.endswith("release-artifacts")
                    and finding.reason == "forbidden recursive release directory"
                    for finding in report.findings
                )
            )

    def test_nested_robb_installer_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = root / "resources" / "app"
            payload.mkdir(parents=True)
            (payload / "Robb-Agents-x64.zip").write_bytes(b"nested")

            report = audit_package(root, max_bytes=None)

            self.assertFalse(report.ok)
            self.assertTrue(
                any(finding.reason == "nested Robb distribution artifact (.zip)" for finding in report.findings)
            )

    def test_source_release_output_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "snapshot" / "apps" / "electron" / "release"
            output.mkdir(parents=True)
            (output / "manifest.txt").write_text("embedded", encoding="utf-8")

            report = audit_package(root, max_bytes=None)

            self.assertFalse(report.ok)
            self.assertTrue(
                any(finding.reason == "source release output embedded in package" for finding in report.findings)
            )

    def test_unpacked_size_budget_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "large.bin").write_bytes(b"x" * 32)

            report = audit_package(root, max_bytes=16)

            self.assertFalse(report.ok)
            self.assertTrue(any("budget is 16 B" in finding.reason for finding in report.findings))

    def test_distribution_artifact_size_budget_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "Robb-Agents-arm64.dmg"
            artifact.write_bytes(b"x" * 32)

            finding = artifact_size_finding(artifact, max_bytes=16)

            self.assertIsNotNone(finding)
            self.assertIn("budget is 16 B", finding.reason if finding else "")


if __name__ == "__main__":
    unittest.main()
