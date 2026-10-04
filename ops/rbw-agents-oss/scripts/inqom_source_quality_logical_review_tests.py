#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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
        'no_residual_queue_needed',
        as_int(counts.get('expertReviewItems')) == 0 and len(report.get('actionQueue') or []) == 0,
        {'counts': counts, 'queue': report.get('actionQueue')},
    )

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': gen,
        'contractVersion': 'standard-v2-dynamic-inqom-source-quality-logical-review-tests',
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
