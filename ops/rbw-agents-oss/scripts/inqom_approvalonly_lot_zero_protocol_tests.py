#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from inqom_approvalonly_lot_zero_protocol import verified_empty_registry_queue, REGISTRY, LIVE_JSON, LIVE_TESTS_JSON

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-approvalonly-lot-zero-protocol.json'
DRAFT = OPS / 'inqom-approvalonly-lot-zero-approval-draft.json'
PREFLIGHT = OPS / 'inqom-approvalonly-lot-zero-preflight-required.json'
LEDGER = OPS / 'inqom-approvalonly-lot-zero-ledger.jsonl'
OUT_JSON = OPS / 'inqom-approvalonly-lot-zero-protocol-tests.json'
OUT_MD = OPS / 'inqom-approvalonly-lot-zero-protocol-tests.md'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def read_ledger_latest(path: Path) -> dict[str, Any]:
    latest: dict[str, Any] = {}
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.strip():
                obj = json.loads(line)
                if isinstance(obj, dict):
                    latest = obj
    except Exception:
        pass
    return latest


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def add(checks: list[dict[str, Any]], check_id: str, ok: bool, severity: str = 'critical', detail: Any = None) -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': severity, 'detail': detail})


def main() -> None:
    generated_at = now_iso()
    report = read_json(REPORT, {})
    draft = read_json(DRAFT, {})
    preflight = read_json(PREFLIGHT, {})
    ledger = read_ledger_latest(LEDGER)
    counts = report.get('counts') or {}
    guardrails = report.get('guardrails') or {}
    lot = report.get('lotZero') or {}
    status = str(report.get('status') or '')
    fresh_candidate = counts.get('candidate') == 1
    no_fresh_guarded = status == 'no_fresh_candidate_after_live_preflight_denylist_guarded'
    checks: list[dict[str, Any]] = []
    add(checks, 'report_exists', REPORT.exists(), detail=str(REPORT))
    add(checks, 'draft_exists', DRAFT.exists(), detail=str(DRAFT))
    add(checks, 'preflight_requirement_exists', PREFLIGHT.exists(), detail=str(PREFLIGHT))
    add(checks, 'ledger_exists', LEDGER.exists(), detail=str(LEDGER))
    add(checks, 'report_ok_guarded', report.get('ok') is True and (status.startswith('ready_but_') or no_fresh_guarded), detail={'status': report.get('status'), 'summary': report.get('summary'), 'blockingReasons': report.get('blockingReasons')})
    add(checks, 'candidate_state_consistent', (fresh_candidate and counts.get('lineCount') == 2 and round(float(lot.get('expectedAmountSum') or 0), 2) == 0.0 and len(lot.get('lineIds') or []) == 2) or (no_fresh_guarded and counts.get('candidate') == 0 and (int(counts.get('skippedByLivePreflightDenylist') if counts.get('skippedByLivePreflightDenylist') is not None else 0) > 0 or (counts.get('verifiedEmptyCurrentQueue') == 1 and verified_empty_registry_queue(read_json(REGISTRY, {}), read_json(LIVE_JSON, {}), read_json(LIVE_TESTS_JSON, {}))))), detail={'counts': counts, 'lot': {k: lot.get(k) for k in ['lotId','lineIds','expectedAmountSum']}, 'status': status})
    add(checks, 'line_hash_present_when_candidate', (isinstance(lot.get('lineHash'), str) and len(lot.get('lineHash')) == 64) if fresh_candidate else no_fresh_guarded, detail=lot.get('lineHash'))
    add(checks, 'confidence_threshold_met_when_candidate', (float(lot.get('confidenceScore') or 0) >= float(lot.get('confidenceThreshold') or 0.9)) if fresh_candidate else no_fresh_guarded, detail={'confidence': lot.get('confidenceScore'), 'threshold': lot.get('confidenceThreshold'), 'status': status})
    add(checks, 'draft_is_not_active_approval', draft.get('draftOnly') is True and draft.get('notActiveApprovalFile') is True and draft.get('mustNotBeTreatedAsAuthorization') is True and (report.get('approvalDraft') or {}).get('draftOnly') is True, detail={'draftOnly': draft.get('draftOnly'), 'status': draft.get('status'), 'activeApprovalPath': draft.get('activeApprovalPathIfSeparatelyApproved')})
    add(checks, 'preflight_requirement_state', preflight.get('requiredBeforeAnyFutureActiveApproval') is True and ((fresh_candidate and preflight.get('status') == 'not_run_by_lot_zero_guard_wrapper' and ((preflight.get('readOnlyTool') or {}).get('tool') == 'inqom_get_native_lettering_preflight')) or (no_fresh_guarded and preflight.get('status') == 'not_required_no_fresh_lot_zero_candidate_after_live_preflight_denylist')), detail=preflight.get('status'))
    add(checks, 'no_mutation_or_active_write', counts.get('mutationAttempted') == 0 and counts.get('activeApprovalWritten') == 0 and guardrails.get('noInqomMutation') is True and guardrails.get('activeApprovalNotWritten') is True, detail={'counts': counts, 'guardrails': guardrails})
    add(checks, 'expected_guardrails_recorded', 'explicit_active_approval_required' in (report.get('expectedGuardrails') or []) and 'lot_zero_deliberately_blocks_mutation' in (report.get('expectedGuardrails') or []) and 'live_preflight_denylist_applied' in (report.get('expectedGuardrails') or []), detail=report.get('expectedGuardrails'))
    add(checks, 'ledger_denial_matches_state', ledger.get('status') == 'denied_expected_no_mutation' and ledger.get('mutationAttempted') is False and ((fresh_candidate and ledger.get('lotId') == lot.get('lotId') and ledger.get('lineHash') == lot.get('lineHash')) or (no_fresh_guarded and ledger.get('lotId') is None)), detail=ledger)
    add(checks, 'tax_external_delete_blocked', guardrails.get('noTaxFiling') is True and guardrails.get('noTaxPayment') is True and guardrails.get('noExternalSend') is True and draft.get('allowDelete') is False and draft.get('allowTaxSubmission') is False, detail={'guardrails': guardrails, 'draft': {k: draft.get(k) for k in ['allowDelete','allowTaxSubmission','allowExternalSend']}})
    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v1-inqom-approvalonly-lot-zero-protocol-tests',
        'capabilityId': 'inqom-approvalonly-lot-zero-protocol-tests',
        'ok': not critical_failed and not high_failed,
        'status': 'pass' if not failed else 'failed',
        'summary': f"inqom_approvalonly_lot_zero_protocol_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} mutation_attempted={counts.get('mutationAttempted')} active_approval_written={counts.get('activeApprovalWritten')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed), 'mutationAttempted': counts.get('mutationAttempted'), 'activeApprovalWritten': counts.get('activeApprovalWritten')},
        'blockingReasons': [c['checkId'] for c in critical_failed + high_failed],
        'checks': checks,
        'failedChecks': failed,
        'artifacts': {'sourceReport': str(REPORT), 'draftJson': str(DRAFT), 'preflightJson': str(PREFLIGHT), 'ledgerJsonl': str(LEDGER), 'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': 'inqom-approvalonly-lot-zero-protocol-tests',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f"# Tests ApprovalOnly lot zéro — {generated_at}", '', f"- Résumé : {payload['summary']}", *[f"- {'✅' if c['ok'] else '❌'} {c['checkId']}" for c in checks]]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
