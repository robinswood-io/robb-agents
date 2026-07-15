#!/usr/bin/env python3
"""Validate a packaged Robb Agents Linux AppImage without launching its UI.

The check extracts the AppImage in a temporary directory and confirms that the
Linux desktop entry and the bundled Pi/Vibe subprocesses are present. It is
safe for headless CI and does not require FUSE or any credential.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile


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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--appimage", type=pathlib.Path, required=True, help="Path to Robb Agents AppImage")
    args = parser.parse_args()

    appimage = args.appimage.resolve()
    require(appimage, "AppImage")
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
        require(root / "AppRun", "AppImage launcher")
        desktop = find_one(root, "*.desktop", "desktop entry")
        desktop_text = desktop.read_text(encoding="utf-8", errors="replace")
        has_exec = any(line.startswith("Exec=") and len(line) > len("Exec=") for line in desktop_text.splitlines())
        if "Name=Robb Agents" not in desktop_text or not has_exec:
            fail(f"Invalid desktop metadata in {desktop.relative_to(root)}")

        executables = [path for path in root.rglob("robb-agents") if path.is_file() and os.access(path, os.X_OK)]
        if not executables:
            fail("Missing executable Linux Robb Agents binary in extracted AppImage")

        find_one(root, "resources/app/dist/resources/pi-agent-server/index.js", "Pi agent server")
        find_one(root, "resources/app/dist/resources/pi-agent-server/vibe-acp-server.js", "Mistral Vibe ACP bridge")

    print(f"✓ Linux AppImage metadata for Robb Agents {expected_version()}")
    print("✓ Linux desktop entry, Pi agent server and Mistral Vibe ACP bridge")


if __name__ == "__main__":
    main()
