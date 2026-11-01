from __future__ import annotations

import base64
import html
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from typing import TypedDict

import requests

if __package__:
    from .robinswood_flow_core_support import (
        EMAILQ,
        EVENTS,
        GOOGLE_CREDS,
        GOOGLE_TOKENS,
        HUMAN,
        JSON_ADAPTER,
        JSON_OBJECT_ADAPTER,
        LEDGER,
        REG,
        REPLY,
        JsonObject,
        account_key,
        add_suppression,
        append_unique,
        btext,
        classify,
        due,
        hdict,
        load,
        localnow,
        now,
        optional_object,
        private_text,
        profile,
        report,
        required_text,
        rows_value,
        save,
        sender_email,
        seq_stopped,
        source_message_id,
        source_thread_id,
        stable,
        stop_future,
        string_values,
        text_value,
        validated_object,
    )
else:
    from robinswood_flow_core_support import (
        EMAILQ,
        EVENTS,
        GOOGLE_CREDS,
        GOOGLE_TOKENS,
        HUMAN,
        JSON_ADAPTER,
        JSON_OBJECT_ADAPTER,
        LEDGER,
        REG,
        REPLY,
        JsonObject,
        account_key,
        add_suppression,
        append_unique,
        btext,
        classify,
        due,
        hdict,
        load,
        localnow,
        now,
        optional_object,
        private_text,
        profile,
        report,
        required_text,
        rows_value,
        save,
        sender_email,
        seq_stopped,
        source_message_id,
        source_thread_id,
        stable,
        stop_future,
        string_values,
        text_value,
        validated_object,
    )

GmailIdentity = TypedDict('GmailIdentity', {'sender': str, 'from': str, 'sig': str, 'sigText': str})

def token() -> str:
  _ = profile()
  credential_record = optional_object(load(GOOGLE_CREDS, {}).get(private_text('text_032')), 'google_client_invalid')
  refresh_record = load(GOOGLE_TOKENS, {})
  request_data = {'client_id': required_text(credential_record.get('client_id'), 'google_client_id_missing'), 'client_secret': required_text(credential_record.get('client_secret'), 'google_client_secret_missing'), 'refresh_token': required_text(refresh_record.get('refresh_token'), 'google_refresh_token_missing'), 'grant_type': 'refresh_token'}
  response = requests.post(required_text(credential_record.get('token_uri'), 'google_token_uri_missing'), data=request_data, timeout=30)
  response.raise_for_status()
  payload = JSON_ADAPTER.validate_json(response.content)
  token_response = validated_object(payload, 'google_token_response_invalid')
  return required_text(token_response.get('access_token'), 'google_access_token_missing')

def gh(access: str, path: str, params: Mapping[str, str | list[str]] | None = None) -> JsonObject:
  _ = profile()
  response = requests.get('https://gmail.googleapis.com/gmail/v1/users/me/' + path, headers={'Authorization': 'Bearer ' + access}, params=params, timeout=30)
  response.raise_for_status()
  payload = JSON_ADAPTER.validate_json(response.content)
  return validated_object(payload, 'gmail_response_invalid')

