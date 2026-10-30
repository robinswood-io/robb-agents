"""Exact CRM identity and complete readback for duplicate reconciliation."""

from __future__ import annotations

import re
from urllib.parse import quote

import robinswood_flow_core as core
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows
from pydantic import JsonValue, ValidationError

MARK = "RBW_FLOW_TECHNICAL_DUPLICATE_20260715"


def ident(value: object) -> int | None:
    try:
        row = object_row(value)
    except ValidationError:
        return None
    candidate = row.get("id")
    if candidate in (None, ""):
        nested = row.get("object")
        if isinstance(nested, dict):
            candidate = object_row(row.get("object")).get("id")
    if candidate in (None, ""):
        candidate = core.deepid(OBJECT.validate_python(row, strict=True))
    if isinstance(candidate, bool):
        return None
    if isinstance(candidate, int):
        return candidate if candidate > 0 else None
    if isinstance(candidate, str) and candidate.isascii() and candidate.isdecimal():
        identifier = int(candidate)
        return identifier if identifier > 0 else None
    return None


def has_exact_id(value: JsonValue, target: int) -> bool:
    if isinstance(value, dict):
        return any(has_exact_id(item, target) for item in value.values())
    if isinstance(value, list):
        return any(has_exact_id(item, target) for item in value)
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value == target
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        return int(value) == target
    return False


def list_endpoint(endpoint: str, max_pages: int = 100) -> tuple[list[Row], Row]:
    rows: list[Row] = []
    meta: Row = {
        "endpoint": endpoint,
        "complete": False,
        "pages": 0,
        "reportedTotal": None,
        "error": None,
    }
    if max_pages < 1:
        meta["error"] = "invalid_page_budget"
        return rows, meta
    offset: str | None = None
    seen_offsets: set[str] = set()
    seen_ids: set[int] = set()
    total: int | None = None
    try:
        for page in range(1, max_pages + 1):
            suffix = f"&offset={quote(offset, safe='')}" if offset else ""
            data = object_row(core.crmreq(f"{endpoint}?limit=100{suffix}"))
            batch = object_rows(data.get("data"))
            pagination = object_row(data.get("pagination") or {})
            reported = pagination.get("total")
            if reported is not None:
                if (
                    isinstance(reported, bool)
                    or not isinstance(reported, int)
                    or reported < 0
                ):
                    raise ValueError("invalid_reported_total")
                if total is not None and total != reported:
                    raise ValueError("reported_total_changed_during_scan")
                total = reported
                meta["reportedTotal"] = total
            for item in batch:
                identifier = ident(item)
                if identifier is None or identifier in seen_ids:
                    raise ValueError("missing_or_repeated_record_id")
                seen_ids.add(identifier)
            rows.extend(batch)
            meta["pages"] = page
            cursor = pagination.get("offset")
            if cursor is not None and not isinstance(cursor, str):
                raise ValueError("invalid_pagination_cursor")
            next_offset = cursor or ""
            if total is not None and len(rows) > total:
                raise ValueError("reported_total_smaller_than_rows")
            if total is not None and len(rows) == total:
                meta["complete"] = True
                break
            if len(batch) < 100 and not next_offset:
                if total is not None and len(rows) != total:
                    raise ValueError("incomplete_rows_before_reported_total")
                meta["complete"] = True
                break
            if not next_offset or next_offset in seen_offsets:
                meta["error"] = "missing_or_repeated_cursor"
                break
            seen_offsets.add(next_offset)
            offset = next_offset
        if not meta["complete"] and not meta["error"]:
            meta["error"] = "max_pages_exceeded"
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        meta["error"] = type(exc).__name__
    return rows, meta


def append_marker(existing: str, body: str) -> str:
    existing = existing.strip()
    start, end = f"[{MARK}:START]", f"[{MARK}:END]"
    block = f"{start}\n{body.strip()}\n{end}"
    if start in existing and end in existing:
        return re.sub(
            re.escape(start) + r"[\s\S]*?" + re.escape(end), lambda _: block, existing
        )
    return f"{existing}\n\n{block}".strip()


def exact_search(query: str, object_type: str) -> list[int]:
    result = object_row(core.crmreq("/search?q=" + quote(query, safe="")))
    identifiers: set[int] = set()
    for row in object_rows(result.get("data")):
        nested = row.get("object")
        if nested is None:
            continue
        item = object_row(nested)
        identifier = ident(item)
        if item.get("type") == object_type and identifier is not None:
            identifiers.add(identifier)
    return sorted(identifiers)
