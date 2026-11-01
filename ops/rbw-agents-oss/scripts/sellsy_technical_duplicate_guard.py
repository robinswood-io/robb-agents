from __future__ import annotations

import json
from collections.abc import Sequence

from flow_duplicate_targets import duplicate_ids

type JsonValue = (
    str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]
)

MARKER = "RBW_FLOW_TECHNICAL_DUPLICATE_20260715"


def object_id(row: JsonValue) -> int | None:
    if not isinstance(row, dict):
        return None
    value = row.get("id")
    nested = row.get("object")
    if value in (None, "") and isinstance(nested, dict):
        value = nested.get("id")
    if not isinstance(value, (str, int, float)):
        return None
    try:
        return int(value)
    except (ValueError, OverflowError):
        return None


def _is_technical_duplicate(row: JsonValue, identifiers: set[int]) -> bool:
    if not isinstance(row, dict):
        return False
    oid = object_id(row)
    if oid in identifiers:
        return True
    blob = json.dumps(row, ensure_ascii=False).lower()
    return (
        "[tech duplicate →" in blob
        or "[tech duplicate ->" in blob
        or "[tech false positive →" in blob
        or MARKER.lower() in blob
        or "rbw_flow_contact_false_positive_20260715" in blob
    )


def is_technical_duplicate(row: JsonValue) -> bool:
    return _is_technical_duplicate(row, duplicate_ids())


def filter_canonical(rows: Sequence[JsonValue]) -> list[dict[str, JsonValue]]:
    identifiers = duplicate_ids()
    return [
        row
        for row in rows
        if isinstance(row, dict) and not _is_technical_duplicate(row, identifiers)
    ]


def _item_references_duplicate(item: JsonValue, identifiers: set[int]) -> bool:
    if not isinstance(item, dict):
        return False
    if _is_technical_duplicate(item, identifiers):
        return True
    for key in (
        "sellsyCompanyId",
        "sellsyContactId",
        "companyId",
        "contactId",
        "company_id",
        "contact_id",
    ):
        value = item.get(key)
        if not isinstance(value, (str, int, float)):
            continue
        try:
            if int(value) in identifiers:
                return True
        except (ValueError, OverflowError):
            pass
    for key in ("company", "contact", "recipient", "account", "metadata", "data"):
        if isinstance(item.get(key), dict) and _item_references_duplicate(
            item[key], identifiers
        ):
            return True
    return False


def item_references_duplicate(item: JsonValue) -> bool:
    return _item_references_duplicate(item, duplicate_ids())
