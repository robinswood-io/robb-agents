from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from email.utils import parseaddr
from pathlib import Path

import robinswood_flow_core as c
from flow_contact_evidence_state import OBJECT, Row, object_row, object_rows
from flow_duplicate_crm import has_exact_id, ident, list_endpoint
from flow_duplicate_targets import fingerprint, targets
from robinswood_flow_duplicate_relationship_audit import run as run_duplicate_audit

ROOT = Path("/srv/rbw-agents-oss")
OPS = c.OPS
OUT = OPS / "robinswood-commercial-post-remediation-control-last.json"
OUT_MD = OPS / "robinswood-commercial-post-remediation-control-last.md"
STATE = OPS / "robinswood-commercial-post-remediation-control-state.json"
SYNC = OPS / "robinswood-flow-sellsy-sync-last.json"
INTEGRITY = OPS / "robinswood-flow-sellsy-integrity-last.json"
HDF_GATE = OPS / "robinswood-pme-hdf-pre-send-gate-last.json"
HDF_MAILER = OPS / "robinswood-pme-hdf-audited-mailer-last.json"
HDF_MAILER_LEDGER = OPS / "robinswood-pme-hdf-audited-mailer-ledger.jsonl"
HDF_DISPATCH_LEDGER = OPS / "robinswood-pme-hdf-audited-dispatch-ledger.jsonl"
INCIDENT = OPS / "robinswood-flow-yousign-d5-attachment-incident.json"
DUPLICATE_AUDIT = OPS / "robinswood-flow-duplicate-relationship-audit-last.json"
READY_SCHEDULES = ROOT / "config" / "temporal" / "ready-schedules.json"
CAMPAIGN_ID = "robinswood-pme-hdf-dirigeants-2026-06"
ACCEPTED_SENT = {
    "sent",
    "sent_verified",
    "sent_needs_manual_verification",
    "already_sent_after_verified_lookup",
}


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Row | None = None) -> Row:
    if not path.exists():
        return {} if default is None else default
    return dict(OBJECT.validate_json(path.read_bytes(), strict=True))


def read_jsonl(path: Path) -> list[Row]:
    if not path.exists():
        return []
    return [
        dict(OBJECT.validate_json(line, strict=True))
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_json(path: Path, data: Row) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    _ = tmp.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    _ = tmp.replace(path)


def parse_iso(value: object) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value)).astimezone(UTC)
    except (ValueError, TypeError):
        return None


def hdf_sent_keys() -> set[str]:
    out: set[str] = set()
    for row in read_jsonl(HDF_MAILER_LEDGER) + read_jsonl(HDF_DISPATCH_LEDGER):
        if row.get("status") not in ACCEPTED_SENT:
            continue
        if row.get("campaignId") and row.get("campaignId") != CAMPAIGN_ID:
            continue
        email = str(row.get("recipientEmail") or "").strip().lower()
        key = str(
            row.get("gmailMessageId")
            or row.get("planItemId")
            or row.get("draftId")
            or email
        )
        if key:
            out.add(key)
    return out


def allowed_yousign_message_ids() -> set[str]:
    allowed = {c.source_message_id()}
    for row in object_rows((read_json(c.EMAILQ, {}) or {}).get("items") or []):
        for key in ("providerMessageId", "gmailMessageId"):
            if row.get(key):
                allowed.add(str(row[key]))
    for row in read_jsonl(c.LEDGER):
        for key in ("providerMessageId", "gmailMessageId"):
            if row.get(key):
                allowed.add(str(row[key]))
    incident = read_json(INCIDENT, {}) or {}
    message_id = object_row(incident.get("gmailEvidence") or {}).get("messageId")
    if message_id:
        allowed.add(str(message_id))
    return allowed


def gmail_yousign_readback() -> Row:
    access = c.token()
    query = c.private_text("sentMailAuditQuery")
    ids: set[str] = set()
    seen_tokens: set[str] = set()
    page_token: str | None = None
    pages = 0
    for pages in range(1, 101):
        params: dict[str, str | list[str]] = {"q": query, "maxResults": "100"}
        if page_token is not None:
            params["pageToken"] = page_token
        result = c.gh(access, "messages", params)
        for row in object_rows(result.get("messages") or []):
            identifier = row.get("id")
            if not isinstance(identifier, str) or not identifier:
                raise ValueError("gmail_message_identifier_invalid")
            ids.add(identifier)
        token = result.get("nextPageToken")
        if token is None:
            break
        if not isinstance(token, str) or not token or token in seen_tokens:
            raise ValueError("gmail_pagination_cursor_invalid")
        seen_tokens.add(token)
        page_token = token
    else:
        raise ValueError("gmail_pagination_budget_exhausted")
    allowed = allowed_yousign_message_ids()
    unknown = sorted(ids - allowed)
    unknown_details: list[Row] = []
    for message_id in unknown[:10]:
        message = c.gh(
            access,
            f"messages/{message_id}",
            {"format": "metadata", "metadataHeaders": ["To", "Subject", "Date"]},
        )
        headers = c.hdict(message)
        unknown_details.append(
            {
                "messageId": message_id,
                "threadId": message.get("threadId"),
                "to": parseaddr(headers.get("to") or "")[1].lower(),
                "subject": headers.get("subject"),
                "date": headers.get("date"),
            }
        )
    return {
        "query": query,
        "complete": True,
        "pages": pages,
        "messageIds": sorted(ids),
        "allowedMessageIds": sorted(allowed),
        "unknownMessageIds": unknown,
        "unknownMessages": unknown_details,
        "ok": not unknown,
        "verifiedBy": "gmail_api_exact_search",
    }