def reply_router() -> int:
    _ = profile()
    access = token()
    thread = gh(
        access,
        "threads/" + source_thread_id(),
        {"format": 'full'},
    )
    state_default = validated_object({"accounts": {}}, "reply_state_default_invalid")
    state = load(REPLY, state_default)
    account_states = optional_object(state.get("accounts"), "reply_accounts_invalid")
    key = account_key()
    if key in account_states:
        account_state = optional_object(account_states.get(key), "reply_account_invalid")
    else:
        account_state: JsonObject = {"processedMessageIds": JSON_ADAPTER.validate_python([source_message_id()])}
    account_states[key] = JSON_OBJECT_ADAPTER.validate_python(account_state)
    state["accounts"] = JSON_OBJECT_ADAPTER.validate_python(account_states)

    processed_ids = set(
        string_values(
            account_state.get("processedMessageIds"),
            "processed_message_ids_invalid",
        )
    )
    messages = rows_value(thread.get("messages"), "gmail_messages_invalid")
    new_signals: list[JsonObject] = []
    for message in messages:
        message_id = str(message.get("id"))
        headers = hdict(message)
        sender = parseaddr(headers.get("from") or "")[1].lower()
        if message_id in processed_ids or sender == sender_email() or sender.endswith("@robinswood.io"):
            continue

        payload = optional_object(message.get("payload"), "gmail_payload_invalid")
        text = btext(payload)
        classification = classify(headers.get("subject", "") + " " + text, sender)
        internal_date = message.get("internalDate")
        timestamp_ms = int(internal_date) if isinstance(internal_date, (int, float, str)) else 0
        received_at = datetime.fromtimestamp(timestamp_ms / 1000, UTC).isoformat()
        record = validated_object(
            {
                "messageId": message_id,
                "threadId": source_thread_id(),
                "from": sender,
                "receivedAt": received_at,
                "classification": classification,
                "snippet": text[:1200],
            },
            "reply_record_invalid",
        )
        new_signals.append(record)
        processed_ids.add(message_id)
        stop_future(classification, message_id)

        if classification in {"hard_bounce", "opt_out"}:
            add_suppression(private_text("text_010"), private_text("text_062") + classification, message_id)
        if classification in {"positive_or_referral", "ambiguous", "objection"}:
            human_queue = load(HUMAN, validated_object({"items": []}, "human_queue_default_invalid"))
            items = rows_value(human_queue.get("items"), "human_queue_items_invalid")
            action_id = private_text("text_051") + message_id
            if not any(item.get("action_id") == action_id for item in items):
                items.append(
                    validated_object(
                        {
                            "action_id": action_id,
                            "accountKey": account_key(),
                            "type": "human_commercial_reply",
                            "status": "needs_human_review",
                            "messageId": message_id,
                            "classification": classification,
                            "from": sender,
                            "snippet": text[:1200],
                            "createdAt": now(),
                        },
                        "human_reply_item_invalid",
                    )
                )
                human_queue["items"] = JSON_ADAPTER.validate_python(items)
                save(HUMAN, human_queue)

        event = validated_object(
            {
                "event_id": stable("event", "reply_received", message_id),
                "event_type": "bounce" if classification == "hard_bounce" else "unsubscribe" if classification == "opt_out" else "reply_received",
                "occurred_at": now(),
                "campaign_id": private_text("text_004"),
                "lead_id": private_text("text_010"),
                "accountKey": account_key(),
                "gmail_message_id": message_id,
                "classification": classification,
            },
            "reply_event_invalid",
        )
        _ = append_unique(EVENTS, event, "event_id")

    account_state["processedMessageIds"] = JSON_ADAPTER.validate_python(sorted(processed_ids))
    account_state["lastCheckedAt"] = now()
    account_state["threadMessageCount"] = len(messages)
    if new_signals:
        account_state["signal"] = new_signals[-1]["classification"]
        account_state["sequenceStopped"] = True
    state["generatedAt"] = now()
    account_states[key] = JSON_OBJECT_ADAPTER.validate_python(account_state)
    state["accounts"] = JSON_OBJECT_ADAPTER.validate_python(account_states)
    state["lastNewSignals"] = JSON_ADAPTER.validate_python(new_signals)
    save(REPLY, state)
    return report(
        "reply-router",
        {
            "counts": {
                "threadMessages": len(messages),
                "newSignals": len(new_signals),
                "hardBounces": sum(
                    1 for item in new_signals if item.get("classification") == "hard_bounce"
                ),
                "optOuts": sum(
                    1 for item in new_signals if item.get("classification") == "opt_out"
                ),
            },
            "lastSignals": new_signals[-10:],
        },
    )

def identity(access: str) -> GmailIdentity:
    _ = profile()
    profile_data = gh(access, 'profile')
    sender = required_text(profile_data.get('emailAddress'), 'gmail_profile_email_missing')
    send_as = rows_value(gh(access, 'settings/sendAs').get('sendAs'), 'gmail_send_as_invalid')
    selected: JsonObject = {}
    for row in send_as:
        if text_value(row.get('sendAsEmail')).lower() == sender.lower() and row.get('isPrimary') is True:
            selected = row
            break
    if not selected:
        for row in send_as:
            if text_value(row.get('sendAsEmail')).lower() == sender.lower():
                selected = row
                break
    signature = text_value(selected.get('signature'))
    plain_signature = html.unescape(re.sub('<[^>]+>', ' ', signature))
    return {'sender': sender, 'from': formataddr((text_value(selected.get('displayName')), sender)), 'sig': signature, 'sigText': re.sub('\\s+', ' ', plain_signature).strip()}

