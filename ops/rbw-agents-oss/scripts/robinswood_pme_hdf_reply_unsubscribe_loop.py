#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from email.utils import parseaddr
from pathlib import Path

import requests
from hdf_reply_content import (
    OBJECT,
    Row,
    body,
    bounce,
    bounced_to,
    classify,
    email,
    headers,
    nested,
    object_row,
    object_rows,
)
from outbound_content_guard import CONTRACT_VERSION
from pydantic import TypeAdapter

__all__ = ['OBJECT', 'Row', 'body', 'bounce', 'bounced_to', 'classify', 'email', 'headers', 'nested', 'object_row', 'object_rows']

WS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2")

OPS = WS / "campaigns/ops"

CAM = WS / "campaigns"

CREDS = Path("/home/craft/.craft-agent/xdg-config/google-mcp/credentials.json")

TOKENS = Path("/home/craft/.craft-agent/xdg-data/google-mcp/tokens.json")

INBOX = OPS / "robinswood-pme-hdf-reply-inbox.json"

SUPPRESSION = CAM / "contact-suppression.json"

OUT = OPS / "robinswood-pme-hdf-reply-unsubscribe-loop-last.json"

OUT_MD = OPS / "robinswood-pme-hdf-reply-unsubscribe-loop-last.md"

LEDGER = OPS / "robinswood-pme-hdf-reply-unsubscribe-loop-ledger.jsonl"

STATE = OPS / "robinswood-pme-hdf-reply-unsubscribe-loop-state.json"

HUMAN = OPS / "robinswood-pme-hdf-human-reply-action-queue.json"

PROPOSALS = OPS / "robinswood-pme-hdf-suppression-proposals.json"

CHALLENGES = OPS / "robinswood-pme-hdf-delivery-challenge-queue.json"

SEND_LEDGERS = (
    OPS / "robinswood-pme-hdf-audited-mailer-ledger.jsonl",
    OPS / "robinswood-pme-hdf-send-ledger.jsonl",
    OPS / "robinswood-pme-hdf-audited-dispatch-ledger.jsonl",
)

CAMPAIGN_ID = "robinswood-pme-hdf-dirigeants-2026-06"

SENDER = "thibault@robinswood.io"


def now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read(path: Path, default: Row) -> Row:
    try:
        return dict(OBJECT.validate_json(path.read_bytes(), strict=True))
    except FileNotFoundError:
        return default.copy()


