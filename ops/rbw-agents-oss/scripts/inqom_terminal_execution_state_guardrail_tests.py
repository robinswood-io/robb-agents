#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-terminal-execution-state-guardrail.json'
OUT_JSON = OPS / 'inqom-terminal-execution-state-guardrail-tests.json'
OUT_MD = OPS / 'inqom-terminal-execution-state-guardrail-tests.md'
ACTIVE_APPROVAL = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom/mutation-approvals/active-autonomous-approval.json')
ORIGIN = 'inqom-terminal-execution-state-guardrail-tests'


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


def add(checks: list[dict[str, Any]], check_id: str, ok: bool, detail: Any = None, severity: str = 'critical') -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': severity, 'detail': detail})


import inqom_terminal_execution_state_guardrail as terminal_guard

def main() -> None:
    gen = now_iso()
    report = read_json(REPORT, {})
    counts = report.get('counts') if isinstance(report.get('counts'), dict) else {}
    checks: list[dict[str, Any]] = []
    add(checks, 'report_exists', REPORT.exists(), str(REPORT))
    terminal_closed = count(counts, 'terminalClosed', -1) == 1
    semantics = report.get('stateSemantics') if isinstance(report.get('stateSemantics'), dict) else {}
    state_consistent = (
        terminal_closed
        and report.get('ok') is True
        and report.get('status') == 'terminal_closed_no_agent_executable_work'
        and not report.get('blockingReasons')
        and semantics.get('businessCompletionStatus') == 'complete_verified'
    ) or (
        not terminal_closed
        and report.get('ok') is False
        and report.get('status') == 'blocked_incomplete_work'
        and bool(report.get('blockingReasons'))
        and semantics.get('businessCompletionStatus') == 'blocked_incomplete_work'
    )
    add(checks, 'report_business_state_consistent', isinstance(report, dict) and state_consistent, {'terminalClosed': terminal_closed, 'ok': report.get('ok'), 'status': report.get('status'), 'blockingReasons': report.get('blockingReasons'), 'stateSemantics': semantics})
    add(checks, 'safety_state_fail_closed', semantics.get('safetyStatus') == 'fail_closed', semantics)
    add(checks, 'active_approval_absent', not ACTIVE_APPROVAL.exists() and count(counts, 'activeApprovalPathExists', -1) == 0, counts)
    payloads = {key: read_json(path, {}) for key, path in terminal_guard.REPORTS.items()}
    route_queue = read_json(OPS / 'inqom-execution-blocker-burndown-router-queue.json', [])
    waits_verified = terminal_guard.current_residual_context(payloads, route_queue)
    add(checks, 'no_agent_ready', count(counts, 'safeAgentReady', -1) == 0 and (count(counts, 'agentRoutes', -1) == 0 or waits_verified) and count(counts, 'engineeringRoutes', -1) == 0, counts)
    add(checks, 'expert_handoff_complete', count(counts, 'residualQueue', -1) > 0 and waits_verified and count(counts, 'residualQueue', -1) == count(counts, 'expertRoutes', -1) + count(counts, 'agentRoutes', -1) == count(counts, 'handoffQueue', -1), counts)
    add(checks, 'no_live_drift_or_missing_tool', count(counts, 'liveDriftRecords', -1) == 0 and count(counts, 'missingNativeToolRecords', -1) == 0, counts)
    add(checks, 'no_unguarded_native_apply_candidate', count(counts, 'nativeBankFutureApprovalReady', -1) == 0 and count(counts, 'nativeLetteringFreshReady', -1) == 0 and count(counts, 'lotZeroCandidate', -1) == 0 and count(counts, 'entryCorrectionOperations', -1) >= 0 and count(counts, 'activeApprovalPathExists', -1) == 0 and count(counts, 'mutationAttempted', -1) == 0, counts)
    if count(counts, 'entryCorrectionQuarantinedLots', 0) > 0:
        add(checks, 'quarantined_entry_corrections_are_terminal_fail_closed', (terminal_closed or terminal_guard.documented_wait_state(report, payloads, route_queue)) and count(counts, 'entryCorrectionQuarantinedNoop', -1) == 1 and count(counts, 'entryCorrectionBlockedManifestValid', -1) == 1 and count(counts, 'entryCorrectionOperations', -1) == 0 and count(counts, 'entryCorrectionProposedOperations', -1) == 0 and count(counts, 'mutationAttempted', -1) == 0, counts)
    add(checks, 'active_approval_guard_clean', count(counts, 'activeApprovalGuardFindings', -1) == 0 and count(counts, 'activeApprovalPathExists', -1) == 0, counts)
    add(checks, 'zero_guard_clean', count(counts, 'zeroGuardMatches', -1) == 0 and count(counts, 'zeroGuardScannedFiles', 0) >= 100, counts)
    add(checks, 'integration_contract_clean', count(counts, 'guardrailIntegrationContractFailedChecks', -1) == 0 and count(counts, 'guardrailIntegrationContractRequiredSteps', -1) >= 10, counts)
    add(checks, 'mutation_counters_zero', count(counts, 'mutationAttempted', -1) == 0 and count(counts, 'nativeMutationAttempted', -1) == 0 and count(counts, 'externalSendAttempted', -1) == 0, counts)
    internal_checks_coherent = (
        terminal_closed and count(counts, 'failedChecks', -1) == 0 and count(counts, 'criticalFailedChecks', -1) == 0
    ) or (
        not terminal_closed and count(counts, 'failedChecks', -1) > 0 and count(counts, 'criticalFailedChecks', -1) > 0
    )
    add(checks, 'guardrail_internal_checks_coherent', internal_checks_coherent, counts)

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    payload = {
        'generatedAt': gen,
        'contractVersion': 'standard-v3-dynamic-business-state-aware-inqom-terminal-execution-state-guardrail-tests',
        'capabilityId': ORIGIN,
        'ok': not failed,
        'status': 'pass' if not failed else 'fail',
        'summary': f"inqom_terminal_execution_state_guardrail_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} terminal_closed={counts.get('terminalClosed')} ready={counts.get('safeAgentReady')} expert_routes={counts.get('expertRoutes')} mutation_attempted={counts.get('mutationAttempted')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'mutationAttempted': 0, 'nativeMutationAttempted': 0, 'externalSendAttempted': 0},
        'checks': checks,
        'failedChecks': failed,
        'blockingReasons': [c['checkId'] for c in critical_failed],
        'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD), 'sourceReport': str(REPORT)},
        'updatedBy': ORIGIN + '-v3-dynamic-business-state-aware',
    }
    write_json(OUT_JSON, payload)
    lines = [f'# {ORIGIN} — {gen}', '', f"- Summary: {payload['summary']}"]
    if failed:
        lines += ['', '## Failed checks']
        for item in failed:
            lines.append(f"- **{item['checkId']}** ({item['severity']}): `{item.get('detail')}`")
    else:
        lines += ['', 'All checks passed.']
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': gen, 'ok': payload['ok'], 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
