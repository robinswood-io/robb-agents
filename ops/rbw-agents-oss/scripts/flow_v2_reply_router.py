"""Route verified inbound thread messages, persisting stops before optional CRM actions."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from email.utils import parseaddr
from typing import Literal

import robinswood_flow_core as c
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows, strings
from flow_v2_materializer import keyed_rows
from flow_v2_reply_crm import crm_action_for_signal
from flow_v2_rules import TZ, classify, dt, extract_return_date
from requests import RequestException


def change_future(
    account_key: str,
    mode: Literal["cancel", "hold", "reschedule"],
    source: str,
    resume: datetime | None = None,
) -> None:
    if mode == "reschedule" and (resume is None or resume.tzinfo is None):
        raise ValueError("explicit_resume_date_required")
    for path in (c.EMAILQ, c.LIQ):
        queue = object_row(c.load(path, {}))
        items = object_rows(queue.get("items") or [])
        for item in items:
            if item.get("accountKey") != account_key or item.get("status") not in {
                "scheduled_conditional",
                "held_ooo_ambiguous",
                "held_ambiguous",
            }:
                continue
            if mode == "cancel":
                item.update(
                    {
                        "status": "cancelled_by_signal",
                        "cancelReason": source,
                        "cancelSource": source,
                        "cancelledAt": c.now(),
                    }
                )
            elif mode == "hold":
                item.update(
                    {
                        "status": "held_" + source,
                        "holdReason": source,
                        "heldAt": c.now(),
                    }
                )
            elif resume is not None:
                previous = item.get("dueAt")
                new = max(dt(previous) or resume, resume)
                item.update(
                    {
                        "status": "scheduled_conditional",
                        "rescheduledFrom": previous,
                        "dueAt": new.isoformat(),
                        "pauseUntil": resume.isoformat(),
                        "pauseReason": "out_of_office",
                        "pausedAt": c.now(),
                        "pauseSource": source,
                    }
                )
        queue["items"] = items
        c.save(path, queue)


def human_item(
    account: Row, message_id: str, classification: str, extra: Row | None = None
) -> None:
    queue = object_row(c.load(c.HUMAN, {"items": []}))
    items = object_rows(queue.get("items") or [])
    action_id = "flow-reply:" + message_id
    existing = next(
        (item for item in items if item.get("action_id") == action_id), None
    )
    if existing is None:
        items.append(
            {
                "action_id": action_id,
                "accountKey": account["key"],
                "type": "human_commercial_reply",
                "classification": classification,
                "sourceMessageId": message_id,
                "status": "pending_human_judgment",
                "owner": "workspace_owner",
                "priority": "high"
                if classification in {"positive", "referral"}
                else "medium",
                "createdAt": c.now(),
                **(extra or {}),
            }
        )
    elif extra:
        existing.update(extra)
    queue["items"] = items
    c.save(c.HUMAN, queue)


def detect_referral_identity(text: str, original_email: str) -> Row:
    emails = {
        match.group(0).lower()
        for match in re.finditer(
            r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", text, re.IGNORECASE
        )
    } - {original_email.lower()}
    return {
        "newPersonDetected": bool(emails),
        "emails": sorted(emails),
        "approvalRequired": bool(emails),
    }


def received_time(message: Row) -> datetime:
    value = message.get("internalDate")
    if value is None:
        raise ValueError("message_received_date_missing")
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise TypeError("message_received_date_invalid")
    return datetime.fromtimestamp(int(value) / 1000, UTC).astimezone(TZ)


def route_signal(
    account: Row, record: Row, text: str, state: Row, *, apply: bool
) -> bool:
    """Return whether the signal is fully handled; preparation stays retryable."""
    key, message_id, classification = (
        str(account["key"]),
        str(record["messageId"]),
        str(record["classification"]),
    )
    email = str(account.get("email") or record["from"])
    if classification == "out_of_office":
        if state.get("sequenceStopped") is True:
            return True  # An automatic reply cannot revoke a previous stop or opt-out.
        result = extract_return_date(text, dt(record["receivedAt"]))
        if result["reliable"]:
            change_future(key, "reschedule", message_id, dt(result["returnAt"]))
            state.update(
                {
                    "sequencePaused": True,
                    "pausedUntil": result["returnAt"],
                    "pauseReason": "out_of_office",
                }
            )
        else:
            change_future(key, "hold", "ooo_ambiguous")
            human_item(
                account, message_id, classification, {"returnDateExtraction": result}
            )
            state.update(
                {"sequencePaused": True, "pauseReason": "ooo_ambiguous_human_required"}
            )
        return True
    if classification in {
        "positive",
        "referral",
        "refusal",
        "opt_out",
        "hard_bounce",
        "soft_bounce",
    }:
        change_future(key, "cancel", classification)
        state.update(
            {
                "sequenceStopped": True,
                "sequencePaused": False,
                "stopReason": classification,
            }
        )
        if classification in {"opt_out", "hard_bounce"}:
            c.add_suppression(email, "flow_" + classification, message_id)
        if classification not in {"positive", "referral"}:
            return True
    else:
        change_future(key, "hold", "ambiguous")
        state.update(
            {"sequencePaused": True, "pauseReason": "ambiguous_human_required"}
        )
    action = crm_action_for_signal(account, record, classification, dry_run=not apply)
    extra: Row = {"crmAction": action}
    if classification == "referral":
        extra["referral"] = detect_referral_identity(text, email)
    human_item(account, message_id, classification, extra)
    return apply


def reply_router(*, apply: bool = False) -> int:
    registry = keyed_rows(c.REG, "accounts", "key")
    queue = object_rows(c.load(c.EMAILQ, {}).get("items") or [])
    threads: set[tuple[str, str]] = set()
    for item in queue:
        if item.get("threadId") and item.get("accountKey"):
            threads.add((str(item["accountKey"]), str(item["threadId"])))
    state = object_row(
        c.load(
            c.REPLY, {"schemaVersion": "robinswood-flow-reply-state-v2", "accounts": {}}
        )
    )
    accounts = object_row(state.get("accounts") or {})
    signals: list[Row] = []
    errors: list[Row] = []
    total, pending = 0, 0
    access = c.token() if threads else ""
    sender = c.sender_email().lower() if threads else ""
    for key, thread_id in sorted(threads):
        account = registry.get(key)
        if account is None:
            errors.append({"accountKey": key, "error": "thread_account_missing"})
            continue
        account_state = object_row(
            accounts.get(key) or {"processedMessageIds": [], "sequenceStopped": False}
        )
        done = set(strings(account_state.get("processedMessageIds") or []))
        try:
            thread = c.gh(access, "threads/" + thread_id, {"format": "full"})
            messages = object_rows(thread.get("messages") or [])
            total += len(messages)
            for message in messages:
                message_id = message.get("id")
                if not isinstance(message_id, str) or not message_id:
                    raise ValueError("message_identifier_missing")
                headers = c.hdict(OBJECT.validate_python(message, strict=True))
                source = parseaddr(headers.get("from") or "")[1].lower()
                if (
                    message_id in done
                    or source == sender
                    or source.endswith("@robinswood.io")
                ):
                    continue
                if not source:
                    raise ValueError("message_sender_missing")
                text = c.btext(
                    OBJECT.validate_python(message.get("payload") or {}, strict=True)
                )
                received = received_time(message)
                classification = classify(
                    (headers.get("subject") or "") + " " + text, source
                )
                record: Row = {
                    "messageId": message_id,
                    "threadId": thread_id,
                    "from": source,
                    "receivedAt": received.isoformat(),
                    "classification": classification,
                    "subject": headers.get("subject"),
                    "snippet": text[:1000],
                }
                signals.append(record)
                handled = route_signal(
                    account, record, text, account_state, apply=apply
                )
                if handled:
                    done.add(message_id)
                else:
                    pending += 1
                _ = c.append_unique(
                    c.EVENTS,
                    {
                        "event_id": c.stable("event", "reply_received", message_id),
                        "event_type": "bounce"
                        if "bounce" in classification
                        else "unsubscribe"
                        if classification == "opt_out"
                        else "reply_received",
                        "occurred_at": received.isoformat(),
                        "campaign_id": account["campaign_id"],
                        "lead_id": account["lead_id"],
                        "conversation_id": c.stable("conversation", thread_id),
                        "provider_message_id": message_id,
                        "thread_id": thread_id,
                        "classification": classification,
                        "evidence_level": "technical_observed",
                    },
                    "event_id",
                )
                account_state.update(
                    {"signal": classification, "processedMessageIds": sorted(done)}
                )
                accounts[key] = account_state
                state["accounts"] = accounts
                c.save(c.REPLY, state)
            account_state.update(
                {"lastCheckedAt": c.now(), "threadMessageCount": len(messages)}
            )
        except (
            RequestException,
            OSError,
            ValueError,
            TypeError,
            RuntimeError,
            OverflowError,
        ) as exc:
            errors.append(
                {"accountKey": key, "threadId": thread_id, "error": type(exc).__name__}
            )
        accounts[key] = account_state
    state.update(
        {"generatedAt": c.now(), "accounts": accounts, "lastNewSignals": signals}
    )
    c.save(c.REPLY, state)
    status = (
        "blocked_fail_closed"
        if errors
        else "prepared_crm_actions"
        if pending
        else "signal_processed"
        if signals
        else "no_signal"
    )
    return c.report(
        "reply-router",
        {
            "counts": {
                "threads": len(threads),
                "threadMessages": total,
                "newSignals": len(signals),
                "pendingCrmActions": pending,
                "errors": len(errors),
                "externalSends": 0,
            },
            "signals": signals,
            "errors": errors,
        },
        not errors,
        status,
    )
