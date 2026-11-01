"""Validated contact evidence and retry state; no network or filesystem effects."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from pydantic import JsonValue, TypeAdapter

type Row = dict[str, object]
OBJECT: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])
ROWS: TypeAdapter[list[dict[str, JsonValue]]] = TypeAdapter(list[dict[str, JsonValue]])
VALUES: TypeAdapter[list[JsonValue]] = TypeAdapter(list[JsonValue])
STRINGS: TypeAdapter[list[str]] = TypeAdapter(list[str])
EXEC = {
    "ceo",
    "chief executive",
    "founder",
    "co-founder",
    "president",
    "président",
    "directeur général",
    "directrice générale",
    "general manager",
    "coo",
    "chief operating",
    "managing director",
}


def object_row(value: object) -> Row:
    return dict(OBJECT.validate_python(value, strict=True))


def object_rows(value: object) -> list[Row]:
    return [dict(row) for row in ROWS.validate_python(value, strict=True)]


def strings(value: object) -> list[str]:
    return STRINGS.validate_python(value, strict=True)


def now() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime | None = None) -> str:
    return (value or now()).isoformat().replace("+00:00", "Z")


def norm(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def split_name(value: object) -> tuple[str | None, str | None]:
    parts = str(value or "").split()
    return (parts[0], parts[-1]) if len(parts) > 1 else (None, None)


def valid_url(value: object) -> bool:
    return bool(re.match(r"^https://[^\s]+$", str(value or ""), re.IGNORECASE))


def source_ok(value: object) -> bool:
    return valid_url(value) and not re.search(
        r"(google\.[^/]+/search|bing\.com/search|linkedin\.com/search)",
        str(value),
        re.IGNORECASE,
    )


def source_urls(data: Row) -> list[str]:
    result: list[str] = []
    for source in VALUES.validate_python(data.get("sources") or [], strict=True):
        if isinstance(source, str) and source_ok(source):
            result.append(source)
        elif isinstance(source, dict):
            for key in ("uri", "url", "source"):
                value = source.get(key)
                if isinstance(value, str) and source_ok(value):
                    result.append(value)
                    break
    return list(dict.fromkeys(result))


def role_ok(expected: object, actual: object) -> bool:
    expected_text, actual_text = norm(expected), norm(actual)
    if not expected_text or not actual_text:
        return False
    if expected_text in actual_text or actual_text in expected_text:
        return True
    if ("coo" in expected_text or "chief operating" in expected_text) and not (
        "coo" in actual_text or "chief operating" in actual_text
    ):
        return False
    return bool(
        {value for value in EXEC if value in expected_text}
        and {value for value in EXEC if value in actual_text}
    )


def failclass(result: Row) -> str:
    gaps = set(strings(result.get("gaps") or []))
    if "hunter_auth_or_capacity" in gaps:
        return "hunter_dependency"
    if gaps & {"professional_email_exact_domain", "email_evidence_url"}:
        return "exact_email_not_proven"
    if "email_verification_0_90" in gaps:
        return "email_verification_insufficient"
    if gaps & {"professional_profile_url", "verified_role_match"}:
        return "person_role_not_proven"
    if "public_company_evidence" in gaps:
        return "company_evidence_not_proven"
    return "other_evidence_gap"


def retry_at(failure_class: str, failures: int) -> datetime:
    reference = now().astimezone(ZoneInfo("Europe/Paris"))
    days = (
        1
        if failures < 2
        else min(
            30,
            (
                7
                if failure_class in {"exact_email_not_proven", "person_role_not_proven"}
                else 2
            )
            * (1 << min(4, max(0, failures - 2))),
        )
    )
    day = (reference + timedelta(days=days)).date()
    while day.weekday() > 4:
        day += timedelta(days=1)
    return datetime(
        day.year, day.month, day.day, 8, 20, tzinfo=reference.tzinfo
    ).astimezone(UTC)


def due(state: Row, key: str) -> bool:
    account = object_row(object_row(state.get("accounts") or {}).get(key) or {})
    timestamp = account.get("nextRetryAt")
    if not timestamp:
        return True
    try:
        return now() >= datetime.fromisoformat(str(timestamp))
    except (ValueError, TypeError):
        return False


def retry_due_for_reuse(state: Row, key: str) -> bool:
    account = object_row(object_row(state.get("accounts") or {}).get(key) or {})
    return not account.get("passed") and due(state, key)
