#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS = WS / 'campaigns' / 'ops'
LIVE_JSON = OPS / 'inqom-native-lettering-live-state-reconciler.json'
LIVE_TESTS_JSON = OPS / 'inqom-native-lettering-live-state-reconciler-tests.json'
DENYLIST_JSON = OPS / 'inqom-native-lettering-live-preflight-denylist.json'
LOT_ZERO_LIVE_JSON = OPS / 'inqom-approvalonly-lot-zero-live-preflight.json'
OUT_JSON = OPS / 'inqom-native-lettering-denylist-closure.json'
OUT_MD = OPS / 'inqom-native-lettering-denylist-closure.md'
ACTIVE_APPROVAL = WS / 'sources' / 'inqom' / 'mutation-approvals' / 'active-autonomous-approval.json'
ORIGIN = 'inqom-native-lettering-denylist-closure'


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


def compact_lot(lot: dict[str, Any]) -> dict[str, Any]:
    return {
        'lotId': lot.get('lotId') or lot.get('pairId'),
        'sortedLineKey': lot.get('sortedLineKey'),
        'kind': lot.get('kind'),
        'thirdPartyKey': lot.get('thirdPartyKey'),
        'lineIds': lot.get('lineIds'),
        'entryIds': lot.get('entryIds'),
        'liveStatus': lot.get('liveStatus'),
        'matchedLetters': lot.get('matchedLetters') or sorted({str((line.get('matched') or {}).get('matchedLetter')) for line in (lot.get('preflightLines') or []) if isinstance(line, dict) and (line.get('matched') or {}).get('matchedLetter')}),
        'preflightReady': lot.get('preflightReady') if 'preflightReady' in lot else lot.get('liveReady'),
        'mutationAttempted': lot.get('mutationAttempted') if 'mutationAttempted' in lot else False,
        'reasons': lot.get('reasons') or lot.get('preflightBlockingReasons') or [],
    }


