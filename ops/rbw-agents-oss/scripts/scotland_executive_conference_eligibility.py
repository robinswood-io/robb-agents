"""Eligibility and schedule rules for the Scottish executive campaign."""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from urllib import parse
from zoneinfo import ZoneInfo

from scotland_executive_conference_types import (
    CampaignEvidence,
    CampaignItem,
    CampaignLimits,
    CampaignProof,
)

DAILY40_PROFILE = '2026-10-02.40-split'
GENERIC = re.compile(r'^(info|hello|contact|sales|support|admin|press|jobs|office|team|noreply)@', re.IGNORECASE)

def dt(value: str) -> datetime:
    return datetime.fromisoformat(value)
def fresh(value: str | None, t: datetime, days: int) -> bool:
    if not isinstance(value, str):
        return False
    try:
        age = t - dt(value)
        return timedelta(0) <= age <= timedelta(days=days)
    except (ValueError, TypeError, AttributeError):
        return False
def eligible(item: CampaignItem, proof: CampaignProof | None, t: datetime) -> list[str]:
    reasons: list[str] = []
    role = item.get('role', '')
    if not re.fullmatch(
        r'CEO|Chief Executive Officer|Managing Director|Chief (?:Operating|Financial|Technology|Information|Marketing|Revenue|Commercial|People|Human Resources|Digital|Strategy) Officer',
        role,
        re.IGNORECASE,
    ):
        reasons.append('not_verified_executive')
    employee_minimum = item.get('employeeMinimum', 0)
    employee_evidence = item.get('employeeEvidenceUrl', '')
    if isinstance(employee_minimum, bool) or employee_minimum <= 35 or not employee_evidence:
        reasons.append('strict_headcount_not_proven')
    if item.get('scottishHeadquarters') is not True or item.get('corporateType') != 'limited_company':
        reasons.append('scottish_corporate_scope_not_proven')
    for key in ('roleEvidenceUrl', 'legalEvidenceUrl', 'locationEvidenceUrl'):
        if not str(item.get(key, '')).startswith('https://'):
            reasons.append('missing_' + key)
    if not fresh(item.get('roleCheckedAt'), t, 14):
        reasons.append('role_evidence_stale')
    email = item['email']
    if not re.fullmatch(r'[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+', email) or GENERIC.search(email) or email.split('@')[-1] != item.get('domain'):
        reasons.append('invalid_personal_professional_address')
    if proof is None:
        reasons.append('deliverability_stale_or_unproven')
    else:
        proof_result = proof.get('result')
        if not fresh(proof.get('checkedAt'), t, 30) or not isinstance(proof_result, str) or proof_result not in ('deliverable', 'valid') or proof.get('acceptAll') is not False or proof.get('score', 0) < 90:
            reasons.append('deliverability_stale_or_unproven')
    return reasons

def window(t: datetime, limits: CampaignLimits | None = None) -> bool:
    local = t.astimezone(ZoneInfo('Europe/London'))
    if limits and limits.get('cadenceProfile') == DAILY40_PROFILE:
        minute = local.hour * 60 + local.minute
        return local.weekday() < 5 and (540 <= minute < 720 or 840 <= minute < 1080)
    return local.weekday() < 5 and 9 <= local.hour < 17
def role_focus(item: CampaignItem) -> str:
    role = item.get('role', '').lower()
    if 'financial' in role: return 'the cost of a workflow, its business value and the evidence needed to control it'
    if 'operating' in role: return 'handoffs, delivery delays and the checks needed before automating a process'
    if 'technology' in role or 'information' in role or 'digital' in role: return 'a bounded workflow, model choice and evidence that the integration works'
    return 'leadership capacity, margin and choosing one workflow worth improving'


def refresh_item_evidence(items: list[CampaignItem], current_evidence: dict[str, CampaignEvidence]) -> None:
    for item in items:
        evidence=current_evidence.get(item['id'])
        if evidence is None:
            continue
        if evidence.get('qualification')=='qualified_public_role_and_provider_company_evidence' and (evidence.get('email') == item.get('email') and evidence.get('domain') == item.get('domain') and evidence.get('contactName') == item.get('contactName')):
            url=parse.urlparse(evidence.get('roleEvidenceUrl',''))
            if url.scheme=='https' and url.hostname in [item['domain'],'www.'+item['domain']]:
                qualification = evidence.get('qualification')
                role = evidence.get('role')
                role_url = evidence.get('roleEvidenceUrl')
                role_checked = evidence.get('roleCheckedAt')
                legal_url = evidence.get('legalEvidenceUrl')
                corporate_type = evidence.get('corporateType')
                if isinstance(qualification, str): item['qualification'] = qualification
                if isinstance(role, str): item['role'] = role
                if isinstance(role_url, str): item['roleEvidenceUrl'] = role_url
                if isinstance(role_checked, str): item['roleCheckedAt'] = role_checked
                if isinstance(legal_url, str): item['legalEvidenceUrl'] = legal_url
                if isinstance(corporate_type, str): item['corporateType'] = corporate_type
