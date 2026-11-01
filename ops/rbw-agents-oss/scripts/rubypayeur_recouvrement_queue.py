from __future__ import annotations

import argparse
import json
from pathlib import Path

from pydantic import JsonValue, TypeAdapter

JsonObject = dict[str, JsonValue]
JSON_ADAPTER = TypeAdapter[JsonValue](JsonValue)
JSON_OBJECT_ADAPTER = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


from rubypayeur_recouvrement_client import (
    TEST_DEBTOR_SIREN,
    create_debt,
    rubypayeur_auth,
    safe_public_debt_summary,
    validate_debt,
)
from rubypayeur_recouvrement_sellsy import (
    build_debt_from_sellsy,
    create_sellsy_followup_task,
    scan_sellsy_candidates,
    sellsy_request,
)
from rubypayeur_recouvrement_support import (
    API_BASE,
    LEDGER,
    QUEUE,
    REPORT_JSON,
    REPORT_MD,
    SECRETS_ENV,
    SELLSY_BASE,
    append_jsonl,
    array_value,
    now_iso,
    object_value,
    read_jsonl,
    token_configured,
    write_json,
)


def request_id_for(row: dict[str, JsonValue]) -> str:
    return str(row.get('requestId') or row.get('id') or row.get('queueId') or f'line-{row.get('_lineNo')}')


def load_processed_ids() -> set[str]:
    done: set[str] = set()
    for row in read_jsonl(LEDGER):
        if row.get('requestId') and row.get('status') in {'created'}:
            done.add(str(row['requestId']))
    return done


def normalize_request(row: JsonObject) -> tuple[str, JsonObject, list[str], JsonObject | None]:
    request_id = request_id_for(row)
    sellsy_sync: JsonObject | None = None
    sellsy_value = row.get('sellsy')
    if isinstance(sellsy_value, dict) or row.get('sellsy_invoice_ids') or row.get('invoice_ids'):
        debt, sellsy_sync = build_debt_from_sellsy(row)
    else:
        debt_value = row.get('debt')
        if isinstance(debt_value, dict):
            debt = JSON_OBJECT_ADAPTER.validate_python(debt_value)
        else:
            debt = JSON_OBJECT_ADAPTER.validate_python({
                key: value for key, value in row.items()
                if key not in {'requestId', 'id', 'queueId', 'action', 'approvedForRubypayeur', '_lineNo', '_parseError'}
            })
    errors = validate_debt(debt)
    if sellsy_sync is not None:
        required_overrides = array_value(sellsy_sync.get('requiresDebtorOverride'))
        errors.extend(
            f'sellsy_missing_debtor_{field}_override_required'
            for field in required_overrides if str(field) not in debt
        )
    return request_id, debt, errors, sellsy_sync

