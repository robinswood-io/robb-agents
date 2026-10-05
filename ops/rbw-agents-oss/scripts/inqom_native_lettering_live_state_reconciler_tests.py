#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-native-lettering-live-state-reconciler.json'
DENYLIST = OPS / 'inqom-native-lettering-live-preflight-denylist.json'
OUT_JSON = OPS / 'inqom-native-lettering-live-state-reconciler-tests.json'
OUT_MD = OPS / 'inqom-native-lettering-live-state-reconciler-tests.md'
BATCHER = OPS / 'inqom-lettering-autonomy-batcher.json'
QUEUE = OPS / 'inqom-human-replicated-lettering-executable-queue.json'
SNAPSHOT = OPS / 'inqom-operator-guidance-native-snapshot.json'


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


def recent(value: Any, now: datetime) -> bool:
    try:
        timestamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return 0 <= (now - timestamp).total_seconds() <= 3600
    except (ValueError, TypeError):
        return False


def queue_pairs_classified(report: dict, batcher: dict, queue: Any,
                           snapshot: dict, queue_exists: bool,
                           now: datetime | None = None) -> bool:
    counts = report.get('counts') or {}
    records = report.get('records')
    declared = counts.get('queuePairs')
    if type(declared) is not int or declared < 0 or not isinstance(records, list) or declared != len(records):
        return False
    if declared > 0:
        return True
    now = now or datetime.now(timezone.utc)
    producer_counts = batcher.get('counts') or {}
    coverage = snapshot.get('coverage')
    if not isinstance(coverage, list) or not coverage:
        return False
    folders = {18627, 124920, 124921}
    expected_months = set(range(1, now.month + 1))
    covered = {folder: set() for folder in folders}
    for row in coverage:
        try:
            start = datetime.fromisoformat(row['period']['startDate']).date()
            end = datetime.fromisoformat(row['period']['endDate']).date()
            folder = row['folderId']
            if folder not in folders or row.get('complete') is not True or start.year != now.year or start.day != 1 or start.month != end.month:
                return False
            import calendar
            expected_end = now.date() if start.month == now.month else start.replace(day=calendar.monthrange(start.year, start.month)[1])
            if end != expected_end or start.month in covered[folder]:
                return False
            covered[folder].add(start.month)
        except (KeyError, TypeError, ValueError):
            return False
    return (
        all(months == expected_months for months in covered.values())
        and snapshot.get('ok') is True and isinstance(snapshot.get('lines'), list)
        and len(snapshot['lines']) > 0
        and sum(row.get('lines', 0) for row in coverage) == len(snapshot['lines'])
        and recent(snapshot.get('generatedAt'), now)
        and batcher.get('operatorNativeSnapshotGeneratedAt') == snapshot.get('generatedAt')
        and batcher.get('ok') is True and batcher.get('status') == 'processed'
        and recent(batcher.get('generatedAt'), now)
        and producer_counts.get('executableQueue') == 0
        and producer_counts.get('validationIssues') == 0
        and batcher.get('executableQueue') == []
        and queue_exists and isinstance(queue, list) and queue == []
        and counts.get('canonicalCoverageComplete') == 1
        and counts.get('declaredCanonicalCandidates') == 0
        and counts.get('uniqueCanonicalCandidates') == 0
        and counts.get('validationIssues') == 0
        and counts.get('eligibleForLivePreflight') == 0
        and counts.get('freshReady') == 0 and report.get('freshReadyLots') == []
    )


