#!/usr/bin/env python3
"""Archive-content checks, without mounting or launching any real application."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("archive_smoke", SCRIPTS / "robinswood-packaged-smoke.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@unittest.skipUnless(os.name == "posix", "macOS archive fixture requires POSIX permissions and symlinks")
class PackagedArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="robb-archive-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "Robb Agents.app"
        self.resources = self.app / "Contents/Resources"
        self.resources.mkdir(parents=True)
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleName": "Robb Agents", "CFBundleIdentifier": "io.robinswood.robbagents"}))
        (self.resources / "app.asar").write_bytes(b"expected authoritative application")
        bridge = self.resources / "app/resources/pi-agent-server"
        bridge.mkdir(parents=True)
        for name in ("vibe-acp-server.js", "antigravity-server.js"):
            (bridge / name).write_text("// expected external runtime")
        binary = self.app / "Contents/MacOS/Robb Agents"
        binary.parent.mkdir()
        binary.write_bytes(b"expected native executable")
        binary.chmod(0o755)
        (self.resources / "current").symlink_to("app.asar")
        self.zip = self.root / "Robb-Agents-arm64.zip"
        self.dmg = self.root / "Robb-Agents-arm64.dmg"
        self.dmg.write_bytes(b"mount is supplied by the fixture")

    def write_zip(self, changes: dict[str, bytes | None] | None = None, *, duplicate: bool = False, dos_member: str | None = None) -> None:
        changes = dict(changes or {})
        with zipfile.ZipFile(self.zip, "w", compression=zipfile.ZIP_STORED) as archive:
            for path in sorted(self.app.rglob("*")):
                if path.is_dir():
                    continue
                name = path.relative_to(self.root).as_posix()
                content = changes.pop(name, path.readlink().as_posix().encode() if path.is_symlink() else path.read_bytes())
                if content is None:
                    continue
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = path.lstat().st_mode << 16
                if name == dos_member:
                    info.create_system = 0
                    info.external_attr = (path.lstat().st_mode & ~0o111) << 16
                archive.writestr(info, content)
            for name, content in changes.items():
                assert content is not None
                archive.writestr(name, content)
            if duplicate:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    archive.writestr("Robb Agents.app/Contents/Resources/app.asar", b"duplicate")

    def check(self) -> None:
        def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            if command[:2] == ["hdiutil", "attach"]:
                mount = Path(command[command.index("-mountpoint") + 1])
                shutil.copytree(self.app, mount / self.app.name, symlinks=True)
            return subprocess.CompletedProcess(command, 0, "", "")

        with patch.multiple(MODULE, ZIP=self.zip, DMG=self.dmg, APP_DIR=self.app), \
             patch.object(MODULE, "run", side_effect=run), \
             patch.object(MODULE.shutil, "which", return_value="/fixture/hdiutil"):
            MODULE.check_dmg()

    def test_complete_archive_with_native_permissions_and_symlink_passes(self) -> None:
        self.write_zip()
        self.check()

    def test_non_zip_payload_is_rejected(self) -> None:
        self.zip.write_bytes(b"this is not a zip")
        with self.assertRaises(SystemExit):
            self.check()

    def test_changed_asar_is_rejected_even_with_valid_zip_crc(self) -> None:
        self.write_zip({"Robb Agents.app/Contents/Resources/app.asar": b"expected authoritative application".upper()})
        with self.assertRaises(SystemExit):
            self.check()

    def test_missing_native_binary_is_rejected(self) -> None:
        self.write_zip({"Robb Agents.app/Contents/MacOS/Robb Agents": None})
        with self.assertRaises(SystemExit):
            self.check()

    def test_duplicate_entry_is_rejected(self) -> None:
        self.write_zip(duplicate=True)
        with self.assertRaises(SystemExit):
            self.check()

    def test_traversal_entry_is_rejected_without_extraction(self) -> None:
        self.write_zip({"../outside": b"must not be extracted"})
        with self.assertRaises(SystemExit):
            self.check()
        self.assertFalse((self.root.parent / "outside").exists())

    def test_changed_symlink_is_rejected(self) -> None:
        self.write_zip({"Robb Agents.app/Contents/Resources/current": b"../other"})
        with self.assertRaises(SystemExit):
            self.check()

    def test_corrupted_crc_is_rejected(self) -> None:
        self.write_zip()
        data = bytearray(self.zip.read_bytes())
        start = data.index(b"expected authoritative application")
        data[start] ^= 1
        self.zip.write_bytes(data)
        with self.assertRaises(SystemExit):
            self.check()

    def test_dos_metadata_cannot_hide_lost_executable_permissions(self) -> None:
        self.write_zip(dos_member="Robb Agents.app/Contents/MacOS/Robb Agents")
        with self.assertRaises(SystemExit):
            self.check()

    def test_dos_metadata_cannot_hide_a_flattened_symlink(self) -> None:
        self.write_zip(dos_member="Robb Agents.app/Contents/Resources/current")
        with self.assertRaises(SystemExit):
            self.check()


if __name__ == "__main__":
    unittest.main()
