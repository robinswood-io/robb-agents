#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
REPORT = OPS / 'inqom-native-lettering-denylist-closure.json'
OUT_JSON = OPS / 'inqom-native-lettering-denylist-closure-tests.json'
OUT_MD = OPS / 'inqom-native-lettering-denylist-closure-tests.md'
ACTIVE_APPROVAL = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom/mutation-approvals/active-autonomous-approval.json')
ORIGIN = 'inqom-native-lettering-denylist-closure-tests'


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
    lots = report.get('closedLots') if isinstance(report.get('closedLots'), list) else []
    checks: list[dict[str, Any]] = []
    check(checks, 'report_exists', REPORT.exists(), str(REPORT))
    check(checks, 'report_ok_and_closure_ready', isinstance(report, dict) and report.get('ok') is True and report.get('closureReady') is True, report.get('blockingReasons'))
    check(checks, 'active_approval_absent', not ACTIVE_APPROVAL.exists() and int(counts.get('activeApprovalPathExists') if counts.get('activeApprovalPathExists') is not None else 0) == 0, {'activePath': str(ACTIVE_APPROVAL), 'counts': counts})
    check(checks, 'no_mutation_attempted', int(counts.get('mutationAttempted') if counts.get('mutationAttempted') is not None else 0) == 0 and int(counts.get('nativeLetteringAttempted') if counts.get('nativeLetteringAttempted') is not None else 0) == 0 and int(counts.get('activeApprovalWritten') if counts.get('activeApprovalWritten') is not None else 0) == 0, counts)
    check(checks, 'fresh_ready_zero', int(counts.get('freshReady') if counts.get('freshReady') is not None else -1) == 0, counts)
    check(checks, 'eligible_all_already_lettered', int(counts.get('eligibleForLivePreflight') if counts.get('eligibleForLivePreflight') is not None else 0) > 0 and int(counts.get('eligibleForLivePreflight') if counts.get('eligibleForLivePreflight') is not None else 0) == int(counts.get('alreadyLettered') if counts.get('alreadyLettered') is not None else -1), counts)
    check(checks, 'denylist_covers_current_already_lettered', int(counts.get('denylistMissingCurrentLots') if counts.get('denylistMissingCurrentLots') is not None else -1) == 0 and int(counts.get('currentAlreadyLetteredLotsCoveredByDenylist') if counts.get('currentAlreadyLetteredLotsCoveredByDenylist') is not None else -1) == int(counts.get('alreadyLettered') if counts.get('alreadyLettered') is not None else -2) and int(counts.get('denylistBlockedLots') if counts.get('denylistBlockedLots') is not None else 0) >= int(counts.get('alreadyLettered') if counts.get('alreadyLettered') is not None else -1), counts)
    check(checks, 'closed_lots_are_already_lettered_not_ready', bool(lots) and all(l.get('liveStatus') == 'already_lettered_live' and l.get('preflightReady') is False and l.get('mutationAttempted') is False and l.get('matchedLetters') for l in lots), lots[:5])
    check(checks, 'denylist_policy_is_antireplay_only', ((report.get('mutationPolicy') or {}).get('denylistOnlyBlocksReplay') is True and (report.get('mutationPolicy') or {}).get('denylistAuthorizesMutation') is False), report.get('mutationPolicy'))

    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    payload = {
        'generatedAt': gen,
        'contractVersion': 'standard-v1-inqom-native-lettering-denylist-closure-tests',
        'capabilityId': ORIGIN,
        'ok': not failed,
        'status': 'pass' if not failed else 'fail',
        'summary': f"inqom_native_lettering_denylist_closure_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} fresh={counts.get('freshReady')} mutation_attempted={counts.get('mutationAttempted')}",
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
