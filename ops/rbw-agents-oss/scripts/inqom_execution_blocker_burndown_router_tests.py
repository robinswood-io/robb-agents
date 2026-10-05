#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-execution-blocker-burndown-router.json'
QUEUE = OPS / 'inqom-execution-blocker-burndown-router-queue.json'
OUT_JSON = OPS / 'inqom-execution-blocker-burndown-router-tests.json'
OUT_MD = OPS / 'inqom-execution-blocker-burndown-router-tests.md'
PREFLIGHT_CONTRACTS = OPS / 'inqom-execution-preflight-contract-specifier.json'
LIVE_PREFLIGHT = OPS / 'inqom-native-reconciliation-live-preflight.json'
AUTONOMOUS_RESOLVER = OPS / 'inqom-expert-route-autonomous-resolver.json'


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


def add(checks: list[dict[str, Any]], check_id: str, ok: bool, severity: str = 'critical', detail: Any = None) -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': severity, 'detail': detail})


def resolved_route_overlay_consistent(report: dict, resolver: dict, records: list[dict]) -> bool:
    from inqom_execution_readiness_registry_tests import protected_residuals_consistent
    counts = report.get('counts') or {}
    rc = resolver.get('counts') or {}
    decisions = resolver.get('decisions') or []
    human = resolver.get('humanResiduals') or []
    expected = {}
    closed = set()
    for row in records:
        status = row.get('readinessStatus')
        if status == 'completed_no_action_required':
            route = 'closed_no_action'; closed.add(row.get('registryId'))
        elif status == 'requires_human_doctrine': route = 'doctrine_question'
        elif status == 'manual_only': route = 'manual_only'
        elif status == 'requires_expert_decision':
            route = 'source_quality_review' if row.get('family') == 'source_quality' else 'expert_review'
        else: return False
        expected[route] = expected.get(route, 0) + 1
    decision_ids = [r.get('registryId') for r in decisions]
    return (
        resolver.get('ok') is True and resolver.get('status') == 'resolved_with_human_inputs_only'
        and rc.get('unrecognizedTechnicalResiduals') == 0
        and rc.get('inputRecords') == counts.get('records') == len(records)
        and rc.get('resolved') == len(decisions) == len(set(decision_ids))
        and set(decision_ids).issubset(closed)
        and rc.get('humanResiduals') == len(human)
        and counts.get('closedNoAction') == len(closed)
        and counts.get('engineeringRoutes') == 0
        and report.get('routeCounts') == expected
        and protected_residuals_consistent(records, human)
        and all(r.get('mutationAllowedCurrent') is False
            and r.get('canEnterApprovalOnlyPreflight') is False for r in records)
        and all(rc.get(k) == 0 for k in ['mutationAttempted','externalActionAttempted','activeApprovalWritten'])
    )

