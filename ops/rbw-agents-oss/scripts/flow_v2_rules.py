"""Scheduling and reply decisions shared by the recovered Flow v2 commands."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import robinswood_flow_core as c
from flow_contact_evidence_state import Row

TZ = ZoneInfo("Europe/Paris")


MONTHS = {
    "janvier": 1,
    "février": 2,
    "fevrier": 2,
    "mars": 3,
    "avril": 4,
    "mai": 5,
    "juin": 6,
    "juillet": 7,
    "août": 8,
    "aout": 8,
    "septembre": 9,
    "octobre": 10,
    "novembre": 11,
    "décembre": 12,
    "decembre": 12,
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


def dt(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value)
        return result.astimezone(TZ) if result.tzinfo is not None else None
    except ValueError:
        return None


def next_business(ref: datetime, offset: int, hour: int, minute: int) -> datetime:
    if offset < 0 or ref.tzinfo is None:
        raise ValueError("invalid_business_date_reference")
    d = ref.astimezone(TZ).date()
    seen = 0
    while seen < offset:
        d += timedelta(days=1)
        if d.weekday() < 5:
            seen += 1
    out = datetime(d.year, d.month, d.day, hour, minute, tzinfo=TZ)
    while out <= ref.astimezone(TZ) or out.weekday() > 4:
        d += timedelta(days=1)
        if d.weekday() < 5:
            out = datetime(d.year, d.month, d.day, hour, minute, tzinfo=TZ)
    return out


def task_due(a: Row, ref: datetime | None = None) -> datetime:
    ref = (ref or datetime.now(TZ)).astimezone(TZ)
    if a.get("key") == c.account_key():
        return next_business(ref, 1, 9, 40)
    if a.get("wave") == 1:
        peers = [
            x
            for x in c.accounts()
            if x.get("wave") == 1 and x.get("key") != c.account_key()
        ]
        idx = next((i for i, x in enumerate(peers) if x["key"] == a["key"]), 0)
        return next_business(ref, 1, 9, 30) + timedelta(minutes=20 * idx)
    peers = [x for x in c.accounts() if x.get("wave") == 2]
    idx = next((i for i, x in enumerate(peers) if x["key"] == a["key"]), 0)
    return next_business(ref, 2, 13, 30) + timedelta(minutes=20 * idx)


def future_slot(
    ref: datetime | None = None, hour: int = 9, minute: int = 15
) -> datetime:
    ref = (ref or datetime.now(TZ)).astimezone(TZ)
    candidate = ref.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= ref or candidate.weekday() > 4:
        return next_business(ref, 1, hour, minute)
    return candidate


APPROVAL_SCOPE_VERSION = "robinswood-flow-sequence-approval-v2"
APPROVED_ACTIONS = ("email_d0", "email_d5", "email_d10", "email_d14", "linkedin_connection")


def approval_scope(account: Mapping[str, object]) -> str | None:
    key = account.get("key")
    campaign = account.get("campaign_id")
    name = account.get("name")
    email = account.get("email")
    linkedin = account.get("linkedin")
    company_id = account.get("sellsyCompanyId")
    contact_id = account.get("sellsyContactId")
    cost = account.get("costHypothesisEur")
    domain = account.get("domain")
    if (
        not isinstance(key, str)
        or not key.strip()
        or not isinstance(campaign, str)
        or not campaign.strip()
        or not isinstance(name, str)
        or not name.strip()
        or not isinstance(email, str)
        or not email.strip()
        or not isinstance(linkedin, str)
        or not linkedin.strip()
        or account.get("contactVerified") is not True
        or not isinstance(domain, str)
        or not domain.strip()
        or isinstance(company_id, bool)
        or not isinstance(company_id, (int, str))
        or not str(company_id).isdecimal()
        or int(str(company_id)) <= 0
        or isinstance(contact_id, bool)
        or not isinstance(contact_id, (int, str))
        or not str(contact_id).isdecimal()
        or int(str(contact_id)) <= 0
        or isinstance(cost, bool)
        or not isinstance(cost, int)
        or cost < 0
    ):
        return None
    copy_fields = ("sponsor", "role", "civility")
    copy_inputs: dict[str, str | None] = {}
    for field in copy_fields:
        value = account.get(field)
        if value is not None and not isinstance(value, str):
            return None
        copy_inputs[field] = value
    civility_source = (
        account.get("civility_source")
        or account.get("civilitySource")
        or account.get("civility_proof_source")
    )
    if civility_source is not None and not isinstance(civility_source, str):
        return None
    copy_inputs["civilitySource"] = civility_source
    payload: dict[str, object] = {
        "version": APPROVAL_SCOPE_VERSION,
        "actions": APPROVED_ACTIONS,
        "accountKey": key.strip(),
        "campaignId": campaign.strip(),
        "companyName": name.strip(),
        "domain": domain.strip().lower(),
        "recipientEmail": email.strip().lower(),
        "linkedinProfileUrl": linkedin.strip(),
        "sellsyCompanyId": int(str(company_id)),
        "sellsyContactId": int(str(contact_id)),
        "copy": {
            **copy_inputs,
            "flow": str(account.get("flow") or "flux critique"),
            "trigger": str(account.get("trigger") or "votre contexte actuel"),
            "costHypothesisEur": cost,
            "budget": str(account.get("budget") or "mandat de transformation"),
        },
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "flow-v2-scope:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def approval_for(
    a: Row,
    old: Row,
    decision: Row,
    reference: datetime | None = None,
) -> tuple[bool, Row]:
    """Fail closed on legacy decisions; a new matching scope needs explicit approval."""
    _ = old
    expected_scope = approval_scope(a)
    approved_at = dt(decision.get("approvedAt"))
    now = reference or datetime.now(TZ)
    valid = (
        expected_scope is not None
        and decision.get("accountKey") == a.get("key")
        and decision.get("approvalScope") == expected_scope
        and decision.get("approvedForSequence") is True
        and isinstance(decision.get("approvedBy"), str)
        and bool(str(decision.get("approvedBy") or "").strip())
        and str(decision.get("status") or "").lower() == "approved"
        and approved_at is not None
        and now.tzinfo is not None
        and approved_at <= now.astimezone(TZ)
    )
    metadata = {
        "approvedAt": decision.get("approvedAt") if valid else None,
        "approvedBy": decision.get("approvedBy") if valid else None,
        "approvalScope": expected_scope if valid else None,
    }
    return bool(valid), metadata


def classify(text: str, frm: str = "") -> str:
    t = (text + " " + frm).lower()
    if any(
        x in t
        for x in (
            "mailer-daemon",
            "postmaster",
            "status: 5.",
            "permanent error",
            "recipient address rejected",
        )
    ):
        return "hard_bounce"
    if any(x in t for x in ("temporarily unavailable", "mailbox full", "status: 4.")):
        return "soft_bounce"
    if any(
        x in t
        for x in (
            "unsubscribe",
            "désabonner",
            "desabonner",
            "ne me contactez plus",
            "remove me",
            "opt out",
            "opt-out",
        )
    ):
        return "opt_out"
    if any(
        x in t
        for x in (
            "out of office",
            "automatic reply",
            "réponse automatique",
            "reponse automatique",
            "absent du bureau",
            "de retour le",
            "returning on",
        )
    ):
        return "out_of_office"
    if any(
        x in t
        for x in (
            "mettre en relation",
            "mettez-vous en relation",
            "orienter vers",
            "contactez plutôt",
            "contactez plutot",
            "je vous redirige",
            "referral",
        )
    ):
        return "referral"
    if any(
        x in t
        for x in (
            "pas intéressé",
            "pas interesse",
            "non merci",
            "aucun intérêt",
            "aucun interet",
            "ne donne pas suite",
            "refus",
        )
    ):
        return "refusal"
    if any(
        x in t
        for x in (
            "rendez-vous",
            "disponible",
            "intéressé",
            "interesse",
            "volontiers",
            "avec plaisir",
            "prenons un créneau",
            "prenons un creneau",
        )
    ):
        return "positive"
    return "ambiguous"


def extract_return_date(text: str, received: datetime | None = None) -> Row:
    received = (received or datetime.now(TZ)).astimezone(TZ)
    t = text.lower()
    candidates: list[datetime] = []
    patterns = [
        r"(?:de retour|retour|returning|back|until|jusqu[^ ]*)[^\d]{0,25}(20\d{2})-(\d{1,2})-(\d{1,2})",
        r"(?:de retour|retour|returning|back|until|jusqu[^ ]*)[^\d]{0,25}(\d{1,2})[/.](\d{1,2})[/.](20\d{2})",
    ]
    for i, p in enumerate(patterns):
        for m in re.finditer(p, t):
            try:
                if i == 0:
                    y, mo, d = map(int, m.groups())
                else:
                    d, mo, y = map(int, m.groups())
                candidates.append(datetime(y, mo, d, 9, 15, tzinfo=TZ))
            except (ValueError, KeyError):
                pass
    for m in re.finditer(
        r"(?:de retour|retour|returning|back|until|jusqu[^ ]*)[^\d]{0,25}(\d{1,2})(?:er|st|nd|rd|th)?\s+([a-zéûôîàèùç]+)(?:\s+(20\d{2}))?",
        t,
    ):
        try:
            d = int(m.group(1))
            mo = MONTHS[m.group(2)]
            y = int(m.group(3) or received.year)
            x = datetime(y, mo, d, 9, 15, tzinfo=TZ)
            if x <= received and m.group(3) is None:
                x = x.replace(year=y + 1)
            candidates.append(x)
        except (ValueError, KeyError):
            pass
    uniq = sorted(
        {
            x.isoformat(): x
            for x in candidates
            if received < x <= received + timedelta(days=180)
        }.values()
    )
    if len(uniq) != 1:
        return {
            "reliable": False,
            "returnAt": None,
            "reason": "missing_return_date" if not uniq else "multiple_return_dates",
        }
    x = uniq[0]
    while x.weekday() > 4:
        x += timedelta(days=1)
    return {
        "reliable": True,
        "returnAt": x.isoformat(),
        "reason": "explicit_single_future_return_date",
    }


def is_due(item: Row, now: datetime | None = None) -> bool:
    current = now or datetime.now(TZ)
    due = dt(item.get("dueAt"))
    pause_value = item.get("pauseUntil")
    pause = dt(pause_value)
    if (
        current.tzinfo is None
        or due is None
        or (pause_value not in (None, "") and pause is None)
    ):
        return False
    return current >= due and (pause is None or current >= pause)