def write(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    _ = temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def token() -> str:
    credentials = object_row(read(CREDS, {}).get("installed") or {})
    tokens = read(TOKENS, {})
    response = requests.post(
        str(credentials["token_uri"]),
        data={
            "client_id": str(credentials["client_id"]),
            "client_secret": str(credentials["client_secret"]),
            "refresh_token": str(tokens["refresh_token"]),
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    response.raise_for_status()
    return TypeAdapter(str).validate_python(
        OBJECT.validate_json(response.content)["access_token"], strict=True
    )


def sent_threads() -> dict[str, Row]:
    result: dict[str, Row] = {}
    for path in SEND_LEDGERS:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = dict(OBJECT.validate_json(line))
            except ValueError:
                continue
            if row.get("status") not in (
                "sent",
                "sent_verified",
                "sent_needs_manual_verification",
                "already_sent_after_verified_lookup",
            ):
                continue
            thread = str(nested(row, "gmailThreadId", "threadId") or "")
            message = str(nested(row, "gmailMessageId", "messageId", "id") or "")
            if thread:
                result[thread] = {
                    "threadId": thread,
                    "gmailMessageId": message,
                    "recipientEmail": email(row.get("recipientEmail")),
                    "companyName": row.get("companyName"),
                    "subject": row.get("subject"),
                    "planItemId": row.get("planItemId") or row.get("draftId"),
                }
    return result


def ingest(timestamp: str) -> list[Row]:
    access = token()
    replies: list[Row] = []
    for thread, metadata in sent_threads().items():
        response = requests.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/threads/{thread}",
            headers={"Authorization": f"Bearer {access}"},
            params={"format": "full"},
            timeout=30,
        )
        if response.status_code == 404:
            continue
        response.raise_for_status()
        for message in object_rows(
            OBJECT.validate_json(response.content).get("messages") or []
        ):
            identifier = str(message.get("id") or "")
            if identifier == metadata.get("gmailMessageId"):
                continue
            metadata_headers = headers(message)
            sender = email(parseaddr(metadata_headers.get("from") or "")[1])
            if not sender or sender == SENDER or sender.endswith("@robinswood.io"):
                continue
            received = timestamp
            if message.get("internalDate"):
                received = (
                    datetime.fromtimestamp(
                        int(str(message["internalDate"])) / 1000, UTC
                    )
                    .isoformat()
                    .replace("+00:00", "Z")
                )
            replies.append(
                {
                    "messageId": identifier,
                    "threadId": thread,
                    "fromEmail": sender,
                    "toEmail": email(metadata_headers.get("to")),
                    "subject": metadata_headers.get("subject")
                    or metadata.get("subject"),
                    "bodyText": body(object_row(message.get("payload") or {})),
                    "receivedAt": received,
                    "source": "gmail_thread_ingest",
                    "campaignId": CAMPAIGN_ID,
                    "companyName": metadata.get("companyName"),
                    "planItemId": metadata.get("planItemId"),
                }
            )
    return replies


def suppress(address: str, reason: str, source: str, timestamp: str) -> Row:
    data = read(SUPPRESSION, {})
    records = object_rows(data.get("records") or [])
    for row in object_rows(data.get("blockedRecipients") or []) + records:
        if email(row.get("email") or row.get("value")) == address:
            return {"email": address, "status": "already_suppressed"}
    record: Row = {
        "email": address,
        "status": "do_not_contact",
        "active": True,
        "reason": reason,
        "source": source,
        "createdAt": timestamp,
        "campaignId": CAMPAIGN_ID,
    }
    records.append(record)
    data["records"] = records
    write(SUPPRESSION, data)
    return {"email": address, "status": "suppression_applied", "record": record}


def main() -> int:
    ts = now()
    if not INBOX.exists():
        write(INBOX, {"generatedAt": ts, "status": "awaiting_replies", "replies": []})
    state = read(STATE, {"processedMessageIds": []})
    seen = set(
        TypeAdapter(list[str]).validate_python(
            state.get("processedMessageIds") or [], strict=True
        )
    )
    err = None
    try:
        gmail = ingest(ts)
    except (OSError, ValueError, TypeError, KeyError, requests.RequestException) as e:
        gmail = []
        err = type(e).__name__
    combined = gmail + object_rows(read(INBOX, {}).get("replies") or [])
    processed: list[Row] = []
    supp: list[Row] = []
    actions: list[Row] = []
    challenges: list[Row] = []
    ids: list[str] = []
    for r in combined:
        mid = str(
            r.get("messageId")
            or r.get("id")
            or f"manual:{r.get('fromEmail')}:{r.get('receivedAt')}"
        )
        if mid in seen:
            continue
        seen.add(mid)
        b = str(r.get("bodyText") or "")
        cls = classify(r, b)
        rec: Row = {
            **r,
            "messageId": mid,
            "classification": cls,
            "processedAt": ts,
            "externalSendAllowed": False,
        }
        processed.append(rec)
        ids.append(mid)
        addr = email(r.get("fromEmail"))
        if cls == "delivery_challenge":
            challenges.append(
                {
                    "challengeId": "hdf-delivery:" + mid,
                    "sourceMessageId": mid,
                    "threadId": r.get("threadId"),
                    "fromEmail": addr,
                    "subject": r.get("subject"),
                    "status": "delivery_challenge_no_business_reply",
                    "automaticChallengeResponseAllowed": False,
                    "createdAt": ts,
                }
            )
        elif cls == "hard_bounce_auto_suppression":
            supp.append(
                suppress(bounced_to(r, b), "hdf_hard_bounce_delivery_failure", mid, ts)
            )
        elif cls == "unsubscribe_or_negative" and addr:
            supp.append(suppress(addr, "hdf_reply_unsubscribe_or_negative", mid, ts))
        elif cls in {
            "positive_interest_human_required",
            "ambiguous_reply_human_required",
        }:
            actions.append(
                {
                    "createdAt": ts,
                    "actionId": "hdf-reply:" + mid,
                    "type": "human_reply_required",
                    "classification": cls,
                    "fromEmail": addr,
                    "companyName": r.get("companyName"),
                    "subject": r.get("subject"),
                    "bodyText": b,
                    "sourceMessageId": mid,
                    "threadId": r.get("threadId"),
                    "priority": "high" if cls.startswith("positive") else "medium",
                    "owner": "Thibault",
                    "status": "pending_human_response",
                }
            )
    state.update(
        {
            "processedMessageIds": sorted(seen.union(ids)),
            "lastRunAt": ts,
            "lastGmailError": err,
        }
    )
    write(STATE, state)
    old = object_rows(read(HUMAN, {}).get("actions") or [])
    oldids = {str(x.get("actionId")) for x in old}
    merged = old + [x for x in actions if str(x["actionId"]) not in oldids]
    write(
        HUMAN,
        {
            "generatedAt": ts,
            "status": "human_in_loop_after_reply",
            "externalSendAllowed": False,
            "actions": merged,
        },
    )
    oldc = object_rows(read(CHALLENGES, {}).get("challenges") or [])
    oldcids = {str(x.get("challengeId")) for x in oldc}
    mergedc = oldc + [x for x in challenges if str(x["challengeId"]) not in oldcids]
    write(
        CHALLENGES,
        {
            "generatedAt": ts,
            "status": "delivery_challenges_separated_from_business_replies",
            "automaticResponseAllowed": False,
            "challenges": mergedc,
        },
    )
    write(
        PROPOSALS,
        {
            "generatedAt": ts,
            "status": "suppression_applied_or_proposed",
            "applied": supp,
            "proposals": [],
        },
    )
    counts = {
        "gmailThreadsTracked": len(sent_threads()),
        "gmailRepliesFetched": len(gmail),
        "newMessagesProcessed": len(processed),
        "deliveryChallenges": sum(
            x["classification"] == "delivery_challenge" for x in processed
        ),
        "businessReplies": sum(
            str(x["classification"])
            in {
                "unsubscribe_or_negative",
                "positive_interest_human_required",
                "ambiguous_reply_human_required",
            }
            for x in processed
        ),
        "qualifiedPositiveReplies": sum(
            x["classification"] == "positive_interest_human_required" for x in processed
        ),
        "hardBounces": sum(
            x["classification"] == "hard_bounce_auto_suppression" for x in processed
        ),
        "suppressionApplied": sum(
            x.get("status") == "suppression_applied" for x in supp
        ),
        "humanActionsNew": len(actions),
    }
    report: Row = {
        "generatedAt": ts,
        "capabilityId": "robinswood-pme-hdf-reply-unsubscribe-loop",
        "contractVersion": "hdf-reply-loop-v5-delivery-challenge-separated",
        "guardContractVersion": CONTRACT_VERSION,
        "status": "processed",
        "ok": err is None,
        "gmailError": err,
        "externalSendAllowed": False,
        "counts": counts,
        "processed": processed,
        "humanActionsNew": actions,
        "deliveryChallengesNew": challenges,
        "suppressionResults": supp,
        "artifacts": {
            "json": str(OUT),
            "deliveryChallengeQueue": str(CHALLENGES),
            "state": str(STATE),
            "humanReplyActionQueue": str(HUMAN),
            "suppressionList": str(SUPPRESSION),
        },
    }
    write(OUT, report)
    _ = OUT_MD.write_text(
        f"# PME HDF — reply loop\n\n- Messages: {counts['newMessagesProcessed']}\n- Business replies: {counts['businessReplies']}\n- Delivery challenges: {counts['deliveryChallenges']}\n- Hard bounces: {counts['hardBounces']}\n- Automatic challenge response: **false**\n",
        encoding="utf-8",
    )
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    f = LEDGER.open("a", encoding="utf-8")
    _ = f.write(
        json.dumps(
            {
                "generatedAt": ts,
                "counts": counts,
                "status": report["status"],
                "gmailError": err,
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    f.close()
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "status": report["status"],
                "counts": counts,
                "gmailError": err,
                "artifacts": report["artifacts"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if err is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
