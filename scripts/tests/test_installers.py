#!/usr/bin/env python3
"""Cross-platform contract tests for the public Robb installers."""
from __future__ import annotations

import contextlib
import functools
import http.server
import json
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
ELECTRON_UPDATER = ROOT / "apps" / "electron" / "src" / "main" / "auto-update.ts"
WINDOWS_INSTALLER_E2E = ROOT / "scripts" / "robinswood-windows-installer-e2e.ps1"
VERSION = "1.2.3"
SHA512_FIXTURE = f"{'A' * 86}=="
PLATFORM_BUILD_SCRIPTS = (
    ROOT / "apps" / "electron" / "scripts" / "build-dmg.sh",
    ROOT / "apps" / "electron" / "scripts" / "build-linux.sh",
    ROOT / "apps" / "electron" / "scripts" / "build-win.ps1",
    ROOT / "scripts" / "build" / "darwin.ts",
    ROOT / "scripts" / "build" / "linux.ts",
    ROOT / "scripts" / "build" / "win32.ts",
)


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
    def test_electron_updater_uses_single_flight_download_and_transactional_macos_swap(self) -> None:
        source = ELECTRON_UPDATER.read_text(encoding="utf-8")
        required = [
            "let updateDownloadPromise: Promise<UpdateInfo> | null = null",
            "if (updateDownloadPromise) return updateDownloadPromise",
            "basename(configuredPath)",
            "right.modifiedAt - left.modifiedAt",
            "Ignored unsafe updater cache directory name",
            "Refusing unsafe macOS application replacement target",
            "Unsafe application replacement target",
            "Staging verified update beside installed application",
            "Replacing installed application transactionally",
            "restore_previous_app",
            'mv "$APP_PATH" "$OLD_APP_PATH"',
            'mv "$STAGED_APP" "$APP_PATH"',
            'rm -f "$0"',
        ]
        for token in required:
            self.assertIn(token, source)

        self.assertNotIn(
            'rm -rf "$APP_PATH"\nditto "$SRC" "$APP_PATH"',
            source,
        )

    @unittest.skipUnless(
        shutil.which("bash") and platform.system() in {"Darwin", "Linux"},
        "Embedded macOS updater syntax validation requires macOS or Linux with bash",
    )
    def test_embedded_macos_updater_has_valid_bash_syntax(self) -> None:
        source = ELECTRON_UPDATER.read_text(encoding="utf-8")
        prefix = "const script = `"
        start = source.index(prefix) + len(prefix)
        end = source.index("`\n  writeFileSync", start)
        script = source[start:end].replace(r"\${", "${")
        result = subprocess.run(
            ["bash", "-n"],
            input=script,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_platform_builds_use_the_bun_workspace_executor(self) -> None:
        for script in PLATFORM_BUILD_SCRIPTS:
            source = script.read_text(encoding="utf-8")
            self.assertIn("bun x --bun electron-builder", source, str(script))
            self.assertNotIn("npx electron-builder", source, str(script))

        mac_build = (ROOT / "apps" / "electron" / "scripts" / "build-dmg.sh").read_text(encoding="utf-8")
        windows_build = (ROOT / "apps" / "electron" / "scripts" / "build-win.ps1").read_text(encoding="utf-8")
        linux_build = (ROOT / "apps" / "electron" / "scripts" / "build-linux.sh").read_text(encoding="utf-8")
        validation_workflow = (ROOT / ".github" / "workflows" / "robinswood-validate.yml").read_text(encoding="utf-8")
        self.assertIn("export CSC_IDENTITY_AUTO_DISCOVERY=false", mac_build)
        self.assertIn("unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME", mac_build)
        self.assertIn("export ROBB_BUILD_CHANNEL=production", mac_build)
        self.assertIn("export ROBB_BUILD_CHANNEL=development", mac_build)
        self.assertIn("releaseIntegrity.cjs", mac_build)
        self.assertIn("--config.mac.forceCodeSigning=true", mac_build)
        self.assertIn("--config.mac.forceCodeSigning=false", mac_build)
        self.assertIn("--config.mac.identity=-", mac_build)
        self.assertIn('$env:ROBB_BUILD_CHANNEL = "production"', windows_build)
        self.assertIn('$env:ROBB_BUILD_CHANNEL = "development"', windows_build)
        self.assertIn("releaseIntegrity.cjs", windows_build)
        self.assertIn('$BunVersion = "bun-v1.3.14"', windows_build)
        self.assertIn('bun-version: "1.3.14"', validation_workflow)
        self.assertIn("export ROBB_BUILD_CHANNEL=production", linux_build)
        self.assertIn("export ROBB_BUILD_CHANNEL=development", linux_build)
        self.assertIn("Linux arm64 is a local development artifact only", linux_build)

        release_builder = (ROOT / "apps" / "electron" / "electron-builder.yml").read_text(encoding="utf-8")
        development_builder = (ROOT / "apps" / "electron" / "electron-builder.dev.yml").read_text(encoding="utf-8")
        self.assertIn("beforePack: scripts/releaseIntegrity.cjs", release_builder)
        self.assertIn("afterSign: scripts/afterSign.cjs", release_builder)
        self.assertIn("forceCodeSigning: true", release_builder)
        self.assertIn("forceCodeSigning: false", development_builder)
        self.assertIn("asar: true", release_builder)
        self.assertIn("enableEmbeddedAsarIntegrityValidation: true", release_builder)
        self.assertIn("onlyLoadAppFromAsar: true", release_builder)
        self.assertIn("asar: false", development_builder)
        self.assertIn("electronFuses: null", development_builder)
        self.assertIn('identity: "-"', development_builder)

        for script in PLATFORM_BUILD_SCRIPTS[:3]:
            self.assertIn(
                "validate-electron-package-security.ts",
                script.read_text(encoding="utf-8"),
                str(script),
            )

        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        for dependency in ("postcss", "tar"):
            self.assertEqual(
                package["devDependencies"][dependency],
                package["overrides"][dependency],
                f"{dependency} must be pinned to the same spec as its npm override",
            )

    def test_windows_installer_e2e_uses_packaged_paths_and_ephemeral_cdp_port(self) -> None:
        source = WINDOWS_INSTALLER_E2E.read_text(encoding="utf-8")
        self.assertIn(
            r"resources\app\resources\pi-agent-server\vibe-acp-server.js",
            source,
        )
        self.assertIn(r"resources\app\resources\bin\win32-x64\rtk.exe", source)
        self.assertIn("[System.Net.Sockets.TcpListener]::new", source)
        self.assertIn("Get-AvailableLoopbackPort", source)
        self.assertIn("Get-InstalledAppProcesses", source)
        self.assertIn("[System.StringComparison]::OrdinalIgnoreCase", source)
        self.assertIn("Write-StartupDiagnostics $InstallDir $SmokeConfig", source)
        self.assertIn("[switch]$RequireAuthenticode", source)
        self.assertIn("Get-AuthenticodeSignature $app", source)
        self.assertIn("Installed executable Authenticode verification failed", source)
        self.assertIn("[int]$MaxInstalledMiB = 1024", source)
        self.assertIn("--max-mib $MaxInstalledMiB", source)
        self.assertNotIn(r"resources\app\dist\resources", source)
        self.assertNotIn("$DebugPort = 9229", source)
        self.assertNotIn('Win32_Process -Filter "ParentProcessId =', source)

    def test_windows_release_requires_dual_authenticode_proof_before_provenance(self) -> None:
        windows_build = (ROOT / "apps" / "electron" / "scripts" / "build-win.ps1").read_text(
            encoding="utf-8"
        )
        workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")

        unpacked_build_check = (
            'Require-ValidAuthenticodeSignature $UnpackedBinary "unpacked Electron binary"'
        )
        installer_build_check = (
            'Require-ValidAuthenticodeSignature $Installer.FullName "NSIS installer"'
        )
        self.assertIn("Get-AuthenticodeSignature $Path", windows_build)
        self.assertIn(unpacked_build_check, windows_build)
        self.assertIn(installer_build_check, windows_build)
        self.assertLess(windows_build.index(unpacked_build_check), windows_build.index(installer_build_check))
        self.assertLess(windows_build.index(installer_build_check), windows_build.index("=== Build complete ==="))

        unpacked_workflow_path = (
            "$unpackedBinary = 'apps/electron/release/win-unpacked/Robb Agents.exe'"
        )
        installer_workflow_check = (
            "Assert-ValidAuthenticodeSignature $installer.FullName 'installer'"
        )
        unpacked_workflow_check = (
            "Assert-ValidAuthenticodeSignature $unpackedBinary 'unpacked executable'"
        )
        signed_provenance = "$signing = 'verified-authenticode'"
        for token in (
            unpacked_workflow_path,
            installer_workflow_check,
            unpacked_workflow_check,
            signed_provenance,
            "$e2eArgs += '-RequireAuthenticode'",
        ):
            self.assertIn(token, workflow)
        self.assertLess(workflow.index(installer_workflow_check), workflow.index(unpacked_workflow_check))
        self.assertLess(workflow.index(unpacked_workflow_check), workflow.index(signed_provenance))

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
            "PROVENANCE-windows-x64.txt",
            "verified-authenticode",
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
        self.assertNotIn("unsigned-github-release", source)

    @unittest.skipUnless(
        shutil.which("bash") and platform.system() in {"Darwin", "Linux"},
        "Bash syntax validation requires macOS or Linux with bash",
    )
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