def process_queue(rows: list[dict[str, JsonValue]], *, apply: bool, max_items: int) -> dict[str, JsonValue]:
    generated_at = now_iso()
    processed_ids = load_processed_ids()
    results: list[dict[str, JsonValue]] = []
    counts = {'observed': len(rows), 'created': 0, 'dryRunValidated': 0, 'skipped': 0, 'errors': 0, 'duplicates': 0}
    auth: dict[str, JsonValue] | None = None
    for row in rows[:max_items]:
        rid = request_id_for(row)
        if row.get('_parseError'):
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'error', 'error': 'json_parse_error', 'lineNo': row.get('_lineNo')})
            counts['errors'] += 1
            results.append(result)
            append_jsonl(LEDGER, {**result, 'generatedAt': generated_at})
            continue
        action = row.get('action', 'create_debt')
        if action != 'create_debt':
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'skipped', 'reason': f'unsupported_action:{action}'})
            counts['skipped'] += 1
            results.append(result)
            continue
        if rid in processed_ids:
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'duplicate_skipped'})
            counts['duplicates'] += 1
            results.append(result)
            continue
        approved = row.get('approvedForRubypayeur') is True
        if not approved:
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'skipped', 'reason': 'missing_approvedForRubypayeur_true'})
            counts['skipped'] += 1
            results.append(result)
            continue
        try:
            rid, debt, errors, sellsy_sync = normalize_request(row)
        except (RuntimeError, TypeError, ValueError) as exc:
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'error', 'error': f'sellsy_sync_failed:{exc}'})
            counts['errors'] += 1
            results.append(result)
            append_jsonl(LEDGER, {**result, 'generatedAt': generated_at})
            continue
        public_summary = safe_public_debt_summary(debt)
        if sellsy_sync:
            public_summary['sellsySync'] = sellsy_sync
        if errors:
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'error', 'error': 'validation_failed', 'errors': errors, 'debtSummary': public_summary})
            counts['errors'] += 1
            results.append(result)
            append_jsonl(LEDGER, {**result, 'generatedAt': generated_at})
            continue
        if not apply:
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'dry_run_validated', 'debtSummary': public_summary})
            counts['dryRunValidated'] += 1
            results.append(result)
            append_jsonl(LEDGER, {**result, 'generatedAt': generated_at})
            processed_ids.add(rid)
            continue
        try:
            if auth is None:
                auth = rubypayeur_auth()
            auth_token = auth.get('auth_token')
            if not isinstance(auth_token, str) or not auth_token:
                raise RuntimeError('rubypayeur_auth_token_missing')
            response = create_debt(debt, auth_token)
            rubypayeur_info = {'id': response.get('id'), 'ref': response.get('ref'), 'validation': response.get('validation'), 'customer': auth.get('customer')}
            sellsy_followup = create_sellsy_followup_task(sellsy_sync if 'sellsy_sync' in locals() else None, rubypayeur_info, rid)
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'created', 'rubypayeur': rubypayeur_info, 'sellsyFollowup': sellsy_followup, 'debtSummary': public_summary})
            counts['created'] += 1
            results.append(result)
            append_jsonl(LEDGER, {**result, 'generatedAt': generated_at})
            processed_ids.add(rid)
        except (OSError, RuntimeError, TypeError, ValueError) as exc:
            result = JSON_OBJECT_ADAPTER.validate_python({'requestId': rid, 'status': 'error', 'error': str(exc), 'debtSummary': public_summary})
            counts['errors'] += 1
            results.append(result)
            append_jsonl(LEDGER, {**result, 'generatedAt': generated_at})
    status = 'processed' if counts['created'] or counts['dryRunValidated'] else 'blocked' if counts['errors'] else 'idle'
    return JSON_OBJECT_ADAPTER.validate_python({'generatedAt': generated_at, 'contractVersion': 'rubypayeur-recouvrement-oss-v3-sellsy-autonomy', 'capabilityId': 'rubypayeur-recouvrement-queue', 'ok': counts['errors'] == 0, 'status': status, 'apply': apply, 'summary': f'rubypayeur queue: observed={counts['observed']} created={counts['created']} dry_run={counts['dryRunValidated']} skipped={counts['skipped']} duplicates={counts['duplicates']} errors={counts['errors']}', 'counts': counts, 'blockingReasons': ['rubypayeur_errors_present'] if counts['errors'] else [], 'artifacts': {'queue': str(QUEUE), 'ledger': str(LEDGER), 'reportJson': str(REPORT_JSON), 'reportMd': str(REPORT_MD), 'secretEnv': str(SECRETS_ENV)}, 'checks': {'tokenConfigured': token_configured(), 'apiBase': API_BASE, 'approvalRequired': True, 'dedupeLedgerEnabled': True, 'testDebtorSiren': TEST_DEBTOR_SIREN, 'sellsySyncEnabled': True, 'sellsyBase': SELLSY_BASE}, 'results': results, 'updatedBy': 'rubypayeur-recouvrement-queue'})


def write_markdown(payload: JsonObject) -> None:
    lines = [
        f"# Rubypayeur Recouvrement Queue — {payload.get('generatedAt')}",
        '', f"- Status: {payload.get('status')}", '',
        '| Request | Status | Ref | Error |', '|---|---|---|---|',
    ]
    for result_value in array_value(payload.get('results')):
        result = JSON_OBJECT_ADAPTER.validate_python(result_value)
        rubypayeur = object_value(result.get('rubypayeur'))
        cells = (
            str(result.get('requestId')), str(result.get('status')),
            str(rubypayeur.get('ref')), str(result.get('error')),
        )
        lines.append('| ' + ' | '.join(cells) + ' |')
    REPORT_MD.parent.mkdir(parents=True, exist_ok=True)
    _ = REPORT_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')

