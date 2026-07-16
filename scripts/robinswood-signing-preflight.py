#!/usr/bin/env python3
"""Robb Agents macOS signing/notarization preflight.

Reports only whether required variables are present; it never prints secret
values. Use ``--strict`` before a public release. ``--ci`` checks the same
GitHub Actions secret names used by the release workflow and skips local
Keychain inspection.

Usage:
    python3 scripts/robinswood-signing-preflight.py
    python3 scripts/robinswood-signing-preflight.py --strict
    python3 scripts/robinswood-signing-preflight.py --ci --strict
"""
from __future__ import annotations

import argparse
import os
import pathlib
import re
import subprocess
import sys
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_BUILDER = ROOT / "apps/electron/electron-builder.yml"
APP_ID = "io.robinswood.robbagents"
PRODUCT_NAME = "Robb Agents"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def present(name: str) -> bool:
    return bool(os.environ.get(name))


def check_builder_metadata() -> list[Check]:
    text = ELECTRON_BUILDER.read_text(encoding="utf-8")
    return [
        Check("electron-builder appId", f"appId: {APP_ID}" in text, APP_ID),
        Check("electron-builder productName", f"productName: {PRODUCT_NAME}" in text, PRODUCT_NAME),
        Check("mac hardened runtime", "hardenedRuntime: true" in text, "required for notarized distribution"),
        Check("mac notarization", "notarize: true" in text, "electron-builder notarization enabled"),
        Check("mac entitlements", "entitlements: build/entitlements.mac.plist" in text, "build/entitlements.mac.plist"),
    ]


def check_local_identity() -> Check:
    security = run(["security", "find-identity", "-v", "-p", "codesigning"])
    output = security.stdout + security.stderr
    if security.returncode != 0:
        return Check("Developer ID Application identity", False, "security tool or Developer ID identity unavailable")
    identities = [line for line in output.splitlines() if "Developer ID Application:" in line and "REVOKED" not in line]
    configured = os.environ.get("APPLE_SIGNING_IDENTITY", "").replace("Developer ID Application: ", "").strip()
    if configured:
        return Check("Developer ID Application identity", any(configured in line for line in identities), "configured APPLE_SIGNING_IDENTITY found in Keychain")
    return Check(
        "Developer ID Application identity",
        bool(identities),
        "Developer ID Application identity found in Keychain" if identities else "no valid Developer ID Application identity found in Keychain",
    )


def check_signing_material(ci: bool) -> Check:
    if ci:
        ok = present("MAC_CSC_LINK") and present("MAC_CSC_KEY_PASSWORD")
        return Check("macOS signing material", ok, "MAC_CSC_LINK and MAC_CSC_KEY_PASSWORD present" if ok else "missing MAC_CSC_LINK or MAC_CSC_KEY_PASSWORD")
    ok = present("CSC_LINK") or present("CSC_NAME") or present("APPLE_SIGNING_IDENTITY")
    return Check("macOS signing material", ok, "CSC_LINK/CSC_NAME/APPLE_SIGNING_IDENTITY present" if ok else "missing signing material")


def check_notarization() -> list[Check]:
    team_id = os.environ.get("APPLE_TEAM_ID", "")
    team = Check("APPLE_TEAM_ID", bool(re.fullmatch(r"[A-Z0-9]{10}", team_id)), "10 uppercase alphanumeric characters required")
    apple_id_route = present("APPLE_ID") and present("APPLE_APP_SPECIFIC_PASSWORD")
    api_route = present("APPLE_API_KEY") and present("APPLE_API_KEY_ID") and present("APPLE_API_ISSUER")
    return [
        team,
        Check(
            "Apple notarization authentication",
            apple_id_route or api_route,
            "Apple-ID or App Store Connect API-key route present" if apple_id_route or api_route else "missing both Apple-ID and API-key notarization routes",
        ),
    ]


def check_notarytool(ci: bool) -> Check:
    if ci:
        return Check("notarytool host", True, "validated by macOS release runner")
    result = run(["xcrun", "--find", "notarytool"])
    return Check("xcrun notarytool", result.returncode == 0, "available" if result.returncode == 0 else "notarytool not found")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exit non-zero if any public-release requirement is missing")
    parser.add_argument("--ci", action="store_true", help="validate GitHub Actions secret names instead of local Keychain material")
    args = parser.parse_args()

    checks = check_builder_metadata()
    if not args.ci:
        checks.append(check_local_identity())
    checks.append(check_signing_material(args.ci))
    checks.extend(check_notarization())
    checks.append(check_notarytool(args.ci))

    ok = True
    for check in checks:
        print(f"{'OK' if check.ok else 'MISSING'}: {check.name} — {check.detail}")
        ok = ok and check.ok
    print("Robb signing/notarization preflight " + ("passed" if ok else "incomplete"))
    if args.strict and not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
