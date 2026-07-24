#!/usr/bin/env python3
"""Smoke-test a locally packaged Robb Agents macOS build.

Run after:

    cd apps/electron && bash scripts/build-dmg.sh arm64

The script validates the generated app bundle and DMG metadata without requiring
Developer ID signing. Use --launch for a short isolated runtime smoke-test.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from robb_package_audit import (
    audit_package,
    artifact_size_finding,
    format_bytes,
    print_report,
)

ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_DIR = ROOT / "apps" / "electron"
RELEASE_DIR = ELECTRON_DIR / "release"
APP_NAME = "Robb Agents.app"
APP_DIR = RELEASE_DIR / "mac-arm64" / APP_NAME
APP_BIN = APP_DIR / "Contents" / "MacOS" / "Robb Agents"
PLIST = APP_DIR / "Contents" / "Info.plist"
PACKAGED_ICON = APP_DIR / "Contents" / "Resources" / "icon.icns"
# Pi providers run as explicit resource subprocesses. In particular, this is
# the credential-free ACP bridge for Mistral Vibe subscriptions.
PACKAGED_PI_AGENT_SERVER = APP_DIR / "Contents" / "Resources" / "app" / "dist" / "resources" / "pi-agent-server" / "index.js"
PACKAGED_VIBE_ACP_BRIDGE = APP_DIR / "Contents" / "Resources" / "app" / "dist" / "resources" / "pi-agent-server" / "vibe-acp-server.js"
SOURCE_ICON = ELECTRON_DIR / "resources" / "robinswood-icon.icns"
DMG = RELEASE_DIR / "Robb-Agents-arm64.dmg"
ZIP = RELEASE_DIR / "Robb-Agents-arm64.zip"
PACKAGE_JSON = ELECTRON_DIR / "package.json"
ARCH = "arm64"


def configure_arch(arch: str) -> None:
    global APP_DIR, APP_BIN, PLIST, PACKAGED_ICON, PACKAGED_PI_AGENT_SERVER
    global PACKAGED_VIBE_ACP_BRIDGE, DMG, ZIP, ARCH

    ARCH = arch
    app_output_directory = "mac-arm64" if arch == "arm64" else "mac"
    APP_DIR = RELEASE_DIR / app_output_directory / APP_NAME
    APP_BIN = APP_DIR / "Contents" / "MacOS" / "Robb Agents"
    PLIST = APP_DIR / "Contents" / "Info.plist"
    PACKAGED_ICON = APP_DIR / "Contents" / "Resources" / "icon.icns"
    PACKAGED_PI_AGENT_SERVER = (
        APP_DIR / "Contents" / "Resources" / "app" / "dist" / "resources" / "pi-agent-server" / "index.js"
    )
    PACKAGED_VIBE_ACP_BRIDGE = (
        APP_DIR
        / "Contents"
        / "Resources"
        / "app"
        / "dist"
        / "resources"
        / "pi-agent-server"
        / "vibe-acp-server.js"
    )
    DMG = RELEASE_DIR / f"Robb-Agents-{arch}.dmg"
    ZIP = RELEASE_DIR / f"Robb-Agents-{arch}.zip"


def expected_app_version() -> str:
    with PACKAGE_JSON.open("r", encoding="utf-8") as handle:
        package = json.load(handle)
    version = package.get("version")
    if not isinstance(version, str) or not version:
        fail(f"Invalid Electron package version in {PACKAGE_JSON}")
    return version


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    raise SystemExit(1)


def run(cmd: list[str], *, env: dict[str, str] | None = None, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, env=env, timeout=timeout, check=False)


def require(path: pathlib.Path, label: str) -> None:
    if not path.exists():
        fail(f"Missing {label}: {path}")


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def check_bundle(require_release_signing: bool = False) -> None:
    require(APP_DIR, "packaged app bundle")
    require(APP_BIN, "packaged app executable")
    require(PLIST, "Info.plist")
    require(PACKAGED_ICON, "packaged app icon")
    require(PACKAGED_PI_AGENT_SERVER, "packaged Pi agent server")
    require(PACKAGED_VIBE_ACP_BRIDGE, "packaged Mistral Vibe ACP bridge")
    require(SOURCE_ICON, "Robinswood source icon")

    with PLIST.open("rb") as handle:
        plist = plistlib.load(handle)

    version = expected_app_version()
    expected = {
        "CFBundleName": "Robb Agents",
        "CFBundleDisplayName": "Robb Agents",
        "CFBundleExecutable": "Robb Agents",
        "CFBundleIdentifier": "io.robinswood.robbagents",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "CFBundleIconFile": "icon.icns",
    }
    mismatches = [f"{key}={plist.get(key)!r} (expected {value!r})" for key, value in expected.items() if plist.get(key) != value]
    if mismatches:
        fail("Invalid packaged Info.plist: " + "; ".join(mismatches))

    file_result = run(["file", str(APP_BIN)])
    expected_architecture = "arm64" if ARCH == "arm64" else "x86_64"
    if file_result.returncode != 0 or f"Mach-O 64-bit executable {expected_architecture}" not in file_result.stdout:
        fail(f"Packaged executable is not {expected_architecture}: {file_result.stdout}{file_result.stderr}")

    if sha256(PACKAGED_ICON) != sha256(SOURCE_ICON):
        fail("Packaged icon.icns does not match resources/robinswood-icon.icns")

    package_report = audit_package(APP_DIR)
    print_report(package_report)
    if not package_report.ok:
        fail("Packaged app failed recursive release or unpacked size audit")

    code_result = run(["codesign", "-dv", str(APP_DIR)])
    code_text = code_result.stdout + code_result.stderr
    if code_result.returncode != 0:
        fail(f"codesign inspection failed: {code_text}")
    is_adhoc = "Signature=adhoc" in code_text or "TeamIdentifier=not set" in code_text
    if is_adhoc:
        if require_release_signing:
            fail("Release validation requires a Developer ID signature, but the packaged app is ad-hoc signed")
        print("- packaged app uses ad-hoc signature; skipping Developer ID signature identifier check")
    elif "Identifier=io.robinswood.robbagents" not in code_text:
        fail("Packaged app signature does not expose io.robinswood.robbagents identifier")
    else:
        print("✓ packaged signature identifier")

    if require_release_signing:
        verify_result = run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(APP_DIR)])
        if verify_result.returncode != 0:
            fail(f"Developer ID signature verification failed: {verify_result.stdout}{verify_result.stderr}")
        gatekeeper_result = run(["spctl", "--assess", "--verbose", "--type", "exec", str(APP_DIR)])
        gatekeeper_text = gatekeeper_result.stdout + gatekeeper_result.stderr
        if gatekeeper_result.returncode != 0 or "Notarized Developer ID" not in gatekeeper_text:
            fail(f"Notarization assessment failed: {gatekeeper_text}")
        stapler_result = run(["xcrun", "stapler", "validate", str(APP_DIR)])
        if stapler_result.returncode != 0:
            fail(f"Notarization ticket validation failed: {stapler_result.stdout}{stapler_result.stderr}")
        print("✓ Developer ID signature, Gatekeeper assessment and notarization ticket")

    print("✓ packaged app bundle metadata")
    print(f"✓ packaged app architecture {expected_architecture}")
    print("✓ packaged Robinswood icon")
    print("✓ packaged Pi agent server and Mistral Vibe ACP bridge")


def check_dmg() -> None:
    require(DMG, f"Robinswood {ARCH} DMG")
    require(ZIP, f"Robinswood {ARCH} ZIP")
    for artifact in (DMG, ZIP):
        finding = artifact_size_finding(artifact)
        if finding is not None:
            fail(f"{finding.path}: {finding.reason}")
        print(f"✓ {artifact.name} size {format_bytes(artifact.stat().st_size)}")
    if shutil.which("hdiutil") is None:
        print("- hdiutil unavailable; skipping DMG mount check")
        return

    with tempfile.TemporaryDirectory(prefix="robinswood-dmg-") as tmp:
        mount = pathlib.Path(tmp) / "mount"
        mount.mkdir()
        attach = run(["hdiutil", "attach", str(DMG), "-mountpoint", str(mount), "-nobrowse", "-readonly"], timeout=180)
        if attach.returncode != 0:
            fail(f"Could not mount DMG: {attach.stdout}{attach.stderr}")
        try:
            mounted_app = mount / APP_NAME
            mounted_plist = mounted_app / "Contents" / "Info.plist"
            require(mounted_app, "DMG Robb Agents.app")
            require(mounted_app / "Contents" / "Resources" / "app" / "dist" / "resources" / "pi-agent-server" / "vibe-acp-server.js", "DMG Mistral Vibe ACP bridge")
            with mounted_plist.open("rb") as handle:
                plist = plistlib.load(handle)
            if plist.get("CFBundleName") != "Robb Agents" or plist.get("CFBundleIdentifier") != "io.robinswood.robbagents":
                fail("DMG-mounted app has invalid Robinswood metadata")
        finally:
            detach = run(["hdiutil", "detach", str(mount)], timeout=60)
            if detach.returncode != 0:
                print(f"Warning: could not detach DMG mount: {detach.stdout}{detach.stderr}", file=sys.stderr)

    print("✓ DMG mounts with Robb Agents.app")


def pids_for_packaged_app() -> set[int]:
    ps = run(["ps", "ax", "-o", "pid=", "-o", "args="])
    if ps.returncode != 0:
        return set()
    pids: set[int] = set()
    app_bin = str(APP_BIN)
    for line in ps.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_text, _, args = line.partition(" ")
        if args == app_bin or args.startswith(app_bin + " "):
            try:
                pids.add(int(pid_text))
            except ValueError:
                pass
    return pids


def terminate_pids(pids: set[int]) -> None:
    for pid in sorted(pids):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.time() + 5
    while time.time() < deadline:
        remaining = {pid for pid in pids if pathlib.Path(f"/proc/{pid}").exists()} if sys.platform.startswith("linux") else pids_for_packaged_app().intersection(pids)
        if not remaining:
            return
        time.sleep(0.25)
    for pid in sorted(pids):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def launch_smoke(seconds: int) -> None:
    existing = pids_for_packaged_app()
    if existing:
        fail("Packaged Robb Agents is already running; close it before --launch smoke-test. PIDs: " + ", ".join(map(str, sorted(existing))))

    smoke_dir = pathlib.Path.home() / ".craft-agent-robinswood-packaged-smoke"
    if smoke_dir.exists():
        shutil.rmtree(smoke_dir)
    smoke_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env.update(
        {
            "CRAFT_CONFIG_DIR": str(smoke_dir),
            "CRAFT_INSTANCE_NUMBER": "robinswood-packaged-smoke",
            "CRAFT_DEEPLINK_SCHEME": "robbagentssmoke",
        }
    )
    proc = subprocess.Popen([str(APP_BIN)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    launched_pids: set[int] = set()
    try:
        time.sleep(seconds)
        launched_pids = pids_for_packaged_app()
        if proc.poll() is not None and not launched_pids:
            output = proc.stdout.read() if proc.stdout else ""
            fail(f"Packaged app exited during launch smoke-test with code {proc.returncode}:\n{output[-4000:]}")
        print(f"✓ packaged app launch smoke-test ({seconds}s)")
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        terminate_pids(launched_pids)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=("arm64", "x64"), default="arm64", help="packaged macOS architecture")
    parser.add_argument("--launch", action="store_true", help="also launch the packaged app briefly with an isolated config directory")
    parser.add_argument("--launch-seconds", type=int, default=12, help="duration for --launch smoke-test")
    parser.add_argument("--require-release-signing", action="store_true", help="require Developer ID signing plus a stapled notarization ticket")
    args = parser.parse_args()

    configure_arch(args.arch)
    check_bundle(require_release_signing=args.require_release_signing)
    check_dmg()
    if args.launch:
        launch_smoke(args.launch_seconds)
    print("Robinswood packaged smoke-test passed")


if __name__ == "__main__":
    main()
