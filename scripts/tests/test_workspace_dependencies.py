"""Exercise dependency-audit boundaries without network calls or real credentials."""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import cast, override
from unittest.mock import patch

from scripts import check_workspace_dependencies as audit


class DependencyBoundaryTests(unittest.TestCase):
    temporary: tempfile.TemporaryDirectory[str] | None = None

    @property
    def root(self) -> Path:
        if self.temporary is None:
            raise RuntimeError("Fixture is not set up")
        return Path(self.temporary.name)

    @override
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        patcher = patch.object(audit, "ROOT", self.root)
        _ = cast(object, patcher.start())
        self.addCleanup(patcher.stop)
        self.write("package.json", {"version": "0.12.11"})
    def test_python_quality_and_runtime_requirement_files_are_audited(self) -> None:
        quality = self.root / "python-quality-requirements.txt"
        runtime = self.root / "requirements.txt"
        _ = quality.write_text("# quality tools\nPillow==13.0.0\n\n")
        _ = runtime.write_text("requests==2.34.2\n")
        self.assertEqual(audit.python_pins([quality.name, runtime.name]),
                         {"pillow": "13.0.0", "requests": "2.34.2"})

    def test_python_requirement_files_reject_unpinned_and_conflicting_versions(self) -> None:
        quality = self.root / "python-quality-requirements.txt"
        runtime = self.root / "requirements.txt"
        _ = quality.write_text("python-dateutil==3.0.0\n")
        for spec in ("requests>=2", "Python_Dateutil==2.9.0"):
            with self.subTest(spec=spec):
                _ = runtime.write_text(spec + "\n")
                with self.assertRaises(ValueError):
                    _ = audit.python_pins([quality.name, runtime.name])

    def write(self, name: str, value: object) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        _ = path.write_text(json.dumps(value))
    def test_versioned_override_keeps_selector_and_resolves_installed_package(self) -> None:
        self.write("package.json", {"overrides": {
            "glob@>=9.0.0 <14.0.2": "14.0.3", "@scope/pkg@^2": "3.0.0",
        }})
        self.write("node_modules/glob/package.json", {"version": "14.0.3"})
        self.write("node_modules/@scope/pkg/package.json", {"version": "3.0.0"})
        rows = audit.dependencies(["package.json"])
        self.assertEqual([(row["package"], row["registry_name"], row["installed"]) for row in rows], [
            ("glob@>=9.0.0 <14.0.2", "glob", "14.0.3"), ("@scope/pkg@^2", "@scope/pkg", "3.0.0"),
        ])
        for invalid in ("", "glob@", "../glob", "@scope", "glob@1@2"):
            with self.subTest(selector=invalid), self.assertRaises(ValueError):
                _ = audit.override_package_name(invalid)

    def test_dependency_rows_preserve_manifest_paths(self) -> None:
        self.write("package.json", {"devDependencies": {"typescript": "~6.0.3"},
                                    "overrides": {"glob@>=9.0.0 <14.0.2": "14.0.3"}})
        self.write("packages/worker/package.json", {"dependencies": {
            "@whiskeysockets/baileys": "7.0.0-rc14",
        }})
        rows = audit.dependencies(["package.json", "packages/worker/package.json"])
        self.assertEqual([(row["manifest"], row["package"]) for row in rows], [
            ("package.json", "typescript"),
            ("package.json", "glob@>=9.0.0 <14.0.2"),
            ("packages/worker/package.json", "@whiskeysockets/baileys"),
        ])

    def authorization(self) -> dict[str, object]:
        return {"release": "0.12.11", "approved_by": "Thibault",
                "authorization_reference": "Synthetic test fixture; grants no real authorization",
                "dependencies": [{"manifest": "package.json", "package": "typescript",
                                  "version": "6.0.3", "reason": "Synthetic peer compatibility fixture"}]}
    def test_exception_expires_when_release_version_changes(self) -> None:
        self.write("bmad/dependency-exceptions.json", self.authorization())
        self.assertEqual(audit.compatibility_exceptions(), {("package.json", "typescript", "6.0.3")})
        self.write("package.json", {"version": "0.12.12"})
        with self.assertRaisesRegex(ValueError, "do not apply"):
            _ = audit.compatibility_exceptions()
    def test_missing_reference_and_unapproved_version_are_rejected(self) -> None:
        value = self.authorization()
        value["authorization_reference"] = ""
        self.write("bmad/dependency-exceptions.json", value)
        with self.assertRaisesRegex(ValueError, "human authorization"):
            _ = audit.compatibility_exceptions()
        value = self.authorization()
        value["dependencies"] = [{"manifest": "package.json", "package": "typescript",
                                  "version": "5.0.0", "reason": "Unapproved fixture"}]
        self.write("bmad/dependency-exceptions.json", value)
        with self.assertRaisesRegex(ValueError, "outside"):
            _ = audit.compatibility_exceptions()
    def test_local_patch_requires_latest_base_and_exact_installed_bytes(self) -> None:
        vendor = self.root / "scripts/vendor/sprintf-js/src/sprintf.js"
        installed = self.root / "node_modules/sprintf-js/src/sprintf.js"
        for path in [vendor, installed]:
            path.parent.mkdir(parents=True, exist_ok=True)
            _ = path.write_bytes(b"bounded fixture")
        self.write("scripts/vendor/sprintf-js/upstream.json",
                   {"base_version": "1.1.3", "patched_source_sha256": hashlib.sha256(vendor.read_bytes()).hexdigest()})
        row: audit.Dependency = {"manifest": "package.json", "group": "overrides", "package": "sprintf-js",
                                 "registry_name": "sprintf-js", "spec": "file:./scripts/vendor/sprintf-js", "installed": "1.1.4"}
        self.assertTrue(audit.verified_sprintf_patch(row, "1.1.3"))
        self.assertFalse(audit.verified_sprintf_patch(row, "1.1.5"))
        _ = installed.write_bytes(b"tampered installed fixture")
        self.assertFalse(audit.verified_sprintf_patch(row, "1.1.3"))
        _ = installed.write_bytes(vendor.read_bytes())
        _ = vendor.write_bytes(b"tampered vendor fixture")
        self.assertFalse(audit.verified_sprintf_patch(row, "1.1.3"))
if __name__ == "__main__":
    _ = unittest.main()
