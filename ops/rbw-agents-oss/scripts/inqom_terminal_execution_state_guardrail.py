#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS = WS / 'campaigns' / 'ops'
ACTIVE_APPROVAL = WS / 'sources' / 'inqom' / 'mutation-approvals' / 'active-autonomous-approval.json'
OUT_JSON = OPS / 'inqom-terminal-execution-state-guardrail.json'
OUT_MD = OPS / 'inqom-terminal-execution-state-guardrail.md'
ORIGIN = 'inqom-terminal-execution-state-guardrail'

REPORTS = {
    'expertResolver': OPS / 'inqom-expert-route-autonomous-resolver.json',
    'executionRegistry': OPS / 'inqom-execution-readiness-registry.json',
    'executionRegistryTests': OPS / 'inqom-execution-readiness-registry-tests.json',
    'blockerRouter': OPS / 'inqom-execution-blocker-burndown-router.json',
    'blockerRouterTests': OPS / 'inqom-execution-blocker-burndown-router-tests.json',
    'residualExpertHandoff': OPS / 'inqom-residual-expert-handoff-coverage.json',
    'residualExpertHandoffTests': OPS / 'inqom-residual-expert-handoff-coverage-tests.json',
    'activeApprovalWriteGuardrail': OPS / 'inqom-active-approval-write-guardrail.json',
    'activeApprovalWriteGuardrailTests': OPS / 'inqom-active-approval-write-guardrail-tests.json',
    'zeroValueCountGuardrail': OPS / 'inqom-zero-value-count-guardrail.json',
    'zeroValueCountGuardrailTests': OPS / 'inqom-zero-value-count-guardrail-tests.json',
    'guardrailIntegrationContract': OPS / 'inqom-guardrail-integration-contract.json',
    'guardrailIntegrationContractTests': OPS / 'inqom-guardrail-integration-contract-tests.json',
    'boundedMutationEnvelopeTests': OPS / 'inqom-bounded-mutation-envelope-tests.json',
    'businessAutonomy': OPS / 'inqom-business-autonomy-control-plane.json',
    'businessAutonomyTests': OPS / 'inqom-business-autonomy-control-plane-tests.json',
    'sourceQualityLogicalReview': OPS / 'inqom-source-quality-logical-review.json',
    'sourceQualityLogicalReviewTests': OPS / 'inqom-source-quality-logical-review-tests.json',
    'nativeReconciliationLivePreflight': OPS / 'inqom-native-reconciliation-live-preflight.json',
    'nativeReconciliationLivePreflightTests': OPS / 'inqom-native-reconciliation-live-preflight-tests.json',
    'nativeReconciliationNoLinkReview': OPS / 'inqom-native-reconciliation-no-link-candidate-review.json',
    'nativeReconciliationNoLinkReviewTests': OPS / 'inqom-native-reconciliation-no-link-candidate-review-tests.json',
    'nativeLetteringLiveState': OPS / 'inqom-native-lettering-live-state-reconciler.json',
    'nativeLetteringLiveStateTests': OPS / 'inqom-native-lettering-live-state-reconciler-tests.json',
    'nativeLetteringDenylistClosure': OPS / 'inqom-native-lettering-denylist-closure.json',
    'nativeLetteringDenylistClosureTests': OPS / 'inqom-native-lettering-denylist-closure-tests.json',
    'approvalOnlyLotZeroProtocol': OPS / 'inqom-approvalonly-lot-zero-protocol.json',
    'approvalOnlyLotZeroProtocolTests': OPS / 'inqom-approvalonly-lot-zero-protocol-tests.json',
    'approvalOnlyLotZeroLivePreflight': OPS / 'inqom-approvalonly-lot-zero-live-preflight.json',
    'approvalOnlyLotZeroLivePreflightTests': OPS / 'inqom-approvalonly-lot-zero-live-preflight-tests.json',
    'entryCorrectionApprovalProducer': OPS / 'inqom-accounting-entry-correction-approval-producer.json',
    'entryCorrectionApprovedExecutor': OPS / 'inqom-accounting-entry-correction-approved-executor.json',
    'entryCorrectionApprovedExecutorTests': OPS / 'inqom-accounting-entry-correction-approved-executor-tests.json',
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def count(data: dict[str, Any], key: str, default: int = 0) -> int:
    if not isinstance(data, dict):
        return default
    value = data.get(key)
    return int(value) if value is not None else default


def counts(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get('counts'), dict):
        return payload['counts']
    return {}


def report_clean(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get('ok') is not True:
        return False
    if payload.get('blockingReasons'):
        return False
    c = counts(payload)
    if count(c, 'failed', 0) != 0 or count(c, 'criticalFailed', 0) != 0 or count(c, 'highFailed', 0) != 0:
        return False
    return True


def add_check(checks: list[dict[str, Any]], check_id: str, ok: bool, detail: Any = None, severity: str = 'critical') -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': severity, 'detail': detail})


def current_residual_context(payloads: dict, queue: list[dict]) -> bool:
    from inqom_business_autonomy_control_plane import current_human_residual_records, freshness
    from inqom_residual_expert_handoff_coverage import responsible_handoff_contract
    reg = payloads.get('executionRegistry') or {}; res = payloads.get('expertResolver') or {}
    router = payloads.get('blockerRouter') or {}; handoff = payloads.get('residualExpertHandoff') or {}
    business = payloads.get('businessAutonomy') or {}; metrics = business.get('metrics') or {}
    if any(r.get('mutationAllowedCurrent') is not False or r.get('canEnterApprovalOnlyPreflight') is not False for r in reg.get('records') or []): return False
    doctrine, manual, expert, issues = current_human_residual_records(res, reg)
    if issues or not all(freshness(p, 60)[0] and p.get('ok') is True for p in [reg, res, router, handoff, business]):
        return False
    if not responsible_handoff_contract(router.get('counts') or {}, reg.get('statusCounts') or {}, queue, reg.get('records') or []):
        return False
    denominator = len(reg.get('records') or []) - len(doctrine) - len(manual)
    completed = sum(r.get('readinessStatus') == 'completed_no_action_required' for r in reg.get('records') or [])
    rate = round(completed / denominator, 6) if denominator else 1.0
    return (
        business.get('platformReady') is True
        and metrics.get('humanDoctrine') == len(doctrine) and metrics.get('manualIncompressible') == len(manual)
        and metrics.get('expertDecisionRemaining') == len(expert)
        and metrics.get('unresolvedTechnical') == 0 and metrics.get('mutationAttempts') == 0
        and metrics.get('businessAutonomyRate') == rate
        and (business.get('businessAutonomyStatus') == 'complete_verified') == (rate >= metrics.get('businessAutonomyTarget', 1.0))
    )


def documented_pending_waiting_lots(payloads: dict, queue: list[dict]) -> int:
    if not current_residual_context(payloads, queue): return 0
    reg = payloads['executionRegistry']; human = {r['registryId']: r for r in payloads['expertResolver'].get('humanResiduals') or []}
    rows = [r for r in reg.get('records') or [] if r.get('family') == 'waiting_account' and r.get('readinessStatus') == 'requires_expert_decision']
    return sum(
        human.get(r['registryId'], {}).get('documentedPendingProof') is True
        and bool(r.get('sourceActionHash'))
        and human[r['registryId']].get('sourceActionHash') == r['sourceActionHash']
        for r in rows
    )


def documented_wait_state(report: dict, payloads: dict, queue: list[dict]) -> bool:
    reasons = [r.get('checkId') for r in report.get('failedChecks') or []]
    semantics = report.get('stateSemantics') or {}
    return (
        current_residual_context(payloads, queue)
        and reasons == ['business_autonomy_complete_verified']
        and report.get('blockingReasons') == reasons
        and (report.get('counts') or {}).get('terminalClosed') == 0
        and semantics.get('safetyStatus') == 'fail_closed'
        and semantics.get('businessCompletionStatus') == 'blocked_incomplete_work'
        and payloads['businessAutonomy'].get('businessAutonomyStatus') == 'review_required'
    )


def main() -> None:
    gen = now_iso()
    payloads = {key: read_json(path, {}) for key, path in REPORTS.items()}
    checks: list[dict[str, Any]] = []

    for key, path in REPORTS.items():
        add_check(checks, f'{key}_exists', path.exists(), str(path))
        add_check(checks, f'{key}_clean', report_clean(payloads[key]), {'path': str(path), 'status': payloads[key].get('status') if isinstance(payloads[key], dict) else None, 'blockingReasons': payloads[key].get('blockingReasons') if isinstance(payloads[key], dict) else None})

    reg = counts(payloads['executionRegistry'])
    router = counts(payloads['blockerRouter'])
    handoff = counts(payloads['residualExpertHandoff'])
    active_approval_guard = counts(payloads['activeApprovalWriteGuardrail'])
    zero = counts(payloads['zeroValueCountGuardrail'])
    integration_contract = counts(payloads['guardrailIntegrationContract'])
    business_autonomy = payloads['businessAutonomy']
    business_metrics = business_autonomy.get('metrics') if isinstance(business_autonomy, dict) and isinstance(business_autonomy.get('metrics'), dict) else {}
    source_quality = counts(payloads['sourceQualityLogicalReview'])
    bank_live = counts(payloads['nativeReconciliationLivePreflight'])
    bank_no_link = counts(payloads['nativeReconciliationNoLinkReview'])
    lettering_live = counts(payloads['nativeLetteringLiveState'])
    lettering_closure = counts(payloads['nativeLetteringDenylistClosure'])
    lot_zero = counts(payloads['approvalOnlyLotZeroProtocol'])
    lot_zero_live = counts(payloads['approvalOnlyLotZeroLivePreflight'])
    entry_producer = counts(payloads['entryCorrectionApprovalProducer'])
    entry_executor = counts(payloads['entryCorrectionApprovedExecutor'])

    route_queue = read_json(OPS / 'inqom-execution-blocker-burndown-router-queue.json', [])
    wait_context = current_residual_context(payloads, route_queue)
    pending_waiting_lots = documented_pending_waiting_lots(payloads, route_queue)
    from inqom_business_autonomy_control_plane import current_human_residual_records
    current_doctrine, current_manual, current_expert, current_scope_issues = current_human_residual_records(payloads['expertResolver'], payloads['executionRegistry'])
    add_check(checks, 'active_approval_absent', not ACTIVE_APPROVAL.exists(), str(ACTIVE_APPROVAL))
    registry_partition = sum(count(reg, key, 0) for key in ('completedNoActionRequired', 'requiresExpertDecision', 'requiresHumanDoctrine', 'manualOnly', 'readyForAutonomousPreflight', 'blockedByLiveDrift', 'blockedByMissingNativeTool'))
    add_check(checks, 'execution_registry_terminal', count(reg, 'records', -1) >= 0 and registry_partition == count(reg, 'records', -1) and count(reg, 'readyForAutonomousPreflight', -1) == 0 and count(reg, 'blockedByLiveDrift', -1) == 0 and count(reg, 'blockedByMissingNativeTool', -1) == 0 and count(reg, 'validationIssues', -1) == 0, {'counts': reg, 'partition': registry_partition})
    add_check(checks, 'blocker_router_expert_only', wait_context and count(router, 'engineeringRoutes', -1) == 0 and count(router, 'mutationAttempted', -1) == 0 and count(router, 'validationIssues', -1) == 0, router)
    add_check(checks, 'handoff_covers_residual_routes', wait_context and count(handoff, 'coveredRoutes', -1) == count(handoff, 'handoffQueue', -1) == count(router, 'queue', -1) and count(handoff, 'expertRouteActions', -1) == count(router, 'expertRoutes', -1) and count(handoff, 'agentRouteActions', -1) == count(router, 'agentRoutes', -1) and count(handoff, 'uncoveredRecords', -1) == 0 and count(handoff, 'unexpectedRoutes', -1) == 0 and count(handoff, 'validationIssues', -1) == 0, {'handoff': handoff, 'router': router})
    add_check(checks, 'active_approval_write_guardrail_clean', count(active_approval_guard, 'findings', -1) == 0 and count(active_approval_guard, 'activeApprovalPathExists', -1) == 0 and count(active_approval_guard, 'activeApprovalWritten', -1) == 0 and count(active_approval_guard, 'mutationAttempted', -1) == 0, active_approval_guard)
    add_check(checks, 'zero_value_guardrail_clean', count(zero, 'matches', -1) == 0 and count(zero, 'scannedFiles', 0) >= 100, zero)
    add_check(checks, 'guardrail_integration_contract_clean', count(integration_contract, 'failedChecks', -1) == 0 and count(integration_contract, 'requiredPipelineSteps', -1) >= 10, integration_contract)
    add_check(
        checks,
        'business_autonomy_complete_verified',
        business_autonomy.get('platformReady') is True
        and business_autonomy.get('businessAutonomyStatus') == 'complete_verified'
        and business_metrics.get('businessAutonomyRate') == 1.0
        and count(business_metrics, 'unresolvedTechnical', -1) == 0
        and count(business_metrics, 'expertDecisionRemaining', -1) == 0
        and count(business_metrics, 'humanDoctrine', -1) == len(current_doctrine)
        and count(business_metrics, 'manualIncompressible', -1) == len(current_manual)
        and count(business_metrics, 'mutationAttempts', -1) == 0,
        {'platformReady': business_autonomy.get('platformReady'), 'businessAutonomyStatus': business_autonomy.get('businessAutonomyStatus'), 'metrics': business_metrics},
    )
    source_quality_classified = count(source_quality, 'closedNoAction', 0) + count(source_quality, 'expertReviewItems', 0)
    add_check(checks, 'source_quality_resolved_no_action', count(source_quality, 'sourceQualityActions', -1) == source_quality_classified and count(source_quality, 'reviewedClasses', -1) == source_quality_classified and count(source_quality, 'queue', -1) == count(source_quality, 'expertReviewItems', -1) and count(source_quality, 'mutationAttempted', -1) == 0 and count(source_quality, 'activeApprovalWritten', -1) == 0 and count(source_quality, 'validationIssues', -1) == 0, {'counts': source_quality, 'classified': source_quality_classified})
    bank_items = count(bank_no_link, 'items', -1)
    bank_classified = count(bank_no_link, 'closedNoAction', 0) + count(bank_no_link, 'expertReviewItems', 0) + count(bank_no_link, 'approvalRequests', 0)
    add_check(checks, 'native_bank_no_apply_candidate', bank_items >= 0 and bank_classified == bank_items and count(bank_live, 'inputItems', -1) == bank_items and count(bank_live, 'liveVerifiedItems', -1) == bank_items and count(bank_live, 'futureApprovalReadyItems', -1) == 0 and count(bank_live, 'readOnlyEvidenceReadyItems', -1) == 0 and count(bank_live, 'liveDriftItems', -1) == 0 and count(bank_live, 'mutationAttempted', -1) == 0 and count(bank_no_link, 'approvalRequests', -1) == 0 and count(bank_no_link, 'queue', -1) == count(bank_no_link, 'expertReviewItems', -1), {'live': bank_live, 'noLink': bank_no_link, 'classified': bank_classified})
    lettering_partition = count(lettering_live, 'alreadyLettered', 0) + count(lettering_live, 'freshReady', 0) + count(lettering_live, 'blockedByLivePreflight', 0)
    add_check(checks, 'native_lettering_no_fresh_candidate', count(lettering_live, 'eligibleForLivePreflight', -1) == lettering_partition and count(lettering_live, 'freshReady', -1) == 0 and count(lettering_live, 'mutationAttempted', -1) == 0 and count(lettering_closure, 'eligibleForLivePreflight', -1) == count(lettering_closure, 'alreadyLettered', -1) and count(lettering_closure, 'freshReady', -1) == 0 and count(lettering_closure, 'blockedLotsAllSafeAlreadyLettered', -1) == 1 and count(lettering_closure, 'nativeLetteringAttempted', -1) == 0 and count(lettering_closure, 'validationIssues', -1) == 0, {'live': lettering_live, 'closure': lettering_closure, 'partition': lettering_partition})
    add_check(checks, 'approval_only_lot_zero_closed', count(lot_zero, 'candidate', -1) == 0 and count(lot_zero, 'activeApprovalPresent', -1) == 0 and count(lot_zero, 'activeApprovalWritten', -1) == 0 and count(lot_zero, 'mutationAttempted', -1) == 0 and count(lot_zero_live, 'livePreflightReady', -1) == 0 and count(lot_zero_live, 'noFreshCandidate', -1) == 1 and count(lot_zero_live, 'mutationAttempted', -1) == 0, {'protocol': lot_zero, 'live': lot_zero_live})
    producer_operations = count(entry_producer, 'operations', -1)
    producer_quarantined = count(entry_producer, 'quarantinedLots', -1)
    executor_operations = count(entry_executor, 'operations', -1)
    executor_completed = executor_operations > 0 and count(entry_executor, 'executed', -1) == executor_operations and count(entry_executor, 'nativeLetteringsExecuted', -1) == executor_operations and count(entry_executor, 'sameLetterVerified', -1) == executor_operations and count(entry_executor, 'validationIssues', -1) == 0
    no_entry_correction_work = producer_operations == 0 and producer_quarantined == 0 and executor_operations == 0 and count(entry_executor, 'validationIssues', -1) == 0
    quarantined_entry_correction_noop = (
        producer_operations == 0
        and producer_quarantined > 0
        and count(entry_producer, 'inputLots', -1) == producer_quarantined + pending_waiting_lots
        and count(entry_producer, 'quarantineReasons', -1) == producer_quarantined
        and count(entry_producer, 'readyLots', -1) == 0
        and count(entry_producer, 'validationIssues', -1) == 0
        and count(entry_producer, 'activeApprovalWritten', -1) == 0
        and count(entry_producer, 'mutationAttempted', -1) == 0
        and payloads['entryCorrectionApprovalProducer'].get('ok') is True
        and payloads['entryCorrectionApprovalProducer'].get('status') == 'guarded_unsafe_source_lineage_quarantined'
        and executor_operations == 0
        and count(entry_executor, 'blockedManifest', -1) == 1
        and count(entry_executor, 'blockedManifestValid', -1) == 1
        and count(entry_executor, 'quarantinedLots', -1) == producer_quarantined
        and count(entry_executor, 'validationIssues', -1) == 0
        and count(entry_executor, 'activeApprovalExists', -1) == 0
        and count(entry_executor, 'activeApprovalWritten', -1) == 0
        and count(entry_executor, 'mutationAttempted', -1) == 0
        and payloads['entryCorrectionApprovedExecutor'].get('ok') is True
        and payloads['entryCorrectionApprovedExecutor'].get('status') == 'guarded_unsafe_source_lineage_quarantined_noop'
        and not (payloads['entryCorrectionApprovedExecutor'].get('blockingReasons') or [])
    )
    add_check(checks, 'entry_correction_business_completion', no_entry_correction_work or quarantined_entry_correction_noop or executor_completed, {'producer': entry_producer, 'executor': entry_executor, 'noWork': no_entry_correction_work, 'quarantinedNoop': quarantined_entry_correction_noop, 'completed': executor_completed})

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    terminal_closed = len(failed) == 0
    output = {
        'generatedAt': gen,
        'contractVersion': 'standard-v5-business-autonomy-proof-inqom-terminal-execution-state-guardrail',
        'capabilityId': ORIGIN,
        'ok': terminal_closed,
        'status': 'terminal_closed_no_agent_executable_work' if terminal_closed else 'blocked_incomplete_work',
        'summary': f"inqom_terminal_execution_state_guardrail: terminal_closed={int(terminal_closed)} ready={count(reg, 'readyForAutonomousPreflight', -1)} expert_routes={count(router, 'expertRoutes', -1)}/{count(router, 'queue', -1)} handoff={count(handoff, 'handoffQueue', -1)} active_approval_findings={count(active_approval_guard, 'findings', -1)} zero_matches={count(zero, 'matches', -1)} integration_contract_failed={count(integration_contract, 'failedChecks', -1)} active_approval={int(ACTIVE_APPROVAL.exists())} mutation_attempted=0 checks={len(checks)} failed={len(failed)}",
        'counts': {
            'terminalClosed': int(terminal_closed),
            'documentedBusinessWaitContext': int(wait_context),
            'documentedPendingWaitingLots': pending_waiting_lots,
            'safeAgentReady': count(reg, 'readyForAutonomousPreflight', -1),
            'executionRegistryRecords': count(reg, 'records', -1),
            'completedNoActionRequired': count(reg, 'completedNoActionRequired', -1),
            'expertDecisionRecords': count(reg, 'requiresExpertDecision', -1),
            'humanDoctrineRecords': count(reg, 'requiresHumanDoctrine', -1),
            'manualOnlyRecords': count(reg, 'manualOnly', -1),
            'liveDriftRecords': count(reg, 'blockedByLiveDrift', -1),
            'missingNativeToolRecords': count(reg, 'blockedByMissingNativeTool', -1),
            'residualQueue': count(router, 'queue', -1),
            'expertRoutes': count(router, 'expertRoutes', -1),
            'agentRoutes': count(router, 'agentRoutes', -1),
            'engineeringRoutes': count(router, 'engineeringRoutes', -1),
            'handoffQueue': count(handoff, 'handoffQueue', -1),
            'activeApprovalGuardFindings': count(active_approval_guard, 'findings', -1),
            'activeApprovalGuardEnvMentions': count(active_approval_guard, 'envMentions', -1),
            'zeroGuardMatches': count(zero, 'matches', -1),
            'zeroGuardScannedFiles': count(zero, 'scannedFiles', -1),
            'guardrailIntegrationContractFailedChecks': count(integration_contract, 'failedChecks', -1),
            'guardrailIntegrationContractRequiredSteps': count(integration_contract, 'requiredPipelineSteps', -1),
            'businessAutonomyRate': business_metrics.get('businessAutonomyRate'),
            'businessAutonomyUnresolvedTechnical': count(business_metrics, 'unresolvedTechnical', -1),
            'businessAutonomyHumanDoctrine': count(business_metrics, 'humanDoctrine', -1),
            'businessAutonomyManualIncompressible': count(business_metrics, 'manualIncompressible', -1),
            'sourceQualityClosedNoAction': count(source_quality, 'closedNoAction', -1),
            'nativeBankFutureApprovalReady': count(bank_live, 'futureApprovalReadyItems', -1),
            'nativeBankNoLinkExpertReview': count(bank_no_link, 'expertReviewItems', -1),
            'nativeLetteringFreshReady': count(lettering_live, 'freshReady', -1),
            'lotZeroCandidate': count(lot_zero, 'candidate', -1),
            'entryCorrectionProposedOperations': count(entry_producer, 'operations', -1),
            'entryCorrectionQuarantinedLots': count(entry_producer, 'quarantinedLots', -1),
            'entryCorrectionQuarantinedNoop': int(quarantined_entry_correction_noop),
            'entryCorrectionBlockedManifestValid': count(entry_executor, 'blockedManifestValid', -1),
            'entryCorrectionOperations': count(entry_executor, 'operations', -1),
            'activeApprovalPathExists': int(ACTIVE_APPROVAL.exists()),
            'mutationAttempted': 0,
            'nativeMutationAttempted': 0,
            'externalSendAttempted': 0,
            'checks': len(checks),
            'failedChecks': len(failed),
            'criticalFailedChecks': len(critical_failed),
        },
        'blockingReasons': [c['checkId'] for c in critical_failed],
        'checks': checks,
        'failedChecks': failed,
        'stateSemantics': {
            'safetyStatus': 'fail_closed' if count(entry_executor, 'mutationAttempted', -1) == 0 and not ACTIVE_APPROVAL.exists() else 'mutation_or_approval_present',
            'businessCompletionStatus': 'complete_verified' if terminal_closed else 'blocked_incomplete_work',
        },
        'terminalPolicy': {
            'inqomMutation': 'blocked_without_fresh_live_preflight_and_active_approval',
            'nativeBankReconciliation': 'blocked_no_exact_apply_candidate_and_no_active_approval',
            'nativeLettering': 'blocked_no_fresh_candidate_all_safe_candidates_already_lettered_or_denylisted',
            'nativeRevisionMarking': 'blocked_expert_gate_required',
            'taxSubmissionPayment': 'manual_only_separate_approval_required',
            'activeApprovalPath': str(ACTIVE_APPROVAL),
        },
        'inputReports': {key: str(path) for key, path in REPORTS.items()},
        'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': ORIGIN + '-v5-business-autonomy-proof',
    }
    write_json(OUT_JSON, output)
    lines = [
        f'# Inqom terminal execution state guardrail — {gen}',
        '',
        f"- Summary: {output['summary']}",
        f"- Status: {output['status']}",
        f"- Active approval path exists: {ACTIVE_APPROVAL.exists()}",
        '- Mutations attempted by this guardrail: 0',
        '',
        '## Terminal evidence',
        f"- Safe agent-ready records: {output['counts']['safeAgentReady']}",
        f"- Residual queue: {output['counts']['residualQueue']} expert route(s), {output['counts']['agentRoutes']} agent route(s), {output['counts']['engineeringRoutes']} engineering route(s)",
        f"- Handoff queue: {output['counts']['handoffQueue']}",
        f"- Active approval write findings: {output['counts']['activeApprovalGuardFindings']}",
        f"- Zero-value fragile counter patterns: {output['counts']['zeroGuardMatches']}",
        f"- Guardrail integration contract failed checks: {output['counts']['guardrailIntegrationContractFailedChecks']}",
        f"- Native bank future approval-ready items: {output['counts']['nativeBankFutureApprovalReady']}",
        f"- Native lettering fresh ready items: {output['counts']['nativeLetteringFreshReady']}",
        f"- Lot zero candidate: {output['counts']['lotZeroCandidate']}",
    ]
    if failed:
        lines += ['', '## Failed checks']
        for item in failed:
            lines.append(f"- **{item['checkId']}** ({item['severity']}): `{item.get('detail')}`")
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': gen, 'ok': output['ok'], 'summary': output['summary'], 'blockingReasons': output['blockingReasons']}, ensure_ascii=False))
    # A blocked business state is a valid guard evaluation, not a runtime failure.
    # Keep the JSON fail-closed while allowing downstream tests and aggregation
    # to consume this fresh state instead of stale artifacts.


if __name__ == '__main__':
    main()
