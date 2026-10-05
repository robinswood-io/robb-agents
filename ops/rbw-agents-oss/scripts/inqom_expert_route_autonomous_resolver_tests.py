#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from inqom_expert_route_autonomous_resolver import DOCUMENTED_PENDING_INPUTS, CORRECTION_MANIFEST, REGISTRY_JSON, collect_values, file_sha256

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
SCRIPT = Path('/srv/rbw-agents-oss/scripts/inqom_expert_route_autonomous_resolver.py')
REPORT = OPS / 'inqom-expert-route-autonomous-resolver.json'
LEDGER = OPS / 'inqom-expert-route-autonomous-resolver-ledger.json'
WAITING_BATCHER_REPORT = OPS / 'inqom-waiting-account-resolution-batcher.json'
ACTIVE_APPROVAL = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom/mutation-approvals/active-autonomous-approval.json')
OUT_JSON = OPS / 'inqom-expert-route-autonomous-resolver-tests.json'
OUT_MD = OPS / 'inqom-expert-route-autonomous-resolver-tests.md'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def add(checks: list[dict[str, Any]], check_id: str, ok: bool, detail: Any = None) -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': 'critical', 'detail': detail})


def quarantine_decisions_consistent(manifest: dict, decisions: list, records: list, digest: str | None) -> bool:
    lots = manifest.get('quarantinedLots')
    if (manifest.get('schemaVersion') != 'inqom-accounting-entry-correction-execution-manifest-v2-blocked'
        or manifest.get('operations') != [] or manifest.get('mutationAttempted') != 0
        or not isinstance(lots,list) or not lots or not digest):
        return False
    if len({lot.get('lotId') for lot in lots}) != len(lots):
        return False
    ids = {int(x) for x in collect_values(lots,{'lineId','lineIds'}) if str(x).isdigit()}
    orange = [d for d in decisions if d.get('resolutionClass') == 'unsafe_orange_correction_quarantined_noop']
    if len(orange) != len(lots) or len({d.get('registryId') for d in orange}) != len(orange):
        return False
    by_id = {r.get('registryId'):r for r in records}
    observed = []
    for decision in orange:
        record = by_id.get(decision.get('registryId'),{})
        lines = record.get('lineIds')
        if (not isinstance(lines,list) or not lines or not set(lines).issubset(ids)
            or decision.get('sourceActionHash') != record.get('sourceActionHash')
            or (decision.get('evidence') or {}).get('manifestSha256') != digest
            or decision.get('targetReadinessStatus') != 'completed_no_action_required'
            or any(decision.get(key) is not False for key in ['mutationExecuted','activeApprovalWritten','externalActionExecuted'])):
            return False
        observed.extend(lines)
    return len(observed) == len(set(observed)) and set(observed) == ids


