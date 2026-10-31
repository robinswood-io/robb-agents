"""Pure qualification and reporting for the note-free browser transport."""

from __future__ import annotations

import re

from flow_contact_evidence_state import Row

PERSON = re.compile(
    "^https://([a-z]{2,3}\\.)?www\\.linkedin\\.com/in/[^/?#]+/?", re.IGNORECASE
)

COMPANY = re.compile("linkedin\\.com/(company|school|showcase)/", re.IGNORECASE)


def normalize(raw: Row) -> Row:
    return {
        "requestId": raw.get("requestId"),
        "linkedinProfileUrl": raw.get("linkedinProfileUrl"),
        "companyName": raw.get("companyName"),
        "contactName": raw.get("contactName"),
        "messageDraft": "",
        "officerRoleQualified": raw.get("officerRoleQualified") is True,
        "officerRoleEvidence": raw.get("officerRoleEvidence"),
    }


def validate(it: Row) -> tuple[bool, str]:
    if it.get("officerRoleQualified") is not True or not it.get("officerRoleEvidence"):
        return (False, "needs_officer_role_validation")
    u = str(it.get("linkedinProfileUrl") or "")
    if not u:
        return (False, "missing_linkedin_profile_url")
    if COMPANY.search(u):
        return (False, "company_page_url_forbidden")
    if not PERSON.search(u):
        return (False, "not_a_linkedin_person_profile_url")
    return (True, "ok")


def summarize(rows: list[Row]) -> dict[str, int]:
    c = {
        "processed": len(rows),
        "sent": 0,
        "blocked": 0,
        "errors": 0,
        "skipped": 0,
        "dryRun": 0,
        "pendingOrFollowOnly": 0,
    }
    for r in rows:
        s = str(r.get("status") or "")
        if s == "sent_ui":
            c["sent"] += 1
        elif s == "blocked_ui":
            c["blocked"] += 1
        elif s == "error":
            c["errors"] += 1
        elif s == "skipped_already_connected":
            c["skipped"] += 1
        elif s == "dry_run_ready_not_sent":
            c["dryRun"] += 1
        elif s == "pending_or_follow_only":
            c["pendingOrFollowOnly"] += 1
    return c


def md(rep: Row) -> str:
    return (
        "# LinkedIn connection browser provider\n\n- Generated: "
        + str(rep.get("generatedAt"))
        + "\n- Status: `"
        + str(rep.get("status"))
        + "`\n- Summary: "
        + str(rep.get("summary"))
        + "\n"
    )
