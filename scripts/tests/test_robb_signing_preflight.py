#!/usr/bin/env python3
from __future__ import annotations

import base64
import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "robb_signing_preflight",
    SCRIPTS_DIR / "robinswood-signing-preflight.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load robinswood-signing-preflight.py")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class SigningPreflightTests(unittest.TestCase):
    def test_builder_metadata_includes_apple_and_azure_signing_contracts(self) -> None:
        checks = MODULE.check_builder_metadata()

        self.assertTrue(all(check.ok for check in checks))

    def test_ci_apple_api_key_route_requires_valid_pkcs8_base64(self) -> None:
        private_key = base64.b64encode(
            b"-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n"
        ).decode("ascii")
        with patch.dict(
            os.environ,
            {
                "APPLE_TEAM_ID": MODULE.APPLE_TEAM_ID,
                "APPLE_API_KEY_BASE64": private_key,
                "APPLE_API_KEY_ID": "A1B2C3D4E5",
                "APPLE_API_ISSUER": "11111111-2222-3333-4444-555555555555",
            },
            clear=True,
        ):
            checks = MODULE.check_notarization(ci=True)

        self.assertTrue(all(check.ok for check in checks))

    def test_ci_apple_api_key_route_rejects_raw_or_invalid_content(self) -> None:
        with patch.dict(
            os.environ,
            {
                "APPLE_TEAM_ID": MODULE.APPLE_TEAM_ID,
                "APPLE_API_KEY_BASE64": "not-base64",
                "APPLE_API_KEY_ID": "A1B2C3D4E5",
                "APPLE_API_ISSUER": "11111111-2222-3333-4444-555555555555",
            },
            clear=True,
        ):
            checks = MODULE.check_notarization(ci=True)

        encoding = next(check for check in checks if check.name == "App Store Connect private key encoding")
        self.assertFalse(encoding.ok)

    def test_windows_pfx_route_requires_link_and_password_in_ci(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WINDOWS_SIGNING_MODE": "pfx",
                "WINDOWS_CSC_LINK": "base64-certificate",
            },
            clear=True,
        ):
            checks = MODULE.check_windows_signing(ci=True)

        self.assertTrue(checks[0].ok)
        self.assertFalse(checks[1].ok)
        self.assertIn("WINDOWS_CSC_KEY_PASSWORD", checks[1].detail)

    def test_windows_azure_route_accepts_complete_configuration(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WINDOWS_SIGNING_MODE": "azure",
                "WINDOWS_AZURE_ENDPOINT": "https://weu.codesigning.azure.net",
                "WINDOWS_AZURE_ACCOUNT_NAME": "robb-agents-signing",
                "WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME": "robb-agents-public",
                "WINDOWS_AZURE_PUBLISHER_NAME": "CN=Robinswood, O=Robinswood, C=FR",
                "AZURE_TENANT_ID": "11111111-2222-3333-4444-555555555555",
                "AZURE_CLIENT_ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "AZURE_CLIENT_SECRET": "secret",
            },
            clear=True,
        ):
            checks = MODULE.check_windows_signing(ci=True)

        self.assertTrue(all(check.ok for check in checks))

    def test_windows_azure_route_rejects_non_microsoft_endpoint(self) -> None:
        with patch.dict(
            os.environ,
            {
                "WINDOWS_SIGNING_MODE": "azure",
                "WINDOWS_AZURE_ENDPOINT": "https://signing.example.com",
                "WINDOWS_AZURE_ACCOUNT_NAME": "robb-agents-signing",
                "WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME": "robb-agents-public",
                "WINDOWS_AZURE_PUBLISHER_NAME": "CN=Robinswood, O=Robinswood, C=FR",
                "AZURE_TENANT_ID": "11111111-2222-3333-4444-555555555555",
                "AZURE_CLIENT_ID": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                "AZURE_CLIENT_SECRET": "secret",
            },
            clear=True,
        ):
            checks = MODULE.check_windows_signing(ci=True)

        endpoint = next(check for check in checks if check.name == "Microsoft Artifact Signing endpoint")
        self.assertFalse(endpoint.ok)

    def test_windows_signing_rejects_unknown_mode(self) -> None:
        with patch.dict(os.environ, {"WINDOWS_SIGNING_MODE": "automatic"}, clear=True):
            checks = MODULE.check_windows_signing(ci=True)

        self.assertEqual(len(checks), 1)
        self.assertFalse(checks[0].ok)


if __name__ == "__main__":
    unittest.main()