def main() -> None:
    generated_at = now_iso()
    report = read_json(REPORT, {})
    ledger = read_json(LEDGER, {})
    waiting_batcher = read_json(WAITING_BATCHER_REPORT, {})
    waiting_counts = waiting_batcher.get('counts') if isinstance(waiting_batcher.get('counts'), dict) else {}
    counts = report.get('counts') if isinstance(report.get('counts'), dict) else {}
    decisions = report.get('decisions') if isinstance(report.get('decisions'), list) else []
    residuals = report.get('humanResiduals') if isinstance(report.get('humanResiduals'), list) else []
    guardrails = report.get('guardrails') if isinstance(report.get('guardrails'), dict) else {}
    script_text = SCRIPT.read_text(encoding='utf-8') if SCRIPT.exists() else ''
    checks: list[dict[str, Any]] = []

    add(checks, 'resolver_report_ok', report.get('ok') is True and report.get('status') == 'resolved_with_human_inputs_only', report.get('status'))
    add(checks, 'resolver_contract_version', report.get('contractVersion') == 'inqom-expert-route-autonomous-resolver-v1', report.get('contractVersion'))
    add(checks, 'all_technical_routes_resolved', int(counts.get('unrecognizedTechnicalResiduals') if counts.get('unrecognizedTechnicalResiduals') is not None else -1) == 0 and int(counts.get('resolved') if counts.get('resolved') is not None else -1) == len(decisions), {'counts': counts, 'decisionCount': len(decisions)})
    add(checks, 'only_genuine_human_inputs_remain', len(residuals) == int(counts.get('humanResiduals') if counts.get('humanResiduals') is not None else -1) and all(r.get('reason') == 'genuine_doctrine_or_missing_external_evidence' and ((r.get('family'), r.get('readinessStatus')) in {('waiting_account', 'requires_human_doctrine'), ('document_evidence', 'manual_only')} or ((r.get('family'), r.get('readinessStatus')) in DOCUMENTED_PENDING_INPUTS and r.get('documentedPendingProof') is True and r.get('mutationAllowed') is False and r.get('externalSendAllowed') is False and len(str(r.get('sourceActionHash') or '')) == 64 and len(str(r.get('sourceReportSha256') or '')) == 64)) for r in residuals), residuals)
    manifest = read_json(CORRECTION_MANIFEST, {})
    expected_orange_quarantine = len(manifest.get('quarantinedLots') or [])
    registry_records = (read_json(REGISTRY_JSON, {}).get('records') or [])
    observed_orange_decisions = sum(1 for d in decisions if d.get('resolutionClass') == 'unsafe_orange_correction_quarantined_noop')
    add(checks, 'orange_is_quarantined_noop', waiting_batcher.get('ok') is True and quarantine_decisions_consistent(manifest, decisions, registry_records, file_sha256(CORRECTION_MANIFEST)) and expected_orange_quarantine >= 0 and int(counts.get('orangeQuarantinedNoop') if counts.get('orangeQuarantinedNoop') is not None else -1) == expected_orange_quarantine == observed_orange_decisions, {'resolverCounts': counts, 'waitingBatcherCounts': waiting_counts, 'observedOrangeDecisions': observed_orange_decisions})
    add(checks, 'tax_submission_is_policy_terminal', int(counts.get('policyTerminal') or 0) == 1 and sum(1 for d in decisions if d.get('resolutionClass') == 'policy_terminal_tax_submission_not_agent_work') == 1, counts)
    add(checks, 'decision_ids_and_hashes_are_exact', len(decisions) == len({d.get('registryId') for d in decisions}) and all(d.get('registryId') and len(str(d.get('sourceActionHash') or '')) == 64 and len(str(d.get('sourceReportSha256') or '')) == 64 for d in decisions))
    add(checks, 'all_decisions_are_noop_closures', all(d.get('targetReadinessStatus') == 'completed_no_action_required' and d.get('mutationExecuted') is False and d.get('activeApprovalWritten') is False and d.get('externalActionExecuted') is False for d in decisions))
    add(checks, 'ledger_matches_report', ledger.get('contractVersion') == report.get('contractVersion') and ledger.get('decisions') == decisions)
    add(checks, 'no_active_approval_residue', not ACTIVE_APPROVAL.exists(), str(ACTIVE_APPROVAL))
    add(checks, 'side_effect_counts_zero', all(int(counts.get(k) or 0) == 0 for k in ['mutationAttempted', 'activeApprovalWritten', 'externalActionAttempted', 'validationIssues']), counts)
    add(checks, 'guardrails_fail_closed', all(guardrails.get(k) is True for k in ['sourceActionHashRequired', 'sourceReportHashRequired', 'activeApprovalMustBeAbsent', 'noMutation', 'noNativeLettering', 'noNativeRevisionMarking', 'noNativeBankReconciliation', 'noTaxSubmission', 'noTaxPayment', 'noExternalSend', 'orangeManifestNeverExecuted', 'reopenOnSourceActionHashChange']), guardrails)
    add(checks, 'source_contains_strict_allowlists', all(token in script_text for token in ['ALLOWED_UNREVISED_CLASSES', 'ALLOWED_HUMAN_RESIDUALS', 'RESOLVABLE_SOURCE_REPORTS', 'source_action_hash_mismatch', 'duplicate_waiting_line_id_across_resolution_records']))

    failed = [c for c in checks if not c['ok']]
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'inqom-expert-route-autonomous-resolver-tests-v2-dynamic-quarantine-cardinality',
        'capabilityId': 'inqom-expert-route-autonomous-resolver-tests',
        'ok': not failed,
        'status': 'passed' if not failed else 'failed',
        'summary': f"inqom_expert_route_autonomous_resolver_tests: checks={len(checks)} failed={len(failed)} resolved={counts.get('resolved')} human_residuals={counts.get('humanResiduals')} mutation=0",
        'counts': {'checks': len(checks), 'passed': len(checks) - len(failed), 'failed': len(failed), 'critical': len(failed), 'mutationAttempted': 0, 'validationIssues': len(failed)},
        'blockingReasons': [c['checkId'] for c in failed],
        'checks': checks,
        'guardrails': {'readOnlyTest': True, 'noInqomMutation': True, 'noApprovalWrite': True},
        'updatedBy': 'inqom-expert-route-autonomous-resolver-tests',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f'# Tests résolveur autonome Inqom — {generated_at}', '', f"- Résumé : {payload['summary']}"] + [f"- {'OK' if c['ok'] else 'FAIL'} — {c['checkId']}" for c in checks]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
