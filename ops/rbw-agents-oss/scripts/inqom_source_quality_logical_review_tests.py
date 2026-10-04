#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from action_queue_contract import validate_action_item

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-source-quality-logical-review.json'
OUT_JSON = OPS / 'inqom-source-quality-logical-review-tests.json'
OUT_MD = OPS / 'inqom-source-quality-logical-review-tests.md'
ACTIVE_APPROVAL = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom/mutation-approvals/active-autonomous-approval.json')
ORIGIN = 'inqom-source-quality-logical-review-tests'
TOLERANCE = 0.01


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


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def sample_contract_ok(item: dict[str, Any]) -> bool:
    sample_count = as_int(item.get('sampleCount'), -1)
    fingerprints = item.get('sampleFingerprints') if isinstance(item.get('sampleFingerprints'), list) else []
    return bool(item.get('sourceClass')) and sample_count > 0 and sample_count == len(fingerprints)



def residual_queue_issues(report: dict[str, Any]) -> list[str]:
    """An expert wait is valid work; a missing, unsafe or inconsistent route is not."""
    issues = []
    counts = report.get('counts') or {}
    items = report.get('items') or []
    queue = report.get('actionQueue') or []
    if not isinstance(items, list) or not isinstance(queue, list):
        return ['items_or_queue_not_list']
    expected = {}
    for item in items:
        if not isinstance(item, dict) or not sample_contract_ok(item):
            issues.append('invalid_item_contract'); continue
        key = item['sourceClass']
        if key in expected:
            issues.append('duplicate_source_class')
        expected[key] = item
        if (item.get('closedNoAction') is True) == (item.get('expertReviewRequired') is True):
            issues.append('item_neither_closed_nor_routed')
        if any(item.get(k) is not False for k in ('mutationAllowed', 'externalSendAllowed', 'nativeReclassificationAllowed')):
            issues.append('unsafe_item_effect')
    expert = {k: v for k, v in expected.items() if v.get('expertReviewRequired') is True}
    seen, ids, dedupes = set(), set(), set()
    for action in queue:
        if not isinstance(action, dict):
            issues.append('invalid_queue_item'); continue
        issues.extend(validate_action_item(action))
        data = action.get('data') or {}
        key = data.get('sourceClass')
        item = expert.get(key)
        if key in seen or action.get('id') in ids or action.get('dedupeKey') in dedupes:
            issues.append('duplicate_expert_route')
        seen.add(key); ids.add(action.get('id')); dedupes.add(action.get('dedupeKey'))
        if not item:
            issues.append('orphan_expert_route'); continue
        if (action.get('owner') != 'agent_then_expert_accountant'
            or action.get('originAutomation') != 'inqom-source-quality-logical-review'
            or action.get('actionType') != 'review_source_quality_logical_classification_residual'
            or action.get('target') != f'inqom:source-quality-logical-review:{key}'
            or action.get('blockingReason') != 'source_quality_logical_review_residual_requires_expert'
            or action.get('actionableNow') is not True
            or not action.get('dedupeKey')):
            issues.append('expert_route_contract_mismatch')
        if data.get('classification') != item.get('classification') or data.get('sampleFingerprints') != item.get('sampleFingerprints'):
            issues.append('expert_evidence_mismatch')
        if any(data.get(k) is not False for k in ('mutationAllowed', 'externalSendAllowed', 'nativeReclassificationAllowed')):
            issues.append('unsafe_expert_route_effect')
    if seen != set(expert):
        issues.append('expert_route_coverage_mismatch')
    if (as_int(counts.get('expertReviewItems'), -1) != len(expert)
        or as_int(counts.get('queue'), -1) != len(queue)
        or as_int(counts.get('closedNoAction'), -1) != len(items) - len(expert)):
        issues.append('review_counts_mismatch')
    return sorted(set(issues))


