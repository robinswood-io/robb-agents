"""Single-item browser dispatch; incomplete or uncertain results stay visible."""

from __future__ import annotations

from datetime import datetime

import robinswood_flow_core as c
from flow_contact_evidence_state import object_row, object_rows
from flow_duplicate_crm import ident
from flow_v2_delivery import eligible
from flow_v2_materializer import keyed_rows
from flow_v2_reply_router import reply_router
from flow_v2_rules import TZ, is_due
from linkedin_connection_browser_provider_core import run_browser_provider


def linkedin_queue(*, apply: bool = False, reference: datetime | None = None) -> int:
    if reply_router(apply=apply) != 0:
        return c.report(
            "linkedin-queue",
            {"blockingReasons": ["reply_router_failed"]},
            False,
            "blocked_fail_closed",
        )
    queue = object_row(c.load(c.LIQ, {}))
    items = object_rows(queue.get("items") or [])
    queue["items"] = items
    registry = keyed_rows(c.REG, "accounts", "key")
    now = reference or datetime.now(TZ)
    if any(item.get("status") == "held_delivery_uncertain" for item in items):
        return c.report(
            "linkedin-queue",
            {
                "counts": {"processed": 0, "sent": 0},
                "blockingReasons": ["previous_browser_outcome_unknown"],
            },
            False,
            "blocked_fail_closed",
        )
    due = [
        item
        for item in items
        if item.get("status") == "scheduled_conditional" and is_due(item, now)
    ]
    if not due:
        return c.report(
            "linkedin-queue",
            {
                "counts": {"processed": 0, "sent": 0},
                "nextDue": min(
                    (
                        str(item.get("dueAt"))
                        for item in items
                        if item.get("status") == "scheduled_conditional"
                    ),
                    default=None,
                ),
            },
            True,
            "no_due_actions",
        )
    item = due[0]
    account = registry.get(str(item.get("accountKey") or ""))
    if (
        not eligible(account, item)
        or account is None
        or item.get("linkedinProfileUrl") != account.get("linkedin")
        or ident({"id": item.get("sellsyCompanyId")})
        != ident({"id": account.get("sellsyCompanyId")})
        or ident({"id": item.get("sellsyContactId")})
        != ident({"id": account.get("sellsyContactId")})
        or ident({"id": item.get("sellsyCompanyId")}) is None
        or ident({"id": item.get("sellsyContactId")}) is None
        or item.get("request_id")
        != c.stable(
            "linkedin-request",
            account.get("campaign_id"),
            account.get("key"),
            account.get("linkedin"),
        )
    ):
        return c.report(
            "linkedin-queue",
            {
                "counts": {"processed": 0, "sent": 0},
                "blockingReasons": ["approval_signal_relation_or_duplicate_gate"],
            },
            False,
            "blocked_fail_closed",
        )
    if not apply:
        return c.report(
            "linkedin-queue",
            {"counts": {"processed": 0, "sent": 0, "prepared": 1}},
            True,
            "prepared_no_browser_action",
        )
    item.update({"status": "held_delivery_uncertain", "attemptedAt": c.now()})
    c.save(c.LIQ, queue)
    try:
        result = run_browser_provider(
            [{**item, "requestId": item["request_id"]}],
            apply=True,
            allow_note=False,
            pace_seconds=45,
        )
        rows = object_rows(result.get("results") or [])
        if len(rows) != 1:
            raise ValueError("single_browser_result_required")
        row = rows[0]
        if row.get("requestId") != item["request_id"]:
            raise ValueError("browser_result_identity_mismatch")
        status = row.get("status")
        ok = result.get("ok") is True and status in {
            "sent_ui",
            "skipped_already_connected",
        }
        item.update(
            {
                "status": "sent_ui_verified"
                if status == "sent_ui" and ok
                else "skipped_already_connected"
                if ok
                else "held_delivery_uncertain",
                "uiEvidence": row,
                "processedAt": c.now(),
            }
        )
        c.save(c.LIQ, queue)
        return c.report(
            "linkedin-queue",
            {
                "counts": {"processed": 1, "sent": int(status == "sent_ui" and ok)},
                "result": row,
            },
            ok,
            "dispatch_completed" if ok else "blocked_fail_closed",
        )
    except (OSError, ValueError, RuntimeError, TypeError) as exc:
        return c.report(
            "linkedin-queue",
            {
                "counts": {"processed": 1, "sent": 0},
                "blockingReasons": [type(exc).__name__],
            },
            False,
            "blocked_fail_closed",
        )
