#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-residual-expert-handoff-coverage.json'
OUT_JSON = OPS / 'inqom-residual-expert-handoff-coverage-tests.json'
OUT_MD = OPS / 'inqom-residual-expert-handoff-coverage-tests.md'
ACTIVE_APPROVAL = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom/mutation-approvals/active-autonomous-approval.json')
ORIGIN = 'inqom-residual-expert-handoff-coverage-tests'
EXPECTED_ROUTES = {
    'source_quality_review',
    'expert_review',
    'bank_reconciliation_no_link_candidate_review',
    'bank_reconciliation_review',
    'closing_balance_review',
    'doctrine_question',
    'fixed_assets_expert_review',
    'manual_only',
    'unrevised_revision_expert_gate',
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


def check(checks: list[dict[str, Any]], check_id: str, ok: bool, detail: Any = None, severity: str = 'critical') -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': severity, 'detail': detail})


def main() -> None:
    gen = now_iso()
    report = read_json(REPORT, {})
    counts = report.get('counts') if isinstance(report.get('counts'), dict) else {}
    routes = report.get('expertHandoff') if isinstance(report.get('expertHandoff'), list) else []
    route_names = {str(item.get('route')) for item in routes if isinstance(item, dict)}
    queue = report.get('actionQueue') if isinstance(report.get('actionQueue'), list) else []
    checks: list[dict[str, Any]] = []

    check(checks, 'report_exists', REPORT.exists(), str(REPORT))
    check(checks, 'report_ok', isinstance(report, dict) and report.get('ok') is True and report.get('status') == 'expert_handoff_ready', report.get('blockingReasons'))
    check(checks, 'active_approval_absent', not ACTIVE_APPROVAL.exists() and int(counts.get('activeApprovalPathExists') if counts.get('activeApprovalPathExists') is not None else 0) == 0, {'activePath': str(ACTIVE_APPROVAL), 'counts': counts})
    check(checks, 'no_mutation_or_send_attempted', int(counts.get('mutationAttempted') if counts.get('mutationAttempted') is not None else 0) == 0 and int(counts.get('nativeMutationAttempted') if counts.get('nativeMutationAttempted') is not None else 0) == 0 and int(counts.get('externalSendAttempted') if counts.get('externalSendAttempted') is not None else 0) == 0 and int(counts.get('activeApprovalWritten') if counts.get('activeApprovalWritten') is not None else 0) == 0, counts)
    check(checks, 'all_residual_routes_allowed_and_covered', bool(route_names) and route_names.issubset(EXPECTED_ROUTES) and int(counts.get('coveredRoutes') if counts.get('coveredRoutes') is not None else 0) == len(route_names) and int(counts.get('unexpectedRoutes') if counts.get('unexpectedRoutes') is not None else -1) == 0, {'routeNames': sorted(route_names), 'allowlist': sorted(EXPECTED_ROUTES), 'counts': counts})
    check(checks, 'route_queue_exclusively_expert', int(counts.get('expertRouteActions', -1)) + int(counts.get('agentRouteActions', -1)) == int(counts.get('routerQueue', -1)) and int(counts.get('agentRouteActions', -1)) == sum(i.get('route') == 'source_quality_review' and i.get('owner') == 'agent_then_expert_accountant' for i in (report.get('expertHandoff') or [])) and int(counts.get('engineeringRouteActions', -1)) == 0, counts)
    check(checks, 'registry_has_no_ready_drift_or_missing_tool', int(counts.get('registryReady') if counts.get('registryReady') is not None else -1) == 0 and int(counts.get('registryDrift') if counts.get('registryDrift') is not None else -1) == 0 and int(counts.get('registryMissingTool') if counts.get('registryMissingTool') is not None else -1) == 0, counts)
    check(checks, 'handoff_queue_matches_routes', len(queue) == len(route_names) and int(counts.get('handoffQueue') if counts.get('handoffQueue') is not None else 0) == len(route_names), {'queueCount': len(queue), 'counts': counts})
    check(checks, 'handoff_actions_guarded', bool(queue) and all((item.get('data') or {}).get('mutationAllowed') is False and (item.get('data') or {}).get('externalSendAllowed') is False and item.get('owner') == ('agent_then_expert_accountant' if (item.get('data') or {}).get('route') == 'source_quality_review' else 'expert_accountant') for item in queue), queue[:3])
    check(checks, 'source_reports_all_clean', int(counts.get('sourceReportFailures') if counts.get('sourceReportFailures') is not None else -1) == 0 and int(counts.get('uncoveredRecords') if counts.get('uncoveredRecords') is not None else -1) == 0, counts)
    routed_records = sum(int(item.get('recordCount') or 0) for item in routes if isinstance(item, dict))
    registry_residual = sum(int(counts.get(key) if counts.get(key) is not None else 0) for key in ('registryExpert', 'registryDoctrine', 'registryManualOnly'))
    route_counts_consistent = all(
        int(item.get('recordCount') or 0) == int(item.get('expectedRecordCount') or 0)
        and int(item.get('recordCount') or 0) == len(item.get('registryIds') or [])
        and int(item.get('recordCount') or 0) == sum(int(value or 0) for value in (item.get('readinessStatuses') or {}).values())
        for item in routes if isinstance(item, dict)
    )
    check(checks, 'residual_counts_preserved', routed_records == registry_residual and route_counts_consistent and int(counts.get('registryCompletedNoAction') if counts.get('registryCompletedNoAction') is not None else 0) >= 0, {'counts': counts, 'routedRecords': routed_records, 'registryResidual': registry_residual, 'routeCountsConsistent': route_counts_consistent}, severity='high')

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': gen,
        'contractVersion': 'standard-v4-dynamic-entry-corrections-inqom-residual-expert-handoff-coverage-tests',
        'capabilityId': ORIGIN,
        'ok': not failed,
        'status': 'pass' if not failed else 'fail',
        'summary': f"inqom_residual_expert_handoff_coverage_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} routes={counts.get('coveredRoutes')} agent={counts.get('agentRouteActions')} mutation_attempted={counts.get('mutationAttempted')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed)},
        'checks': checks,
        'failedChecks': failed,
        'blockingReasons': [c['checkId'] for c in critical_failed],
        'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD), 'sourceReport': str(REPORT)},
        'updatedBy': ORIGIN + '-v4-dynamic-entry-corrections',
    }
    write_json(OUT_JSON, payload)
    lines = [f'# {ORIGIN} — {gen}', '', f"- Summary: {payload['summary']}", '']
    if failed:
        lines.append('## Failed checks')
        for c in failed:
            lines.append(f"- **{c['checkId']}** ({c['severity']}): `{c.get('detail')}`")
    else:
        lines.append('All checks passed.')
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': gen, 'ok': payload['ok'], 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