def main() -> None:
    gen = now_iso()
    report = read_json(REPORT, {})
    counts = report.get('counts') if isinstance(report.get('counts'), dict) else {}
    items = report.get('items') if isinstance(report.get('items'), list) else []
    by_class = {item.get('sourceClass'): item for item in items if isinstance(item, dict) and item.get('sourceClass')}
    checks: list[dict[str, Any]] = []

    check(checks, 'report_exists', REPORT.exists(), str(REPORT))
    check(checks, 'report_ok', isinstance(report, dict) and report.get('ok') is True, report.get('blockingReasons'))
    check(
        checks,
        'no_mutation_flags',
        as_int(counts.get('mutationAttempted')) == 0
        and as_int(counts.get('nativeReclassificationAttempted')) == 0
        and as_int(counts.get('activeApprovalWritten')) == 0,
        counts,
    )
    check(checks, 'active_approval_absent', not ACTIVE_APPROVAL.exists(), str(ACTIVE_APPROVAL))

    source_actions = as_int(counts.get('sourceQualityActions'), -1)
    reviewed_classes = as_int(counts.get('reviewedClasses'), -2)
    coverage_detail = {
        'sourceQualityActions': source_actions,
        'reviewedClasses': reviewed_classes,
        'itemCount': len(items),
        'itemContractsValid': all(sample_contract_ok(item) for item in items if isinstance(item, dict)),
        'classes': sorted(str(key) for key in by_class),
    }
    check(
        checks,
        'source_quality_actions_covered',
        source_actions >= 0
        and source_actions == reviewed_classes == len(items)
        and len(by_class) == len(items)
        and coverage_detail['itemContractsValid'],
        coverage_detail,
    )

    agent_item = by_class.get('AgentCorrectionOrCadrage')
    agent_applicable = isinstance(agent_item, dict)
    agent_rows = agent_item.get('sampleRows') if agent_applicable and isinstance(agent_item.get('sampleRows'), list) else []
    agent_ok = (
        not agent_applicable
        or (
            agent_item.get('closedNoAction') is True
            and agent_item.get('expertReviewRequired') is False
            and agent_item.get('classification') == 'closed_confirmed_agent_correction_or_cadrage_review_only'
            and sample_contract_ok(agent_item)
            and bool(agent_rows)
            and all(row.get('proposedSourceClass') == 'AgentCorrectionOrCadrage' for row in agent_rows if isinstance(row, dict))
            and all(row.get('nonBlockingByDefault') is True for row in agent_rows if isinstance(row, dict))
        )
    )
    check(
        checks,
        'agent_correction_cadrage_closed_when_present',
        agent_ok,
        {'applicable': agent_applicable, 'item': agent_item},
    )

    waiting_item = by_class.get('WaitingAccountReview')
    waiting_applicable = isinstance(waiting_item, dict)
    paired = waiting_item.get('pairedDocRefs') if waiting_applicable and isinstance(waiting_item.get('pairedDocRefs'), list) else []
    waiting_closed_ok = (
        not waiting_applicable
        or waiting_item.get('expertReviewRequired') is True
        or (
            waiting_item.get('closedNoAction') is True
            and waiting_item.get('expertReviewRequired') is False
            and waiting_item.get('classification') == 'closed_revised_extourne_waiting_account_review_only'
            and sample_contract_ok(waiting_item)
        )
    )
    check(
        checks,
        'waiting_account_review_closed_when_present',
        waiting_closed_ok,
        {'applicable': waiting_applicable, 'item': waiting_item},
    )

    pairs_ok = (
        not waiting_applicable
        or waiting_item.get('expertReviewRequired') is True
        or (
            bool(paired)
            and all(
                abs(float(pair.get('amountTotal') if pair.get('amountTotal') is not None else 999999)) <= TOLERANCE
                and as_int(pair.get('lineCount')) >= 2
                and pair.get('hasCorrectCounterpart') is True
                for pair in paired
                if isinstance(pair, dict)
            )
            and all(isinstance(pair, dict) for pair in paired)
        )
    )
    check(
        checks,
        'waiting_account_review_pairs_balance_when_present',
        pairs_ok,
        {'applicable': waiting_applicable, 'pairedDocRefs': paired},
    )

    check(
        checks,
        'residual_expert_queue_consistent_and_readonly',
        not residual_queue_issues(report),
        {'issues': residual_queue_issues(report), 'counts': counts},
    )

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': gen,
        'contractVersion': 'standard-v3-routed-expert-review-queue',
        'capabilityId': ORIGIN,
        'ok': not failed,
        'status': 'pass' if not failed else 'fail',
        'summary': f"inqom_source_quality_logical_review_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} closed={counts.get('closedNoAction')} mutation_attempted={counts.get('mutationAttempted')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed)},
        'checks': checks,
        'failedChecks': failed,
        'blockingReasons': [c['checkId'] for c in critical_failed],
        'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD), 'sourceReport': str(REPORT)},
        'updatedBy': ORIGIN,
    }
    write_json(OUT_JSON, payload)
    lines = [f'# {ORIGIN} — {gen}', '', f"- Summary: {payload['summary']}", '']
    if failed:
        lines.append('## Failed checks')
        for item in failed:
            lines.append(f"- **{item['checkId']}** ({item['severity']}): `{item.get('detail')}`")
    else:
        lines.append('All checks passed.')
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': gen, 'ok': payload['ok'], 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
