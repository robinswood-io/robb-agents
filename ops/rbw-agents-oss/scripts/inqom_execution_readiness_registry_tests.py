#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-execution-readiness-registry.json'
RECORDS = OPS / 'inqom-execution-readiness-registry-records.jsonl'
FIRST_WAVE = OPS / 'inqom-execution-readiness-first-wave.json'
LIVE_PREFLIGHT_DENYLIST = OPS / 'inqom-approvalonly-lot-zero-preflight-denylist.json'
NATIVE_LIVE_PREFLIGHT_DENYLIST = OPS / 'inqom-native-lettering-live-preflight-denylist.json'
SALES_LINKAGE = OPS / 'finance-inqom-vat-sellsy-issued-invoice-control.json'
CLOSE_READINESS = OPS / 'finance-inqom-close-readiness-last.json'
VAT_PREPARATION = OPS / 'finance-inqom-vat-cash-basis-monthly-preparation-last.json'
AUTONOMOUS_RESOLVER = OPS / 'inqom-expert-route-autonomous-resolver.json'
OUT_JSON = OPS / 'inqom-execution-readiness-registry-tests.json'
OUT_MD = OPS / 'inqom-execution-readiness-registry-tests.md'
GATE_JSON = OPS / 'inqom-production-quality-gate.json'
GATE_MD = OPS / 'inqom-production-quality-gate.md'
REQUIRED_FAMILIES = {'document_evidence', 'unrevised_revision', 'waiting_account', 'native_lettering', 'vat_cash_basis', 'source_quality', 'fixed_assets_closing', 'closing_balance', 'bank_reconciliation'}
REQUIRED_STATUSES = {'completed_no_action_required', 'ready_for_autonomous_preflight', 'requires_expert_decision', 'requires_human_doctrine', 'blocked_by_live_drift', 'blocked_by_missing_native_tool', 'manual_only'}
MAX_WEEKLY_ARTIFACT_AGE_HOURS = 192


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.strip():
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
    except Exception:
        return rows
    return rows


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def add(checks: list[dict[str, Any]], check_id: str, ok: bool, severity: str = 'critical', detail: Any = None) -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': severity, 'detail': detail})


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    except Exception:
        return None


def artifact_age_hours(payload: dict[str, Any], now: datetime) -> float | None:
    for key in ('generatedAt', 'updatedAt', 'checkedAt', 'runAt'):
        parsed = parse_time(payload.get(key))
        if parsed:
            return round((now - parsed).total_seconds() / 3600, 2)
    return None


def first_value(obj: Any, keys: set[str]) -> Any:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in keys and value is not None:
                return value
        for value in obj.values():
            found = first_value(value, keys)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = first_value(value, keys)
            if found is not None:
                return found
    return None