def verified_empty_current_queue(live: dict, tests: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    try:
        generated = datetime.fromisoformat(str(live['generatedAt']).replace('Z', '+00:00'))
        tested = datetime.fromisoformat(str(tests['generatedAt']).replace('Z', '+00:00'))
        if not (0 <= (now - generated).total_seconds() <= 3600 and generated <= tested <= now):
            return False
    except (KeyError, ValueError, TypeError):
        return False
    counts = live.get('counts') or {}
    test_counts = tests.get('counts') or {}
    checks = tests.get('checks')
    return (
        live.get('ok') is True and live.get('status') == 'processed'
        and live.get('records') == [] and live.get('freshReadyLots') == []
        and all(type(counts.get(key)) is int and counts[key] == 0 for key in [
            'queuePairs', 'eligibleForLivePreflight', 'alreadyLettered', 'freshReady',
            'declaredCanonicalCandidates', 'uniqueCanonicalCandidates', 'validationIssues',
            'mutationAttempted', 'activeApprovalWritten'])
        and counts.get('canonicalCoverageComplete') == 1
        and tests.get('ok') is True and tests.get('status') == 'pass'
        and test_counts.get('queuePairs') == 0 and test_counts.get('failed') == 0
        and isinstance(checks, list) and len(checks) >= 8
        and all(check.get('ok') is True for check in checks)
        and len([check for check in checks if check.get('checkId') == 'queue_pairs_classified']) == 1
    )


def main() -> None:
    gen = now_iso()
    live = read_json(LIVE_JSON, {})
    live_tests = read_json(LIVE_TESTS_JSON, {})
    deny = read_json(DENYLIST_JSON, {})
    lot_zero_live = read_json(LOT_ZERO_LIVE_JSON, {})
    validation: list[dict[str, Any]] = []

    live_counts = live.get('counts') if isinstance(live.get('counts'), dict) else {}
    deny_counts = deny.get('counts') if isinstance(deny.get('counts'), dict) else {}
    zero_counts = lot_zero_live.get('counts') if isinstance(lot_zero_live.get('counts'), dict) else {}
    already_lots = live.get('alreadyLetteredLots') if isinstance(live.get('alreadyLetteredLots'), list) else []
    blocked_lots = deny.get('blockedLots') if isinstance(deny.get('blockedLots'), list) else []
    already_line_keys = {str(lot.get('sortedLineKey')) for lot in already_lots if isinstance(lot, dict) and lot.get('sortedLineKey')}
    blocked_line_keys = {str(lot.get('sortedLineKey')) for lot in blocked_lots if isinstance(lot, dict) and lot.get('sortedLineKey')}
    missing_current_line_keys = sorted(already_line_keys - blocked_line_keys)
    historical_safe_line_keys = sorted(blocked_line_keys - already_line_keys)

    if not isinstance(live, dict) or live.get('ok') is not True:
        validation.append({'code': 'native_lettering_live_state_not_ok', 'detail': live.get('blockingReasons') if isinstance(live, dict) else None})
    if not isinstance(live_tests, dict) or live_tests.get('ok') is not True:
        validation.append({'code': 'native_lettering_live_state_tests_not_ok', 'detail': live_tests.get('blockingReasons') if isinstance(live_tests, dict) else None})
    if not isinstance(deny, dict) or not blocked_lots:
        validation.append({'code': 'native_lettering_denylist_missing_or_empty', 'detail': str(DENYLIST_JSON)})

    all_blocked_lots_safe = bool(blocked_lots) and all(
        isinstance(lot, dict)
        and lot.get('status') == 'blocked_by_live_preflight'
        and lot.get('preflightReady') is False
        and lot.get('mutationAttempted') is False
        and str(lot.get('liveStatus') or '') == 'already_lettered_live'
        and bool(lot.get('matchedLetters'))
        for lot in blocked_lots
    )
    if not all_blocked_lots_safe:
        validation.append({'code': 'denylist_lots_not_all_already_lettered_safe', 'detail': [compact_lot(l) for l in blocked_lots[:10] if isinstance(l, dict)]})

    counts = {
        'activeApprovalWritten': 0,
        'activeApprovalPathExists': 1 if ACTIVE_APPROVAL.exists() else 0,
        'eligibleForLivePreflight': int(live_counts.get('eligibleForLivePreflight') or 0),
        'alreadyLettered': int(live_counts.get('alreadyLettered') or 0),
        'freshReady': int(live_counts.get('freshReady') or 0),
        'denylistBlockedLotsFromLive': int(live_counts.get('denylistBlockedLots') or 0),
        'denylistBlockedLots': int(deny_counts.get('blockedLots') or len(blocked_lots)),
        'currentAlreadyLetteredLotsCoveredByDenylist': len(already_line_keys & blocked_line_keys),
        'denylistMissingCurrentLots': len(missing_current_line_keys),
        'denylistHistoricalSafeLots': len(historical_safe_line_keys),
        'blockedLotsAllSafeAlreadyLettered': 1 if all_blocked_lots_safe else 0,
        'lotZeroLiveReady': int(zero_counts.get('livePreflightReady') or 0),
        'lotZeroNoFreshCandidate': int(zero_counts.get('noFreshCandidate') or 0),
        'mutationAttempted': int(live_counts.get('mutationAttempted') or 0) + int(zero_counts.get('mutationAttempted') or 0),
        'nativeLetteringAttempted': 0,
        'validationIssues': 0,
        'verifiedEmptyCurrentQueue': 1 if verified_empty_current_queue(live, live_tests) else 0,
    }

    if counts['activeApprovalPathExists']:
        validation.append({'code': 'active_approval_path_exists', 'detail': str(ACTIVE_APPROVAL)})
    if counts['freshReady'] != 0:
        validation.append({'code': 'fresh_ready_lots_present', 'detail': counts['freshReady']})
    if (counts['eligibleForLivePreflight'] <= 0 and not counts['verifiedEmptyCurrentQueue']) or counts['eligibleForLivePreflight'] != counts['alreadyLettered']:
        validation.append({'code': 'eligible_lots_not_all_already_lettered', 'detail': counts})
    if missing_current_line_keys or counts['currentAlreadyLetteredLotsCoveredByDenylist'] != counts['alreadyLettered']:
        validation.append({'code': 'denylist_missing_current_already_lettered_lots', 'detail': {'counts': counts, 'missingSortedLineKeys': missing_current_line_keys}})
    if counts['mutationAttempted'] != 0:
        validation.append({'code': 'mutation_attempted_not_zero', 'detail': counts['mutationAttempted']})

    counts['validationIssues'] = len(validation)
    closure_ready = not validation
    payload = {
        'generatedAt': gen,
        'contractVersion': 'standard-v1-inqom-native-lettering-denylist-closure',
        'capabilityId': ORIGIN,
        'ok': closure_ready,
        'status': 'closed_no_action_required' if closure_ready else 'blocked',
        'summary': f"inqom_native_lettering_denylist_closure: closure_ready={closure_ready} eligible={counts['eligibleForLivePreflight']} already={counts['alreadyLettered']} fresh={counts['freshReady']} denylist={counts['denylistBlockedLots']} mutation_attempted={counts['mutationAttempted']} validation_issues={counts['validationIssues']}",
        'counts': counts,
        'closureReady': closure_ready,
        'blockingReasons': [issue['code'] for issue in validation],
        'mutationPolicy': {
            'inqomMutations': 'blocked',
            'nativeLettering': 'blocked',
            'denylistAuthorizesMutation': False,
            'denylistOnlyBlocksReplay': True,
            'externalSend': 'blocked',
        },
        'closedLots': [compact_lot(lot) for lot in blocked_lots],
        'validationIssues': validation,
        'inputReports': {
            'liveStateReconciler': str(LIVE_JSON),
            'liveStateReconcilerTests': str(LIVE_TESTS_JSON),
            'denylistJson': str(DENYLIST_JSON),
            'lotZeroLivePreflight': str(LOT_ZERO_LIVE_JSON),
        },
        'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD)},
        'updatedBy': ORIGIN,
    }
    write_json(OUT_JSON, payload)
    lines = [f'# Inqom native lettering denylist closure — {gen}', '', f"- Summary: {payload['summary']}", '- Mutation policy: **blocked**', '- Denylist role: anti-replay only, never approval.', '', '## Closed lots']
    for lot in payload['closedLots'][:30]:
        lines.append(f"- {lot.get('lotId')} — {lot.get('thirdPartyKey')} — lines {lot.get('sortedLineKey')} — letters {','.join(lot.get('matchedLetters') or [])}")
    if validation:
        lines += ['', '## Validation issues']
        for issue in validation:
            lines.append(f"- {issue.get('code')}: {issue.get('detail')}")
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': gen, 'ok': payload['ok'], 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons'], 'reportJson': str(OUT_JSON)}, ensure_ascii=False))
    if not closure_ready:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
