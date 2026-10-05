#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-native-reconciliation-no-link-candidate-review.json'
OUT_JSON = OPS / 'inqom-native-reconciliation-no-link-candidate-review-tests.json'
OUT_MD = OPS / 'inqom-native-reconciliation-no-link-candidate-review-tests.md'
ACTIVE_APPROVAL = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom/mutation-approvals/active-autonomous-approval.json')


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


def closed_review_consistent(rows, queue, counts, class_counts):
    from collections import Counter
    if not rows or Counter(row.get('classification') for row in rows) != Counter(class_counts):
        return False
    if any(row.get('approvalRequestAllowed') is not False or row.get('mutationAllowed') is not False
           or row.get('nativeReconciliationAttempted') is not False for row in rows):
        return False
    closed_rows = [row for row in rows if row.get('owner') == 'closed' and str(row.get('classification', '')).startswith('closed_')]
    expert_rows = [row for row in rows if row.get('owner') == 'expert_accountant'
                   and row.get('classification') == 'expert_review_psp_internal_transfer_without_native_bank_transaction_id']
    if len(closed_rows) != counts.get('closedNoAction') or len(expert_rows) != counts.get('expertReviewItems') or len(closed_rows) + len(expert_rows) != len(rows):
        return False
    def key(row):
        return (row.get('packSlug'), row.get('packIndex'))
    if len({key(row) for row in rows}) != len(rows):
        return False
    routed = [item.get('data') or {} for item in queue]
    if Counter(key(row) for row in routed) != Counter(key(row) for row in expert_rows):
        return False
    expected = {key(row): row for row in expert_rows}
    for item, data in zip(queue, routed):
        row = expected.get(key(data))
        if row is None or item.get('owner') != 'expert_accountant' or item.get('actionType') != 'review_native_bank_reconciliation_no_link_candidate':
            return False
        if not item.get('id') or not item.get('dedupeKey') or not item.get('target') or not item.get('doneCondition'):
            return False
        if data.get('mutationAllowed') is not False or data.get('externalSendAllowed') is not False or data.get('approvalRequestAllowed') is not False or data.get('nativeReconciliationAttempted') is not False:
            return False
        if data.get('bankTransactionIds') or not data.get('lineIds') or not data.get('entryIds'):
            return False
        if any(data.get(name) != row.get(name) for name in ('classification', 'lineIds', 'entryIds', 'accounts', 'amounts', 'targetLines')):
            return False
    return True

def main() -> None:
    generated_at = now_iso()
    report = read_json(REPORT, {})
    counts = report.get('counts') if isinstance(report.get('counts'), dict) else {}
    guardrails = report.get('guardrails') if isinstance(report.get('guardrails'), dict) else {}
    rows = report.get('rows') if isinstance(report.get('rows'), list) else []
    queue = report.get('queue') if isinstance(report.get('queue'), list) else []
    class_counts = report.get('classCounts') if isinstance(report.get('classCounts'), dict) else {}
    checks: list[dict[str, Any]] = []
    add(checks, 'report_exists', REPORT.exists(), detail=str(REPORT))
    add(checks, 'report_ok_processed', report.get('ok') is True and report.get('status') == 'processed_prepare_only', detail={'summary': report.get('summary'), 'blockingReasons': report.get('blockingReasons')})
    items = int(counts.get('items') if counts.get('items') is not None else -1)
    closed = int(counts.get('closedNoAction') if counts.get('closedNoAction') is not None else -1)
    expert = int(counts.get('expertReviewItems') if counts.get('expertReviewItems') is not None else -1)
    approvals = int(counts.get('approvalRequests') if counts.get('approvalRequests') is not None else -1)
    classified = sum(int(value or 0) for value in class_counts.values())
    add(checks, 'all_current_items_classified', items > 0 and len(rows) == items and classified == items and closed + expert + approvals == items, detail={'counts': counts, 'rows': len(rows), 'classified': classified, 'classCounts': class_counts})
    add(checks, 'closed_and_expert_routes_consistent', closed_review_consistent(rows, queue, counts, class_counts), detail={'counts': counts, 'classCounts': class_counts})
    add(checks, 'no_approval_or_mutation', int(counts.get('approvalRequests', -1)) == 0 and int(counts.get('mutationAttempted', -1)) == 0 and int(counts.get('nativeReconciliationAttempted', -1)) == 0 and guardrails.get('noApprovalRequest') is True and guardrails.get('noInqomMutation') is True and guardrails.get('activeApprovalExists') is False and not ACTIVE_APPROVAL.exists(), detail={'counts': counts, 'guardrails': guardrails})
    add(checks, 'expert_queue_only_for_missing_transaction_id', len(queue) == int(counts.get('expertReviewItems') if counts.get('expertReviewItems') is not None else -1) and all(isinstance(item, dict) and item.get('owner') == 'expert_accountant' and (item.get('data') or {}).get('approvalRequestAllowed') is False for item in queue), detail=queue)
    add(checks, 'completed_od_not_sent_to_approval', any(key == 'closed_completed_od_correction_no_native_bank_link_applicable' and int(value or 0) >= 1 for key, value in class_counts.items()), detail=class_counts)
    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v2-dynamic-inqom-native-reconciliation-no-link-candidate-review-tests',
        'capabilityId': 'inqom-native-reconciliation-no-link-candidate-review-tests',
        'ok': not critical_failed and not high_failed,
        'status': 'pass' if not failed else 'failed',
        'summary': f"inqom_native_reconciliation_no_link_candidate_review_tests: checks={len(checks)} failed={len(failed)} items={counts.get('items')} closed={counts.get('closedNoAction')} expert={counts.get('expertReviewItems')} mutation_attempted={counts.get('mutationAttempted')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed), 'items': counts.get('items'), 'closedNoAction': counts.get('closedNoAction'), 'expertReviewItems': counts.get('expertReviewItems'), 'mutationAttempted': counts.get('mutationAttempted')},
        'blockingReasons': [c['checkId'] for c in critical_failed + high_failed],
        'checks': checks,
        'failedChecks': failed,
        'artifacts': {'sourceReport': str(REPORT), 'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': 'inqom-native-reconciliation-no-link-candidate-review-tests-v2-dynamic',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f'# Tests revue rapprochement sans candidat de lien — {generated_at}', '', f"- Résumé : {payload['summary']}", *[f"- {'✅' if c['ok'] else '❌'} {c['checkId']}" for c in checks]]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