def opportunity_readback() -> Row:
    opportunities, scan = list_endpoint("/opportunities")
    ids = [int(str(ident(row))) for row in opportunities if ident(row) is not None]
    state = read_json(c.CRMSTATE, {}) or {}
    target_ids = {
        int(str(value))
        for section in ("companies", "contacts")
        for value in object_row(state.get(section) or {}).values()
        if value not in (None, "")
    }
    matches: list[Row] = []
    archived_synthetic_controls: list[Row] = []
    for row in opportunities:
        blob = json.dumps(row, ensure_ascii=False).lower()
        linked_ids = sorted(
            value
            for value in target_ids
            if has_exact_id(OBJECT.validate_python(row, strict=True), value)
        )
        marker = "rbw-flow:" in blob or "robinswood flow" in blob
        if not linked_ids and (not marker):
            continue
        detail = row
        if marker and ident(row) is not None:
            detail = object_row(c.crmreq(f"/opportunities/{int(str(ident(row)))}"))
        detail_blob = json.dumps(detail, ensure_ascii=False).lower()
        archived_synthetic = (
            not linked_ids
            and str(detail.get("status") or "").lower() == "lost"
            and ("[canary archived" in detail_blob)
            and ("@youcom.io" in detail_blob)
        )
        item = {
            "opportunityId": ident(row),
            "linkedCanonicalIds": linked_ids,
            "marker": marker,
            "name": row.get("name"),
            "status": detail.get("status"),
            "companyId": detail.get("company_id"),
        }
        if archived_synthetic:
            archived_synthetic_controls.append(item)
        else:
            matches.append(item)
    return {
        "rowsRead": len(opportunities),
        "uniqueIds": len(set(ids)),
        "flowMatches": matches,
        "archivedSyntheticControls": archived_synthetic_controls,
        "ok": scan["complete"] is True
        and len(opportunities) == len(set(ids))
        and (not matches),
        "scan": scan,
        "verifiedBy": "sellsy_api_cursor_complete_read_plus_targeted_detail_readback",
        "syntheticExclusionRule": "lost + explicit [CANARY ARCHIVED] evidence + internal @youcom.io identity + no current canonical account link",
    }


def duplicate_audit_readback() -> Row:
    current = read_json(DUPLICATE_AUDIT, {}) or {}
    generated = parse_iso(current.get("generatedAt"))
    same_targets = current.get("targetFingerprint") == fingerprint(targets())
    refresh = (
        not current
        or not same_targets
        or not generated
        or not timedelta(0) <= datetime.now(UTC) - generated <= timedelta(days=7)
    )
    if refresh:
        current = run_duplicate_audit(emit=False)
    counts = object_row(current.get("counts") or {})
    return {
        "refreshed": refresh,
        "reportPath": str(DUPLICATE_AUDIT),
        "status": current.get("status"),
        "objects": counts.get("objects"),
        "archives": counts.get("archives"),
        "hardDeletes": counts.get("hardDeletes"),
        "crmMutations": counts.get("crmMutations"),
        "ok": current.get("ok") is True
        and counts.get("archives") == 0
        and (counts.get("hardDeletes") == 0)
        and (counts.get("crmMutations") == 0),
    }


def schedule_contract() -> Row:
    payload = read_json(READY_SCHEDULES, {}) or {}
    rows = [
        row
        for row in object_rows(payload.get("schedules") or [])
        if str(row.get("schedule_id") or "").startswith("sched.robinswood-flow-")
    ]
    owners = [
        row
        for row in rows
        if object_row(row.get("payload") or {}).get("legacy_id")
        == "robinswood-flow-sellsy-sync"
    ]
    return {
        "flowSchedules": len(rows),
        "sellsyMutationOwners": len(owners),
        "ownerScheduleId": owners[0].get("schedule_id") if len(owners) == 1 else None,
        "ok": len(rows) == 8 and len(owners) == 1,
        "note": "live drift is checked by the existing schedule-drift-watchdog; no second schedule is created",
    }
