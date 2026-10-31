"""Optional adapter protocol and private configuration, exclusively QA fixtures."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import final
from unittest.mock import patch

import contact_provider as provider
import evergreen_offline_test_guard as offline
import requests


def tearDownModule() -> None:
    offline.assert_no_external_attempts()


@final
class FixtureResponse(requests.Response):
    def __init__(self, body: provider.JsonObject, status: int = 200) -> None:
        super().__init__()
        self.status_code = status
        self._content = json.dumps(body).encode()


class PostRecorder:
    def __init__(self, responses: list[requests.Response]) -> None:
        self.responses: list[requests.Response] = responses
        self.calls: list[dict[str, object]] = []

    def __call__(self, url: str, **kwargs: object) -> requests.Response:
        self.calls.append({"url": url, **kwargs})
        return self.responses.pop(0)


class ContactProviderTests(unittest.TestCase):
    def config(self, token: Path) -> provider.Configuration:
        return {"schemaVersion": 1, "provider": provider.MARKER, "url": provider.URL,
                "enabled": True, "tokenFile": str(token), "campaigns": ["qa"]}

    def test_private_regular_files_and_token_required(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            token, config = root / "token", root / "config.json"
            _ = token.write_text("qa-fixture-" * 4)
            _ = config.write_text(json.dumps(self.config(token)))
            token.chmod(0o600)
            config.chmod(0o600)
            with patch.object(provider, "CONFIG", config), patch.object(provider, "TOKEN_PATH", token):
                self.assertTrue(provider.configured())
                self.assertEqual(provider.marker(), provider.MARKER)
                self.assertEqual(provider.configuration()[0]["campaigns"], ["qa"])
                for path in [config, token]:
                    path.chmod(0o644)
                    with self.assertRaises(ValueError):
                        _ = provider.configuration()
                    path.chmod(0o600)
                config.unlink()
                config.symlink_to(token)
                with self.assertRaisesRegex(ValueError, "private_client_configuration_required"):
                    _ = provider.configuration()

    def test_mcp_initialization_and_both_response_forms(self) -> None:
        for structured in [True, False]:
            with self.subTest(structured=structured):
                data: provider.JsonObject = {"data": {"email": "qa@example.org"}}
                result: provider.JsonObject = {"structuredContent": data} if structured else {
                    "content": [{"type": "text", "text": json.dumps(data)}]}
                post = PostRecorder([FixtureResponse({"result": {}}), FixtureResponse({"id": 1, "result": result})])
                with patch.object(provider, "configuration", return_value=(self.config(Path("qa")), "qa-token")), \
                     patch.object(requests, "post", side_effect=post):
                    self.assertEqual(provider.call("Email-Verifier", {"email": "qa@example.org"}, "qa"), data)
                self.assertEqual(len(post.calls), 2)
                self.assertTrue(all(call["url"] == provider.URL and call["allow_redirects"] is False for call in post.calls))
                self.assertEqual(post.calls[1]["json"], {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": {"name": "Email-Verifier", "arguments": {"email": "qa@example.org", "campaign": "qa"}}})

    def test_campaign_denial_precedes_http(self) -> None:
        with patch.object(provider, "configuration", return_value=(self.config(Path("qa")), "qa-token")), \
             self.assertRaisesRegex(ValueError, "campaign_not_authorized"):
            _ = provider.call("Service-Status", {}, "unauthorized")

    def test_malformed_mcp_results_are_rejected(self) -> None:
        cases: list[provider.JsonObject] = [
            {"id": 2, "result": {}}, {"id": 1, "error": {"code": -1}},
            {"id": 1, "result": {"isError": True}}, {"id": 1, "result": {}},
            {"id": 1, "result": {"structuredContent": {"data": []}}},
        ]
        for payload in cases:
            with self.subTest(payload=payload), \
                 patch.object(provider, "configuration", return_value=(self.config(Path("qa")), "qa-token")), \
                 patch.object(requests, "post", side_effect=[FixtureResponse({"result": {}}), FixtureResponse(payload)]), \
                 self.assertRaises((ValueError, TypeError)):
                _ = provider.call("Email-Verifier", {}, "qa")

    def test_search_clamps_limits_and_finder_keeps_name(self) -> None:
        calls: list[tuple[str, provider.JsonObject, str]] = []
        def call(name: str, args: provider.JsonObject, campaign: str) -> provider.JsonObject:
            calls.append((name, args, campaign))
            return {"data": {"ok": True}}
        with patch.object(provider, "call", side_effect=call):
            self.assertEqual(provider.get("domain-search", {"domain": " EXAMPLE.ORG ", "limit": 100}, "qa").status_code, 200)
            self.assertEqual(provider.get("email-finder", {"domain": "example.org", "first_name": "QA", "last_name": "Example"}, "qa").status_code, 200)
        self.assertEqual(calls, [("Domain-Search", {"domain": "example.org", "limit": 10}, "qa"),
                                ("Email-Finder", {"domain": "example.org", "full_name": "QA Example"}, "qa")])

    def test_unsupported_operations_and_invalid_limits_are_closed(self) -> None:
        self.assertEqual(provider.get("domain-search", {}, "qa").status_code, 422)
        self.assertEqual(provider.get("delete", {"domain": "example.org"}, "qa").status_code, 400)
        self.assertEqual(provider.get("domain-search", {"domain": "example.org", "limit": [1]}, "qa").status_code, 503)

    def test_errors_do_not_disclose_request_or_credentials(self) -> None:
        with patch.object(provider, "call", side_effect=requests.RequestException("private-qa-credential")):
            response = provider.get("email-verifier", {"email": "qa@example.org"}, "qa")
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("private-qa-credential", response.text)
            with self.assertRaisesRegex(ValueError, "contact_provider_unavailable"):
                response.raise_for_status()

    def test_service_status_and_legacy_keep_contract(self) -> None:
        with patch.object(provider, "call", return_value={"data": {"ready": True}}):
            self.assertEqual(provider.get("account", {}, "qa").json(), {
                "data": {"provider": provider.MARKER, "localService": {"ready": True}, "hunterRequired": False}})
            result = provider.legacy("email-verifier", {"email": "qa@example.org"}, "qa")
            self.assertIs(result["ok"], True)
            self.assertEqual(result["hunterCalls"], 0)
