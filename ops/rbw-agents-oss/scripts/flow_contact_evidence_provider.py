"""Bounded provider reads and exact-person evidence; no CRM or outbound mutation."""

from __future__ import annotations

import hashlib
import math
import re
from typing import TypedDict
from urllib.parse import urlparse

import contact_provider
import requests
from flow_contact_evidence_state import (
    Row,
    iso,
    norm,
    object_row,
    role_ok,
    source_urls,
    split_name,
    strings,
    valid_url,
)
from robinswood_pme_hdf_hunter_contact_enrichment import (
    email_finder,
    hunter_get,
    response_data,
    verify_email,
)


class Quota(TypedDict):
    minHeadroom: int
    searches: int
    verifications: int
    policyPath: str


UA = "Robinswood-Flow-Evidence-Discovery/2.0 account-scoped prepare-only no-send"


def capacity(key: str, limits: Quota) -> Row:
    if contact_provider.configured():
        response = contact_provider.get("account", {}, "robinswood-flow")
        service = object_row(
            object_row(response.json().get("data") or {}).get("localService") or {}
        )
        ready = response.status_code == 200 and service.get("state") == "ready"
        return {
            "ok": ready,
            "allowed": ready,
            "provider": contact_provider.MARKER,
            "hunterRequired": False,
            "remaining": None,
            "requiredHeadroom": None,
        }
    response = hunter_get("account", {"api_key": key}, timeout=12)
    data = response_data(response) if response.get("ok") else {}
    calls = object_row(data.get("calls") or {})
    remaining: int | None = None
    try:
        remaining = int(str(calls["available"])) - int(str(calls["used"]))
    except (ValueError, KeyError):
        remaining = None
    required = limits["minHeadroom"] + limits["searches"] + limits["verifications"]
    return {
        "ok": bool(response.get("ok")),
        "statusCode": response.get("statusCode"),
        "remaining": remaining,
        "requiredHeadroom": required,
        "allowed": bool(
            response.get("ok") and remaining is not None and (remaining >= required)
        ),
    }


def public_company(account: Row) -> Row:
    wanted = [
        word
        for word in norm(account.get("legalName") or account.get("name")).split()
        if len(word) > 3 and word not in {"sasu", "sarl", "company", "service"}
    ]
    domain = str(account["domain"])
    urls = [url for url in strings(account.get("sources") or []) if valid_url(url)] + [
        "https://" + domain
    ]
    for url in urls[:5]:
        try:
            response = requests.get(
                url, headers={"User-Agent": UA}, timeout=8, allow_redirects=True
            )
            text = norm(re.sub("<[^>]+>", " ", response.text[:150000]))
            host = (urlparse(response.url).hostname or "").removeprefix("www.")
            matches_domain = host == domain or host.endswith("." + domain)
            matches = [word for word in wanted if word in text]
            if response.status_code < 400 and (matches_domain or matches):
                return {
                    "ok": True,
                    "url": response.url,
                    "statusCode": response.status_code,
                    "matchedTokens": matches,
                    "domainMatched": matches_domain,
                }
        except (OSError, ValueError, requests.RequestException):
            continue
    return {"ok": False, "url": None}


def discover(account: Row, key: str | None, available: Row) -> Row:
    base: Row = {
        "accountKey": account["key"],
        "accountName": account["name"],
        "personName": account["sponsor"],
        "expectedRole": account["role"],
        "domain": account["domain"],
        "externalOutbound": False,
        "crmMutation": False,
        "opportunityCreated": False,
    }
    if not key or not available.get("allowed"):
        return {
            **base,
            "status": "blocked_hunter_auth_or_capacity",
            "passed": False,
            "gaps": ["hunter_auth_or_capacity"],
            "sourceUrls": [],
            "confidence": 0,
        }
    first, last = split_name(account["sponsor"])
    if not first or not last:
        return {
            **base,
            "status": "needs_evidence",
            "passed": False,
            "gaps": ["person_identity_incomplete"],
            "sourceUrls": [],
            "confidence": 0,
        }
    company = public_company(account)
    finder = email_finder(
        key,
        str(account["domain"]),
        first,
        last,
        str(account.get("legalName") or account["name"]),
        campaign="robinswood-flow",
    )
    found = response_data(finder) if finder.get("ok") else {}
    email = str(found.get("email") or "").lower()
    verification: Row = (
        verify_email(key, email, campaign="robinswood-flow")
        if email
        else {"ok": False, "body": {}}
    )
    verified = response_data(verification) if verification.get("ok") else {}
    profile = str(
        found.get("linkedin")
        or found.get("linkedin_url")
        or found.get("linkedinUrl")
        or ""
    )
    role = str(found.get("position") or "")
    urls = source_urls(found)
    email_url = next(iter(urls), None)
    try:
        score = float(str(verified.get("score", found.get("score", 0))))
    except (TypeError, ValueError, OverflowError):
        score = 0
    if not math.isfinite(score) or not 0 <= score <= 100:
        score = 0
    confidence = score / 100 if score > 1 else score
    status = str(verified.get("result") or verified.get("status") or "").lower()
    gaps: list[str] = []
    if not email or email.split("@")[-1] not in {
        str(account["domain"]),
        *strings(account.get("domains") or []),
    }:
        gaps.append("professional_email_exact_domain")
    if not email_url:
        gaps.append("email_evidence_url")
    if status not in {"valid", "deliverable", "accepted"} or confidence < 0.9:
        gaps.append("email_verification_0_90")
    if not valid_url(profile):
        gaps.append("professional_profile_url")
    if not role_ok(account["role"], role):
        gaps.append("verified_role_match")
    if not company["ok"]:
        gaps.append("public_company_evidence")
    passed = not gaps
    evidence: Row = {
        "accountKey": account["key"],
        "personName": account["sponsor"],
        "professionalEmail": email,
        "emailEvidenceUrl": email_url,
        "emailVerification": {
            "status": status,
            "confidence": confidence,
            "score": score,
        },
        "profileUrl": profile,
        "verifiedRole": role,
        "roleEvidenceUrl": profile,
        "companyEvidenceUrl": company.get("url"),
        "source": "robinswood_flow_contact_evidence_discovery_v2",
        "sourceGeneratedAt": iso(),
        "evidenceHash": hashlib.sha256(
            "|".join(
                map(
                    str,
                    [
                        account["key"],
                        email,
                        email_url,
                        profile,
                        role,
                        company.get("url"),
                        status,
                        confidence,
                    ],
                )
            ).encode()
        ).hexdigest(),
    }
    return {
        **base,
        "status": "verified_evidence_ready_for_inbox" if passed else "needs_evidence",
        "passed": passed,
        "gaps": gaps,
        "professionalEmail": email or None,
        "profileUrl": profile,
        "verifiedRole": role or None,
        "sourceUrls": list(
            dict.fromkeys(
                urls + [url for url in [profile, str(company.get("url") or "")] if url]
            )
        ),
        "confidence": confidence,
        "companyEvidence": company,
        "hunter": {
            "finderOk": finder.get("ok"),
            "finderStatusCode": finder.get("statusCode"),
            "verifierOk": verification.get("ok"),
            "verifierStatusCode": verification.get("statusCode"),
            "verificationStatus": status,
        },
        "evidence": evidence if passed else None,
    }
