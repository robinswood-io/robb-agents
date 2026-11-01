"""Small typed helpers for the read-only deployed Flow audit."""

from __future__ import annotations

from pathlib import Path

from flow_contact_evidence_state import OBJECT
from flow_duplicate_crm import has_exact_id
from flow_v2_rules import dt
from pydantic import JsonValue

type Report = dict[str, JsonValue]


def obj(value: JsonValue) -> Report:
    if not isinstance(value, dict):
        raise TypeError("expected_report_object")
    return value


def rows(value: JsonValue) -> list[Report]:
    if not isinstance(value, list):
        raise TypeError("expected_report_rows")
    return [obj(item) for item in value]


def child(value: Report, key: str) -> Report:
    return obj(value.get(key))


def items(value: Report, key: str = "items") -> list[Report]:
    return rows(value.get(key))


def read(path: Path) -> Report:
    return OBJECT.validate_json(path.read_bytes(), strict=True)


def number(value: JsonValue) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("expected_report_number")
    return value


def string(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise TypeError("expected_report_string")
    return value


def check(name: str, ok: object, detail: JsonValue = None) -> Report:
    return {"name": name, "ok": bool(ok), "detail": detail}


def canonical_contacts_valid(contacts: JsonValue, accounts: list[Report]) -> bool:
    if not isinstance(contacts, dict) or not contacts:
        return False
    expected: dict[str, int] = {}
    account_keys: set[str] = set()
    for account in accounts:
        key = account.get("key")
        if not isinstance(key, str) or not key or key in account_keys:
            return False
        account_keys.add(key)
        identifier = account.get("sellsyContactId")
        if account.get("contactVerified") is True:
            if (
                not isinstance(identifier, int)
                or isinstance(identifier, bool)
                or identifier <= 0
            ):
                return False
            expected[key] = identifier
    if not expected or len(set(expected.values())) != len(expected):
        return False
    return (
        all(
            isinstance(value, int) and not isinstance(value, bool) and value > 0
            for value in contacts.values()
        )
        and contacts == expected
    )


def clean_ids(value: JsonValue, excluded: set[int]) -> bool:
    return not any(has_exact_id(value, identifier) for identifier in excluded)


def dated(value: JsonValue) -> bool:
    return dt(value) is not None
