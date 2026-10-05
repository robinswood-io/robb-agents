#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
INQOM_SOURCE = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom')
REGISTRY_JSON = OPS / 'inqom-execution-readiness-registry.json'
REGISTRY_JSONL = OPS / 'inqom-execution-readiness-registry-records.jsonl'
OUT_JSON = OPS / 'inqom-expert-route-autonomous-resolver.json'
OUT_MD = OPS / 'inqom-expert-route-autonomous-resolver.md'
OUT_LEDGER = OPS / 'inqom-expert-route-autonomous-resolver-ledger.json'
ACTIVE_APPROVAL = INQOM_SOURCE / 'mutation-approvals' / 'active-autonomous-approval.json'
CORRECTION_MANIFEST = OPS / 'inqom-accounting-entry-correction-execution-manifest.json'
CORRECTION_PRODUCER = OPS / 'inqom-accounting-entry-correction-approval-producer.json'
CORRECTION_EXECUTOR = OPS / 'inqom-accounting-entry-correction-approved-executor.json'
NATIVE_RECONCILER = OPS / 'inqom-native-lettering-live-state-reconciler.json'
NATIVE_EXECUTOR = OPS / 'inqom-native-lettering-approved-batch-executor.json'
ORIGIN = 'inqom-expert-route-autonomous-resolver'
CONTRACT_VERSION = 'inqom-expert-route-autonomous-resolver-v1'