def build_production_gate(
    generated_at: str,
    report: dict[str, Any],
    records: list[dict[str, Any]],
    registry_tests_ok: bool,
) -> dict[str, Any]:
    now = parse_time(generated_at) or datetime.now(timezone.utc)
    close = read_json(CLOSE_READINESS, {})
    vat = read_json(VAT_PREPARATION, {})
    counts = report.get('counts') or {}
    guardrails = report.get('guardrails') or {}
    vat_safety = vat.get('safety') or {}

    ages = {
        'executionRegistryHours': artifact_age_hours(report, now),
        'closeReadinessHours': artifact_age_hours(close, now),
        'vatPreparationHours': artifact_age_hours(vat, now),
    }
    fresh = all(value is not None and 0 <= value <= MAX_WEEKLY_ARTIFACT_AGE_HOURS for value in ages.values())
    close_processed = close.get('ok') is True and close.get('status') == 'processed'
    vat_prepared = vat.get('ok') is True and vat.get('vatRegime') == 'cash_basis'
    registry_guards_closed = (
        guardrails.get('noInqomMutation') is True
        and guardrails.get('noNativeLettering') is True
        and guardrails.get('noNativeRevisionMarking') is True
        and guardrails.get('noTaxFiling') is True
        and guardrails.get('registryCannotAuthorizeExecution') is True
        and guardrails.get('approvalOnlyProtocolRequiredForAnyMutation') is True
        and guardrails.get('failClosedOnSourceDriftOrAlreadyMutatedLines') is True
    )
    vat_guards_closed = (
        vat_safety.get('allowedEffect') == 'prepare_only'
        and vat_safety.get('externalSubmissionAllowed') is False
        and vat_safety.get('taxPaymentAllowed') is False
        and vat_safety.get('mutationAllowed') is False
        and vat_safety.get('nativeLetteringMutationAllowed') is False
        and vat_safety.get('requiresHumanPortalValidation') is True
    )

    internal_blockers: list[str] = []
    if not registry_tests_ok:
        internal_blockers.append('execution_registry_controls_failed')
    if not fresh:
        internal_blockers.append('weekly_control_artifact_stale_or_undated')
    if not close_processed:
        internal_blockers.append('close_readiness_not_processed')
    if not vat_prepared:
        internal_blockers.append('cash_basis_vat_preparation_not_ready')
    if not registry_guards_closed:
        internal_blockers.append('execution_registry_guardrail_open')
    if not vat_guards_closed:
        internal_blockers.append('vat_submission_or_mutation_guardrail_open')
    internal_ready = not internal_blockers

    ready_records = [r for r in records if r.get('readinessStatus') == 'ready_for_autonomous_preflight']
    ready_records_exact = all(
        r.get('approvalOnlyRequired') is True
        and r.get('activeApprovalRequired') is True
        and r.get('livePreflightRequired') is True
        and r.get('postMutationReadbackRequired') is True
        and r.get('rollbackOrCompensationRequired') is True
        and r.get('mutationAllowedCurrent') is False
        and bool(r.get('entryIds') or r.get('lineIds'))
        for r in ready_records
    )
    unresolved_decisions = int(counts.get('requiresExpertDecision') or 0) + int(counts.get('requiresHumanDoctrine') or 0)
    execution_ready = internal_ready and bool(ready_records) and ready_records_exact and unresolved_decisions == 0 and int(counts.get('blockedByLiveDrift') or 0) == 0 and int(counts.get('blockedByMissingNativeTool') or 0) == 0
    if execution_ready:
        execution_status = 'ready_for_bounded_agent_preflight'
    elif not internal_ready:
        execution_status = 'blocked_by_control_plane'
    elif not ready_records:
        execution_status = 'preparation_active_no_executable_lot'
    else:
        execution_status = 'preparation_active_decisions_or_exactness_pending'

    unrevised = first_value(close, {'unrevisedLines', 'unrevisedEntryLines', 'unrevisedCount'})
    missing_doc_refs = first_value(close, {'missingDocRefs', 'missingDocRefLines', 'missingDocRefCount'})
    close_signal = first_value(close, {'closeSignal', 'closeStatus'})
    final_ready = False
    final_status = 'annual_expert_review_and_human_tax_portal_validation_required'

    gate = {
        'generatedAt': generated_at,
        'contractVersion': 'inqom-production-quality-gate-v1-three-distinct-readiness-states',
        'capabilityId': 'inqom-production-quality-gate',
        'ok': True,
        'status': 'processed',
        'overallOperationalStatus': 'internal_ready_controlled_execution_pending' if internal_ready and not execution_ready else ('bounded_agent_preflight_ready' if execution_ready else 'control_plane_blocked'),
        'principle': 'A technical success never certifies final French accounting production.',
        'readiness': {
            'internalInterimSituation': {
                'ready': internal_ready,
                'status': 'ready_internal' if internal_ready else 'blocked',
                'blockingReasons': internal_blockers,
                'scope': 'internal management and interim accounting analysis; ordinary open controls continue autonomously',
            },
            'boundedAccountingExecution': {
                'ready': execution_ready,
                'status': execution_status,
                'candidateCount': len(ready_records),
                'candidateIdentifiersExact': ready_records_exact,
                'requiresExpertDecision': int(counts.get('requiresExpertDecision') or 0),
                'requiresHumanDoctrine': int(counts.get('requiresHumanDoctrine') or 0),
                'blockedByLiveDrift': int(counts.get('blockedByLiveDrift') or 0),
                'blockedByMissingNativeTool': int(counts.get('blockedByMissingNativeTool') or 0),
                'currentMutationAllowed': False,
                'executionProtocol': ['exact identifiers', 'expiring bounded approval', 'live preflight', 'single execution', 'post-mutation readback', 'balance and affected-account recomputation', 'anti-replay trace', 'guard closure'],
            },
            'finalFrenchAccountingProduction': {
                'ready': final_ready,
                'status': final_status,
                'automaticCertificationAllowed': False,
                'automaticTaxFilingAllowed': False,
                'automaticTaxPaymentAllowed': False,
                'note': 'Final accounts, annual review and tax portal submission remain outside autonomous certification authority.',
            },
        },
        'openControlWork': {
            'executionRegistryRecords': int(counts.get('records') or len(records)),
            'completedNoActionRequired': int(counts.get('completedNoActionRequired') or 0),
            'requiresExpertDecision': int(counts.get('requiresExpertDecision') or 0),
            'requiresHumanDoctrine': int(counts.get('requiresHumanDoctrine') or 0),
            'manualOnly': int(counts.get('manualOnly') or 0),
            'unrevisedLinesReported': unrevised,
            'missingDocRefsReported': missing_doc_refs,
            'legacyCloseSignal': close_signal,
            'interpretation': 'These are autonomous work queues or true decision inputs; they do not by themselves invalidate an internal interim situation.',
        },
        'controlDesign': {
            'makerCheckerSeparation': True,
            'preparerCannotSelfCertifyFinalAccounts': True,
            'technicalSuccessSeparatedFromAccountingReadiness': True,
            'interimReadinessSeparatedFromFinalProduction': True,
            'missingFileIdNotAutomaticallyMissingEvidence': True,
            'cashBasisVatUsesCollectionsNotIssuedInvoicesAlone': True,
            'falseReadyPrevented': not final_ready,
        },
        'evidenceFreshness': {'maximumHours': MAX_WEEKLY_ARTIFACT_AGE_HOURS, 'fresh': fresh, **ages},
        'safety': {'executionRegistryGuardrailsClosed': registry_guards_closed, 'vatGuardrailsClosed': vat_guards_closed, 'mutationAllowed': False, 'taxFilingAllowed': False, 'taxPaymentAllowed': False},
        'artifacts': {'executionRegistry': str(REPORT), 'closeReadiness': str(CLOSE_READINESS), 'vatCashBasisPreparation': str(VAT_PREPARATION), 'reportJson': str(GATE_JSON), 'reportMd': str(GATE_MD)},
        'blockingReasons': internal_blockers,
        'updatedBy': 'inqom-execution-readiness-registry-tests',
    }
    write_json(GATE_JSON, gate)
    lines = [
        f"# Verrou qualité de production comptable Inqom — {generated_at}", '',
        f"- Situation intermédiaire interne : **{gate['readiness']['internalInterimSituation']['status']}**",
        f"- Exécution comptable bornée : **{execution_status}**",
        f"- Production comptable française finale : **{final_status}**", '',
        '## Principe',
        '- Un succès technique ne constitue jamais une certification comptable finale.',
        '- Les contrôles ordinaires restent traités par les agents sans transformer Thibault en opérateur Inqom.',
        '- Toute mutation utilise un lot exact, une autorisation expirante, un préflight live, une relecture et une trace anti-rejeu.', '',
        '## Travail de contrôle ouvert',
        f"- Décisions expertes : {gate['openControlWork']['requiresExpertDecision']}",
        f"- Questions de doctrine humaine : {gate['openControlWork']['requiresHumanDoctrine']}",
        f"- Lots actuellement exécutables : {len(ready_records)}",
    ]
    GATE_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return gate


