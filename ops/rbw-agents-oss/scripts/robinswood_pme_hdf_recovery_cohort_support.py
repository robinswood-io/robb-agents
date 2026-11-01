from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue, TypeAdapter, ValidationError

JsonObject = dict[str, object]
JSON_OBJECT_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])
JSON_LIST_ADAPTER: TypeAdapter[list[JsonValue]] = TypeAdapter(list[JsonValue])
FREE_DOMAINS = {
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.fr", "outlook.com", "outlook.fr",
    "yahoo.com", "yahoo.fr", "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "icloud.com",
    "me.com", "protonmail.com", "proton.me", "gmx.com", "gmx.fr", "aol.com",
}
ACCEPTED_SENT = {"sent", "sent_verified", "sent_needs_manual_verification", "already_sent_after_verified_lookup"}
BOUNCE_MARKERS = ("hard_bounce", "bounce", "delivery failure", "recipient address rejected", "5.1.1", "5.4.1", "permanent error")
EXECUTIVE_ROLE_MARKERS = (
    "président", "president", "chief executive", "ceo", "directeur général", "directeur general",
    "directrice générale", "directrice generale", "gérant", "gerant", "gérante", "gerante",
    "managing director", "directeur administratif et financier", "directrice administrative et financière",
    "daf", "chief financial officer", "cfo", "directeur des opérations", "directrice des opérations",
)
MAX_REVIEW_PACK_CANDIDATES = 10
MAX_FUTURE_CANARY_RECIPIENTS = 1


def object_value(value: object) -> JsonObject:
    validated = JSON_OBJECT_ADAPTER.validate_python(value)
    result: JsonObject = {}
    for key, item in validated.items():
        result[key] = item
    return result


def object_or_empty(value: object) -> JsonObject:
    try:
        return object_value(value)
    except ValidationError:
        return {}


def rows_value(value: object) -> list[JsonObject]:
    try:
        items = JSON_LIST_ADAPTER.validate_python(value)
    except ValidationError:
        return []
    rows: list[JsonObject] = []
    for item in items:
        try:
            rows.append(object_value(item))
        except ValidationError:
            continue
    return rows


def values(value: object) -> list[object]:
    try:
        return list(JSON_LIST_ADAPTER.validate_python(value))
    except ValidationError:
        return []


def text_value(value: object) -> str:
    return str(value) if isinstance(value, str) else ""

