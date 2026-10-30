from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue, TypeAdapter, ValidationError

JsonObject = dict[str, JsonValue]
JSON_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
ROOT = Path("/srv/rbw-agents-oss")
WS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2")
OPS = WS / "campaigns" / "ops"
SECRETS_ENV = ROOT / "secrets" / "rubypayeur.env"
QUEUE = OPS / "rubypayeur-recouvrement-queue.jsonl"
LEDGER = OPS / "rubypayeur-recouvrement-ledger.jsonl"
REPORT_JSON = OPS / "rubypayeur-recouvrement-last.json"
REPORT_MD = OPS / "rubypayeur-recouvrement-last.md"
CANDIDATES_JSON = OPS / "rubypayeur-recouvrement-candidates.json"
CANDIDATES_MD = OPS / "rubypayeur-recouvrement-candidates.md"
DRAFT_QUEUE = OPS / "rubypayeur-recouvrement-draft-queue.jsonl"
API_BASE = os.environ.get("RUBYPAYEUR_API_BASE_URL", "https://rubypayeur.com/api").rstrip("/")
SELLSY_BASE = os.environ.get("SELLSY_BASE_URL", "https://api.sellsy.com/v2").rstrip("/")
SELLSY_LOGIN_URL = os.environ.get("SELLSY_LOGIN_URL", "https://login.sellsy.com/oauth2/access-tokens")
ALLOWED_FILE_ROOTS = [WS, ROOT]


def object_value(value: JsonValue | None) -> JsonObject:
    if not isinstance(value, dict):
        return {}
    return JSON_OBJECT_ADAPTER.validate_python(value)


def validated_object(value: object) -> JsonObject:
    return JSON_OBJECT_ADAPTER.validate_python(value)


def array_value(value: JsonValue | None) -> list[JsonValue]:
    return value if isinstance(value, list) else []


def identifier_values(value: JsonValue | None) -> list[JsonValue]:
    if isinstance(value, list):
        return value
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return [value]
    return []


def integer_value(value: JsonValue | None) -> int | None:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def write_json(path: Path, payload: object) -> None:
    data = JSON_ADAPTER.validate_python(payload)
    path.parent.mkdir(parents=True, exist_ok=True)
    _ = path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_jsonl(path: Path, row: object) -> None:
    data = JSON_OBJECT_ADAPTER.validate_python(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        _ = stream.write(json.dumps(data, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[JsonObject]:
    rows: list[JsonObject] = []
    if not path.exists():
        return rows
    for line_no, raw in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            row = JSON_OBJECT_ADAPTER.validate_json(line)
        except (ValidationError, ValueError) as exc:
            rows.append({"_lineNo": line_no, "_parseError": str(exc), "_raw": line[:500]})
            continue
        row["_lineNo"] = line_no
        rows.append(row)
    return rows


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        variable = key.strip()
        content = value.strip().strip('"').strip("'")
        if variable and variable not in os.environ:
            os.environ[variable] = content


def get_raw_token(mask: bool = False) -> str | None:
    load_dotenv(SECRETS_ENV)
    token = (
        os.environ.get("RUBYPAYEUR_DEBT_API_TOKEN")
        or os.environ.get("RUBYPAYEUR_API_RECOUVREMENT_TOKEN")
        or os.environ.get("RUBYPAYEUR_API_TOKEN")
    )
    if not token:
        return None
    return "<configured>" if mask else token.strip()


def token_configured() -> bool:
    return bool(get_raw_token(mask=False))


def parse_amount(raw: JsonValue | None) -> float:
    if raw is None or raw == "":
        return 0.0
    try:
        return round(float(str(raw).replace(",", ".")), 2)
    except (ValueError, TypeError, OverflowError):
        return 0.0


def first_non_empty(*values: JsonValue | None) -> JsonValue | None:
    for value in values:
        if value is not None and value != "":
            return value
    return None


def deep_get(data: JsonValue | None, *keys: str) -> JsonValue | None:
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def clean_date(raw: JsonValue | None) -> str | None:
    if not raw:
        return None
    text = str(raw)
    return text[:10] if len(text) >= 10 else text


def find_related_id(row: JsonObject, rel_type: str) -> int | None:
    related = row.get("related")
    if not isinstance(related, list):
        return None
    for item in related:
        if not isinstance(item, dict) or item.get("type") != rel_type:
            continue
        value = item.get("id")
        if value:
            try:
                return int(str(value))
            except (ValueError, TypeError, OverflowError):
                return None
    return None


def ledger_request_ids_by_status() -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for row in read_jsonl(LEDGER):
        request_id = row.get("requestId")
        status = row.get("status")
        if isinstance(request_id, str) and isinstance(status, str):
            result.setdefault(status, set()).add(request_id)
    return result
