#!/usr/bin/env python3
"""Robinswood macOS signing/notarization preflight.

This script checks whether the local machine has the inputs required for an
externally distributable Robinswood Agents macOS build. It never prints secret
values; it only reports whether they are present.

Usage:

    python3 scripts/robinswood-signing-preflight.py
    python3 scripts/robinswood-signing-preflight.py --strict

Use --strict in release automation to fail when any signing/notarization input
is missing.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import plistlib
import re
import subprocess
import sys
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_BUILDER = ROOT / "apps/electron/electron-builder.yml"
APP_ID = "io.robinswood.agents"
PRODUCT_NAME = "Robinswood Agents"
REQUIRED_ENV = [
    "APPLE_ID",
    "APPLE_TEAM_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
]
OPTIONAL_SIGNING_ENV = [
    "APPLE_SIGNING_IDENTITY",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
]


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    required: bool = True


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def masked_present(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        return "missing"
    return "present"


def check_builder_metadata() -> list[Check]:
    text = ELECTRON_BUILDER.read_text(encoding="utf-8")
    return [
        Check("electron-builder appId", f"appId: {APP_ID}" in text, APP_ID),
        Check("electron-builder productName", f"productName: {PRODUCT_NAME}" in text, PRODUCT_NAME),
        Check("mac hardenedRuntime", "hardenedRuntime: true" in text, "required for notarized macOS distribution"),
        Check("mac entitlements", "entitlements: build/entitlements.mac.plist" in text, "build/entitlements.mac.plist"),
        Check("Robinswood artifact names", "Robinswood-Agents-${arch}" in text, "Robinswood-Agents-*"),
    ]


def check_keychain_identity() -> Check:
    security = run(["security", "find-identity", "-v", "-p", "codesigning"])
    output = security.stdout + security.stderr
    if security.returncode != 0:
        return Check("Developer ID Application identity", False, output.strip() or "security find-identity failed")
    identities = [line.strip() for line in output.splitlines() if "Developer ID Application:" in line and "REVOKED" not in line]
    configured = os.environ.get("APPLE_SIGNING_IDENTITY", "").replace("Developer ID Application: ", "").strip()
    if configured:
        match = [line for line in identities if configured in line]
        return Check(
            "Developer ID Application identity",
            bool(match),
            f"configured APPLE_SIGNING_IDENTITY {'matches keychain' if match else 'not found in keychain'}",
        )
    return Check(
        "Developer ID Application identity",
        bool(identities),
        f"{len(identities)} Developer ID Application identit{'y' if len(identities) == 1 else 'ies'} found",
    )


def check_env() -> list[Check]:
    checks = [Check(f"env {name}", bool(os.environ.get(name)), masked_present(name)) for name in REQUIRED_ENV]
    checks.extend(Check(f"env {name}", bool(os.environ.get(name)), masked_present(name), required=False) for name in OPTIONAL_SIGNING_ENV)
    has_identity_or_csc = bool(os.environ.get("APPLE_SIGNING_IDENTITY") or os.environ.get("CSC_LINK"))
    checks.append(Check("signing material", has_identity_or_csc, "APPLE_SIGNING_IDENTITY or CSC_LINK present" if has_identity_or_csc else "missing APPLE_SIGNING_IDENTITY/CSC_LINK"))
    return checks


def check_notarytool() -> Check:
    xcrun = run(["xcrun", "--find", "notarytool"])
    if xcrun.returncode != 0:
        return Check("xcrun notarytool", False, "notarytool not found")
    return Check("xcrun notarytool", True, xcrun.stdout.strip())


def check_team_id_format() -> Check:
    team_id = os.environ.get("APPLE_TEAM_ID", "")
    if not team_id:
        return Check("APPLE_TEAM_ID format", False, "missing APPLE_TEAM_ID")
    return Check("APPLE_TEAM_ID format", bool(re.fullmatch(r"[A-Z0-9]{10}", team_id)), "10 uppercase alphanumeric characters expected")


def print_checks(checks: list[Check]) -> bool:
    all_required_ok = True
    for check in checks:
        marker = "✓" if check.ok else ("✗" if check.required else "-")
        requirement = "required" if check.required else "optional"
        print(f"{marker} {check.name} ({requirement}) — {check.detail}")
        if check.required and not check.ok:
            all_required_ok = False
    return all_required_ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exit non-zero when any required signing/notarization input is missing")
    args = parser.parse_args()

    checks: list[Check] = []
    checks.extend(check_builder_metadata())
    checks.append(check_keychain_identity())
    checks.extend(check_env())
    checks.append(check_team_id_format())
    checks.append(check_notarytool())

    ok = print_checks(checks)
    if ok:
      print("Robinswood macOS signing/notarization preflight passed")
    else:
      print("Robinswood macOS signing/notarization preflight incomplete")
      print("Local builds may still use ad-hoc signing, but external distribution requires the missing inputs above.")
      if args.strict:
          raise SystemExit(1)


if __name__ == "__main__":
    main()
