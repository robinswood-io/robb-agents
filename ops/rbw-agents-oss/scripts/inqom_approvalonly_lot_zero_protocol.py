#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
INQOM_SOURCE = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/sources/inqom')
REGISTRY = OPS / 'inqom-execution-readiness-registry.json'
LETTERING_EXEC_QUEUE = OPS / 'inqom-human-replicated-lettering-executable-queue.json'
REPLAY_DENYLIST = Path('/srv/rbw-agents-oss/config/finance-inqom-native-lettering-replay-denylist.json')
ACTIVE_APPROVAL = INQOM_SOURCE / 'mutation-approvals' / 'active-autonomous-approval.json'
OUT_JSON = OPS / 'inqom-approvalonly-lot-zero-protocol.json'
OUT_MD = OPS / 'inqom-approvalonly-lot-zero-protocol.md'
OUT_DRAFT = OPS / 'inqom-approvalonly-lot-zero-approval-draft.json'
OUT_PREFLIGHT = OPS / 'inqom-approvalonly-lot-zero-preflight-required.json'
LIVE_PREFLIGHT_DENYLIST = OPS / 'inqom-approvalonly-lot-zero-preflight-denylist.json'
NATIVE_LIVE_PREFLIGHT_DENYLIST = OPS / 'inqom-native-lettering-live-preflight-denylist.json'
LEDGER = OPS / 'inqom-approvalonly-lot-zero-ledger.jsonl'
ORIGIN = 'inqom-approvalonly-lot-zero-protocol'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except Exception:
        return None


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def append_ledger(row: dict[str, Any]) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n')


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str, separators=(',', ':')).encode('utf-8')).hexdigest()


def money(value: Any) -> float:
    try:
        return round(float(value or 0), 2)
    except Exception:
        return 0.0


def sorted_line_key(line_ids: list[int]) -> str:
    return '|'.join(str(x) for x in sorted(int(v) for v in line_ids))


def live_preflight_blockers() -> tuple[set[int], set[str], list[dict[str, Any]]]:
    line_ids: set[int] = set()
    line_keys: set[str] = set()
    lots: list[dict[str, Any]] = []
    for deny_path in [LIVE_PREFLIGHT_DENYLIST, NATIVE_LIVE_PREFLIGHT_DENYLIST]:
        deny = read_json(deny_path, {})
        if isinstance(deny, dict):
            for lot in deny.get('blockedLots') or []:
                if not isinstance(lot, dict):
                    continue
                if lot.get('status') != 'blocked_by_live_preflight':
                    continue
                ids: list[int] = []
                for value in lot.get('lineIds') or []:
                    try:
                        ids.append(int(value))
                    except Exception:
                        pass
                if ids:
                    enriched = {**lot, 'denylistPath': str(deny_path)}
                    line_ids.update(ids)
                    line_keys.add(str(lot.get('sortedLineKey') or sorted_line_key(ids)))
                    lots.append(enriched)
    return line_ids, line_keys, lots


def executed_line_ids() -> set[int]:
    replay = read_json(REPLAY_DENYLIST, {})
    ids: set[int] = set()
    if isinstance(replay, dict):
        for value in replay.get('executedLineIds') or []:
            try:
                ids.add(int(value))
            except Exception:
                pass
        for lot in replay.get('executedNativeLetterings') or []:
            if isinstance(lot, dict):
                for value in lot.get('lineIds') or []:
                    try:
                        ids.add(int(value))
                    except Exception:
                        pass
    if LEDGER.exists():
        for line in LEDGER.read_text(encoding='utf-8', errors='ignore').splitlines():
            try:
                row = json.loads(line)
            except Exception:
                continue
            if row.get('status') == 'executed':
                for value in row.get('lineIds') or []:
                    try:
                        ids.add(int(value))
                    except Exception:
                        pass
    return ids


