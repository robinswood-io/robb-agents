"""Pure MIME extraction and reply classification shared by the HDF reply loop."""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Mapping

from outbound_content_guard import is_delivery_challenge
from pydantic import JsonValue, TypeAdapter

type Row = dict[str, object]

OBJECT: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])

BOUNCE_FROM = ("mailer-daemon", "postmaster", "mail delivery subsystem")

BOUNCE_BODY = (
    "mail delivery failed",
    "undelivered mail returned to sender",
    "recipient address rejected",
    "delivery status notification",
    "permanent error",
    "final-recipient",
    "status: 5.",
)

NEG = (
    "unsubscribe",
    "désabonner",
    "desabonner",
    "ne me contactez plus",
    "ne plus me contacter",
    "stop",
    "remove me",
    "opt out",
    "opt-out",
    "pas intéressé",
    "pas interesse",
    "non merci",
)

POS = (
    "intéressé",
    "interesse",
    "ok pour",
    "disponible",
    "rdv",
    "rendez-vous",
    "call",
    "appel",
    "échange",
    "echange",
    "parlons",
    "pourquoi pas",
    "envoyez",
    "dites-m en plus",
    "volontiers",
    "avec plaisir",
)


def object_row(value: object) -> Row:
    return dict(OBJECT.validate_python(value, strict=True))


def object_rows(value: object) -> list[Row]:
    rows: TypeAdapter[list[dict[str, JsonValue]]] = TypeAdapter(
        list[dict[str, JsonValue]]
    )
    return [dict(row) for row in rows.validate_python(value, strict=True)]


def email(value: object) -> str:
    return str(value or "").strip().lower()


def headers(message: Row) -> dict[str, str]:
    payload = object_row(message.get("payload") or {})
    return {
        str(row.get("name") or "").lower(): str(row.get("value") or "")
        for row in object_rows(payload.get("headers") or [])
    }


def body(payload: Row) -> str:
    texts: list[str] = []

    def walk(part: Row) -> None:
        mime = str(part.get("mimeType") or "")
        data = object_row(part.get("body") or {}).get("data")
        if isinstance(data, str) and data and (mime in {"text/plain", "text/html"}):
            try:
                raw = base64.urlsafe_b64decode(
                    data + "=" * ((4 - len(data) % 4) % 4)
                ).decode("utf-8", "ignore")
                if mime == "text/html":
                    raw = re.sub("<br\\s*/?>", "\n", raw, flags=re.IGNORECASE)
                    raw = re.sub("<[^>]+>", " ", raw)
                texts.append(re.sub("\\s+", " ", raw).strip())
            except (ValueError, binascii.Error):
                texts.append("")
        for child in object_rows(part.get("parts") or []):
            walk(child)

    walk(payload)
    return "\n".join(text for text in texts if text)


def nested(row: Mapping[str, object], *keys: str) -> object:
    for key in keys:
        if row.get(key):
            return row[key]
    post = object_row(row.get("postSendVerification") or {})
    metadata = object_row(post.get("metadata") or {})
    message = object_row(post.get("message") or {})
    for key in keys:
        for candidate in [post, metadata, message]:
            if candidate.get(key):
                return candidate[key]
    return None


def bounce(row: Mapping[str, object], text: str) -> bool:
    content = (str(row.get("subject") or "") + "\n" + text).lower()
    return any(value in email(row.get("fromEmail")) for value in BOUNCE_FROM) or any(
        value in content for value in BOUNCE_BODY
    )


def bounced_to(row: Mapping[str, object], body_text: str) -> str:
    text = body_text + "\n" + str(row.get("subject") or "")
    for pattern in (
        "Final-Recipient:\\s*rfc822;\\s*([^\\s;<>]+@[^\\s;<>]+)",
        "RCPT TO:<([^>]+@[^>]+)>",
        "following address\\(es\\) failed:\\s*([^\\s;<>]+@[^\\s;<>]+)",
    ):
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return email(match.group(1).strip(".,;"))
    return email(row.get("recipientEmail") or row.get("toEmail"))


def classify(row: Mapping[str, object], body_text: str) -> str:
    if is_delivery_challenge(row.get("fromEmail"), row.get("subject"), body_text):
        return "delivery_challenge"
    if bounce(row, body_text):
        return "hard_bounce_auto_suppression"
    text = body_text.lower()
    if any(value in text for value in NEG):
        return "unsubscribe_or_negative"
    if any(value in text for value in POS):
        return "positive_interest_human_required"
    return "ambiguous_reply_human_required" if text.strip() else "empty"