def integer_value(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default



def numeric_value(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return default




def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: JsonObject | None = None) -> JsonObject:
    if not path.exists():
        return default if default is not None else {}
    try:
        return object_value(JSON_OBJECT_ADAPTER.validate_json(path.read_bytes()))
    except (OSError, ValueError) as exc:
        raise RuntimeError("recovery_input_json_invalid") from exc


def read_jsonl(path: Path) -> list[JsonObject]:
    if not path.exists():
        return []
    rows: list[JsonObject] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        for line_number, raw in enumerate(lines, 1):
            if not raw.strip():
                continue
            try:
                rows.append(object_value(JSON_OBJECT_ADAPTER.validate_json(raw)))
            except ValueError as exc:
                raise RuntimeError(f"recovery_input_jsonl_invalid:{line_number}") from exc
    except OSError as exc:
        raise RuntimeError("recovery_input_read_failed") from exc
    return rows


def write_json(path: Path, data: JsonObject) -> None:
    validated = JSON_OBJECT_ADAPTER.validate_python(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    _ = tmp.write_text(json.dumps(validated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _ = tmp.replace(path)


def norm_email(value: JsonValue | object) -> str:
    return str(value or '').strip().lower()

def domain(email: str) -> str:
    return email.rsplit('@', 1)[-1] if '@' in email else ''

def suppression_index(path: Path, campaign_id: str) -> dict[str, JsonObject]:
    source = read_json(path, {}) or {}
    out: dict[str, JsonObject] = {}
    for key in ('records', 'blockedRecipients'):
        for row in rows_value(source.get(key)):
            email = norm_email(row.get('email') or row.get('value'))
            status = str(row.get('status') or '').lower()
            active = row.get('active') is True or status in {'do_not_contact', 'blocked', 'unsubscribe', 'opt_out'} or status.startswith('cooldown_')
            if email and active:
                blob = json.dumps(row, ensure_ascii=False).lower()
                out[email] = {
                    **row,
                    'email': email,
                    'bounce': any(marker in blob for marker in BOUNCE_MARKERS),
                    'laneBounce': row.get('campaignId') == campaign_id or str(row.get('reason') or '').lower().startswith('hdf_hard_bounce'),
                }
    return out

def sent_index(mailer_ledger: Path, dispatch_ledger: Path, campaign_id: str) -> tuple[set[str], set[str]]:
    emails: set[str] = set()
    keys: set[str] = set()
    for row in read_jsonl(mailer_ledger) + read_jsonl(dispatch_ledger):
        if row.get('status') not in ACCEPTED_SENT:
            continue
        campaign = str(row.get('campaignId') or campaign_id)
        if campaign != campaign_id:
            continue
        email = norm_email(row.get('recipientEmail'))
        if email:
            emails.add(email)
        keys.add(str(row.get('gmailMessageId') or row.get('planItemId') or row.get('draftId') or email))
    return emails, keys

def attribution_campaigns_by_email(path: Path) -> dict[str, set[str]]:
    out: dict[str, set[str]] = defaultdict(set)
    for row in read_jsonl(path):
        payload = object_or_empty(row.get('raw'))
        email = norm_email(
            row.get('recipientEmail') or row.get('recipient_email') or row.get('email')
            or payload.get('recipientEmail') or payload.get('recipient_email') or payload.get('email')
        )
        campaign = str(
            row.get('campaignId') or row.get('campaign_id')
            or payload.get('campaignId') or payload.get('campaign_id') or ''
        ).strip()
        if email and campaign:
            out[email].add(campaign)
    return out

def profile_source_index(profile_path: Path, seed_path: Path) -> dict[str, JsonObject]:
    pack = read_json(profile_path, {}) or {}
    seeds = read_json(seed_path, {}) or {}
    seed_by_siren = {
        str(row.get('siren') or ''): row
        for row in rows_value(seeds.get('items'))
        if row.get('siren')
    }
    out: dict[str, JsonObject] = {}
    for row in rows_value(pack.get('profiles')):
        email = norm_email(row.get('email'))
        source = object_or_empty(row.get('sourceContact'))
        seed = seed_by_siren.get(str(source.get('siren') or ''), {})
        if email:
            out[email] = {'profile': row, 'sourceContact': source, 'seed': seed}
    return out

def employee_lower_bound(value: object) -> int:
    text = str(value or '').strip().lower().replace('salariés', '').replace('salarié', '')
    match = re.search(r'\d+', text)
    return int(match.group(0)) if match else 0

def capacity_and_mandate_evidence(
    profile: JsonObject,
    source_bundle: JsonObject,
) -> JsonObject:
    source = object_or_empty(source_bundle.get('sourceContact'))
    seed = object_or_empty(source_bundle.get('seed'))
    context = object_or_empty(profile.get('contextStrength'))
    evidence = [str(value) for value in values(context.get('evidenceSample'))]
    evidence_blob = ' '.join(evidence).lower()
    employee_range = seed.get('employeeRange') or source.get('employeeRange')
    employee_floor = employee_lower_bound(employee_range)
    initial_score = integer_value(seed.get('initialScore'))
    public_investment_signal = bool(re.search(r'\b\d+(?:[.,]\d+)?\s*(?:m(?:illion)?s?|million|k)\s*(?:€|eur)', evidence_blob))
    scale_signal = employee_floor >= 50 or initial_score >= 75
    organization_capacity_ok = bool(scale_signal or public_investment_signal)
    role = str(source.get('leaderTitle') or seed.get('decisionMakerTitle') or '').strip()
    role_blob = role.lower()
    executive_role_ok = any(marker in role_blob for marker in EXECUTIVE_ROLE_MARKERS)
    individual_evidence_ok = context.get('individualEvidenceOk') is True
    public_leader_evidence_strength = 2 if source.get('matchedLeaderTokens') else (1 if individual_evidence_ok else 0)
    mandate_contact_ok = bool(executive_role_ok and individual_evidence_ok)
    final_status = str(source.get('finalStatus') or '')
    email_risk = str(source.get('emailRiskVerdict') or '')
    domain_verdict = str(source.get('domainVerdict') or '').lower()
    source_validation_ok = bool(
        final_status == 'ready_for_human_review_not_send'
        and source.get('qualityGateOk') is True
        and email_risk == 'verified_or_low_risk'
        and str(source.get('suppressionStatus') or '') == 'clear'
        and (
            'confirmed_official' in domain_verdict
            or 'probable_official' in domain_verdict
            or source.get('verifiedContextApplied') is True
            or source.get('priorReviewApplied') is True
        )
    )
    budget_value = str(profile.get('minimumBudgetFit') or 'unknown_requires_evidence').strip().lower()
    budget_confirmed = budget_value not in {'', 'unknown', 'unknown_requires_evidence', 'unverified', 'none', 'missing'} and 'confirmed' in budget_value
    return {
        'organizationCapacityEvidenceOk': organization_capacity_ok,
        'employeeRange': employee_range,
        'employeeLowerBound': employee_floor,
        'seedInitialScore': initial_score,
        'publicInvestmentSignal': public_investment_signal,
        'decisionMakerMandateEvidenceOk': mandate_contact_ok,
        'sourceContactValidationOk': source_validation_ok,
        'sourceFinalStatus': final_status,
        'sourceDomainVerdict': source.get('domainVerdict'),
        'sourceEmailRiskVerdict': email_risk,
        'decisionMakerRole': role,
        'executiveRoleOk': executive_role_ok,
        'individualEvidenceOk': individual_evidence_ok,
        'publicLeaderEvidenceStrength': public_leader_evidence_strength,
        'sourceLeaderVerdict': source.get('leaderVerdict'),
        'budgetConfirmed': budget_confirmed,
        'budgetEvidenceStatus': budget_value or 'missing',
        'commercialThresholds': {
            'paidWallEUR': integer_value(profile.get('paidWallEUR'), 5000),
            'pocMinimumEUR': integer_value(profile.get('pocMinimumEUR'), 30000),
        },
        'qualificationRequiredBeforeOpportunityOrOffer': [
            'active_mandate_confirmation',
            'budget_confirmation_at_or_above_commercial_thresholds',
        ],
        'basis': 'public organizational capacity and decision-maker evidence; budget is never inferred',
    }

def contact_quality_evidence(profile: JsonObject, email: str) -> bool:
    reasons = {str(value) for value in values(profile.get('reasons'))}
    context = object_or_empty(profile.get('contextStrength'))
    return (
        bool(email and '@' in email)
        and domain(email) not in FREE_DOMAINS
        and 'contact_quality_ok' in reasons
        and context.get('individualEvidenceOk') is True
    )

def classify_draft(
    draft: JsonObject,
    suppressions: dict[str, JsonObject],
    sent_emails: set[str],
    attribution: dict[str, set[str]],
    source_bundle: JsonObject | None = None,
    *, campaign_id: str, draft_source_path: str,
) -> JsonObject:
    email = norm_email(draft.get('recipientEmail'))
    profile = object_or_empty(draft.get('profileControl'))
    context = object_or_empty(profile.get('contextStrength'))
    blockers = [str(value) for value in values(profile.get('blockers'))] + [str(value) for value in values(context.get('blockers'))]
    suppression = suppressions.get(email)
    campaigns = sorted(attribution.get(email) or [])
    other_campaigns = [value for value in campaigns if value != campaign_id]
    qualification = capacity_and_mandate_evidence(profile, source_bundle or {})
    email_verified = contact_quality_evidence(profile, email)
    strong_context = (
        context.get('ok') is True
        and context.get('companyEvidenceOk') is True
        and context.get('individualEvidenceOk') is True
        and context.get('specificAngleOk') is True
        and not blockers
    )
    tier_a = str(profile.get('tier') or '').startswith('A_go_')

    hard_reasons: list[str] = []
    enrichment_reasons: list[str] = []
    if not email or '@' not in email:
        hard_reasons.append('missing_or_invalid_email')
    elif domain(email) in FREE_DOMAINS:
        hard_reasons.append('non_professional_email_domain')
    if suppression:
        hard_reasons.append('hard_bounce_suppressed' if suppression.get('bounce') else 'active_suppression_or_optout')
    if email in sent_emails:
        hard_reasons.append('already_sent_historical_lane')
    if other_campaigns:
        hard_reasons.append('cross_campaign_recipient_duplicate')
    if not tier_a:
        enrichment_reasons.append('tier_a_not_reached')
    if not email_verified:
        enrichment_reasons.append('professional_email_not_freshly_verified')
    if not strong_context:
        enrichment_reasons.append('company_individual_context_or_angle_incomplete')
    if not qualification['organizationCapacityEvidenceOk']:
        enrichment_reasons.append('organization_capacity_evidence_missing')
    if not qualification['decisionMakerMandateEvidenceOk']:
        enrichment_reasons.append('decision_maker_mandate_evidence_missing')
    if not qualification['sourceContactValidationOk']:
        enrichment_reasons.append('source_contact_domain_or_email_validation_incomplete')

    if hard_reasons:
        disposition = 'excluded'
    elif enrichment_reasons:
        disposition = 'needs_reenrichment'
    else:
        disposition = 'eligible_for_recovery_canary_review'

    evidence = [str(value) for value in values(context.get('evidenceSample'))][:8]
    return {
        'recoveryId': f"hdf-recovery:{email or draft.get('draftId')}",
        'draftId': draft.get('draftId'),
        'companyName': draft.get('companyName'),
        'recipientName': draft.get('recipientName'),
        'recipientEmail': email,
        'segment': profile.get('segment') or context.get('segment'),
        'disposition': disposition,
        'hardExclusionReasons': sorted(set(hard_reasons)),
        'reenrichmentReasons': sorted(set(enrichment_reasons)),
        'profileTier': profile.get('tier'),
        'profileScore': profile.get('score'),
        'qualificationControl': qualification,
        'budgetEvidenceStatus': qualification['budgetEvidenceStatus'],
        'budgetConfirmed': qualification['budgetConfirmed'],
        'emailEvidenceOk': email_verified,
        'strongContextOk': strong_context,
        'suppressionEvidence': suppression,
        'otherCampaignIds': other_campaigns,
        'sourceEvidence': evidence,
        'sourceDraftGeneratedAt': draft.get('generatedAt'),
        'sourceDraftPath': draft_source_path,
        'externalSendAllowed': False,
        'readyForOutbound': False,
        'mailerConsumable': False,
        'humanReviewRequired': True,
        'reviewPurpose': 'bounded recovery canary qualification only; never an offer or send authorization',
    }

def render_md(report: JsonObject) -> str:
    counts = object_or_empty(report.get('counts'))
    metrics = object_or_empty(report.get('historicalMetricsFrozen'))
    return '\n'.join([
        '# Robinswood PME HDF — cohorte de récupération',
        '',
        f"- Generated: {report.get('generatedAt')}",
        f"- Status: **{report.get('status')}**",
        f"- Drafts reviewed: **{counts.get('draftsReviewed')}**",
        f"- Excluded: **{counts.get('excluded')}**",
        f"- Needs reenrichment: **{counts.get('needs_reenrichment')}**",
        f"- Eligible for human review: **{counts.get('eligible_for_human_review')}**",
        '- Ready for outbound: **0**',
        '- External send allowed: **false**',
        '',
        '## Historical denominator preserved',
        f"- Sends: **{metrics.get('sentCumulative')}**",
        f"- Lane hard bounces: **{metrics.get('laneHardBounces')}**",
        f"- Hard-bounce rate: **{metrics.get('hardBounceRate')}**",
        '',
        'This register is not a mailer queue. A separate explicit human approval is required before any future canary.',
    ]) + '\n'

def selftest() -> JsonObject:
    synthetic = object_value(JSON_OBJECT_ADAPTER.validate_python({
        'draftId': 'synthetic',
        'recipientEmail': 'person@company.example',
        'companyName': 'Example',
        'profileControl': {
            'tier': 'A_go_autonomous_pre_send_gate',
            'score': 90,
            'reasons': ['contact_quality_ok'],
            'blockers': [],
            'minimumBudgetFit': 'unknown_requires_evidence',
            'pocMinimumEUR': 30000,
            'paidWallEUR': 5000,
            'contextStrength': {
                'ok': True,
                'companyEvidenceOk': True,
                'individualEvidenceOk': True,
                'specificAngleOk': True,
                'blockers': [],
                'evidenceSample': ['Official company page and named executive evidence.'],
            },
        },
    }))
    capacity = object_value(JSON_OBJECT_ADAPTER.validate_python({
        'sourceContact': {
            'leaderTitle': 'Directeur Général',
            'siren': '999999999',
            'finalStatus': 'ready_for_human_review_not_send',
            'qualityGateOk': True,
            'emailRiskVerdict': 'verified_or_low_risk',
            'suppressionStatus': 'clear',
            'domainVerdict': 'confirmed_official_company_domain',
        },
        'seed': {'employeeRange': '100-199', 'initialScore': 85, 'decisionMakerTitle': 'Directeur Général'},
    }))
    missing_capacity = classify_draft(synthetic, {}, set(), {}, {}, campaign_id="qa-campaign", draft_source_path="qa://drafts")
    reviewable = classify_draft(synthetic, {}, set(), {}, capacity, campaign_id="qa-campaign", draft_source_path="qa://drafts")
    bounce_row: JsonObject = {'bounce': True}
    bounce_suppressions: dict[str, JsonObject] = {'person@company.example': bounce_row}
    bounced = classify_draft(synthetic, bounce_suppressions, set(), {}, capacity, campaign_id='qa-campaign', draft_source_path='qa://drafts')
    return {
        'ok': (
            missing_capacity.get('disposition') == 'needs_reenrichment'
            and reviewable.get('disposition') == 'eligible_for_recovery_canary_review'
            and bounced.get('disposition') == 'excluded'
        ),
        'unknownBudgetNeverInferred': reviewable.get('budgetConfirmed') is False,
        'unknownBudgetCanReachReviewNotSend': reviewable.get('disposition') == 'eligible_for_recovery_canary_review',
        'capacityAndExecutiveEvidenceRequired': missing_capacity.get('disposition') == 'needs_reenrichment',
        'bounceAlwaysExcluded': bounced.get('disposition') == 'excluded',
        'externalSendAllowed': reviewable.get('externalSendAllowed') is False,
        'mailerConsumable': reviewable.get('mailerConsumable') is False,
    }
