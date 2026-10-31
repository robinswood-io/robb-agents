from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from robinswood_pme_hdf_recovery_cohort_support import (
    JSON_OBJECT_ADAPTER,
    MAX_FUTURE_CANARY_RECIPIENTS,
    MAX_REVIEW_PACK_CANDIDATES,
    JsonObject,
    attribution_campaigns_by_email,
    classify_draft,
    integer_value,
    norm_email,
    now_iso,
    numeric_value,
    object_or_empty,
    profile_source_index,
    read_json,
    render_md,
    rows_value,
    selftest,
    sent_index,
    suppression_index,
    values,
    write_json,
)

__all__ = ["CONFIG_PATH", "RecoveryConfig", "RecoveryPaths", "main", "run", "selftest"]

CONFIG_PATH = Path(os.environ.get("RBW_HDF_RECOVERY_CONFIG", "/etc/rbw-agents-oss/hdf-recovery-profile.json"))


@dataclass
class RecoveryArguments(argparse.Namespace):
    workspace_root: Path = Path()
    config: Path = CONFIG_PATH


@dataclass(frozen=True)
class RecoveryPaths:
    drafts: Path
    profile_pack: Path
    scale_seed: Path
    performance: Path
    suppression: Path
    mailer_ledger: Path
    dispatch_ledger: Path
    attribution_ledger: Path
    report_json: Path
    report_markdown: Path
    review_pack: Path
    simulated_plan: Path
    history: Path

    @classmethod
    def under(cls, root: Path) -> RecoveryPaths:
        campaign = root / "campaigns"
        ops = campaign / "ops"
        return cls(
            drafts=ops / "robinswood-pme-hdf-email-drafts-prepare-only-latest.json",
            profile_pack=ops / "robinswood-pme-hdf-profile-icp-control-pack-latest.json",
            scale_seed=ops / "robinswood-pme-hdf-scale-seed-latest.json",
            performance=ops / "robinswood-pme-hdf-performance-optimizer-last.json",
            suppression=campaign / "contact-suppression.json",
            mailer_ledger=ops / "robinswood-pme-hdf-audited-mailer-ledger.jsonl",
            dispatch_ledger=ops / "robinswood-pme-hdf-audited-dispatch-ledger.jsonl",
            attribution_ledger=ops / "commercial-attribution-ledger.jsonl",
            report_json=ops / "robinswood-pme-hdf-recovery-cohort-last.json",
            report_markdown=ops / "robinswood-pme-hdf-recovery-cohort-last.md",
            review_pack=ops / "robinswood-pme-hdf-recovery-human-review-pack.json",
            simulated_plan=ops / "robinswood-pme-hdf-recovery-simulated-plan.json",
            history=ops / "robinswood-pme-hdf-recovery-cohort-history.jsonl",
        )


@dataclass(frozen=True)
class RecoveryConfig:
    campaign_id: str
    recovery_cohort_id: str
    expected_sent_cumulative: int
    expected_lane_hard_bounces: int

    @classmethod
    def load(cls, path: Path = CONFIG_PATH) -> RecoveryConfig:
        value = object_or_empty(JSON_OBJECT_ADAPTER.validate_json(path.read_bytes()))
        campaign_id = value.get("campaignId")
        cohort_id = value.get("recoveryCohortId")
        sent = value.get("expectedSentCumulative")
        bounces = value.get("expectedLaneHardBounces")
        if not isinstance(campaign_id, str) or not campaign_id:
            raise ValueError("recovery_campaign_id_missing")
        if not isinstance(cohort_id, str) or not cohort_id:
            raise ValueError("recovery_cohort_id_missing")
        if not isinstance(sent, int) or isinstance(sent, bool) or sent < 0:
            raise ValueError("recovery_expected_sent_invalid")
        if not isinstance(bounces, int) or isinstance(bounces, bool) or bounces < 0:
            raise ValueError("recovery_expected_bounces_invalid")
        return cls(campaign_id, cohort_id, sent, bounces)


