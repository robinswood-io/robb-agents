#!/usr/bin/env python3
"""Static validation for a Robb Agents Windows NSIS installer.

The test is deliberately platform-neutral: macOS/Linux CI can check the public
artifact naming, PE header, embedded Robb metadata and published SHA-256 before
Windows runners execute the actual installer build.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INSTALLER = ROOT / "apps" / "electron" / "release" / "Robb-Agents-x64.exe"
DEFAULT_CHECKSUMS = ROOT / "apps" / "electron" / "release" / "SHA256SUMS-windows-x64.txt"


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    raise SystemExit(1)


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, default=DEFAULT_INSTALLER)
    parser.add_argument("--checksums", type=Path, default=DEFAULT_CHECKSUMS)
    args = parser.parse_args()

    installer = args.installer.resolve()
    checksums = args.checksums.resolve()
    if not installer.is_file():
        fail(f"Missing Windows installer: {installer}")
    if not checksums.is_file():
        fail(f"Missing Windows checksum file: {checksums}")
    if not installer.name.startswith("Robb-Agents-x64") or installer.suffix.lower() != ".exe":
        fail(f"Unexpected installer name: {installer.name}")
    if installer.stat().st_size < 1_000_000:
        fail(f"Installer is implausibly small: {installer.stat().st_size} bytes")

    with installer.open("rb") as handle:
        if handle.read(2) != b"MZ":
            fail("Installer does not have a Windows PE/NSIS MZ header")
        contains_product_metadata = False
        while chunk := handle.read(1024 * 1024):
            if b"Robb Agents" in chunk:
                contains_product_metadata = True
                break
    if not contains_product_metadata:
        fail("Installer does not contain expected Robb Agents product metadata")

    expected_line = f"{digest(installer)}  {installer.name}"
    lines = {line.strip() for line in checksums.read_text(encoding="utf-8").splitlines() if line.strip()}
    if expected_line not in lines:
        fail("SHA-256 checksum file does not match installer")

    print("✓ Windows installer name and size")
    print("✓ Windows PE/NSIS header and Robb metadata")
    print("✓ Windows installer SHA-256 checksum")


if __name__ == "__main__":
    main()