def main() -> None:
    generated_at = now_iso()
    report = read_json(REPORT, {})
    queue = read_json(QUEUE, [])
    counts = report.get('counts') or {}
    guardrails = report.get('guardrails') or {}
    route_counts = report.get('routeCounts') or {}
    contracts = read_json(PREFLIGHT_CONTRACTS, {})
    resolver = read_json(AUTONOMOUS_RESOLVER, {})
    resolver_counts = resolver.get('counts') if isinstance(resolver.get('counts'), dict) else {}
    live_preflight = read_json(LIVE_PREFLIGHT, {})
    live_tool_available = ((live_preflight.get('toolAvailability') or {}).get('futureApplyToolAvailable') is True) if isinstance(live_preflight, dict) else None
    live_preflight_ok = isinstance(live_preflight, dict) and live_preflight.get('ok') is True
    contracts_ok = contracts.get('ok') is True and contracts.get('status') == 'contracts_specified_prepare_only'
    checks: list[dict[str, Any]] = []
    add(checks, 'report_exists', REPORT.exists(), detail=str(REPORT))
    add(checks, 'queue_exists', QUEUE.exists(), detail=str(QUEUE))
    add(checks, 'report_ok_processed', report.get('ok') is True and report.get('status') == 'processed', detail={'summary': report.get('summary'), 'blockingReasons': report.get('blockingReasons')})
    add(checks, 'queue_matches_counts', isinstance(queue, list) and len(queue) == int(counts.get('queue') if counts.get('queue') is not None else 0) and int(counts.get('records') if counts.get('records') is not None else 0) > 0, detail={'queueLen': len(queue) if isinstance(queue, list) else None, 'counts': counts})
    contract_counts = contracts.get('counts') if isinstance(contracts.get('counts'), dict) else {}
    entry_ready = int(contract_counts.get('accountingEntryCorrectionReadyLots') or 0)
    native_missing = int(contract_counts.get('nativeReconciliationMissingNativeIdentifiers') or 0)
    native_eligible = int(contract_counts.get('nativeReconciliationEligibleItems') or 0)
    accounting_route_count = int(route_counts.get('accounting_entry_correction_approval_review') or 0) + int(route_counts.get('expert_review') or 0)
    accounting_route_ok = accounting_route_count >= entry_ready if entry_ready > 0 else accounting_route_count == 0
    if native_missing > 0:
        native_route_ok = 'bank_reconciliation_native_identifier_enrichment' in route_counts
    elif native_eligible > 0 and live_preflight_ok and live_tool_available is False:
        native_route_ok = 'missing_native_reconciliation_apply_tool' in route_counts
    elif native_eligible > 0 and live_preflight_ok and live_tool_available is True:
        live_counts = live_preflight.get('counts') if isinstance(live_preflight.get('counts'), dict) else {}
        needs_link_proposal = int(live_counts.get('futureApplyNeedsExactLinkProposal') or 0) > 0
        if needs_link_proposal:
            native_route_ok = 'bank_reconciliation_link_proposal_prepare' in route_counts
        else:
            native_route_ok = 'bank_reconciliation_no_link_candidate_review' in route_counts
    elif native_eligible > 0:
        native_route_ok = 'bank_reconciliation_live_preflight_prepare' in route_counts
    else:
        native_route_ok = True
    engineering_expected = bool(native_eligible > 0 and live_preflight_ok and live_tool_available is False)
    contracts_resolved_routes_ok = ((int(counts.get('engineeringRoutes') if counts.get('engineeringRoutes') is not None else 0) == 0) or engineering_expected) and accounting_route_ok and native_route_ok
    overlay_resolved_routes_ok = resolved_route_overlay_consistent(report, resolver, read_json(OPS / 'inqom-execution-readiness-registry.json', {}).get('records') or [])
    missing_contracts_routed_ok = int(counts.get('engineeringRoutes') if counts.get('engineeringRoutes') is not None else 0) >= 1 and ('missing_accounting_entry_correction_preflight_contract' in route_counts or 'missing_native_reconciliation_contract' in route_counts)
    add(checks, 'preflight_contract_routes_consistent', (contracts_ok and (contracts_resolved_routes_ok or overlay_resolved_routes_ok)) or ((not contracts_ok) and missing_contracts_routed_ok), detail={'contractsOk': contracts_ok, 'entryReady': entry_ready, 'nativeMissing': native_missing, 'nativeEligible': native_eligible, 'livePreflightOk': live_preflight_ok, 'liveToolAvailable': live_tool_available, 'overlayResolvedRoutesOk': overlay_resolved_routes_ok, 'resolverCounts': resolver_counts, 'routeCounts': route_counts, 'counts': counts})
    add(checks, 'expert_and_doctrine_routes_preserved', int(counts.get('expertRoutes') if counts.get('expertRoutes') is not None else 0) >= 1 and ('doctrine_question' in route_counts or 'fixed_assets_expert_review' in route_counts or 'unrevised_revision_expert_gate' in route_counts), detail=route_counts)
    add(checks, 'no_mutation_or_external_send', counts.get('mutationAttempted') == 0 and counts.get('activeApprovalWritten') == 0 and guardrails.get('noInqomMutation') is True and guardrails.get('noExternalSend') is True and guardrails.get('activeApprovalNotWritten') is True, detail={'counts': counts, 'guardrails': guardrails})
    add(checks, 'queue_prepare_only', all(isinstance(i, dict) and i.get('actionType') == 'prepare_only_blocker_burndown_route' and (i.get('data') or {}).get('mutationAllowed') is False for i in queue), detail=queue[:3] if isinstance(queue, list) else queue)
    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v1-inqom-execution-blocker-burndown-router-tests',
        'capabilityId': 'inqom-execution-blocker-burndown-router-tests',
        'ok': not critical_failed and not high_failed,
        'status': 'pass' if not failed else 'failed',
        'summary': f"inqom_execution_blocker_burndown_router_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} queue={counts.get('queue')} mutation_attempted={counts.get('mutationAttempted')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed), 'queue': counts.get('queue'), 'mutationAttempted': counts.get('mutationAttempted')},
        'blockingReasons': [c['checkId'] for c in critical_failed + high_failed],
        'checks': checks,
        'failedChecks': failed,
        'artifacts': {'sourceReport': str(REPORT), 'queueJson': str(QUEUE), 'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': 'inqom-execution-blocker-burndown-router-tests',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f"# Tests routeur reste à traiter — {generated_at}", '', f"- Résumé : {payload['summary']}", *[f"- {'✅' if c['ok'] else '❌'} {c['checkId']}" for c in checks]]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