def command_auth_check() -> dict[str, JsonValue]:
    generated_at = now_iso()
    try:
        auth = rubypayeur_auth()
        payload = JSON_OBJECT_ADAPTER.validate_python({'generatedAt': generated_at, 'capabilityId': 'rubypayeur-recouvrement-queue', 'ok': True, 'status': 'auth_ok', 'summary': f'Rubypayeur Recouvrement auth OK for customer={auth.get('customer')}', 'checks': {'tokenConfigured': True, 'apiBase': API_BASE, 'customer': auth.get('customer')}, 'artifacts': {'secretEnv': str(SECRETS_ENV)}})
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        payload = JSON_OBJECT_ADAPTER.validate_python({'generatedAt': generated_at, 'capabilityId': 'rubypayeur-recouvrement-queue', 'ok': False, 'status': 'auth_failed', 'summary': 'Rubypayeur Recouvrement auth failed', 'blockingReasons': ['rubypayeur_auth_failed'], 'error': str(exc), 'checks': {'tokenConfigured': token_configured(), 'apiBase': API_BASE}, 'artifacts': {'secretEnv': str(SECRETS_ENV)}})
    return payload


class QueueArguments(argparse.Namespace):
    def __init__(self) -> None:
        super().__init__()
        self.mode: str = 'queue'
        self.queue: str = str(QUEUE)
        self.input_json: str | None = None
        self.max: int = 5
        self.apply: bool = False
        self.min_overdue_days: int = 30
        self.min_amount: float = 100.0


def main() -> None:
    parser = argparse.ArgumentParser(description='OSS Rubypayeur Recouvrement queue processor')
    _ = parser.add_argument('--mode', choices=['queue', 'auth', 'candidates'], default='queue')
    _ = parser.add_argument('--queue', default=str(QUEUE))
    _ = parser.add_argument('--input-json', help='Single request JSON file; bypasses queue file.')
    _ = parser.add_argument('--max', type=int, default=5)
    _ = parser.add_argument('--apply', action='store_true', help='Actually submit approved debts to Rubypayeur. With apply and candidate mode, credentials will be used.')
    _ = parser.add_argument('--min-overdue-days', type=int, default=30, help='Candidate scan: minimum days overdue.')
    _ = parser.add_argument('--min-amount', type=float, default=100.0, help='Candidate scan: minimum remaining amount.')
    args = parser.parse_args(namespace=QueueArguments())
    if args.mode == 'candidates':
        payload = scan_sellsy_candidates(
            max_items=max(1, args.max),
            min_overdue_days=max(0, args.min_overdue_days),
            min_amount=max(0.0, args.min_amount),
            write_draft_queue=not args.apply,
        )
        candidates = array_value(payload.get('candidates'))
        report_payload = JSON_OBJECT_ADAPTER.validate_python({
            key: value for key, value in payload.items() if key != 'candidates'
        } | {'candidateSample': candidates[:10]})
        write_json(REPORT_JSON, report_payload)
        print(json.dumps({
            'ok': payload.get('ok'), 'status': payload.get('status'),
            'summary': payload.get('summary'), 'candidateCount': payload.get('candidateCount'),
            'candidateSample': candidates[:10],
        }, ensure_ascii=False))
        if payload.get('ok') is not True:
            raise SystemExit(1)
        return
    if args.mode == 'auth':
        payload = command_auth_check()
        write_json(REPORT_JSON, payload)
        write_markdown(JSON_OBJECT_ADAPTER.validate_python({**payload, 'results': []}))
        print(json.dumps({
            'ok': payload.get('ok'), 'status': payload.get('status'), 'summary': payload.get('summary'),
        }, ensure_ascii=False))
        if payload.get('ok') is not True:
            raise SystemExit(1)
        return
    if args.input_json:
        raw = JSON_ADAPTER.validate_json(Path(args.input_json).read_bytes())
        if isinstance(raw, list):
            rows = [JSON_OBJECT_ADAPTER.validate_python(item) for item in raw]
        else:
            rows = [JSON_OBJECT_ADAPTER.validate_python(raw)]
    else:
        rows = read_jsonl(Path(args.queue))
    payload = process_queue(rows, apply=args.apply, max_items=max(1, args.max))
    write_json(REPORT_JSON, payload)
    write_markdown(payload)
    print(json.dumps({
        'ok': payload.get('ok'), 'status': payload.get('status'),
        'summary': payload.get('summary'), 'reportJson': str(REPORT_JSON),
        'reportMarkdown': str(REPORT_MD),
    }, ensure_ascii=False))
    if payload.get('ok') is not True:
        raise SystemExit(1)



__all__ = [
    "command_auth_check",
    "main",
    "process_queue",
    "safe_public_debt_summary",
    "sellsy_request",
]

if __name__ == "__main__":
    main()
