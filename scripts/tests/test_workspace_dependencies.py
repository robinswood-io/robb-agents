"""Exercise dependency-audit boundaries without network calls or real credentials."""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import check_workspace_dependencies as audit


class DependencyBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.patch = patch.object(audit, "ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.write("package.json", {"version": "0.12.11"})
    def write(self, name: str, value: object) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
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
            audit.compatibility_exceptions()
    def test_missing_reference_and_unapproved_version_are_rejected(self) -> None:
        value = self.authorization()
        value["authorization_reference"] = ""
        self.write("bmad/dependency-exceptions.json", value)
        with self.assertRaisesRegex(ValueError, "human authorization"):
            audit.compatibility_exceptions()
        value = self.authorization()
        value["dependencies"] = [{"manifest": "package.json", "package": "typescript",
                                  "version": "5.0.0", "reason": "Unapproved fixture"}]
        self.write("bmad/dependency-exceptions.json", value)
        with self.assertRaisesRegex(ValueError, "outside"):
            audit.compatibility_exceptions()
    def test_local_patch_requires_latest_base_and_exact_installed_bytes(self) -> None:
        vendor = self.root / "scripts/vendor/sprintf-js/src/sprintf.js"
        installed = self.root / "node_modules/sprintf-js/src/sprintf.js"
        for path in [vendor, installed]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"bounded fixture")
        self.write("scripts/vendor/sprintf-js/upstream.json",
                   {"base_version": "1.1.3", "patched_source_sha256": hashlib.sha256(vendor.read_bytes()).hexdigest()})
        row: audit.Dependency = {"manifest": "package.json", "group": "overrides", "package": "sprintf-js",
                                 "registry_name": "sprintf-js", "spec": "file:./scripts/vendor/sprintf-js", "installed": "1.1.4"}
        self.assertTrue(audit.verified_sprintf_patch(row, "1.1.3"))
        self.assertFalse(audit.verified_sprintf_patch(row, "1.1.5"))
        installed.write_bytes(b"tampered installed fixture")
        self.assertFalse(audit.verified_sprintf_patch(row, "1.1.3"))
        installed.write_bytes(vendor.read_bytes())
        vendor.write_bytes(b"tampered vendor fixture")
        self.assertFalse(audit.verified_sprintf_patch(row, "1.1.3"))
if __name__ == "__main__":
    unittest.main()
