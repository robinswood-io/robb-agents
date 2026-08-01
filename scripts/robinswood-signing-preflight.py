#!/usr/bin/env python3
"""Robb Agents desktop signing/notarization preflight.

Reports only whether required variables are present; it never prints secret
values. Use ``--strict`` before a public release. ``--ci`` checks the same
GitHub Actions secret names used by the release workflow and skips local
Keychain inspection. The Windows check supports either a traditional PFX or
Microsoft Artifact Signing (the service formerly named Trusted Signing).

Usage:
    python3 scripts/robinswood-signing-preflight.py
    python3 scripts/robinswood-signing-preflight.py --strict
    python3 scripts/robinswood-signing-preflight.py --ci --strict
"""
from __future__ import annotations

import argparse
import base64
import binascii
import os
import pathlib
import re
import subprocess
import sys
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_BUILDER = ROOT / "apps/electron/electron-builder.yml"
ELECTRON_BUILDER_AZURE = ROOT / "apps/electron/electron-builder.azure.yml"
APP_ID = "io.robinswood.robbagents"
PRODUCT_NAME = "Robb Agents"
WINDOWS_SIGNING_MODES = {"pfx", "azure"}
UUID_PATTERN = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


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
    azure_text = ELECTRON_BUILDER_AZURE.read_text(encoding="utf-8") if ELECTRON_BUILDER_AZURE.exists() else ""
    return [
        Check("electron-builder appId", f"appId: {APP_ID}" in text, APP_ID),
        Check("electron-builder productName", f"productName: {PRODUCT_NAME}" in text, PRODUCT_NAME),
        Check("mac hardened runtime", "hardenedRuntime: true" in text, "required for notarized distribution"),
        Check("mac notarization", "notarize: true" in text, "electron-builder notarization enabled"),
        Check("mac entitlements", "entitlements: build/entitlements.mac.plist" in text, "build/entitlements.mac.plist"),
        Check(
            "Windows Artifact Signing configuration",
            all(
                token in azure_text
                for token in (
                    "azureSignOptions:",
                    "WINDOWS_AZURE_ENDPOINT",
                    "WINDOWS_AZURE_ACCOUNT_NAME",
                    "WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME",
                    "WINDOWS_AZURE_PUBLISHER_NAME",
                )
            ),
            "apps/electron/electron-builder.azure.yml",
        ),
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


def valid_private_key_base64(value: str) -> bool:
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return False
    return decoded.startswith(b"-----BEGIN PRIVATE KEY-----") and decoded.rstrip().endswith(b"-----END PRIVATE KEY-----")


def check_notarization(ci: bool) -> list[Check]:
    team_id = os.environ.get("APPLE_TEAM_ID", "")
    team = Check("APPLE_TEAM_ID", bool(re.fullmatch(r"[A-Z0-9]{10}", team_id)), "10 uppercase alphanumeric characters required")
    apple_id_route = present("APPLE_ID") and present("APPLE_APP_SPECIFIC_PASSWORD")
    api_key_name = "APPLE_API_KEY_BASE64" if ci else "APPLE_API_KEY"
    api_key_value = os.environ.get(api_key_name, "")
    api_route = bool(api_key_value) and present("APPLE_API_KEY_ID") and present("APPLE_API_ISSUER")
    checks = [
        team,
        Check(
            "Apple notarization authentication",
            apple_id_route or api_route,
            "Apple-ID or App Store Connect API-key route present"
            if apple_id_route or api_route
            else f"missing both Apple-ID and API-key notarization routes ({api_key_name})",
        ),
    ]
    if ci and api_key_value:
        valid_encoding = valid_private_key_base64(api_key_value)
        checks.append(
            Check(
                "App Store Connect private key encoding",
                valid_encoding,
                "valid base64 PKCS#8 private key" if valid_encoding else "APPLE_API_KEY_BASE64 is not a valid base64 PKCS#8 private key",
            )
        )
    elif api_key_value:
        api_key_path = pathlib.Path(api_key_value).expanduser()
        checks.append(
            Check(
                "App Store Connect private key file",
                api_key_path.is_absolute() and api_key_path.is_file(),
                "absolute .p8 path exists" if api_key_path.is_absolute() and api_key_path.is_file() else "APPLE_API_KEY must be an existing absolute .p8 path",
            )
        )
    if api_key_value:
        key_id = os.environ.get("APPLE_API_KEY_ID", "")
        issuer = os.environ.get("APPLE_API_ISSUER", "")
        checks.extend(
            [
                Check(
                    "App Store Connect key ID",
                    bool(re.fullmatch(r"[A-Z0-9]{10}", key_id)),
                    "10 uppercase alphanumeric characters required",
                ),
                Check(
                    "App Store Connect issuer ID",
                    bool(UUID_PATTERN.fullmatch(issuer)),
                    "UUID issuer ID required",
                ),
            ]
        )
    return checks


def missing(names: tuple[str, ...]) -> list[str]:
    return [name for name in names if not present(name)]


def check_windows_signing(ci: bool) -> list[Check]:
    mode = os.environ.get("WINDOWS_SIGNING_MODE", "pfx").strip().lower()
    mode_ok = mode in WINDOWS_SIGNING_MODES
    checks = [
        Check(
            "Windows signing mode",
            mode_ok,
            mode if mode_ok else f"unsupported {mode!r}; expected pfx or azure",
        )
    ]
    if not mode_ok:
        return checks

    if mode == "pfx":
        if ci:
            required = ("WINDOWS_CSC_LINK", "WINDOWS_CSC_KEY_PASSWORD")
            absent = missing(required)
            checks.append(
                Check(
                    "Windows PFX signing material",
                    not absent,
                    "WINDOWS_CSC_LINK and WINDOWS_CSC_KEY_PASSWORD present" if not absent else "missing " + ", ".join(absent),
                )
            )
        else:
            link = present("CSC_LINK")
            name = present("CSC_NAME")
            password_ok = not link or present("CSC_KEY_PASSWORD")
            checks.append(
                Check(
                    "Windows PFX signing material",
                    (link or name) and password_ok,
                    "CSC_LINK/CSC_NAME signing route present" if (link or name) and password_ok else "missing CSC_NAME or CSC_LINK with CSC_KEY_PASSWORD",
                )
            )
        return checks

    required = (
        "WINDOWS_AZURE_ENDPOINT",
        "WINDOWS_AZURE_ACCOUNT_NAME",
        "WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME",
        "WINDOWS_AZURE_PUBLISHER_NAME",
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
    )
    absent = missing(required)
    checks.append(
        Check(
            "Microsoft Artifact Signing configuration",
            not absent,
            "account, profile, publisher and service-principal authentication present" if not absent else "missing " + ", ".join(absent),
        )
    )
    endpoint = os.environ.get("WINDOWS_AZURE_ENDPOINT", "")
    checks.append(
        Check(
            "Microsoft Artifact Signing endpoint",
            bool(re.fullmatch(r"https://[a-z0-9-]+\.codesigning\.azure\.net/?", endpoint)),
            "regional HTTPS codesigning.azure.net endpoint required",
        )
    )
    for name in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID"):
        value = os.environ.get(name, "")
        checks.append(
            Check(
                name,
                bool(UUID_PATTERN.fullmatch(value)),
                "Microsoft Entra UUID required",
            )
        )
    return checks


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
    checks.extend(check_notarization(args.ci))
    checks.append(check_notarytool(args.ci))
    checks.extend(check_windows_signing(args.ci))

    ok = True
    for check in checks:
        print(f"{'OK' if check.ok else 'MISSING'}: {check.name} — {check.detail}")
        ok = ok and check.ok
    print("Robb signing/notarization preflight " + ("passed" if ok else "incomplete"))
    if args.strict and not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
