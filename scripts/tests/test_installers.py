#!/usr/bin/env python3
"""Cross-platform contract tests for the public Robb installers."""
from __future__ import annotations

import contextlib
import functools
import http.server
import os
import pathlib
import platform
import shutil
import subprocess
import tempfile
import threading
import unittest
from collections.abc import Iterator


ROOT = pathlib.Path(__file__).resolve().parents[2]
SHELL_INSTALLER = ROOT / "scripts" / "install-app.sh"
POWERSHELL_INSTALLER = ROOT / "scripts" / "install-app.ps1"
VERSION = "1.2.3"
SHA512_FIXTURE = f"{'A' * 86}=="


class QuietRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format_string: str, *args: object) -> None:
        del format_string, args


@contextlib.contextmanager
def serve_directory(directory: pathlib.Path) -> Iterator[str]:
    handler = functools.partial(QuietRequestHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def write_manifest(path: pathlib.Path, artifact: str) -> None:
    path.write_text(
        "\n".join(
            [
                f"version: {VERSION}",
                "files:",
                f"  - url: {artifact}",
                f"    sha512: {SHA512_FIXTURE}",
                "    size: 123",
                f"path: {artifact}",
                f"sha512: {SHA512_FIXTURE}",
                "releaseDate: 2026-07-24T10:00:00.000Z",
                "",
            ]
        ),
        encoding="utf-8",
    )


class InstallerContractTests(unittest.TestCase):
    def test_shell_installer_uses_public_robb_release_contract(self) -> None:
        source = SHELL_INSTALLER.read_text(encoding="utf-8")
        required = [
            "robinswood-io/robb-agents",
            "releases/latest/download",
            'MANIFEST_NAME="latest-mac.yml"',
            'MANIFEST_NAME="latest-linux.yml"',
            'EXPECTED_ARTIFACT="Robb-Agents-${ARCH}.zip"',
            'EXPECTED_ARTIFACT="Robb-Agents-x64.AppImage"',
            'APP_NAME="Robb Agents.app"',
            'APP_BUNDLE_ID="io.robinswood.robbagents"',
            "openssl dgst -sha512 -binary",
            "codesign --verify --deep --strict",
            "spctl --assess --type execute",
            'export APPIMAGE="$APPIMAGE_PATH"',
        ]
        for token in required:
            self.assertIn(token, source)

        forbidden = [
            "agents.craft.do",
            "Craft-Agents-",
            "Craft Agents.app",
            "com.lukilabs.craft-agent",
            "xattr -rd com.apple.quarantine",
        ]
        for token in forbidden:
            self.assertNotIn(token, source)

    def test_powershell_installer_uses_public_robb_release_contract(self) -> None:
        source = POWERSHELL_INSTALLER.read_text(encoding="utf-8")
        required = [
            "robinswood-io/robb-agents",
            "releases/latest/download",
            "latest.yml",
            "^Robb-Agents-x64[^/\\\\]*\\.exe$",
            "SHA512",
            "Get-AuthenticodeSignature",
            "Programs\\Robb Agents",
            "Robb Agents.exe",
            "robb-agents.cmd",
        ]
        for token in required:
            self.assertIn(token, source)

        forbidden = [
            "agents.craft.do",
            "Craft-Agents-",
            "$APP_NAME = \"Craft Agents\"",
        ]
        for token in forbidden:
            self.assertNotIn(token, source)

    @unittest.skipUnless(shutil.which("bash"), "bash is not installed")
    def test_shell_installer_has_valid_bash_syntax(self) -> None:
        result = subprocess.run(
            ["bash", "-n", str(SHELL_INSTALLER)],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(
        shutil.which("bash") and platform.system() in {"Darwin", "Linux"},
        "Unix installer dry run requires macOS or Linux with bash",
    )
    def test_shell_installer_resolves_platform_manifest_in_dry_run(self) -> None:
        system = platform.system()
        machine = platform.machine().lower()
        with tempfile.TemporaryDirectory(prefix="robb-installer-test-") as temporary:
            release_dir = pathlib.Path(temporary)
            if system == "Darwin":
                architecture = "arm64" if machine in {"arm64", "aarch64"} else "x64"
                manifest_name = "latest-mac.yml"
                artifact = f"Robb-Agents-{architecture}.zip"
            else:
                if machine not in {"x86_64", "amd64"}:
                    self.skipTest(f"Linux {machine} is not a released architecture")
                manifest_name = "latest-linux.yml"
                artifact = "Robb-Agents-x64.AppImage"

            write_manifest(release_dir / manifest_name, artifact)
            with serve_directory(release_dir) as release_url:
                environment = os.environ.copy()
                environment["ROBB_RELEASE_BASE_URL"] = release_url
                result = subprocess.run(
                    [
                        "bash",
                        str(SHELL_INSTALLER),
                        "--version",
                        VERSION,
                        "--dry-run",
                    ],
                    text=True,
                    capture_output=True,
                    check=False,
                    env=environment,
                )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Robb Agents {VERSION}", result.stdout)
        self.assertIn("Release metadata is valid", result.stdout)

    @unittest.skipUnless(
        platform.system() == "Windows" and shutil.which("pwsh"),
        "Windows installer dry run requires PowerShell 7 on Windows",
    )
    def test_powershell_installer_resolves_manifest_in_dry_run(self) -> None:
        with tempfile.TemporaryDirectory(prefix="robb-installer-test-") as temporary:
            release_dir = pathlib.Path(temporary)
            write_manifest(release_dir / "latest.yml", "Robb-Agents-x64.exe")
            with serve_directory(release_dir) as release_url:
                environment = os.environ.copy()
                environment["ROBB_RELEASE_BASE_URL"] = release_url
                result = subprocess.run(
                    [
                        "pwsh",
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(POWERSHELL_INSTALLER),
                        "-Version",
                        VERSION,
                        "-DryRun",
                    ],
                    text=True,
                    capture_output=True,
                    check=False,
                    env=environment,
                )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Robb Agents {VERSION}", result.stdout)
        self.assertIn("Release metadata is valid", result.stdout)


if __name__ == "__main__":
    unittest.main()