def main() -> None:
    generated_at = now_iso()
    report = read_json(REPORT, {})
    deny = read_json(DENYLIST, {})
    counts = report.get('counts') or {}
    guardrails = report.get('guardrails') or {}
    records = report.get('records') if isinstance(report.get('records'), list) else []
    fresh = report.get('freshReadyLots') if isinstance(report.get('freshReadyLots'), list) else []
    checks: list[dict[str, Any]] = []
    add(checks, 'report_exists', REPORT.exists(), detail=str(REPORT))
    add(checks, 'report_ok_processed', report.get('ok') is True and report.get('status') == 'processed', detail={'summary': report.get('summary'), 'blockingReasons': report.get('blockingReasons')})
    add(checks, 'queue_pairs_classified', queue_pairs_classified(report, read_json(BATCHER, {}), read_json(QUEUE, None), read_json(SNAPSHOT, {}), QUEUE.exists()), detail={'queuePairs': counts.get('queuePairs'), 'records': len(records)})
    add(checks, 'eligible_preflight_accounted', int(counts.get('eligibleForLivePreflight') if counts.get('eligibleForLivePreflight') is not None else 0) == int(counts.get('freshReady') if counts.get('freshReady') is not None else 0) + int(counts.get('alreadyLettered') if counts.get('alreadyLettered') is not None else 0) + int(counts.get('blockedByLiveDrift') if counts.get('blockedByLiveDrift') is not None else 0) + int(counts.get('blockedByLivePreflight') if counts.get('blockedByLivePreflight') is not None else 0), detail=counts)
    add(checks, 'denylist_exists_when_blocked', (int(counts.get('alreadyLettered') if counts.get('alreadyLettered') is not None else 0) + int(counts.get('blockedByLiveDrift') if counts.get('blockedByLiveDrift') is not None else 0) + int(counts.get('blockedByLivePreflight') if counts.get('blockedByLivePreflight') is not None else 0) == 0) or (DENYLIST.exists() and len(deny.get('blockedLots') or []) >= int(counts.get('alreadyLettered') if counts.get('alreadyLettered') is not None else 0)), detail={'denylist': len(deny.get('blockedLots') or []) if isinstance(deny, dict) else None, 'counts': counts})
    add(checks, 'fresh_lots_are_live_ready', all(r.get('liveReady') is True and r.get('liveStatus') == 'fresh_ready_for_approvalonly_preflight' for r in fresh), detail=fresh[:3])
    add(checks, 'no_mutation_or_active_approval_write', counts.get('mutationAttempted') == 0 and counts.get('activeApprovalWritten') == 0 and guardrails.get('noInqomMutation') is True and guardrails.get('activeApprovalNotWritten') is True, detail={'counts': counts, 'guardrails': guardrails})
    add(checks, 'tax_revision_external_blocked', guardrails.get('noNativeLetteringExecuted') is True and guardrails.get('noNativeRevisionMarking') is True and guardrails.get('noTaxFiling') is True and guardrails.get('noExternalSend') is True, detail=guardrails)
    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v1-inqom-native-lettering-live-state-reconciler-tests',
        'capabilityId': 'inqom-native-lettering-live-state-reconciler-tests',
        'ok': not critical_failed and not high_failed,
        'status': 'pass' if not failed else 'failed',
        'summary': f"inqom_native_lettering_live_state_reconciler_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} pairs={counts.get('queuePairs')} eligible={counts.get('eligibleForLivePreflight')} fresh={counts.get('freshReady')} mutation_attempted={counts.get('mutationAttempted')}",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed), 'queuePairs': counts.get('queuePairs'), 'eligibleForLivePreflight': counts.get('eligibleForLivePreflight'), 'freshReady': counts.get('freshReady'), 'mutationAttempted': counts.get('mutationAttempted')},
        'blockingReasons': [c['checkId'] for c in critical_failed + high_failed],
        'checks': checks,
        'failedChecks': failed,
        'artifacts': {'sourceReport': str(REPORT), 'denylistJson': str(DENYLIST), 'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': 'inqom-native-lettering-live-state-reconciler-tests',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f"# Tests réconciliation live lettrage natif — {generated_at}", '', f"- Résumé : {payload['summary']}", *[f"- {'✅' if c['ok'] else '❌'} {c['checkId']}" for c in checks]]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons']}, ensure_ascii=False))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