def run(paths: RecoveryPaths, config: RecoveryConfig, emit: bool = True) -> JsonObject:
    generated = now_iso()
    drafts_payload = read_json(paths.drafts, {}) or {}
    drafts: list[JsonObject] = rows_value(drafts_payload.get('drafts'))
    perf = read_json(paths.performance, {}) or {}
    metrics = object_or_empty(perf.get('metrics'))
    suppressions = suppression_index(paths.suppression, config.campaign_id)
    sent_emails, sent_keys = sent_index(paths.mailer_ledger, paths.dispatch_ledger, config.campaign_id)
    attribution = attribution_campaigns_by_email(paths.attribution_ledger)
    source_index = profile_source_index(paths.profile_pack, paths.scale_seed)

    seen: set[str] = set()
    results: list[JsonObject] = []
    duplicate_drafts = 0
    for draft in drafts:
        email = norm_email(draft.get('recipientEmail'))
        dedupe = email or str(draft.get('draftId') or '')
        if dedupe in seen:
            duplicate_drafts += 1
            continue
        seen.add(dedupe)
        results.append(classify_draft(draft, suppressions, sent_emails, attribution, source_index.get(email) or {}, campaign_id=config.campaign_id, draft_source_path=str(paths.drafts)))

    disposition_counts: Counter[str] = Counter(str(row.get('disposition')) for row in results)
    reason_counts: Counter[str] = Counter(
        str(reason)
        for row in results
        for reason in values(row.get('hardExclusionReasons')) + values(row.get('reenrichmentReasons'))
    )
    candidates: list[JsonObject] = [row for row in results if row.get('disposition') == 'eligible_for_recovery_canary_review']
    candidates.sort(key=lambda row: (
        -integer_value(object_or_empty(row.get('qualificationControl')).get('publicLeaderEvidenceStrength')),
        -integer_value(row.get('profileScore')),
        -integer_value(object_or_empty(row.get('qualificationControl')).get('employeeLowerBound')),
        str(row.get('companyName') or ''),
    ))
    reenrichment: list[JsonObject] = [row for row in results if row.get('disposition') == 'needs_reenrichment']
    excluded: list[JsonObject] = [row for row in results if row.get('disposition') == 'excluded']
    review_candidates: list[JsonObject] = []
    seen_companies: set[str] = set()
    for row in candidates:
        company_key = re.sub(r'[^a-z0-9]+', '', str(row.get('companyName') or '').lower())
        if not company_key or company_key in seen_companies:
            continue
        seen_companies.add(company_key)
        review_candidates.append(row)
        if len(review_candidates) >= MAX_REVIEW_PACK_CANDIDATES:
            break

    frozen = {
        'campaignId': config.campaign_id,
        'sentCumulative': integer_value(metrics.get('sentCumulative')),
        'laneHardBounces': integer_value(metrics.get('laneHardBounces')),
        'excludedCrossCampaignBounces': integer_value(metrics.get('excludedCrossCampaignBounces')),
        'hardBounceRate': numeric_value(metrics.get('hardBounceRate')),
        'qualifiedReplies': integer_value(metrics.get('qualifiedReplies')),
        'source': str(paths.performance),
        'dilutionForbidden': True,
    }
    counts = {
        'draftsReviewed': len(drafts),
        'uniqueRecipientsReviewed': len(results),
        'duplicateDraftsExcluded': duplicate_drafts,
        'excluded': disposition_counts.get('excluded', 0),
        'needs_reenrichment': disposition_counts.get('needs_reenrichment', 0),
        'eligible_for_human_review': disposition_counts.get('eligible_for_recovery_canary_review', 0),
        'eligible_for_recovery_canary_review': disposition_counts.get('eligible_for_recovery_canary_review', 0),
        'reviewPackCandidates': len(review_candidates),
        'budgetConfirmed': sum(1 for row in candidates if row.get('budgetConfirmed') is True),
        'budgetQualificationRequired': sum(1 for row in candidates if row.get('budgetConfirmed') is not True),
        'readyForOutbound': 0,
        'approvedForSend': 0,
        'sentHistoricalRecipientsExcluded': sum(1 for row in results if 'already_sent_historical_lane' in values(row.get('hardExclusionReasons'))),
        'activeSuppressionRecipients': len(suppressions),
        'historicalSentKeys': len(sent_keys),
    }
    report: JsonObject = {
        'generatedAt': generated,
        'contractVersion': 'robinswood-pme-hdf-recovery-cohort-v2-capacity-mandate-review-only',
        'capabilityId': 'robinswood-pme-hdf-recovery-cohort',
        'ok': True,
        'status': 'prepared_review_only_zero_send',
        'summary': f"hdf_recovery: reviewed={len(results)} excluded={counts['excluded']} reenrich={counts['needs_reenrichment']} reviewEligible={counts['eligible_for_human_review']} outbound=0",
        'campaignId': config.campaign_id,
        'recoveryCohortId': config.recovery_cohort_id,
        'counts': counts,
        'reasonCounts': dict(reason_counts),
        'historicalMetricsFrozen': frozen,
        'candidatesForHumanReview': review_candidates,
        'allEligibleCandidateCount': len(candidates),
        'reenrichmentQueue': reenrichment,
        'excluded': excluded,
        'checks': {
            'historicalMetricsPreserved': frozen['sentCumulative'] == config.expected_sent_cumulative and frozen['laneHardBounces'] == config.expected_lane_hard_bounces,
            'hardBounceRecipientsExcluded': all(row.get('disposition') == 'excluded' for row in results if object_or_empty(row.get('suppressionEvidence')).get('bounce')),
            'crossCampaignDuplicatesExcluded': all(row.get('disposition') == 'excluded' for row in results if row.get('otherCampaignIds')),
            'budgetNeverInferred': all(row.get('budgetConfirmed') is not True for row in candidates if row.get('budgetEvidenceStatus') in {'unknown', 'unknown_requires_evidence', 'missing'}),
            'reviewCandidatesHaveCapacityAndMandateEvidence': all(
                object_or_empty(row.get('qualificationControl')).get('organizationCapacityEvidenceOk') is True
                and object_or_empty(row.get('qualificationControl')).get('decisionMakerMandateEvidenceOk') is True
                and object_or_empty(row.get('qualificationControl')).get('sourceContactValidationOk') is True
                for row in candidates
            ),
            'reviewCandidatesRemainNonSendable': all(
                row.get('externalSendAllowed') is False
                and row.get('readyForOutbound') is False
                and row.get('mailerConsumable') is False
                for row in candidates
            ),
            'externalSendAllowed': False,
            'sendQueueCreated': False,
            'mailerConsumable': False,
            'microCanaryEnabled': False,
        },
        'blockingReasons': ['explicit_human_approval_required_before_any_future_canary'],
        'warningReasons': [] if candidates else ['no_recovery_candidate_currently_meets_capacity_mandate_email_and_context_gate'],
        'systemsOfRecord': {
            'classification': 'none',
            'work': {'required': False, 'objectIds': [], 'verifiedByReadback': False},
            'sellsy': {'required': False, 'tenant': 'robinswood', 'objectIds': [], 'verifiedByReadback': False},
            'pendingSyncItems': [],
        },
        'artifacts': {
            'reportJson': str(paths.report_json),
            'reportMd': str(paths.report_markdown),
            'humanReviewPack': str(paths.review_pack),
            'simulatedPlan': str(paths.simulated_plan),
            'historyJsonl': str(paths.history),
            'sourceDrafts': str(paths.drafts),
        },
        'externalEffects': {'emailsSent': 0, 'linkedinActions': 0, 'crmMutations': 0, 'opportunitiesCreated': 0},
    }
    review_pack: JsonObject = {
        'generatedAt': generated,
        'contractVersion': 'robinswood-pme-hdf-recovery-human-review-pack-v2-capacity-mandate',
        'status': 'needs_human_review',
        'approved': False,
        'externalSendAllowed': False,
        'readyForOutbound': 0,
        'counts': {
            'eligibleTotal': len(candidates),
            'candidatesInPack': len(review_candidates),
            'reenrichment': len(reenrichment),
        },
        'candidates': review_candidates,
        'qualificationPolicy': {
            'budgetIsNeverInferred': True,
            'reviewEligibilityRequiresOrganizationCapacityEvidence': True,
            'reviewEligibilityRequiresDecisionMakerMandateEvidence': True,
            'futureFirstContactPurpose': 'qualify active mandate and budget; no offer below thresholds',
            'paidWallEUR': 5000,
            'pocMinimumEUR': 30000,
        },
        'approvalContract': {
            'approvalMustBeExplicitAndSeparate': True,
            'approvalScope': 'future_bounded_micro_canary_only',
            'maxRecipientsPerFutureCanary': MAX_FUTURE_CANARY_RECIPIENTS,
            'historicalMetricsMustRemainSeparate': True,
            'approvalDoesNotConfirmBudgetOrMandate': True,
        },
    }
    simulated_plan: JsonObject = {
        'generatedAt': generated,
        'contractVersion': 'robinswood-pme-hdf-recovery-simulated-plan-v2-one-recipient-review-only',
        'status': 'simulation_disabled_not_mailer_consumable',
        'mailerConsumable': False,
        'externalSendAllowed': False,
        'approvedItemsCount': 0,
        'readyForOutbound': 0,
        'maxFutureCanaryRecipients': MAX_FUTURE_CANARY_RECIPIENTS,
        'microCanaryEnabled': False,
        'simulatedCandidates': review_candidates[:MAX_FUTURE_CANARY_RECIPIENTS],
        'blockedUntil': [
            'explicit_human_approval_for_exact_recipient_and_message',
            'fresh_email_verification',
            'fresh_suppression_and_cross_campaign_dedupe',
            'separate_recovery_canary_safety_contract_green',
        ],
        'qualificationObligationsBeforeOpportunityOrOffer': [
            'active_mandate_confirmation',
            'budget_confirmation_at_or_above_5000_eur_paid_wall',
            'poc_budget_at_or_above_30000_eur_when_poc_is_proposed',
        ],
    }
    write_json(paths.report_json, report)
    _ = paths.report_markdown.write_text(render_md(report), encoding='utf-8')
    write_json(paths.review_pack, review_pack)
    write_json(paths.simulated_plan, simulated_plan)
    with paths.history.open('a', encoding='utf-8') as handle:
        _ = handle.write(json.dumps({'generatedAt': generated, 'counts': counts, 'historicalMetricsFrozen': frozen}, ensure_ascii=False) + '\n')
    if emit:
        print(json.dumps({'ok': True, 'status': report['status'], 'counts': counts, 'artifacts': report['artifacts']}, ensure_ascii=False))
    return report

def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare a non-sendable HDF recovery review report.")
    _ = parser.add_argument("--workspace-root", required=True, type=Path)
    _ = parser.add_argument("--config", default=CONFIG_PATH, type=Path)
    args = parser.parse_args(namespace=RecoveryArguments())
    config = RecoveryConfig.load(args.config)
    report = run(RecoveryPaths.under(args.workspace_root), config)
    return 0 if report.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
