#!/usr/bin/env python3
"""Validate a packaged Robb Agents Linux AppImage.

The static check extracts the AppImage and validates its desktop metadata and
runtime payload. ``--launch`` additionally exercises the extracted application
under Xvfb and waits for a live Electron renderer through the Chrome DevTools
Protocol. Neither mode requires FUSE or application credentials.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from robb_package_audit import audit_package, artifact_size_finding, format_bytes, print_report


ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_DIR = ROOT / "apps" / "electron"
PACKAGE_JSON = ELECTRON_DIR / "package.json"


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    raise SystemExit(1)


def require(path: pathlib.Path, label: str) -> None:
    if not path.exists():
        fail(f"Missing {label}: {path}")


def expected_version() -> str:
    try:
        value = json.loads(PACKAGE_JSON.read_text(encoding="utf-8")).get("version")
    except (OSError, json.JSONDecodeError) as error:
        fail(f"Cannot read Electron package metadata: {error}")
    if not isinstance(value, str) or not value:
        fail("Electron package version is missing")
    return value


def find_one(root: pathlib.Path, suffix: str, label: str) -> pathlib.Path:
    matches = list(root.glob(f"**/{suffix}"))
    if not matches:
        fail(f"Missing {label} in extracted AppImage ({suffix})")
    return matches[0]


def reserve_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def read_cdp_targets(port: int) -> list[object]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=1) as response:
            payload: object = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return []
    return payload if isinstance(payload, list) else []


def has_robb_renderer(targets: list[object]) -> bool:
    for target in targets:
        if not isinstance(target, dict):
            continue
        if target.get("type") == "page" and target.get("title") == "Robb Agents":
            return True
    return False


def launch_smoke(root: pathlib.Path, timeout_seconds: int) -> None:
    xvfb_run = shutil.which("xvfb-run")
    if xvfb_run is None:
        fail("--launch requires xvfb-run (install the xvfb package)")

    port = reserve_loopback_port()
    with tempfile.TemporaryDirectory(prefix="robb-linux-runtime-") as runtime:
        runtime_dir = pathlib.Path(runtime)
        config_dir = runtime_dir / "craft"
        config_dir.mkdir()
        env = os.environ.copy()
        env.update(
            {
                "CRAFT_CONFIG_DIR": str(config_dir),
                "CRAFT_INSTANCE_NUMBER": "linux-appimage-e2e",
                "CRAFT_DEEPLINK_SCHEME": "robbagentslinuxsmoke",
                "HOME": str(runtime_dir),
                "XDG_CACHE_HOME": str(runtime_dir / "cache"),
                "XDG_CONFIG_HOME": str(runtime_dir / "config"),
                "XDG_DATA_HOME": str(runtime_dir / "data"),
            }
        )
        command = [
            xvfb_run,
            "-a",
            str(root / "AppRun"),
            "--no-sandbox",
            f"--remote-debugging-port={port}",
        ]
        process = subprocess.Popen(
            command,
            cwd=root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + timeout_seconds
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    output = process.stdout.read() if process.stdout else ""
                    fail(
                        "Extracted AppImage exited before exposing a renderer "
                        f"(code {process.returncode}): {output[-4000:]}"
                    )
                if has_robb_renderer(read_cdp_targets(port)):
                    print("✓ Linux AppImage exposes a live Robb Agents renderer through CDP")
                    return
                time.sleep(0.5)
            output = ""
            if process.stdout is not None:
                process.stdout.flush()
            fail(
                "Extracted AppImage did not expose a Robb Agents renderer "
                f"within {timeout_seconds} seconds{output}"
            )
        finally:
            if process.poll() is None:
                os.killpg(process.pid, 15)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, 9)
                    process.wait(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--appimage", type=pathlib.Path, required=True, help="Path to Robb Agents AppImage")
    parser.add_argument("--launch", action="store_true", help="launch the extracted application under Xvfb")
    parser.add_argument(
        "--launch-timeout",
        type=int,
        default=45,
        help="maximum seconds to wait for a live Electron renderer",
    )
    args = parser.parse_args()
    if args.launch_timeout < 1:
        fail("--launch-timeout must be positive")

    appimage = args.appimage.resolve()
    require(appimage, "AppImage")
    artifact_finding = artifact_size_finding(appimage)
    if artifact_finding is not None:
        fail(f"{artifact_finding.path}: {artifact_finding.reason}")
    print(f"✓ AppImage size {format_bytes(appimage.stat().st_size)}")
    if not os.access(appimage, os.X_OK):
        fail(f"AppImage is not executable: {appimage}")
    if appimage.read_bytes()[:4] != b"\x7fELF":
        fail(f"AppImage is not an ELF executable: {appimage}")

    with tempfile.TemporaryDirectory(prefix="robb-appimage-") as temporary:
        extract_dir = pathlib.Path(temporary)
        result = subprocess.run(
            [str(appimage), "--appimage-extract"],
            cwd=extract_dir,
            text=True,
            capture_output=True,
            check=False,
            timeout=120,
        )
        if result.returncode != 0:
            fail(f"AppImage extraction failed: {result.stdout[-2000:]}{result.stderr[-2000:]}")

        root = extract_dir / "squashfs-root"
        require(root, "extracted AppImage root")
        package_report = audit_package(root)
        print_report(package_report)
        if not package_report.ok:
            fail("Extracted AppImage failed recursive release or unpacked size audit")
        require(root / "AppRun", "AppImage launcher")
        desktop = find_one(root, "*.desktop", "desktop entry")
        desktop_text = desktop.read_text(encoding="utf-8", errors="replace")
        has_exec = any(line.startswith("Exec=") and len(line) > len("Exec=") for line in desktop_text.splitlines())
        if "Name=Robb Agents" not in desktop_text or not has_exec:
            fail(f"Invalid desktop metadata in {desktop.relative_to(root)}")

        executables = [path for path in root.rglob("robb-agents") if path.is_file() and os.access(path, os.X_OK)]
        if not executables:
            fail("Missing executable Linux Robb Agents binary in extracted AppImage")

        find_one(root, "resources/app.asar", "integrity-protected ASAR")
        find_one(root, "resources/app/resources/pi-agent-server/index.js", "Pi agent server")
        find_one(root, "resources/app/resources/pi-agent-server/vibe-acp-server.js", "Mistral Vibe ACP bridge")
        if (root.joinpath("resources/app/dist/main.cjs").exists()):
            fail("Electron main entrypoint escaped the integrity-protected app.asar")
        bundled_bun = find_one(root, "resources/app/vendor/bun/bun", "bundled Bun runtime")
        if not os.access(bundled_bun, os.X_OK):
            fail(f"Bundled Bun runtime is not executable: {bundled_bun}")
        claude = find_one(root, "resources/app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude", "Claude native runtime")
        if not os.access(claude, os.X_OK):
            fail(f"Claude native runtime is not executable: {claude}")
        ripgrep = find_one(root, "resources/app/node_modules/@vscode/ripgrep/bin/rg", "ripgrep runtime")
        if not os.access(ripgrep, os.X_OK):
            fail(f"ripgrep runtime is not executable: {ripgrep}")
        rtk = find_one(root, "resources/app/resources/bin/linux-x64/rtk", "bundled RTK")
        if not os.access(rtk, os.X_OK):
            fail(f"Bundled RTK is not executable: {rtk}")
        version = subprocess.run([str(rtk), "--version"], text=True, capture_output=True, check=False, timeout=10)
        if version.returncode != 0 or not version.stdout.strip().startswith("rtk "):
            fail(f"Bundled RTK version check failed: {version.stdout}{version.stderr}")
        gain = subprocess.run([str(rtk), "gain", "--format", "json"], text=True, capture_output=True, check=False, timeout=10)
        try:
            parsed_gain = json.loads(gain.stdout) if gain.returncode == 0 else None
        except json.JSONDecodeError:
            parsed_gain = None
        if not isinstance(parsed_gain, dict) or not isinstance(parsed_gain.get("summary"), dict):
            fail(f"Bundled RTK gain JSON check failed: {gain.stdout}{gain.stderr}")
        if args.launch:
            launch_smoke(root, args.launch_timeout)

    print(f"✓ Linux AppImage metadata for Robb Agents {expected_version()}")
    print("✓ Linux desktop entry and bundled Bun, Claude, ripgrep, RTK and Pi/Vibe runtimes")


if __name__ == "__main__":
    main()