def find_lettering_candidate() -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any]]:
    queue = read_json(LETTERING_EXEC_QUEUE, [])
    blocked_line_ids, blocked_keys, blocked_lots = live_preflight_blockers()
    stats = {
        'queueIsList': isinstance(queue, list),
        'scannedSamples': 0,
        'eligibleSamples': 0,
        'skippedByLivePreflightDenylist': 0,
        'livePreflightBlockedLineIds': sorted(blocked_line_ids),
        'livePreflightBlockedLotCount': len(blocked_lots),
    }
    if not isinstance(queue, list):
        return None, None, stats
    best_action: dict[str, Any] | None = None
    best_candidate: dict[str, Any] | None = None
    best_score = -1.0
    for action in queue:
        if not isinstance(action, dict):
            continue
        data = action.get('data') if isinstance(action.get('data'), dict) else {}
        for third in data.get('byThirdParty') or []:
            if not isinstance(third, dict):
                continue
            for sample in third.get('sample') or []:
                if not isinstance(sample, dict):
                    continue
                pos = sample.get('positive') if isinstance(sample.get('positive'), dict) else {}
                neg = sample.get('negative') if isinstance(sample.get('negative'), dict) else {}
                try:
                    pos_line = int(pos.get('lineId'))
                    neg_line = int(neg.get('lineId'))
                except Exception:
                    continue
                stats['scannedSamples'] += 1
                amount_sum = money(pos.get('amount')) + money(neg.get('amount'))
                line_key = sorted_line_key([pos_line, neg_line])
                if line_key in blocked_keys or pos_line in blocked_line_ids or neg_line in blocked_line_ids:
                    stats['skippedByLivePreflightDenylist'] += 1
                    continue
                confidence = float(sample.get('confidenceScore') or 0)
                threshold = float(sample.get('confidenceThreshold') or 0.9)
                sample_mutation_flag = sample.get('mutationAllowed')
                mutation_allowed = sample_mutation_flag is True or (sample_mutation_flag is None and action.get('actionType') == 'execute_high_confidence_native_lettering')
                if mutation_allowed and abs(amount_sum) <= 0.01 and confidence >= threshold:
                    stats['eligibleSamples'] += 1
                    score = confidence + (0.01 if data.get('kind') == 'client' else 0)
                    if score > best_score:
                        best_score = score
                        best_action = action
                        best_candidate = sample
    return best_action, best_candidate, stats


def line_expectation(line: dict[str, Any], side: str) -> dict[str, Any]:
    return {
        'side': side,
        'entryId': int(line.get('entryId')),
        'lineId': int(line.get('lineId')),
        'account': str(line.get('account')),
        'expectedAmount': money(line.get('amount')),
        'expectedDocRef': line.get('docRef'),
        'expectedRevisionState': line.get('revision'),
        'expectedSourceType': line.get('sourceType') or line.get('source'),
        'expectedLabelContains': str(line.get('label') or '')[:120],
    }


def build_lot(action: dict[str, Any], candidate: dict[str, Any], generated_at: str) -> dict[str, Any]:
    pos = candidate.get('positive') if isinstance(candidate.get('positive'), dict) else {}
    neg = candidate.get('negative') if isinstance(candidate.get('negative'), dict) else {}
    lines = [line_expectation(pos, 'positive'), line_expectation(neg, 'negative')]
    line_ids = [line['lineId'] for line in lines]
    amount_sum = money(sum(line['expectedAmount'] for line in lines))
    source = {
        'sourceActionId': action.get('id'),
        'sourceDedupeKey': action.get('dedupeKey'),
        'sourceTarget': action.get('target'),
        'candidateType': candidate.get('type'),
        'thirdPartyKey': candidate.get('thirdPartyKey'),
        'sharedReferenceToken': candidate.get('sharedReferenceToken'),
        'confidenceScore': candidate.get('confidenceScore'),
        'confidenceRuleId': candidate.get('confidenceRuleId'),
    }
    base = {
        'lotId': 'lot-zero:native-lettering:' + digest({'lineIds': line_ids, 'source': source})[:16],
        'expectedFolderId': 18627,
        'mutationType': 'native_lettering',
        'lineIds': line_ids,
        'entryIds': [line['entryId'] for line in lines],
        'expectedLineCount': len(lines),
        'expectedAmountSum': amount_sum,
        'letterType': 'PublicApi',
        'reviseEntryLines': False,
        'requireUnmatched': True,
        'confidenceScore': float(candidate.get('confidenceScore') or 0),
        'confidenceThreshold': float(candidate.get('confidenceThreshold') or 0.9),
        'lineExpectations': lines,
        'source': source,
        'approvalOnly': {
            'required': True,
            'activeApprovalPath': str(ACTIVE_APPROVAL),
            'activeApprovalWrittenByThisWrapper': False,
            'approvalDraftPath': str(OUT_DRAFT),
            'expiresWithinMinutes': 120,
            'requiresExactLineHash': True,
            'requiresLiveNativePreflight': True,
            'requiresPostMutationReadback': True,
        },
        'preflightTool': {
            'tool': 'inqom_get_native_lettering_preflight',
            'readOnly': True,
            'requiredBeforeActivation': True,
            'arguments': {
                'folderId': 18627,
                'lineIds': line_ids,
                'expectedLineCount': len(lines),
                'expectedAmountSum': 0,
                'letterType': 'PublicApi',
                'requireUnmatched': True,
                'allowDifferentSubAccount': False,
            },
        },
        'guardrails': {
            'stopIfAlreadyLettered': True,
            'stopIfLineMissing': True,
            'stopIfAmountMismatch': True,
            'stopIfAccountMismatch': True,
            'stopIfLineHashMismatch': True,
            'neverDeletter': True,
            'neverTaxFile': True,
            'neverExternalSend': True,
        },
        'generatedAt': generated_at,
    }
    base['lineHash'] = digest({'expectedFolderId': 18627, 'lineExpectations': lines, 'expectedAmountSum': amount_sum, 'letterType': 'PublicApi'})
    return base


