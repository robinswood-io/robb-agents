#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-agent-work-expectation-controller.json'
QUEUE = OPS / 'inqom-agent-work-expectation-controller-queue.json'
TERMINAL_REPORT = OPS / 'inqom-terminal-execution-state-guardrail.json'
PARTIAL_RECOVERY_REPORT = OPS / 'inqom-accounting-entry-correction-partial-recovery.json'
OUT_JSON = OPS / 'inqom-agent-work-expectation-controller-tests.json'
OUT_MD = OPS / 'inqom-agent-work-expectation-controller-tests.md'


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


def documented_business_wait_valid(terminal: dict, row: dict, evidence_valid: bool) -> bool:
    """Qualify control health while keeping accounting completion false."""
    semantics = terminal.get('stateSemantics') or {}
    counts = terminal.get('counts') or {}
    return (
        evidence_valid is True
        and terminal.get('ok') is False
        and terminal.get('status') == 'blocked_incomplete_work'
        and terminal.get('blockingReasons') == ['business_autonomy_complete_verified']
        and counts.get('terminalClosed') == 0
        and all(counts.get(key) == 0 for key in [
            'mutationAttempted', 'nativeMutationAttempted',
            'externalSendAttempted', 'activeApprovalPathExists'])
        and semantics.get('safetyStatus') == 'fail_closed'
        and semantics.get('businessCompletionStatus') == 'blocked_incomplete_work'
        and row.get('ok') is True
        and row.get('sourceReportOk') is False
        and row.get('businessCompleted') is False
        and row.get('stateQualified') == 'documented_business_inputs_pending'
        and row.get('blockingReasons') == terminal.get('blockingReasons')
    )


