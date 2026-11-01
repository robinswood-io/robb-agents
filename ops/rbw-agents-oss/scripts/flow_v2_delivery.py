"""Explicit outbound execution with checkpoints before transport and verified completion."""

from __future__ import annotations

import base64
import html
import re
from datetime import datetime
from email.message import EmailMessage
from email.utils import parseaddr

import requests
import robinswood_flow_core as c
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows, strings
from flow_v2_materializer import keyed_rows, message_templates
from flow_v2_reply_router import reply_router
from flow_v2_rules import TZ, approval_scope, is_due
from outbound_content_guard import salutation_reasons
from sellsy_technical_duplicate_guard import item_references_duplicate


def stopped(key: str, email: str) -> bool:
    states = object_row(c.load(c.REPLY, {}).get("accounts") or {})
    state = object_row(states.get(key) or {})
    return state.get("sequenceStopped") is True or c.suppressed(email)


def required_text(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("delivery_text_missing")
    return value


def eligible(account: Row | None, item: Row) -> bool:
    if (
        account is None
        or account.get("approvedForSequence") is not True
        or account.get("contactVerified") is not True
    ):
        return False
    scope = approval_scope(account)
    email = str(account.get("email") or "").lower()
    return bool(
        scope is not None
        and account.get("approvalScope") == scope
        and item.get("approvalScope") == scope
        and email
        and not stopped(str(account["key"]), email)
        and not item_references_duplicate(OBJECT.validate_python(account, strict=True))
        and not item_references_duplicate(OBJECT.validate_python(item, strict=True))
    )


def email_payload(
    access: str, identity: Row, account: Row, item: Row, queue: list[Row]
) -> Row:
    email = required_text(item.get("recipientEmail")).lower()
    template = message_templates(account).get(str(item.get("type")))
    contact = {
        "name": account.get("sponsor"),
        "role": account.get("role"),
        "civility": account.get("civility"),
        "civility_source": account.get("civility_source")
        or account.get("civilitySource")
        or account.get("civility_proof_source"),
    }
    if (
        email != str(account.get("email") or "").lower()
        or parseaddr(email)[1] != email
        or item.get("attachmentsAllowed") is not False
        or template is None
        or item.get("subject") != template.get("subject")
        or item.get("body") != template.get("body")
        or bool(salutation_reasons(item.get("body"), contact))
    ):
        raise ValueError("recipient_copy_or_attachment_contract_invalid")
    if str(
        identity.get("sender") or ""
    ).lower() != c.sender_email().lower() or not identity.get("sigText"):
        raise ValueError("gmail_identity_or_signature_failed")
    message = EmailMessage()
    message["From"] = required_text(identity.get("from"))
    message["To"] = email
    message["Subject"] = required_text(item.get("subject"))
    message["X-RBW-Flow-Action-ID"] = required_text(item.get("action_id"))
    payload: Row = {}
    if item.get("type") != "email_d0":
        first = next(
            (
                row
                for row in queue
                if row.get("accountKey") == account["key"]
                and row.get("type") == "email_d0"
                and row.get("status") in {"sent_verified", "sent_verified_backfill"}
            ),
            None,
        )
        if first is None:
            raise ValueError("missing_original_thread")
        message_id = required_text(first.get("providerMessageId"))
        payload["threadId"] = required_text(first.get("threadId"))
        original = c.gh(
            access,
            "messages/" + message_id,
            {"format": "metadata", "metadataHeaders": ["Message-ID"]},
        )
        header_id = required_text(c.hdict(original).get("message-id"))
        message["In-Reply-To"] = header_id
        message["References"] = header_id
    body, signature = (
        required_text(item.get("body")),
        required_text(identity.get("sig")),
    )
    message.set_content(body + "\n\n" + re.sub(r"<[^>]+>", " ", signature))
    message.add_alternative(
        '<div dir="ltr">'
        + html.escape(body).replace("\n", "<br>")
        + "</div><br>"
        + signature,
        subtype="html",
    )
    payload["raw"] = base64.urlsafe_b64encode(message.as_bytes()).decode().rstrip("=")
    return payload


def attachment_names(payload: Row) -> list[str]:
    names = (
        [str(payload["filename"])] if str(payload.get("filename") or "").strip() else []
    )
    for child in object_rows(payload.get("parts") or []):
        names.extend(attachment_names(child))
    return names


def verify_email(access: str, account: Row, item: Row) -> Row:
    message_id = required_text(item.get("providerMessageId"))
    result = c.gh(access, "messages/" + message_id, {"format": "full"})
    headers = c.hdict(result)
    attachments = attachment_names(object_row(result.get("payload") or {}))
    expected_thread = item.get("threadId")
    thread = required_text(result.get("threadId"))
    ok = (
        result.get("id") == message_id
        and "SENT" in strings(result.get("labelIds") or [])
        and parseaddr(headers.get("to") or "")[1].lower()
        == str(account.get("email") or "").lower()
        and not attachments
        and (not expected_thread or expected_thread == thread)
    )
    return {
        "ok": ok,
        "labelSent": "SENT" in strings(result.get("labelIds") or []),
        "recipient": headers.get("to"),
        "attachmentCount": len(attachments),
        "threadId": thread,
    }


def record_verified(account: Row, item: Row, verification: Row) -> None:
    message_id = required_text(item.get("providerMessageId"))
    send_id = "gmail:" + message_id
    _ = c.append_unique(
        c.LEDGER,
        {
            "generatedAt": c.now(),
            "ledger_id": str(item["action_id"]) + ":" + message_id,
            "accountKey": account["key"],
            "type": item["type"],
            "status": "sent_verified",
            "gmailMessageId": message_id,
            "gmailThreadId": verification["threadId"],
            "recipientEmail": account["email"],
            "attachments": 0,
            "send_id": send_id,
        },
        "ledger_id",
    )
    _ = c.append_unique(
        c.EVENTS,
        {
            "event_id": c.stable("event", "email_sent", message_id),
            "event_type": "email_sent",
            "occurred_at": c.now(),
            "campaign_id": account["campaign_id"],
            "lead_id": account["lead_id"],
            "send_id": send_id,
            "provider_message_id": message_id,
            "thread_id": verification["threadId"],
            "recipient_id": account.get("sellsyContactId"),
            "evidence_level": "user_result_verified",
            "attachment_count": 0,
        },
        "event_id",
    )


def email_sequencer(*, apply: bool = False, reference: datetime | None = None) -> int:
    if reply_router(apply=apply) != 0:
        return c.report(
            "email-sequencer",
            {"blockingReasons": ["reply_router_failed"], "externalSendsNow": 0},
            False,
            "blocked_fail_closed",
        )
    queue = object_row(c.load(c.EMAILQ, {}))
    items = object_rows(queue.get("items") or [])
    queue["items"] = items
    registry = keyed_rows(c.REG, "accounts", "key")
    blocked: list[Row] = []
    sent, verified, prepared = 0, 0, 0
    access: str | None = None
    identity: Row | None = None
    now = reference or datetime.now(TZ)
    for item in items:
        status = item.get("status")
        if status == "held_delivery_uncertain":
            blocked.append(
                {
                    "action": item.get("action_id"),
                    "reason": "delivery_outcome_unknown_no_resend",
                }
            )
            continue
        recovering = status in {"sent_pending_verification", "sent_verification_failed"}
        if not recovering and (
            status != "scheduled_conditional" or not is_due(item, now)
        ):
            continue
        account = registry.get(str(item.get("accountKey") or ""))
        if account is None or (not recovering and not eligible(account, item)):
            blocked.append(
                {
                    "action": item.get("action_id"),
                    "reason": "approval_contact_signal_or_duplicate_gate",
                }
            )
            continue
        if not recovering and (now.weekday() > 4 or not 8 <= now.hour < 18):
            continue
        if not apply:
            prepared += 1
            continue
        try:
            if access is None:
                access = c.token()
            if not recovering:
                if identity is None:
                    identity = object_row(c.identity(access))
                payload = email_payload(access, identity, account, item, items)
                item.update(
                    {"status": "held_delivery_uncertain", "attemptedAt": c.now()}
                )
                c.save(c.EMAILQ, queue)
                response = requests.post(
                    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                    headers={
                        "Authorization": "Bearer " + access,
                        "Content-Type": "application/json",
                    },
                    json=OBJECT.validate_python(payload, strict=True),
                    timeout=30,
                )
                response.raise_for_status()
                result = OBJECT.validate_json(response.content)
                message_id = required_text(result.get("id"))
                sent += 1
                item.update(
                    {
                        "providerMessageId": message_id,
                        "threadId": payload.get("threadId") or result.get("threadId"),
                        "status": "sent_pending_verification",
                        "sentAt": c.now(),
                    }
                )
                c.save(c.EMAILQ, queue)
            verification = verify_email(access, account, item)
            item["verification"] = verification
            if verification["ok"] is not True:
                item["status"] = "sent_verification_failed"
                blocked.append(
                    {"action": item.get("action_id"), "reason": "send_readback_failed"}
                )
            else:
                record_verified(account, item, verification)
                item.update(
                    {"status": "sent_verified", "threadId": verification["threadId"]}
                )
                verified += 1
            c.save(c.EMAILQ, queue)
        except (
            requests.RequestException,
            OSError,
            ValueError,
            RuntimeError,
            TypeError,
        ) as exc:
            blocked.append(
                {"action": item.get("action_id"), "reason": type(exc).__name__}
            )
            c.save(c.EMAILQ, queue)
    status = (
        "blocked_fail_closed"
        if blocked
        else "prepared_no_sends"
        if not apply
        else "sent_and_verified"
        if verified
        else "no_due_actions"
    )
    return c.report(
        "email-sequencer",
        {
            "counts": {
                "sent": sent,
                "verified": verified,
                "prepared": prepared,
                "blocked": len(blocked),
            },
            "blockedReasons": blocked,
            "externalSendsNow": sent,
        },
        not blocked,
        status,
    )