ALLOWED_UNREVISED_CLASSES = {
    'psp_gocardless_payment_flow',
    'manual_cadrage_expert_validation',
    'waiting_account_cross_reference',
    'supplier_expense_supporting_document_review',
    'tax_vat_expert_validation',
    'payroll_social_expert_validation',
}
ALLOWED_HUMAN_RESIDUALS = {
    ('waiting_account', 'requires_human_doctrine'),
    ('document_evidence', 'manual_only'),
}
RESOLVABLE_SOURCE_REPORTS = {
    'inqom-native-reconciliation-no-link-candidate-review.json',
    'inqom-manual-reconciliation-packs.json',
    'inqom-waiting-account-resolution-batcher.json',
    'inqom-unrevised-expert-gate-router.json',
    'inqom-review-only-controls.json',
    'inqom-expert-accountant-benchmark.json',
    'finance-inqom-close-readiness-last.json',
    'finance-inqom-vat-cash-basis-monthly-tests.json',
}


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
                value = json.loads(line)
                if isinstance(value, dict):
                    rows.append(value)
    except Exception:
        return []
    return rows


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def canonical_digest(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def file_sha256(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except Exception:
        return None


def count(report: dict[str, Any], key: str, default: int = 0) -> int:
    counts = report.get('counts') if isinstance(report.get('counts'), dict) else {}
    value = counts.get(key, report.get(key, default))
    try:
        return int(value if value is not None else default)
    except Exception:
        return default


def collect_values(value: Any, keys: set[str]) -> list[Any]:
    out: list[Any] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in keys:
                if isinstance(nested, list):
                    out.extend(nested)
                else:
                    out.append(nested)
            out.extend(collect_values(nested, keys))
    elif isinstance(value, list):
        for nested in value:
            out.extend(collect_values(nested, keys))
    return out


def report_is_safe(path: Path) -> tuple[bool, dict[str, Any], list[str]]:
    report = read_json(path, {})
    reasons: list[str] = []
    if not path.exists():
        reasons.append('source_report_missing')
    if not isinstance(report, dict) or report.get('ok') is not True:
        reasons.append('source_report_not_ok')
    if report.get('blockingReasons'):
        reasons.append('source_report_has_blocking_reasons')
    if report.get('validationIssues'):
        reasons.append('source_report_has_validation_issues')
    if count(report, 'validationIssues') != 0:
        reasons.append('source_report_validation_issue_count_nonzero')
    if count(report, 'mutationAttempted') != 0:
        reasons.append('source_report_mutation_attempted')
    if count(report, 'activeApprovalWritten') != 0:
        reasons.append('source_report_active_approval_written')
    return not reasons, report if isinstance(report, dict) else {}, reasons


def correction_quarantine_terminal(line_ids: list[int]) -> tuple[bool, list[str], dict[str, Any]]:
    manifest = read_json(CORRECTION_MANIFEST, {})
    producer = read_json(CORRECTION_PRODUCER, {})
    executor = read_json(CORRECTION_EXECUTOR, {})
    quarantined = manifest.get('quarantinedLots') if isinstance(manifest.get('quarantinedLots'), list) else []
    quarantine_numbers = {int(x) for x in collect_values(quarantined, {'lineId', 'lineIds'}) if str(x).isdigit()}
    reasons: list[str] = []
    if manifest.get('schemaVersion') != 'inqom-accounting-entry-correction-execution-manifest-v2-blocked':
        reasons.append('correction_manifest_not_blocked_v2')
    if manifest.get('operations') not in ([], None):
        reasons.append('correction_manifest_has_operations')
    if not quarantined:
        reasons.append('correction_manifest_has_no_quarantined_lots')
    if any(int(x) not in quarantine_numbers for x in line_ids):
        reasons.append('record_line_not_in_correction_quarantine')
    if producer.get('ok') is not True or producer.get('status') != 'guarded_unsafe_source_lineage_quarantined':
        reasons.append('correction_producer_not_terminal_quarantine')
    if count(producer, 'operations') != 0 or count(producer, 'mutationAttempted') != 0:
        reasons.append('correction_producer_effect_detected')
    if executor.get('ok') is not True or executor.get('status') != 'guarded_unsafe_source_lineage_quarantined_noop':
        reasons.append('correction_executor_not_terminal_quarantine_noop')
    if count(executor, 'operations') != 0 or count(executor, 'mutationAttempted') != 0:
        reasons.append('correction_executor_effect_detected')
    if count(executor, 'blockedManifestValid') != 1:
        reasons.append('correction_executor_blocked_manifest_not_valid')
    return not reasons, reasons, {
        'manifestSha256': file_sha256(CORRECTION_MANIFEST),
        'producerSha256': file_sha256(CORRECTION_PRODUCER),
        'executorSha256': file_sha256(CORRECTION_EXECUTOR),
        'quarantinedLots': len(quarantined),
    }


def native_lettering_terminal() -> tuple[bool, list[str], dict[str, Any]]:
    reconciler = read_json(NATIVE_RECONCILER, {})
    executor = read_json(NATIVE_EXECUTOR, {})
    fresh_keys = ['freshReady', 'freshReadyLots', 'readyLots', 'ready']
    fresh_values = [count(reconciler, key, 0) for key in fresh_keys]
    reasons: list[str] = []
    if reconciler.get('ok') is not True:
        reasons.append('native_reconciler_not_ok')
    if any(fresh_values):
        reasons.append('native_reconciler_has_fresh_ready_work')
    if count(reconciler, 'mutationAttempted') != 0:
        reasons.append('native_reconciler_mutation_attempted')
    if executor.get('ok') is not True:
        reasons.append('native_executor_not_ok')
    if count(executor, 'executed') != 0 or count(executor, 'mutationAttempted') != 0:
        reasons.append('native_executor_effect_detected')
    return not reasons, reasons, {
        'reconcilerSha256': file_sha256(NATIVE_RECONCILER),
        'executorSha256': file_sha256(NATIVE_EXECUTOR),
        'freshReadySignals': dict(zip(fresh_keys, fresh_values)),
    }


def action_data(record: dict[str, Any]) -> dict[str, Any]:
    action = record.get('sourceAction') if isinstance(record.get('sourceAction'), dict) else {}
    return action.get('data') if isinstance(action.get('data'), dict) else {}


def decision_for(record: dict[str, Any]) -> tuple[str | None, list[str], dict[str, Any]]:
    family = str(record.get('family') or '')
    action = record.get('sourceAction') if isinstance(record.get('sourceAction'), dict) else {}
    data = action_data(record)
    action_type = str(action.get('actionType') or record.get('actionType') or '')
    source_name = Path(str(record.get('sourceReport') or '')).name
    mutation_type = str(record.get('mutationType') or '')
    line_ids = [int(x) for x in (record.get('lineIds') or []) if isinstance(x, int) or str(x).isdigit()]

    if family == 'vat_cash_basis' and action_type == 'tax_portal_entry_manual_only_review' and mutation_type == 'tax_filing_manual_only':
        return 'policy_terminal_tax_submission_not_agent_work', [
            'tax_pack_prepared_but_submission_and_payment_forbidden',
            'portal_action_removed_from_agent_execution_backlog',
        ], {'policyBoundary': 'human_portal_validation_only'}

    if family == 'closing_balance' and action_type == 'closing_balance_interim_review_only' and mutation_type == 'closing_review_only':
        return 'interim_close_agent_review_complete', [
            'interim_close_has_no_source_blocking_reason',
            'annual_final_review_not_a_blocker_for_internal_interim_situation',
        ], {'productionBoundary': 'internal_interim_only'}

    if family == 'fixed_assets_closing' and source_name == 'inqom-review-only-controls.json':
        allowed = {'review_only_fixed_asset_control', 'maintain_laure_review_only_knowledge_packs'}
        if action_type in allowed and mutation_type == 'closing_review_only':
            return 'review_only_control_consumed_by_agent', [
                'review_only_pack_is_internal_control_not_mutation_request',
                'final_inventory_or_annual_review_deferred_without_blocking_interim',
            ], {'productionBoundary': 'no_fixed_asset_posting'}

    if family == 'fixed_assets_closing' and source_name == 'inqom-expert-accountant-benchmark.json':
        if mutation_type == 'native_lettering':
            terminal, reasons, evidence = native_lettering_terminal()
            if not terminal:
                return None, reasons, evidence
        return 'benchmark_handoff_deduplicated_to_canonical_agent_lane', [
            'benchmark_action_is_meta_review_not_canonical_execution_target',
            'canonical_specialist_lane_remains_source_of_truth',
        ], {'canonicalLaneRequired': True}

    if family == 'unrevised_revision' and source_name == 'inqom-unrevised-expert-gate-router.json':
        classification = str(data.get('classification') or '')
        if classification in ALLOWED_UNREVISED_CLASSES and action_type == 'inqom_unrevised_expert_gate_decision':
            return 'interim_unrevised_quality_review_completed_by_agent', [
                'known_classification_reviewed_under_existing_agent_doctrine',
                'native_revision_marking_not_required_to_continue_internal_interim',
            ], {'classification': classification, 'nativeRevisionMarked': False}

    if family == 'waiting_account' and source_name == 'inqom-waiting-account-resolution-batcher.json':
        if action_type == 'prepare_waiting_account_line_correction_and_lettering':
            terminal, reasons, evidence = correction_quarantine_terminal(line_ids)
            if terminal:
                return 'unsafe_orange_correction_quarantined_noop', [
                    'blocked_manifest_has_zero_operations',
                    'recursive_or_existing_correction_lineage_forbids_execution',
                ], evidence
            return None, reasons, evidence

    if family == 'bank_reconciliation' and source_name == 'inqom-native-reconciliation-no-link-candidate-review.json':
        classification = str(data.get('classification') or action.get('blockingReason') or '')
        transaction_ids = [x for x in collect_values(action, {'transactionId', 'transactionIds', 'bankTransactionId', 'bankTransactionIds'}) if x not in (None, '', [])]
        accounts = {str(x).upper() for x in collect_values(action, {'account', 'accountName', 'accountNumber', 'accounts'}) if isinstance(x, (str, int))}
        account_prefixes = {a[:3] for a in accounts if a[:3].isdigit()}
        if (
            action_type == 'review_native_bank_reconciliation_no_link_candidate'
            and classification == 'expert_review_psp_internal_transfer_without_native_bank_transaction_id'
            and not transaction_ids
            and {'517', '580'}.issubset(account_prefixes)
        ):
            return 'psp_internal_transfer_without_native_bank_target_closed', [
                'no_transaction_id_exists_for_native_bank_link',
                'internal_psp_517_580_transfer_is_not_a_bank_reconciliation_target',
            ], {'accountPrefixes': sorted(account_prefixes), 'transactionIds': []}

    if family == 'bank_reconciliation' and source_name == 'inqom-manual-reconciliation-packs.json':
        pack = data.get('pack') if isinstance(data.get('pack'), dict) else data
        slug = str(pack.get('slug') or '')
        status = str(pack.get('status') or '')
        transaction_ids = [x for x in collect_values(pack, {'transactionId', 'transactionIds', 'bankTransactionId', 'bankTransactionIds'}) if x not in (None, '', [])]
        if slug in {'bank-ambiguous-review', 'intercompany-unmatched-review'} and status == 'needs_finance_ops_review' and not transaction_ids:
            return 'ambiguous_bank_pack_exhausted_without_exact_native_target', [
                'aggregate_review_pack_contains_no_exact_entry_transaction_pair',
                'future_refresh_may_reopen_only_if_source_action_hash_changes',
            ], {'packSlug': slug, 'transactionIds': []}

    return None, ['no_allowlisted_autonomous_resolution_rule_matched'], {}


def main() -> None:
    generated_at = now_iso()
    registry = read_json(REGISTRY_JSON, {})
    records = registry.get('records') if isinstance(registry.get('records'), list) else []
    if not records:
        records = read_jsonl(REGISTRY_JSONL)
    validation: list[str] = []
    if registry.get('ok') is not True:
        validation.append('execution_readiness_registry_not_ok')
    if ACTIVE_APPROVAL.exists():
        validation.append('active_approval_path_exists')

    decisions: list[dict[str, Any]] = []
    human_residuals: list[dict[str, Any]] = []
    unrecognized: list[dict[str, Any]] = []
    source_report_cache: dict[str, tuple[bool, dict[str, Any], list[str]]] = {}
    waiting_line_ids: set[int] = set()

    for record in records:
        status = str(record.get('readinessStatus') or '')
        original_status = str((record.get('autonomousResolution') or {}).get('originalReadinessStatus') or status)
        if original_status == 'completed_no_action_required':
            continue
        family = str(record.get('family') or '')
        if (family, original_status) in ALLOWED_HUMAN_RESIDUALS:
            human_residuals.append({
                'registryId': record.get('registryId'),
                'family': family,
                'readinessStatus': original_status,
                'title': record.get('title'),
                'reason': 'genuine_doctrine_or_missing_external_evidence',
            })
            continue
        source_path = Path(str(record.get('sourceReport') or ''))
        source_name = source_path.name
        if source_name not in RESOLVABLE_SOURCE_REPORTS:
            unrecognized.append({'registryId': record.get('registryId'), 'family': family, 'reason': 'source_report_not_allowlisted', 'sourceReport': str(source_path)})
            continue
        cache_key = str(source_path)
        if cache_key not in source_report_cache:
            source_report_cache[cache_key] = report_is_safe(source_path)
        source_safe, _source_report, source_reasons = source_report_cache[cache_key]
        action = record.get('sourceAction') if isinstance(record.get('sourceAction'), dict) else {}
        expected_action_hash = str(record.get('sourceActionHash') or '')
        actual_action_hash = canonical_digest(action)
        if not source_safe or not expected_action_hash or actual_action_hash != expected_action_hash:
            unrecognized.append({
                'registryId': record.get('registryId'),
                'family': family,
                'reason': 'source_evidence_or_action_hash_not_safe',
                'details': source_reasons + ([] if actual_action_hash == expected_action_hash else ['source_action_hash_mismatch']),
            })
            continue
        resolution_class, reasons, extra = decision_for(record)
        if not resolution_class:
            unrecognized.append({'registryId': record.get('registryId'), 'family': family, 'reason': 'autonomous_rule_rejected', 'details': reasons, 'evidence': extra})
            continue
        if resolution_class == 'unsafe_orange_correction_quarantined_noop':
            current = set(int(x) for x in (record.get('lineIds') or []) if isinstance(x, int) or str(x).isdigit())
            if current & waiting_line_ids:
                unrecognized.append({'registryId': record.get('registryId'), 'family': family, 'reason': 'duplicate_waiting_line_id_across_resolution_records', 'lineIds': sorted(current)})
                continue
            waiting_line_ids.update(current)
        decisions.append({
            'decisionId': f"autonomous-resolution:{record.get('registryId')}",
            'registryId': record.get('registryId'),
            'family': family,
            'sourceActionHash': expected_action_hash,
            'sourceReport': str(source_path),
            'sourceReportSha256': file_sha256(source_path),
            'sourceGeneratedAt': record.get('sourceGeneratedAt'),
            'originalReadinessStatus': original_status,
            'targetReadinessStatus': 'completed_no_action_required',
            'resolutionClass': resolution_class,
            'readinessReasons': reasons,
            'evidence': extra,
            'mutationExecuted': False,
            'activeApprovalWritten': False,
            'externalActionExecuted': False,
        })

    if unrecognized:
        validation.append('unrecognized_non_human_residual_records')
    if any(d.get('mutationExecuted') is not False or d.get('activeApprovalWritten') is not False for d in decisions):
        validation.append('resolution_side_effect_detected')
    duplicate_decisions = len({d['registryId'] for d in decisions}) != len(decisions)
    if duplicate_decisions:
        validation.append('duplicate_registry_resolution')

    counts = {
        'inputRecords': len(records),
        'resolved': len(decisions),
        'humanResiduals': len(human_residuals),
        'unrecognizedTechnicalResiduals': len(unrecognized),
        'policyTerminal': sum(1 for d in decisions if d['resolutionClass'] == 'policy_terminal_tax_submission_not_agent_work'),
        'orangeQuarantinedNoop': sum(1 for d in decisions if d['resolutionClass'] == 'unsafe_orange_correction_quarantined_noop'),
        'mutationAttempted': 0,
        'activeApprovalWritten': 0,
        'externalActionAttempted': 0,
        'validationIssues': len(validation),
    }
    payload = {
        'generatedAt': generated_at,
        'contractVersion': CONTRACT_VERSION,
        'capabilityId': ORIGIN,
        'ok': not validation,
        'status': 'resolved_with_human_inputs_only' if not validation else 'blocked_fail_closed',
        'summary': f"{ORIGIN}: records={counts['inputRecords']} resolved={counts['resolved']} human_residuals={counts['humanResiduals']} unrecognized={counts['unrecognizedTechnicalResiduals']} orange_quarantined={counts['orangeQuarantinedNoop']} mutation=0 validation_issues={counts['validationIssues']}",
        'counts': counts,
        'blockingReasons': validation,
        'decisions': decisions,
        'humanResiduals': human_residuals,
        'unrecognizedTechnicalResiduals': unrecognized,
        'guardrails': {
            'sourceActionHashRequired': True,
            'sourceReportHashRequired': True,
            'activeApprovalMustBeAbsent': True,
            'noMutation': True,
            'noNativeLettering': True,
            'noNativeRevisionMarking': True,
            'noNativeBankReconciliation': True,
            'noTaxSubmission': True,
            'noTaxPayment': True,
            'noExternalSend': True,
            'orangeManifestNeverExecuted': True,
            'reopenOnSourceActionHashChange': True,
        },
        'artifacts': {
            'registry': str(REGISTRY_JSON),
            'ledger': str(OUT_LEDGER),
            'reportJson': str(OUT_JSON),
            'reportMd': str(OUT_MD),
        },
        'updatedBy': ORIGIN,
    }
    write_json(OUT_LEDGER, {'generatedAt': generated_at, 'contractVersion': CONTRACT_VERSION, 'decisions': decisions})
    write_json(OUT_JSON, payload)
    lines = [
        f'# Résolution autonome des routes Inqom — {generated_at}', '',
        f"- Résumé : {payload['summary']}",
        '- Mutations Inqom : **0**',
        '- Lots Orange exécutés : **0**',
        '- Résidus humains : doctrine particulière ou pièce externe introuvable uniquement', '',
        '## Décisions automatiques',
    ]
    for decision in decisions:
        lines.append(f"- {decision['registryId']} — {decision['resolutionClass']}")
    lines += ['', '## Résidus humains']
    for item in human_residuals:
        lines.append(f"- {item['registryId']} — {item['family']} — {item['title']}")
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': validation}, ensure_ascii=False))
    if validation:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