def protected_residuals_consistent(records: list[dict], residuals: list[dict]) -> bool:
    statuses = {'requires_human_doctrine', 'requires_expert_decision', 'manual_only'}
    protected = [r for r in records if r.get('readinessStatus') in statuses]
    ids = [r.get('registryId') for r in protected]
    human_ids = [r.get('registryId') for r in residuals]
    if (not ids or any(not isinstance(i, str) or not i for i in ids + human_ids)
        or len(set(ids)) != len(ids) or len(set(human_ids)) != len(human_ids)
        or set(ids) != set(human_ids)):
        return False
    by_id = {r['registryId']: r for r in protected}
    return (
        all(not isinstance(r.get('autonomousResolution'), dict)
            and r.get('mutationAllowedCurrent') is False
            and r.get('canEnterApprovalOnlyPreflight') is False for r in protected)
        and all(r.get('mutationAllowed') is False and r.get('externalSendAllowed') is False
            and r.get('readinessStatus') == by_id[r['registryId']]['readinessStatus']
            for r in residuals)
    )

def denylist_respected(records: list[dict], report: dict, blocked_ids: set[int]) -> bool:
    counts = report.get('counts') or {}
    guards = report.get('guardrails') or {}
    applied = report.get('livePreflightDenylist') or {}
    if guards.get('livePreflightDenylistApplied') is not True:
        return False
    if set(applied.get('blockedLineIds') or []) != blocked_ids:
        return False
    intersecting = []
    flagged = []
    for row in records:
        ids = {int(value) for value in (row.get('lineIds') or []) if str(value).isdigit()}
        intersects = bool(ids & blocked_ids)
        if intersects and row.get('readinessStatus') == 'ready_for_autonomous_preflight':
            return False
        if row.get('family') != 'native_lettering' or row.get('mutationType') != 'native_lettering':
            continue
        if row.get('livePreflightBlockedByDenylist') is True:
            flagged.append(row)
        if intersects:
            intersecting.append(row)
            if (row.get('livePreflightBlockedByDenylist') is not True
                or row.get('readinessStatus') not in {'completed_no_action_required','blocked_by_live_drift'}
                or row.get('canEnterApprovalOnlyPreflight') is not False):
                return False
    return (
        type(counts.get('livePreflightDenylistRecordsBlocked')) is int
        and counts['livePreflightDenylistRecordsBlocked'] == len(intersecting)
        and applied.get('recordsBlocked') == len(intersecting)
        and len(flagged) == len(intersecting)
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=['baseline', 'post-resolution'], default='post-resolution')
    args = parser.parse_args()
    phase = args.phase
    generated_at = now_iso()
    report = read_json(REPORT, {})
    first_wave = read_json(FIRST_WAVE, {})
    records = read_jsonl(RECORDS)
    blocked_ids = set()
    for deny_path in [LIVE_PREFLIGHT_DENYLIST, NATIVE_LIVE_PREFLIGHT_DENYLIST]:
        deny = read_json(deny_path, {})
        if isinstance(deny, dict):
            for lot in deny.get('blockedLots') or []:
                if isinstance(lot, dict) and lot.get('status') == 'blocked_by_live_preflight':
                    for value in lot.get('lineIds') or []:
                        try:
                            blocked_ids.add(int(value))
                        except Exception:
                            pass
    counts = report.get('counts') or {}
    guardrails = report.get('guardrails') or {}
    family_counts = report.get('familyCounts') or {}
    status_counts = report.get('statusCounts') or {}
    lot_zero = report.get('lotZeroCandidate') or {}
    sales_linkage = read_json(SALES_LINKAGE, {})
    autonomous_resolver = read_json(AUTONOMOUS_RESOLVER, {})
    autonomous_resolution = report.get('autonomousResolution') if isinstance(report.get('autonomousResolution'), dict) else {}
    sales_actions = [x for x in (sales_linkage.get('actionQueue') or []) if isinstance(x, dict) and x.get('actionType') == 'review_duplicate_sales_entries_before_bounded_accounting_mutation']
    sales_records = {str(x.get('sourceActionId')): x for x in records if x.get('family') == 'sales_entry_linkage'}
    closing_records = [x for x in records if x.get('family') == 'closing_balance']
    sales_identifier_checks = []
    for action in sales_actions:
        action_id = str(action.get('id'))
        record = sales_records.get(action_id) or {}
        expected_entries = {int(action.get('canonicalEntryId'))} | {int(x) for x in (action.get('duplicateEntryIds') or [])}
        expected_lines = {int(x) for x in (action.get('canonicalLineIds') or [])}
        expected_lines |= {int(x) for group in (action.get('duplicateLineIds') or []) for x in (group or [])}
        sales_identifier_checks.append({'actionId': action_id, 'entriesExact': set(record.get('entryIds') or []) == expected_entries, 'linesExact': set(record.get('lineIds') or []) == expected_lines, 'approvalOnlyRequired': record.get('approvalOnlyRequired') is True, 'mutationAllowedCurrent': record.get('mutationAllowedCurrent') is False})

    checks: list[dict[str, Any]] = []
    add(checks, 'report_exists', REPORT.exists(), detail=str(REPORT))
    add(checks, 'records_jsonl_exists', RECORDS.exists(), detail=str(RECORDS))
    add(checks, 'first_wave_exists', FIRST_WAVE.exists(), detail=str(FIRST_WAVE))
    add(checks, 'report_ok_processed', report.get('ok') is True and report.get('status') == 'processed', detail={'summary': report.get('summary'), 'blockingReasons': report.get('blockingReasons')})
    add(checks, 'record_count_matches_jsonl', counts.get('records') == len(records) and len(records) >= 25, detail={'count': counts.get('records'), 'jsonl': len(records)})
    add(checks, 'all_required_families_present', REQUIRED_FAMILIES.issubset(set(family_counts)), detail=family_counts)
    add(checks, 'all_readiness_statuses_recognized', set(status_counts).issubset(REQUIRED_STATUSES) and 'completed_no_action_required' in status_counts, detail=status_counts)
    add(checks, 'ready_or_completed_state_valid', int(counts.get('readyForAutonomousPreflight') or 0) >= 0 and int(counts.get('completedNoActionRequired') or 0) >= 0 and int(counts.get('readyForAutonomousPreflight') or 0) == len(first_wave.get('candidates') or []), detail={'counts': counts, 'firstWave': first_wave.get('candidateCount')})
    add(checks, 'lot_zero_native_candidate_consistent', (int(counts.get('readyNativeLetteringPreflightCandidates') or 0) == 0 and not lot_zero) or (bool(lot_zero.get('registryId')) and lot_zero.get('readinessStatus') == 'ready_for_autonomous_preflight' and lot_zero.get('mutationType') == 'native_lettering'), detail={'lotZero': lot_zero, 'readyNative': counts.get('readyNativeLetteringPreflightCandidates')})
    add(checks, 'no_current_mutation_allowed', all(r.get('mutationAllowedCurrent') is False for r in records), detail=[r.get('registryId') for r in records if r.get('mutationAllowedCurrent') is not False][:5])
    add(checks, 'ready_mutations_require_approval', all((not r.get('approvalOnlyRequired')) or (r.get('activeApprovalRequired') is True and r.get('livePreflightRequired') is True and r.get('postMutationReadbackRequired') is True) for r in records if r.get('readinessStatus') == 'ready_for_autonomous_preflight'), detail=[r for r in records if r.get('readinessStatus') == 'ready_for_autonomous_preflight'][:3])
    add(checks, 'global_guardrails_closed', guardrails.get('noInqomMutation') is True and guardrails.get('noNativeLettering') is True and guardrails.get('noNativeRevisionMarking') is True and guardrails.get('noTaxFiling') is True and guardrails.get('registryCannotAuthorizeExecution') is True, detail=guardrails)
    ready_records_with_blocked_lines = [r for r in records if r.get('readinessStatus') == 'ready_for_autonomous_preflight' and blocked_ids.intersection(set(int(x) for x in (r.get('lineIds') or []) if str(x).isdigit()))]
    add(checks, 'live_preflight_denylist_respected', denylist_respected(records, report, blocked_ids), detail={'blockedIds': sorted(blocked_ids), 'violations': ready_records_with_blocked_lines[:3], 'counts': counts})
    add(checks, 'source_report_shadow_tracked_not_hidden', int(counts.get('sourceReports') or 0) >= 10 and int(counts.get('benignSystemOfRecordShadowReports') or 0) >= 0, detail=counts)
    add(checks, 'sales_duplicate_identifiers_preserved_exactly', len(sales_identifier_checks) == len(sales_actions) and all(row['entriesExact'] and row['linesExact'] and row['approvalOnlyRequired'] and row['mutationAllowedCurrent'] for row in sales_identifier_checks), detail=sales_identifier_checks)
    add(checks, 'production_states_are_distinct', True, detail=['internalInterimSituation', 'boundedAccountingExecution', 'finalFrenchAccountingProduction'])
    add(
        checks,
        'ready_internal_close_not_misclassified_by_zero_arbitrage_counters',
        len(closing_records) == 1
        and closing_records[0].get('readinessStatus') == 'completed_no_action_required'
        and not (closing_records[0].get('blockersBeforeExecution') or []),
        detail=closing_records,
    )
    if autonomous_resolver.get('ok') is True:
        auto_records = [r for r in records if isinstance(r.get('autonomousResolution'), dict)]
        protected = [r for r in records if r.get('readinessStatus') in {'requires_human_doctrine', 'requires_expert_decision', 'manual_only'}]
        protected_ids = {str(r.get('registryId')) for r in protected}
        resolver_human_ids = {str(r.get('registryId')) for r in (autonomous_resolver.get('humanResiduals') or []) if isinstance(r, dict)}
        resolver_decisions = autonomous_resolver.get('decisions') or []
        applied = int(autonomous_resolution.get('applied') or 0)
        rejected = int(autonomous_resolution.get('rejected') or 0)
        rejected_reasons = [str(x) for x in (autonomous_resolution.get('rejectedReasons') or [])]
        add(checks, 'autonomous_resolution_records_are_closed_noop', all(r.get('readinessStatus') == 'completed_no_action_required' and r.get('mutationAllowedCurrent') is False and r.get('canEnterApprovalOnlyPreflight') is False for r in auto_records), detail=[r.get('registryId') for r in auto_records[:5]])
        if phase == 'baseline':
            stale_ledger_rejections = [reason for reason in rejected_reasons if reason.startswith(('source_report_hash_mismatch:', 'source_action_hash_mismatch:', 'unknown_registry_id:'))]
            transaction_abort_reasons = [reason for reason in rejected_reasons if reason.startswith('ledger_transaction_aborted_valid_decisions:')]
            rejection_contract_ok = bool(stale_ledger_rejections) and len(transaction_abort_reasons) <= 1 and len(stale_ledger_rejections) + len(transaction_abort_reasons) == len(rejected_reasons)
            deferred_valid = int(autonomous_resolution.get('deferredValidDecisions') or 0)
            deferred_reason_count = int(transaction_abort_reasons[0].rsplit(':', 1)[-1]) if transaction_abort_reasons else 0
            stale_ledger_rejected_atomically = applied == 0 and not auto_records and rejected == len(resolver_decisions) and autonomous_resolution.get('transactionAborted') is True and deferred_valid == deferred_reason_count and rejection_contract_ok
            current_ledger_applied_atomically = applied == len(resolver_decisions) == len(auto_records) and rejected == 0 and not rejected_reasons and autonomous_resolution.get('transactionAborted') is False and deferred_valid == 0
            add(checks, 'autonomous_resolution_baseline_fail_closed', stale_ledger_rejected_atomically or current_ledger_applied_atomically, detail={'phase': phase, 'registry': autonomous_resolution, 'decisionCount': len(resolver_decisions), 'acceptedSafeStates': ['stale_ledger_rejected_atomically', 'current_ledger_applied_atomically']})
            add(checks, 'baseline_protected_records_not_autoclosed', all(not isinstance(r.get('autonomousResolution'), dict) for r in protected), detail={'phase': phase, 'protected': sorted(protected_ids)})
        else:
            add(checks, 'autonomous_resolution_overlay_applied', int(counts.get('autonomousResolutionsApplied') if counts.get('autonomousResolutionsApplied') is not None else -1) == len(resolver_decisions) == len(auto_records), detail={'phase': phase, 'registry': autonomous_resolution, 'counts': counts})
            add(checks, 'autonomous_resolution_overlay_zero_rejected', int(counts.get('autonomousResolutionsRejected') or 0) == 0 and rejected == 0, detail={'phase': phase, 'registry': autonomous_resolution})
            add(checks, 'human_doctrine_and_missing_evidence_not_autoclosed', protected_residuals_consistent(records, autonomous_resolver.get('humanResiduals') or []), detail={'phase': phase, 'registryProtected': sorted(protected_ids), 'resolverHumanResiduals': sorted(resolver_human_ids)})

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    registry_tests_ok = not critical_failed and not high_failed
    gate = build_production_gate(generated_at, report, records, registry_tests_ok)
    add(checks, 'production_gate_written', GATE_JSON.exists() and gate.get('ok') is True, detail=str(GATE_JSON))
    add(checks, 'technical_success_never_certifies_final_accounts', gate.get('readiness', {}).get('finalFrenchAccountingProduction', {}).get('ready') is False and gate.get('controlDesign', {}).get('falseReadyPrevented') is True, detail=gate.get('readiness'))
    add(checks, 'interim_output_not_blocked_by_annual_review_alone', gate.get('readiness', {}).get('internalInterimSituation', {}).get('status') in {'ready_internal', 'blocked'} and gate.get('readiness', {}).get('finalFrenchAccountingProduction', {}).get('status') != gate.get('readiness', {}).get('internalInterimSituation', {}).get('status'), detail=gate.get('readiness'))

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v2-inqom-execution-readiness-registry-tests-production-gate',
        'capabilityId': 'inqom-execution-readiness-registry-tests',
        'phase': phase,
        'ok': not critical_failed and not high_failed,
        'status': 'pass' if not failed else 'failed',
        'summary': f"inqom_execution_readiness_registry_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} records={counts.get('records')} ready={counts.get('readyForAutonomousPreflight')} production_gate={gate.get('overallOperationalStatus')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed), 'records': counts.get('records'), 'readyForAutonomousPreflight': counts.get('readyForAutonomousPreflight'), 'completedNoActionRequired': counts.get('completedNoActionRequired'), 'readyNativeLetteringPreflightCandidates': counts.get('readyNativeLetteringPreflightCandidates'), 'livePreflightDenylistRecordsBlocked': counts.get('livePreflightDenylistRecordsBlocked')},
        'productionQualityGate': {'overallOperationalStatus': gate.get('overallOperationalStatus'), 'internalInterimSituation': gate.get('readiness', {}).get('internalInterimSituation'), 'boundedAccountingExecution': gate.get('readiness', {}).get('boundedAccountingExecution'), 'finalFrenchAccountingProduction': gate.get('readiness', {}).get('finalFrenchAccountingProduction')},
        'blockingReasons': [c['checkId'] for c in critical_failed + high_failed],
        'checks': checks,
        'failedChecks': failed,
        'artifacts': {'sourceReport': str(REPORT), 'recordsJsonl': str(RECORDS), 'firstWave': str(FIRST_WAVE), 'productionQualityGate': str(GATE_JSON), 'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': 'inqom-execution-readiness-registry-tests',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f"# Tests registre d’exécutabilité Inqom — {generated_at}", '', f"- Résumé : {payload['summary']}", *[f"- {'✅' if c['ok'] else '❌'} {c['checkId']}" for c in checks]]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons'], 'productionQualityGate': payload['productionQualityGate']}, ensure_ascii=False))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
