"""Contact-evidence validation and human approval policy, without side effects."""

from __future__ import annotations

import json
import math
import re

from flow_contact_evidence_state import Row, object_row, strings


def valid_url(x: object) -> bool:
    return bool(re.match("^https://[^\\s]+$", str(x or "").strip(), re.IGNORECASE))


def source_url(x: object) -> bool:
    return valid_url(x) and (
        not re.search(
            "(google\\.[^/]+/search|bing\\.com/search|linkedin\\.com/search)",
            str(x),
            re.IGNORECASE,
        )
    )


def domain(email: str) -> str:
    return email.lower().split("@")[-1] if "@" in email else ""


def validate(a: Row, e: Row) -> tuple[bool, list[str]]:
    gaps: list[str] = []
    email = str(e.get("professionalEmail") or "").strip().lower()
    allowed = {
        str(a.get("domain") or "").lower(),
        *[str(x).lower() for x in strings(a.get("domains") or [])],
    }
    if not email or "@" not in email:
        gaps.append("professional_email")
    elif domain(email) not in allowed:
        gaps.append("email_domain_mismatch")
    if not source_url(e.get("emailEvidenceUrl")):
        gaps.append("email_evidence_url")
    ver = object_row(e.get("emailVerification") or {})
    try:
        confidence = float(str(ver.get("confidence") or ver.get("score") or 0))
        confidence = confidence / 100 if confidence > 1 else confidence
    except (ValueError, TypeError):
        confidence = 0
    if (
        str(ver.get("status") or "").lower() not in {"valid", "deliverable", "accepted"}
        or not math.isfinite(confidence)
        or not 0.9 <= confidence <= 1
    ):
        gaps.append("email_verification")
    if not valid_url(e.get("profileUrl")):
        gaps.append("professional_profile_url")
    if not str(e.get("verifiedRole") or "").strip():
        gaps.append("verified_role")
    if not valid_url(e.get("roleEvidenceUrl")):
        gaps.append("role_evidence_url")
    if not valid_url(
        e.get("companyEvidenceUrl") or next(iter(strings(a.get("sources") or [])), "")
    ):
        gaps.append("company_evidence_url")
    if (
        str(e.get("personName") or "").strip().lower()
        != str(a.get("sponsor") or "").strip().lower()
    ):
        gaps.append("person_identity_match")
    return (not gaps, gaps)


def norm(x: object) -> str:
    return re.sub("\\s+", " ", str(x or "").strip().lower())


def budget_control(a: Row) -> Row:
    text = norm(a.get("budget"))
    trigger = norm(a.get("trigger"))
    amounts = re.findall(
        "(?:€|\\$)\\s?\\d+(?:[.,]\\d+)?\\s?[mk]?",
        str(a.get("budget") or "") + " " + str(a.get("trigger") or ""),
        re.IGNORECASE,
    )
    capacity_signal = bool(
        amounts
        or any(
            x in text + " " + trigger
            for x in (
                "round",
                "series",
                "acquisition",
                "investment",
                "capital",
                "funding",
            )
        )
    )
    mandate_signal = bool(
        any(
            x in text + " " + trigger
            for x in (
                "mandate",
                "migration",
                "integration",
                "international",
                "growth",
                "expansion",
                "operational",
            )
        )
    )
    return {
        "companyCapacitySignal": capacity_signal,
        "mandateSignal": mandate_signal,
        "sourceText": a.get("budget"),
        "amountSignals": amounts,
        "allocatedBudgetEvidence": False,
        "paidWallEur": 5000,
        "minimumPocEur": 30000,
        "budgetGate": "unconfirmed_requires_human_validation",
        "warning": "Funding, acquisition or growth capacity is not proof of an allocated Robinswood budget.",
    }


def approval_item(a: Row, row: Row, e: Row) -> Row:
    employees = a.get("employees")
    size_ok = isinstance(employees, (int, float)) and employees >= 50
    trigger_ok = bool(a.get("trigger"))
    flow_ok = bool(a.get("flow"))
    budget = budget_control(a)
    passed = bool(row.get("evidencePassed"))
    risks: list[str] = []
    if not budget["allocatedBudgetEvidence"]:
        risks.append("allocated_budget_not_proven")
    if passed:
        risks.append("executive_contact_role_does_not_prove_operational_flow_ownership")
    if not a.get("siren"):
        risks.append("legal_identifier_not_recorded")
    return {
        "accountKey": a.get("key"),
        "accountName": a.get("name"),
        "wave": a.get("wave"),
        "contactEvidenceStatus": row.get("status"),
        "eligibleForHumanReview": passed,
        "eligibleForAutomaticApproval": False,
        "approvedForSequence": False,
        "approvalScope": None,
        "companyProfile": {
            "legalName": a.get("legalName"),
            "siren": a.get("siren"),
            "domain": a.get("domain"),
            "employeeCount": employees,
            "sizeEvidenceStatus": "recorded_research_value_needs_freshness_control",
            "trigger": a.get("trigger"),
            "criticalFlow": a.get("flow"),
            "companySources": a.get("sources") or [],
        },
        "contactProfile": {
            "name": a.get("sponsor"),
            "expectedRole": a.get("role"),
            "verifiedRole": e.get("verifiedRole"),
            "professionalEmail": e.get("professionalEmail"),
            "emailVerification": e.get("emailVerification"),
            "profileUrl": e.get("profileUrl"),
            "evidenceHash": e.get("evidenceHash"),
            "evidenceSources": [
                x
                for x in [
                    e.get("emailEvidenceUrl"),
                    e.get("roleEvidenceUrl"),
                    e.get("companyEvidenceUrl"),
                ]
                if x
            ],
            "sellsyCompanyId": a.get("sellsyCompanyId"),
            "sellsyContactId": row.get("sellsyContactId"),
        },
        "icpControl": {
            "companySizeFit": size_ok,
            "triggerFit": trigger_ok,
            "criticalFlowFit": flow_ok,
            "commercialFit": "review_worthy"
            if passed and size_ok and trigger_ok and flow_ok
            else "insufficient",
            "robinswoodPaidWallEur": 5000,
            "minimumPocEur": 30000,
        },
        "budgetControl": budget,
        "costHypothesis": {
            "annualEur": a.get("costHypothesisEur"),
            "isSourcedFact": False,
            "usage": "internal_hypothesis_only",
        },
        "risks": risks,
        "recommendation": "human_review_required_no_auto_approval"
        if passed
        else "blocked_needs_evidence",
        "approvalFieldsRequired": [
            "approvedForSequence",
            "approvedAt",
            "approvedBy",
            "approvalScope",
        ],
        "externalOutboundAllowed": False,
        "opportunityAllowed": False,
    }


def contact_same(rb: Row, email: str, role: str, marker: str, profile: str) -> bool:
    blob = json.dumps(rb, ensure_ascii=False).lower()
    return (
        str(rb.get("email") or "").lower() == email
        and norm(role) in norm(rb.get("position"))
        and (marker.lower() in blob)
        and (str(profile or "").lower() in blob)
    )
