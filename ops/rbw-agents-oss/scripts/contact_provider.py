"""Optional contact MCP adapter; credentials never enter query parameters."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import TypedDict

import requests
from pydantic import JsonValue, TypeAdapter

type JsonObject = dict[str, JsonValue]
OBJECT: TypeAdapter[JsonObject] = TypeAdapter(JsonObject)
ROOT = Path(os.environ.get("RBW_OSS_ROOT", "/srv/rbw-agents-oss"))
CONFIG = ROOT / "config/contact-oss-client.json"
URL = "https://orion.rbw.ovh/assistant-api/contact-enrichment/mcp"
MARKER = "orion-contact-oss"
TOKEN_PATH = Path("/srv/rbw-agents-oss/contact-oss/credentials/client.token")


class Configuration(TypedDict):
    schemaVersion: int
    provider: str
    url: str
    enabled: bool
    tokenFile: str
    campaigns: list[str]


CONFIGURATION: TypeAdapter[Configuration] = TypeAdapter(Configuration)


def configured() -> bool:
    return CONFIG.exists()


def marker() -> str | None:
    return MARKER if configured() else None


def configuration() -> tuple[Configuration, str]:
    meta = CONFIG.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_mode & 0o077:
        raise ValueError("private_client_configuration_required")
    data = CONFIGURATION.validate_json(CONFIG.read_bytes(), strict=True)
    if data["schemaVersion"] != 1 or data["enabled"] is not True or data["provider"] != MARKER or data["url"] != URL:
        raise ValueError("contact_provider_inactive")
    path = Path(data["tokenFile"])
    if path != TOKEN_PATH:
        raise ValueError("private_token_path_required")
    meta = path.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_mode & 0o077:
        raise ValueError("private_token_required")
    token = path.read_text().strip()
    if not 32 <= len(token) <= 256 or not all(c.isalnum() or c in "_-" for c in token):
        raise ValueError("private_token_invalid")
    return data, token


def object_value(value: JsonValue, error: str) -> JsonObject:
    if not isinstance(value, dict):
        raise TypeError(error)
    return value


def call(name: str, args: JsonObject, campaign: str) -> JsonObject:
    config, token = configuration()
    if campaign not in config["campaigns"]:
        raise ValueError("campaign_not_authorized")
    arguments: JsonObject = {**args, **({"campaign": campaign} if name != "Service-Status" else {})}
    headers = {"authorization": "Bearer " + token, "content-type": "application/json", "accept": "application/json"}
    initial = requests.post(URL, headers=headers, json={"jsonrpc": "2.0", "id": 0,
        "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "robinswood-campaign-contact", "version": "1.0.0"}}},
        timeout=15, allow_redirects=False)
    if initial.status_code != 200:
        raise ValueError("contact_mcp_initialization_failed")
    _ = object_value(OBJECT.validate_json(initial.content).get("result"), "contact_mcp_initialization_failed")
    response = requests.post(URL, headers=headers,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}},
        timeout=70, allow_redirects=False)
    if response.status_code != 200:
        raise ValueError("contact_mcp_unavailable")
    value = OBJECT.validate_json(response.content)
    if value.get("id") != 1 or value.get("error"):
        raise ValueError("contact_mcp_contract_invalid")
    result = object_value(value.get("result"), "contact_result_invalid")
    if result.get("isError"):
        raise ValueError("contact_tool_unavailable")
    data = result.get("structuredContent")
    if not isinstance(data, dict):
        contents = result.get("content")
        if not isinstance(contents, list):
            raise TypeError("contact_result_invalid")
        text = next((item.get("text") for item in contents
                     if isinstance(item, dict) and item.get("type") == "text"), None)
        if not isinstance(text, str):
            raise TypeError("contact_result_invalid")
        data = OBJECT.validate_json(text)
    _ = object_value(data.get("data"), "contact_result_invalid")
    return data


class Response:
    def __init__(self, code: int, body: JsonObject) -> None:
        self.status_code: int = code
        self.body: JsonObject = body
        self.text: str = json.dumps(body)

    def json(self) -> JsonObject:
        return self.body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise ValueError("contact_provider_unavailable")


def get(path: str, params: JsonObject, campaign: str) -> Response:
    try:
        if path == "account":
            out = call("Service-Status", {}, campaign)
            return Response(200, {"data": {"provider": MARKER, "localService": out["data"], "hunterRequired": False}})
        if path == "email-verifier":
            out = call("Email-Verifier", {"email": params.get("email", "")}, campaign)
        else:
            domain = str(params.get("domain") or "").lower().strip()
            if not domain:
                return Response(422, {"error": "official_company_domain_required", "data": {}})
            if path == "domain-search":
                limit = params.get("limit") or 10
                if not isinstance(limit, (str, int, float)):
                    raise ValueError("invalid_contact_limit")
                out = call("Domain-Search", {"domain": domain, "limit": max(1, min(10, int(limit)))}, campaign)
            elif path == "email-finder":
                full_name = params.get("full_name") or " ".join(str(params.get(k) or "") for k in ["first_name", "last_name"]).strip()
                out = call("Email-Finder", {"domain": domain, "full_name": full_name}, campaign)
            else:
                return Response(400, {"error": "contact_operation_not_authorized"})
        return Response(200, {**out, "provider": MARKER, "hunterCalls": 0})
    except (OSError, ValueError, TypeError, OverflowError, requests.RequestException) as error:
        code = str(error) if isinstance(error, ValueError) and str(error) in {
            "campaign_not_authorized", "contact_provider_inactive", "official_company_domain_required"
        } else "contact_provider_unavailable"
        return Response(503, {"error": code, "data": {}, "provider": MARKER, "hunterCalls": 0})


def legacy(path: str, params: JsonObject, campaign: str) -> JsonObject:
    response = get(path, params, campaign)
    return {"ok": response.status_code < 400, "statusCode": response.status_code,
            "body": response.json(), "provider": MARKER, "hunterCalls": 0}