def main() -> None:
    generated_at = now_iso()
    report = read_json(REPORT, {})
    queue = read_json(QUEUE, [])
    terminal = read_json(TERMINAL_REPORT, {})
    partial_recovery = read_json(PARTIAL_RECOVERY_REPORT, {})
    counts = report.get('counts') or {}
    guardrails = report.get('guardrails') or {}
    terminal_semantics = terminal.get('stateSemantics') if isinstance(terminal.get('stateSemantics'), dict) else {}
    terminal_rows = [row for row in (report.get('criticalReportChecks') or []) if isinstance(row, dict) and row.get('name') == 'terminalExecutionStateGuardrail']
    terminal_business_checks = [row for row in (terminal.get('checks') or []) if isinstance(row, dict) and row.get('checkId') == 'entry_correction_business_completion']
    blocked_business_control_valid = (
        terminal.get('ok') is False
        and terminal.get('status') == 'blocked_incomplete_work'
        and set(terminal.get('blockingReasons') or []) == {'entry_correction_business_completion'}
        and terminal_semantics.get('safetyStatus') == 'fail_closed'
        and terminal_semantics.get('businessCompletionStatus') == 'blocked_incomplete_work'
        and len(terminal_rows) == 1
        and terminal_rows[0].get('ok') is True
        and terminal_rows[0].get('expectedBlockedBusinessState') is True
    )
    quarantined_noop_completion_valid = (
        terminal.get('ok') is True
        and terminal.get('status') == 'terminal_closed_no_agent_executable_work'
        and not (terminal.get('blockingReasons') or [])
        and terminal_semantics.get('safetyStatus') == 'fail_closed'
        and terminal_semantics.get('businessCompletionStatus') == 'complete_verified'
        and len(terminal_rows) == 1
        and terminal_rows[0].get('ok') is True
        and len(terminal_business_checks) == 1
        and terminal_business_checks[0].get('ok') is True
        and (terminal_business_checks[0].get('detail') or {}).get('quarantinedNoop') is True
    )
    import inqom_terminal_execution_state_guardrail as terminal_guard
    wait_payloads = {key: read_json(path, {}) for key, path in terminal_guard.REPORTS.items()}
    wait_queue = read_json(OPS / 'inqom-execution-blocker-burndown-router-queue.json', [])
    documented_wait_valid = (
        len(terminal_rows) == 1
        and documented_business_wait_valid(
            terminal, terminal_rows[0],
            terminal_guard.documented_wait_state(terminal, wait_payloads, wait_queue))
    )
    partial_counts = partial_recovery.get('counts') if isinstance(partial_recovery.get('counts'), dict) else {}
    partial_plan = partial_recovery.get('freshResolutionPlan') if isinstance(partial_recovery.get('freshResolutionPlan'), dict) else {}
    resolved_live_completion_valid = (
        terminal.get('ok') is True
        and terminal.get('status') == 'terminal_closed_no_agent_executable_work'
        and not (terminal.get('blockingReasons') or [])
        and terminal_semantics.get('safetyStatus') == 'fail_closed'
        and terminal_semantics.get('businessCompletionStatus') == 'complete_verified'
        and len(terminal_rows) == 1
        and terminal_rows[0].get('ok') is True
        and len(terminal_business_checks) == 1
        and terminal_business_checks[0].get('ok') is True
        and (terminal_business_checks[0].get('detail') or {}).get('noWork') is True
        and partial_recovery.get('ok') is True
        and partial_recovery.get('resolved') is True
        and partial_recovery.get('status') == 'contained_live_state_resolved_no_action_required'
        and int(partial_counts.get('accountingStateResolved') or 0) == int(partial_counts.get('duplicateEntriesIdentified') or 0) == 4
        and int(partial_counts.get('boundedResolutionEntriesVerified') or 0) == 3
        and int(partial_counts.get('pairsRequiringResolution') or 0) == 0
        and int(partial_counts.get('freshResidualOperationsPrepared') or 0) == 0
        and int(partial_counts.get('mutationAttempted') or 0) == 0
        and partial_plan.get('status') == 'resolved_inactive'
        and partial_plan.get('approvalStatus') == 'consumed'
        and partial_plan.get('activationAllowed') is False
        and not (partial_plan.get('operations') or [])
    )
    checks: list[dict[str, Any]] = []
    add(checks, 'report_exists', REPORT.exists(), detail=str(REPORT))
    add(checks, 'queue_exists', QUEUE.exists(), detail=str(QUEUE))
    add(checks, 'controller_passes', report.get('ok') is True and report.get('status') == 'pass', detail={'summary': report.get('summary'), 'blockingReasons': report.get('blockingReasons')})
    add(checks, 'agents_all_ok', int(counts.get('agents') if counts.get('agents') is not None else 0) >= 10 and int(counts.get('agentsOk') if counts.get('agentsOk') is not None else 0) == int(counts.get('agents') if counts.get('agents') is not None else 0) and int(counts.get('agentGaps') if counts.get('agentGaps') is not None else 0) == 0 and isinstance(queue, list) and len(queue) == 0, detail={'counts': counts, 'queue': queue[:3] if isinstance(queue, list) else queue})
    add(checks, 'critical_reports_clean', int(counts.get('criticalReports') if counts.get('criticalReports') is not None else 0) > 0 and int(counts.get('failedCriticalReports') if counts.get('failedCriticalReports') is not None else 0) == 0 and int(counts.get('criticalReportsOk') if counts.get('criticalReportsOk') is not None else 0) == int(counts.get('criticalReports') if counts.get('criticalReports') is not None else 0), detail=counts)
    add(checks, 'guardrails_closed', guardrails.get('noInqomMutation') is True and guardrails.get('activeApprovalExists') is False and guardrails.get('activeApprovalNotWritten') is True and guardrails.get('noExternalSend') is True and counts.get('mutationAttempted') == 0, detail={'guardrails': guardrails, 'counts': counts})
    add(checks, 'terminal_business_state_accepted_without_false_completion', blocked_business_control_valid or quarantined_noop_completion_valid or resolved_live_completion_valid or documented_wait_valid, detail={'documentedBusinessWaitValid': documented_wait_valid, 'blockedBusinessControlValid': blocked_business_control_valid, 'quarantinedNoopCompletionValid': quarantined_noop_completion_valid, 'resolvedLiveCompletionValid': resolved_live_completion_valid, 'terminal': {'ok': terminal.get('ok'), 'status': terminal.get('status'), 'blockingReasons': terminal.get('blockingReasons'), 'stateSemantics': terminal_semantics}, 'partialRecovery': {'ok': partial_recovery.get('ok'), 'status': partial_recovery.get('status'), 'resolved': partial_recovery.get('resolved'), 'counts': partial_counts, 'planStatus': partial_plan.get('status'), 'approvalStatus': partial_plan.get('approvalStatus')}, 'controllerTerminalRows': terminal_rows, 'terminalBusinessChecks': terminal_business_checks})
    add(checks, 'schedule_sets_preserved', int(counts.get('scheduleCount') if counts.get('scheduleCount') is not None else 0) > 0 and int(counts.get('scheduleCount') if counts.get('scheduleCount') is not None else 0) == int(counts.get('readyScheduleCount') if counts.get('readyScheduleCount') is not None else 0) and int(counts.get('scheduleMissingInReady') if counts.get('scheduleMissingInReady') is not None else 0) == 0 and int(counts.get('scheduleExtraInReady') if counts.get('scheduleExtraInReady') is not None else 0) == 0, detail=counts)
    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v1-inqom-agent-work-expectation-controller-tests',
        'capabilityId': 'inqom-agent-work-expectation-controller-tests',
        'ok': not critical_failed and not high_failed,
        'status': 'pass' if not failed else 'failed',
        'summary': f"inqom_agent_work_expectation_controller_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} agents={counts.get('agents')} gaps={counts.get('agentGaps')} mutation_attempted={counts.get('mutationAttempted')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed), 'agents': counts.get('agents'), 'agentGaps': counts.get('agentGaps'), 'mutationAttempted': counts.get('mutationAttempted')},
        'blockingReasons': [c['checkId'] for c in critical_failed + high_failed],
        'checks': checks,
        'failedChecks': failed,
        'artifacts': {'sourceReport': str(REPORT), 'queueJson': str(QUEUE), 'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': 'inqom-agent-work-expectation-controller-tests',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f"# Tests contrôleur agents — {generated_at}", '', f"- Résumé : {payload['summary']}", *[f"- {'✅' if c['ok'] else '❌'} {c['checkId']}" for c in checks]]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