def active_approval_matches(active: Any, lot: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if not isinstance(active, dict):
        return False, ['active_approval_missing']
    expires = parse_iso(active.get('expiresAt'))
    if not expires or expires <= datetime.now(timezone.utc):
        reasons.append('active_approval_expired_or_missing_expiry')
    if active.get('allowLettrage') is not True and active.get('allowNativeLettering') is not True:
        reasons.append('active_approval_does_not_allow_native_lettering')
    approved = active.get('approvedNativeLetterings') if isinstance(active.get('approvedNativeLetterings'), list) else []
    found = False
    for item in approved:
        if not isinstance(item, dict):
            continue
        if item.get('lotId') == lot.get('lotId') and [int(x) for x in item.get('lineIds') or []] == lot.get('lineIds') and int(item.get('expectedFolderId') or 0) == 18627:
            found = True
            if item.get('lineHash') and item.get('lineHash') != lot.get('lineHash'):
                reasons.append('active_approval_line_hash_mismatch')
            break
    if not found:
        reasons.append('active_approval_lot_not_exactly_listed')
    return not reasons, reasons


def main() -> None:
    generated_at = now_iso()
    registry = read_json(REGISTRY, {})
    validation_issues: list[str] = []
    if not REGISTRY.exists():
        validation_issues.append('missing_execution_readiness_registry')
    if registry.get('ok') is not True:
        validation_issues.append('execution_readiness_registry_not_ok')
    action, candidate, selection_stats = find_lettering_candidate()
    no_fresh_candidate_after_live_denylist = False
    if not action or not candidate:
        if int(selection_stats.get('skippedByLivePreflightDenylist') or 0) > 0:
            no_fresh_candidate_after_live_denylist = True
        else:
            validation_issues.append('no_native_lettering_lot_zero_candidate')
        lot = None
    else:
        lot = build_lot(action, candidate, generated_at)
    replay_ids = executed_line_ids()
    replay_conflicts = sorted(set(lot.get('lineIds', [])) & replay_ids) if lot else []
    if replay_conflicts:
        validation_issues.append('lot_zero_line_ids_in_replay_denylist:' + ','.join(str(x) for x in replay_conflicts))
    if lot and abs(float(lot.get('expectedAmountSum') or 0)) > 0.01:
        validation_issues.append('lot_zero_amount_sum_not_zero')
    if lot and lot.get('expectedLineCount') != 2:
        validation_issues.append('lot_zero_expected_two_lines')
    active_present = ACTIVE_APPROVAL.exists()
    active_payload = read_json(ACTIVE_APPROVAL, {}) if active_present else None
    active_matches, active_reasons = active_approval_matches(active_payload, lot or {})
    # Lot zéro intentionally refuses execution even if env vars are set; it is a guard-proving wrapper.
    execute_requested = os.environ.get('INQOM_APPROVALONLY_LOT_ZERO_EXECUTE') in {'1', 'true', 'yes'}
    expected_guardrails = ['lot_zero_deliberately_blocks_mutation', 'explicit_active_approval_required', 'live_preflight_denylist_applied']
    if not active_present:
        expected_guardrails.append('active_approval_absent')
    elif not active_matches:
        expected_guardrails.extend(active_reasons)
    expires = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat().replace('+00:00', 'Z')
    draft = None
    preflight = None
    if lot:
        draft = {
            'schemaVersion': 'inqom-approvalonly-lot-zero-draft-v1',
            'generatedAt': generated_at,
            'expiresAt': expires,
            'draftOnly': True,
            'notActiveApprovalFile': True,
            'mustNotBeTreatedAsAuthorization': True,
            'activeApprovalPathIfSeparatelyApproved': str(ACTIVE_APPROVAL),
            'allowLettrage': True,
            'allowNativeLettering': True,
            'allowCreateAccountingEntry': False,
            'allowUpdate': False,
            'allowDelete': False,
            'allowTaxSubmission': False,
            'allowExternalSend': False,
            'approvedNativeLetterings': [
                {
                    'lotId': lot['lotId'],
                    'expectedFolderId': lot['expectedFolderId'],
                    'lineIds': lot['lineIds'],
                    'expectedLineCount': lot['expectedLineCount'],
                    'expectedAmountSum': 0,
                    'letterType': lot['letterType'],
                    'reviseEntryLines': lot['reviseEntryLines'],
                    'requireUnmatched': lot['requireUnmatched'],
                    'lineHash': lot['lineHash'],
                }
            ],
        }
        preflight = {
            'schemaVersion': 'inqom-approvalonly-preflight-required-v1',
            'generatedAt': generated_at,
            'status': 'not_run_by_lot_zero_guard_wrapper',
            'requiredBeforeAnyFutureActiveApproval': True,
            'readOnlyTool': lot['preflightTool'],
            'expectedReadOnlyResult': {
                'ready': True,
                'balanced': True,
                'lineCount': lot['expectedLineCount'],
                'amountSum': 0,
                'unmatched': True,
                'noReplayConflict': True,
            },
            'lot': lot,
        }
        write_json(OUT_DRAFT, draft)
        write_json(OUT_PREFLIGHT, preflight)
    elif no_fresh_candidate_after_live_denylist:
        draft = {
            'schemaVersion': 'inqom-approvalonly-lot-zero-draft-v1',
            'generatedAt': generated_at,
            'draftOnly': True,
            'notActiveApprovalFile': True,
            'mustNotBeTreatedAsAuthorization': True,
            'status': 'no_fresh_lot_zero_candidate_after_live_preflight_denylist',
            'stalePreviousDraftInvalidated': True,
            'activeApprovalPathIfSeparatelyApproved': str(ACTIVE_APPROVAL),
            'allowLettrage': False,
            'allowNativeLettering': False,
            'allowCreateAccountingEntry': False,
            'allowUpdate': False,
            'allowDelete': False,
            'allowTaxSubmission': False,
            'allowExternalSend': False,
            'approvedNativeLetterings': [],
        }
        preflight = {
            'schemaVersion': 'inqom-approvalonly-preflight-required-v1',
            'generatedAt': generated_at,
            'status': 'not_required_no_fresh_lot_zero_candidate_after_live_preflight_denylist',
            'requiredBeforeAnyFutureActiveApproval': True,
            'reason': 'all_current_lot_zero_candidates_blocked_by_live_preflight_denylist',
            'readOnlyTool': None,
            'expectedReadOnlyResult': None,
            'selectionStats': selection_stats,
            'lot': None,
        }
        write_json(OUT_DRAFT, draft)
        write_json(OUT_PREFLIGHT, preflight)
    status = 'ready_but_guarded_no_active_approval'
    if active_present and active_matches:
        status = 'ready_but_lot_zero_deliberately_blocks_even_with_matching_approval'
    if no_fresh_candidate_after_live_denylist:
        status = 'no_fresh_candidate_after_live_preflight_denylist_guarded'
    if validation_issues:
        status = 'blocked_invalid_lot_zero_input'
    ledger_row = {
        'generatedAt': generated_at,
        'originAutomation': ORIGIN,
        'status': 'denied_expected_no_mutation',
        'executeRequested': execute_requested,
        'mutationAttempted': False,
        'activeApprovalPresent': active_present,
        'activeApprovalMatchesLot': active_matches,
        'expectedGuardrails': expected_guardrails,
        'lotId': lot.get('lotId') if lot else None,
        'lineIds': lot.get('lineIds') if lot else [],
        'lineHash': lot.get('lineHash') if lot else None,
        'validationIssues': validation_issues,
        'selectionStats': selection_stats,
    }
    append_ledger(ledger_row)
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'standard-v1-inqom-approvalonly-lot-zero-protocol',
        'capabilityId': 'inqom-approvalonly-lot-zero-protocol',
        'ok': not validation_issues,
        'status': status,
        'summary': f"inqom_approvalonly_lot_zero_protocol: candidate={'yes' if lot else 'no'} line_count={(lot or {}).get('expectedLineCount',0)} active_approval_present={active_present} active_matches={active_matches} execute_requested={execute_requested} mutation_attempted=false active_approval_written=false skipped_live_denylist={selection_stats.get('skippedByLivePreflightDenylist')} validation_issues={len(validation_issues)}",
        'counts': {
            'candidate': 1 if lot else 0,
            'lineCount': (lot or {}).get('expectedLineCount', 0),
            'entryCount': len((lot or {}).get('entryIds') or []),
            'activeApprovalPresent': 1 if active_present else 0,
            'activeApprovalMatchesLot': 1 if active_matches else 0,
            'mutationAttempted': 0,
            'activeApprovalWritten': 0,
            'validationIssues': len(validation_issues),
            'expectedGuardrails': len(expected_guardrails),
            'skippedByLivePreflightDenylist': selection_stats.get('skippedByLivePreflightDenylist'),
            'livePreflightBlockedLotCount': selection_stats.get('livePreflightBlockedLotCount'),
        },
        'blockingReasons': validation_issues,
        'expectedGuardrails': expected_guardrails,
        'lotZero': lot,
        'approvalDraft': draft,
        'preflightRequired': preflight,
        'selectionStats': selection_stats,
        'executionDecision': {
            'executeRequested': execute_requested,
            'wouldExecuteIfSeparateProtocolApproved': False,
            'mutationAttempted': False,
            'denialReason': 'lot_zero_guard_wrapper_never_executes_mutation',
            'nextSafeStep': 'run_live_readonly_preflight_and_create_active_approval_only_after_separate_explicit_authorization',
        },
        'guardrails': {
            'noInqomMutation': True,
            'noNativeLetteringExecuted': True,
            'noNativeRevisionMarking': True,
            'noTaxFiling': True,
            'noTaxPayment': True,
            'noExternalSend': True,
            'activeApprovalNotWritten': True,
            'ledgerAppended': True,
            'antiReplayChecked': True,
            'livePreflightDenylistApplied': True,
            'livePreflightRequiredBeforeFutureExecution': True,
            'postMutationReadbackRequiredBeforeClaimingExecuted': True,
        },
        'artifacts': {
            'registry': str(REGISTRY),
            'letteringExecutableQueue': str(LETTERING_EXEC_QUEUE),
            'replayDenylist': str(REPLAY_DENYLIST),
            'activeApprovalPath': str(ACTIVE_APPROVAL),
            'approvalDraftJson': str(OUT_DRAFT),
            'preflightRequiredJson': str(OUT_PREFLIGHT),
            'livePreflightDenylist': str(LIVE_PREFLIGHT_DENYLIST),
            'nativeLivePreflightDenylist': str(NATIVE_LIVE_PREFLIGHT_DENYLIST),
            'ledgerJsonl': str(LEDGER),
            'reportJson': str(OUT_JSON),
            'reportMd': str(OUT_MD),
        },
        'updatedBy': ORIGIN,
    }
    write_json(OUT_JSON, payload)
    lines = [
        f"# ApprovalOnly Inqom — lot zéro — {generated_at}",
        '',
        f"- Résumé : {payload['summary']}",
        f"- Statut : **{status}**",
        f"- Mutation tentée : **non**",
        f"- Fichier actif écrit : **non**",
        f"- Brouillon d’approbation : `{OUT_DRAFT}`",
        f"- Préflight requis : `{OUT_PREFLIGHT}`",
        '',
        '## Lot zéro',
    ]
    if lot:
        lines += [
            f"- Lot : `{lot['lotId']}`",
            f"- Lignes : {lot['lineIds']}",
            f"- Somme attendue : {lot['expectedAmountSum']:.2f}",
            f"- Hash lignes : `{lot['lineHash']}`",
            f"- Confiance : {lot['confidenceScore']:.2f}",
        ]
    lines += ['', '## Garde-fous attendus']
    for reason in expected_guardrails:
        lines.append(f"- {reason}")
    OUT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'status': status, 'blockingReasons': validation_issues, 'expectedGuardrails': expected_guardrails}, ensure_ascii=False))
    if validation_issues:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