def email_sequencer() -> int:
    _ = profile()
    _ = reply_router()
    queue = load(EMAILQ, {})
    sent = 0
    blocked: list[str] = []
    verified: list[JsonObject] = []

    for action in rows_value(queue.get("items"), "queue_items_invalid"):
        if action.get("status") != "scheduled_conditional" or not due(action):
            continue
        action_type = required_text(action.get("type"), "email_action_type_invalid")
        if seq_stopped():
            action["status"] = "cancelled_by_signal"
            action["cancelReason"] = "fresh_reply_or_suppression"
            continue
        paris = localnow()
        if paris.weekday() > 4 or not (8 <= paris.hour < 18):
            blocked.append("outside_business_window")
            continue

        if action_type == "email_d5":
            subject = private_text("text_037")
            body = private_text("text_038")
        elif action_type == "email_d10":
            subject = private_text("text_037")
            body = private_text("text_052")
        else:
            subject = private_text("text_037")
            body = private_text("text_053")

        access = token()
        identity_data = identity(access)
        if (
            identity_data["sender"].lower() != sender_email()
            or not identity_data["sigText"]
            or identity_data.get("verified") not in (None, "accepted")
        ):
            blocked.append("gmail_identity_or_signature_failed")
            continue

        original = gh(
            access,
            "messages/" + source_message_id(),
            {"format": "metadata", "metadataHeaders": ["Message-ID", "Subject"]},
        )
        original_headers = hdict(original)
        message = EmailMessage()
        message["From"] = identity_data["from"]
        recipient = private_text("text_010")
        message["To"] = recipient
        message["Subject"] = subject
        message["In-Reply-To"] = original_headers.get("message-id")
        message["References"] = original_headers.get("message-id")
        action_id = required_text(action.get("action_id"), "email_action_id_invalid")
        message["X-RBW-Flow-Action-ID"] = action_id
        message.set_content(body + "\n\n" + re.sub(r"<[^>]+>", " ", identity_data["sig"]))
        message.add_alternative(
            '<div dir="ltr">' + html.escape(body).replace("\n", "<br>") + "</div><br>" + identity_data["sig"],
            subtype="html",
        )
        raw = base64.urlsafe_b64encode(message.as_bytes()).decode().rstrip("=")
        response = requests.post(
            private_text("text_040"),
            headers={"Authorization": "Bearer " + access, "Content-Type": "application/json"},
            json={"raw": raw, "threadId": source_thread_id()},
            timeout=30,
        )
        response.raise_for_status()
        response_object = validated_object(
            JSON_ADAPTER.validate_json(response.content),
            "gmail_send_response_invalid",
        )
        message_id = required_text(response_object.get("id"), "gmail_sent_message_id_missing")
        check = gh(access, "messages/" + message_id, {"format": "full"})
        headers = hdict(check)
        attachments: list[str] = []

        def collect_attachments(part: JsonObject, target: list[str] = attachments) -> None:
            filename = text_value(part.get("filename")).strip()
            if filename:
                target.append(filename)
            for child in rows_value(part.get("parts"), "gmail_parts_invalid"):
                collect_attachments(child, target)

        collect_attachments(optional_object(check.get("payload"), "gmail_payload_invalid"))
        label_ids = string_values(check.get("labelIds"), "gmail_labels_invalid")
        checked_thread_id = text_value(check.get("threadId"))
        ok = (
            checked_thread_id == source_thread_id()
            and parseaddr(headers.get("to") or "")[1].lower() == recipient.lower()
            and "SENT" in label_ids
            and not attachments
        )
        action.update(
            {
                "status": "sent_verified" if ok else "sent_verification_failed",
                "providerMessageId": message_id,
                "threadId": checked_thread_id,
                "sentAt": now(),
                "verification": {
                    "labelSent": "SENT" in label_ids,
                    "recipient": headers.get("to"),
                    "attachmentCount": len(attachments),
                    "sameThread": checked_thread_id == source_thread_id(),
                },
            }
        )
        sent += 1
        verified.append(
            validated_object(action["verification"], "email_verification_invalid")
        )

        send_id = "gmail:" + message_id
        _ = append_unique(
            LEDGER,
            validated_object(
                {
                    "generatedAt": now(),
                    "ledger_id": action_id + ":" + message_id,
                    "accountKey": account_key(),
                    "type": action_type,
                    "status": action["status"],
                    "gmailMessageId": message_id,
                    "gmailThreadId": checked_thread_id,
                    "recipientEmail": recipient,
                    "attachments": len(attachments),
                    "send_id": send_id,
                },
                "email_ledger_row_invalid",
            ),
            "ledger_id",
        )
        registry_accounts = rows_value(load(REG, {}).get("accounts"), "account_rows_invalid")
        account = next(row for row in registry_accounts if row.get("key") == account_key())
        _ = append_unique(
            EVENTS,
            validated_object(
                {
                    "event_id": stable("event", "email_sent", message_id),
                    "event_type": "email_sent",
                    "occurred_at": now(),
                    "campaign_id": private_text("text_009"),
                    "lead_id": required_text(account.get("lead_id"), "account_lead_id_missing"),
                    "send_id": send_id,
                    "provider_message_id": message_id,
                    "thread_id": source_thread_id(),
                    "sellsy_contact_id": account.get("sellsyContactId"),
                    "evidence_level": "user_result_verified" if ok else private_text("text_036"),
                    "attachment_count": len(attachments),
                },
                "email_event_invalid",
            ),
            "event_id",
        )

    save(EMAILQ, queue)
    return report(
        "email-sequencer",
        {
            "counts": {
                "sent": sent,
                "verified": sum(
                    1
                    for item in verified
                    if item.get("labelSent") and item.get("sameThread") and item.get("attachmentCount") == 0
                ),
                "blocked": len(blocked),
            },
            "blockedReasons": blocked,
            "externalSendsNow": sent,
        },
        status="processed",
    )
