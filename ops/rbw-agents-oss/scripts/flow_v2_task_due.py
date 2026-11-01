"""Repair missing/past CRM task deadlines without moving already valid future work."""

from __future__ import annotations

from datetime import datetime

import robinswood_flow_core as c
from flow_contact_evidence_state import Row, object_row
from flow_duplicate_crm import ident
from flow_v2_materializer import keyed_rows
from flow_v2_rules import TZ, dt, task_due
from requests import RequestException

DUE_REPORT = c.OPS / "robinswood-flow-task-due-manager-last.json"
CLOSED_STATUSES = {"done", "completed", "cancelled", "canceled"}


def inspect_task(account: Row, task_id: int, now: datetime, *, apply: bool) -> Row:
    before = c.crmreq(f"/tasks/{task_id}")
    if ident(before) != task_id:
        raise ValueError("task_readback_identifier_mismatch")
    before_due = dt(before.get("due_date"))
    closed = str(before.get("status") or "").lower() in CLOSED_STATUSES
    desired = (
        before_due
        if before_due is not None and (before_due > now or closed)
        else task_due(account, now)
    )
    changed = not closed and before_due != desired
    if apply and changed:
        _ = c.crmreq(f"/tasks/{task_id}", "PUT", {"due_date": desired.isoformat()})
    after = c.crmreq(f"/tasks/{task_id}")
    actual = dt(after.get("due_date"))
    verified = ident(after) == task_id and (
        closed or (actual is not None and actual == desired and actual > now)
    )
    return {
        "accountKey": account["key"],
        "taskId": task_id,
        "beforeDue": before.get("due_date"),
        "desiredDue": desired.isoformat(),
        "readbackDue": after.get("due_date"),
        "updated": apply and changed,
        "wouldUpdate": changed,
        "future": actual is not None and actual > now,
        "closed": closed,
        "ok": verified,
        "prepared": not apply and changed,
    }


def task_due_manager(apply: bool = True, reference: datetime | None = None) -> Row:
    now = reference or datetime.now(TZ)
    if now.tzinfo is None:
        raise ValueError("explicit_reference_timezone_required")
    registry = keyed_rows(c.REG, "accounts", "key")
    state = object_row(c.load(c.CRMSTATE, {}))
    tasks = object_row(state.get("tasks") or {})
    rows: list[Row] = []
    errors: list[Row] = []
    expected = len(c.accounts())
    identifiers: set[int] = set()
    for marker, value in tasks.items():
        key = marker.rsplit(":", 1)[-1]
        account = registry.get(key)
        identifier = ident({"id": value})
        if account is None or identifier is None or identifier in identifiers:
            errors.append(
                {
                    "marker": marker,
                    "error": "missing_account_or_invalid_task_identifier",
                }
            )
            continue
        identifiers.add(identifier)
        try:
            row = inspect_task(account, identifier, now, apply=apply)
            rows.append(row)
            if row["ok"] is not True and row["prepared"] is not True:
                errors.append(
                    {
                        "marker": marker,
                        "taskId": identifier,
                        "error": "readback_or_future_check_failed",
                    }
                )
        except (RequestException, OSError, ValueError, RuntimeError) as exc:
            errors.append(
                {"marker": marker, "taskId": identifier, "error": type(exc).__name__}
            )
    if len(rows) != expected or expected == 0:
        errors.append({"error": "canonical_task_count_mismatch"})
    verified = not errors and all(row.get("ok") is True for row in rows)
    prepared = not errors and not apply
    object_ids = sorted(str(value) for value in identifiers)
    payload: Row = {
        "generatedAt": c.now(),
        "contractVersion": "robinswood-flow-task-due-manager-v3-native-sor",
        "capabilityId": "robinswood-flow-task-due-manager",
        "ok": verified or prepared,
        "status": "blocked_fail_closed"
        if errors
        else "applied_and_read_back"
        if apply
        else "dry_run",
        "counts": {
            "tasks": len(rows),
            "updated": sum(row.get("updated") is True for row in rows),
            "wouldUpdate": sum(row.get("wouldUpdate") is True for row in rows),
            "future": sum(row.get("future") is True for row in rows),
            "errors": len(errors),
            "externalSends": 0,
        },
        "tasks": rows,
        "errors": errors,
        "systemsOfRecord": {
            "classification": "sellsy",
            "work": {"required": False, "objectIds": [], "verifiedByReadback": False},
            "sellsy": {
                "required": True,
                "tenant": "robinswood",
                "objectIds": object_ids,
                "verifiedByReadback": verified,
                "verifiedAt": c.now(),
            },
            "pendingSyncItems": [],
        },
    }
    c.save(DUE_REPORT, payload)
    return payload
