#!/usr/bin/env python3
"""Exercise the real shell installer with temporary bundles and native doubles."""
from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.name == "posix" and all(shutil.which(name) for name in ("bash", "unzip", "openssl")), "Requires POSIX shell archive tools")
class MacInstallerTransactionTests(unittest.TestCase):
    def run_installer(self, mode: str) -> tuple[subprocess.CompletedProcess[str], dict[str, bool]]:
        with tempfile.TemporaryDirectory(prefix="robb-installer-transaction-") as temporary:
            base = Path(temporary)
            bins = base / "bin"
            bins.mkdir()
            remote = base / "remote"
            remote.mkdir()
            target = base / "applications" / "Robb Agents.app"
            target.mkdir(parents=True)
            (target / "old.txt").write_text("previous complete bundle")
            artifact = remote / "Robb-Agents-arm64.zip"
            with zipfile.ZipFile(artifact, "w") as archive:
                archive.writestr("Robb Agents.app/new.txt", "new complete bundle")
            data = artifact.read_bytes()
            digest = base64.b64encode(hashlib.sha512(data).digest()).decode()
            (remote / "latest-mac.yml").write_text(
                f"version: 1.2.3\nfiles:\n  - url: Robb-Agents-arm64.zip\n    sha512: {digest}\n    size: {len(data)}\n"
            )

            def executable(name: str, source: str) -> None:
                path = bins / name
                path.write_text(source)
                path.chmod(0o700)

            executable("uname", '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 1;; esac\n')
            # Signature/quit/process commands are doubles, never native app calls.
            executable("osascript", '#!/bin/sh\nexit 0\n')
            for name in ("codesign", "spctl"):
                executable(name, f"#!{sys.executable}\n" + '''import os,sys,pathlib
staged=pathlib.Path(sys.argv[-1]).is_relative_to(pathlib.Path(os.environ['ROBB_FIXTURE_TARGET']).parent)
sys.exit(41 if staged and os.environ['ROBB_FIXTURE_MODE']==pathlib.Path(sys.argv[0]).name+'-error' else 0)
''')
            executable("pgrep", '#!/bin/sh\nexit 1\n')
            executable("curl", f"#!{sys.executable}\n" + '''import os,sys,shutil,pathlib
a=sys.argv[1:]
shutil.copyfile(pathlib.Path(os.environ['ROBB_FIXTURE_REMOTE'])/a[-1].rsplit('/',1)[-1], a[a.index('--output')+1])
''')
            executable("ditto", f"#!{sys.executable}\n" + '''import os,sys,pathlib,shutil,signal
source,target=map(pathlib.Path,sys.argv[1:])
target.mkdir(parents=True,exist_ok=True)
mode=os.environ['ROBB_FIXTURE_MODE']
if mode in ('copy-error','copy-term'):
    (target/'partial.txt').write_text('partial')
    if mode=='copy-term': os.kill(os.getppid(),signal.SIGTERM)
    sys.exit(23 if mode=='copy-error' else 0)
shutil.copytree(source,target,dirs_exist_ok=True)
''')
            executable("mv", f"#!{sys.executable}\n" + '''import os,sys,subprocess,signal
a=sys.argv[1:]; source,target=a[-2:]; mode=os.environ['ROBB_FIXTURE_MODE']
if mode=='publish-error' and source.endswith('/Robb Agents.app') and target==os.environ['ROBB_FIXTURE_TARGET']:
    sys.exit(24)
result=subprocess.run(['/bin/mv',*a]).returncode
if result==0 and mode=='rename-term' and source==os.environ['ROBB_FIXTURE_TARGET']:
    os.kill(os.getppid(),signal.SIGTERM)
sys.exit(result)
''')
            environment = dict(os.environ, PATH=f"{bins}:{os.environ['PATH']}",
                ROBB_FIXTURE_REMOTE=str(remote), ROBB_FIXTURE_MODE=mode, ROBB_FIXTURE_TARGET=str(target),
                ROBB_RELEASE_BASE_URL="https://fixture.invalid", ROBB_DOWNLOAD_DIR=str(base / "downloads"),
                ROBB_INSTALL_DIR=str(target.parent), TMPDIR=str(base))
            result = subprocess.run(["bash", str(ROOT / "scripts/install-app.sh"), "--version", "1.2.3"],
                env=environment, text=True, capture_output=True, timeout=20)
            state = {"old": (target / "old.txt").exists(), "new": (target / "new.txt").exists(),
                "partial": (target / "partial.txt").exists(), "leftovers": any(path != target for path in target.parent.iterdir())}
            return result, state

    def test_normal_install_replaces_complete_bundle(self) -> None:
        result, state = self.run_installer("normal")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(state, {"old": False, "new": True, "partial": False, "leftovers": False})

    def test_copy_error_keeps_previous_bundle(self) -> None:
        result, state = self.run_installer("copy-error")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state, {"old": True, "new": False, "partial": False, "leftovers": False})

    def test_staged_signature_and_gatekeeper_fail_closed(self) -> None:
        for mode in ("codesign-error", "spctl-error"):
            with self.subTest(mode=mode):
                result, state = self.run_installer(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(state, {"old": True, "new": False, "partial": False, "leftovers": False})

    def test_sigterm_during_copy_keeps_previous_bundle(self) -> None:
        result, state = self.run_installer("copy-term")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state, {"old": True, "new": False, "partial": False, "leftovers": False})

    def test_sigterm_after_old_bundle_rename_restores_it(self) -> None:
        result, state = self.run_installer("rename-term")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state, {"old": True, "new": False, "partial": False, "leftovers": False})

    def test_publication_error_restores_previous_bundle(self) -> None:
        result, state = self.run_installer("publish-error")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(state, {"old": True, "new": False, "partial": False, "leftovers": False})


if __name__ == "__main__":
    unittest.main()
