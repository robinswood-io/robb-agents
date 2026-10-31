from __future__ import annotations

import http.client
import mimetypes
import os
import time
import urllib.parse
from pathlib import Path

from pydantic import JsonValue, ValidationError
from rubypayeur_recouvrement_support import (
    ALLOWED_FILE_ROOTS,
    API_BASE,
    JSON_ADAPTER,
    JSON_OBJECT_ADAPTER,
    SECRETS_ENV,
    JsonObject,
    get_raw_token,
)

TEST_DEBTOR_SIREN = os.environ.get("RBW_TEST_DEBTOR_SIREN", "")
DEFAULT_PHONE = os.environ.get("RBW_RUBYPAYEUR_DEFAULT_PHONE", "").strip()
MultipartPart = tuple[str, bytes, str | None, str | None]


def http_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: int = 45,
) -> tuple[int, JsonValue]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("api_url_must_use_https")
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read().decode("utf-8", errors="replace")
        data: JsonValue = {}
        if raw:
            try:
                data = JSON_ADAPTER.validate_json(raw)
            except ValidationError:
                data = {"raw": raw}
        return response.status, data
    finally:
        connection.close()


def rubypayeur_auth() -> JsonObject:
    token = get_raw_token(mask=False)
    if not token:
        raise RuntimeError(f"rubypayeur_token_missing:{SECRETS_ENV}")
    body = urllib.parse.urlencode({"token": token}).encode("utf-8")
    status, data = http_json(
        "POST",
        f"{API_BASE}/debt_auth",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=body,
    )
    if status >= 400 or not isinstance(data, dict):
        raise RuntimeError(f"rubypayeur_auth_failed:{status}")
    auth_token = data.get("auth_token")
    if not isinstance(auth_token, str) or not auth_token:
        raise RuntimeError(f"rubypayeur_auth_failed:{status}")
    return {"auth_token": auth_token, "customer": data.get("customer")}


def add_field(parts: list[MultipartPart], name: str, value: JsonValue | None) -> None:
    if value is None or value == "":
        return
    rendered = "1" if value is True else "0" if value is False else str(value)
    parts.append((name, rendered.encode("utf-8"), None, None))


def resolve_safe_file(path_raw: str) -> Path:
    path = Path(path_raw).expanduser().resolve()
    if not path.exists():
        raise ValueError(f"file_not_found:{path}")
    if not any(path == root or root in path.parents for root in ALLOWED_FILE_ROOTS):
        raise ValueError(f"file_outside_allowed_roots:{path}")
    return path


def add_file(parts: list[MultipartPart], name: str, path_raw: str) -> None:
    path = resolve_safe_file(path_raw)
    mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    parts.append((name, path.read_bytes(), path.name, mime))


def multipart_encode(parts: list[MultipartPart]) -> tuple[bytes, str]:
    boundary = f"----rbwRubypayeur{int(time.time() * 1000)}"
    chunks: list[bytes] = []
    for name, value, filename, mime in parts:
        chunks.append(f"--{boundary}\r\n".encode())
        disposition = f'form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        chunks.append(f"Content-Disposition: {disposition}\r\n".encode())
        if mime:
            chunks.append(f"Content-Type: {mime}\r\n".encode())
        chunks.extend((b"\r\n", value, b"\r\n"))
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def validate_debt(debt: JsonObject) -> list[str]:
    errors: list[str] = []
    for key in ("siren", "gender", "first_name", "last_name", "email"):
        if not debt.get(key):
            errors.append(f"missing_debtor_{key}")
    if debt.get("gender") not in ("male", "female"):
        errors.append("invalid_gender_must_be_male_or_female")
    items = debt.get("items")
    if not isinstance(items, list) or not items:
        errors.append("missing_items")
        return errors
    for index, value in enumerate(items):
        if not isinstance(value, dict):
            errors.append(f"items_{index}_not_object")
            continue
        item = JSON_OBJECT_ADAPTER.validate_python(value)
        for key in ("amount", "invoice_number", "invoiced_on", "due_date"):
            if item.get(key) in (None, ""):
                errors.append(f"items_{index}_missing_{key}")
        if not any(item.get(key) for key in ("billing_proof_remote_url", "billing_proof_data_uri", "billing_proof_file_path")):
            errors.append(f"items_{index}_missing_billing_proof")
    return errors


def build_debt_form(debt: JsonObject) -> tuple[bytes, str]:
    errors = validate_debt(debt)
    if errors:
        raise ValueError(",".join(errors))
    parts: list[MultipartPart] = []
    for key in ("siren", "gender", "first_name", "last_name", "email"):
        add_field(parts, f"debt[{key}]", debt.get(key))
    add_field(parts, "debt[phone]", debt.get("phone") or DEFAULT_PHONE)
    items = debt.get("items")
    if not isinstance(items, list):
        raise TypeError("debt_items_invalid")
    for index, value in enumerate(items):
        if not isinstance(value, dict):
            raise TypeError(f"debt_item_{index}_invalid")
        item = JSON_OBJECT_ADAPTER.validate_python(value)
        prefix = f"debt[items_attributes][{index}]"
        for key in (
            "amount", "invoice_number", "invoiced_on", "due_date", "deposit", "deposit_on",
            "billing_proof_remote_url", "billing_proof_data_uri",
        ):
            add_field(parts, f"{prefix}[{key}]", item.get(key))
        proof_path = item.get("billing_proof_file_path")
        if isinstance(proof_path, str) and proof_path:
            add_file(parts, f"{prefix}[billing_proof]", proof_path)
        elif proof_path:
            raise ValueError(f"debt_item_{index}_proof_path_invalid")
    for key in ("dunning_letter_proof_remote_url", "dunning_letter_proof_data_uri", "comment"):
        add_field(parts, f"debt[{key}]", debt.get(key))
    dunning_path = debt.get("dunning_letter_proof_file_path")
    if isinstance(dunning_path, str) and dunning_path:
        add_file(parts, "debt[dunning_letter_proof]", dunning_path)
    elif dunning_path:
        raise ValueError("debt_dunning_proof_path_invalid")
    add_field(parts, "debt[late_fee]", debt.get("late_fee", True))
    add_field(parts, "debt[terms_agree]", debt.get("terms_agree", True))
    return multipart_encode(parts)


def create_debt(debt: JsonObject, auth_token: str) -> JsonObject:
    body, content_type = build_debt_form(debt)
    status, data = http_json(
        "POST",
        f"{API_BASE}/debts",
        headers={"Authorization": f"Bearer {auth_token}", "Content-Type": content_type},
        body=body,
    )
    if status >= 400:
        raise RuntimeError(f"rubypayeur_create_debt_failed:{status}")
    if isinstance(data, dict):
        return JSON_OBJECT_ADAPTER.validate_python(data)
    return {"response": data}


def safe_public_debt_summary(debt: JsonObject) -> JsonObject:
    email = debt.get("email")
    domain = str(email).split("@", 1)[-1] if isinstance(email, str) and "@" in email else None
    items = debt.get("items")
    items_count = len(items) if isinstance(items, list) else 0
    return {
        "siren": debt.get("siren"),
        "gender": debt.get("gender"),
        "emailDomain": domain,
        "itemsCount": items_count,
    }
