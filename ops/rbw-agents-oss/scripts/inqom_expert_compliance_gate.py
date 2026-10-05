#!/usr/bin/env python3
"""Validate expert findings without confusing documented suspense work with test failure."""
from __future__ import annotations
import calendar
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

MANDATORY = (
    'PCG-5802-ZERO-BALANCE', 'PCG-5800-ZERO-BALANCE', 'PCG-451-GROUP-INTEGRITY',
    'PCG-473-SUSPENSE-CLEARING', 'PCG-42-43-PAYROLL-NOMENCLATURE',
    'PCG-421-EMPLOYEE-SEGREGATION', 'PCG-411-MISPLACED-SUPPLIERS',
    'PCG-TYPO-ACCOUNT-INTEGRITY', 'PCG-6-NO-NET-CREDIT-EXPENSE',
    'PCG-4111-GOCARDLESS-CLEARING', 'PCG-NUMERIC-ACCOUNT-8DIGITS',
    'PCG-DUPLICATE-AUXILIARY-CLEARING', 'CASH-FLOW-STRICT-PHYSICAL-SEPARATION',
    'GOCARDLESS-CLEARING-ZERO-DRIFT', 'TAX-AND-VAT-CASH-BASIS-DOCTRINE',
)
SUSPENSE = 'PCG-473-SUSPENSE-CLEARING'
BLOCKED_EFFECTS = {'inqom_mutation', 'native_reconciliation', 'native_lettering',
                  'entry_creation', 'entry_update', 'entry_delete', 'external_delivery', 'sellsy_mutation'}
ALLOWED_EFFECTS = {'writes_reports', 'writes_action_queue', 'prepare_expert_pack'}

def money(value: Any) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError('non_finite_amount')
    return result.quantize(Decimal('0.01'))

def fresh(value: Any, now: datetime, seconds: int = 3600) -> bool:
    try:
        stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return 0 <= (now - stamp).total_seconds() <= seconds
    except (ValueError, TypeError):
        return False

def validate_report(report: dict, snapshot: dict, queue: list, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    issues: list[str] = []
    pending: list[dict] = []
    checks = report.get('checks')
    if not isinstance(checks, list):
        return {'ok': False, 'issues': ['missing_native_checks'], 'pending': []}
    ids = [c.get('ruleId') for c in checks if isinstance(c, dict)]
    if len(ids) != len(checks) or len(ids) != len(set(ids)) or set(ids) != set(MANDATORY):
        issues.append('mandatory_native_checks_missing_or_duplicate')
    if not fresh(report.get('timestamp'), now):
        issues.append('stale_native_guardian')
    failed = [c for c in checks if c.get('status') == 'FAIL']
    if report.get('overallStatus') != ('FAIL' if failed else 'PASS'):
        issues.append('inconsistent_overall_status')
    for check in checks:
        if check.get('status') not in {'PASS', 'FAIL', 'WARNING'}:
            issues.append('invalid_check_status')
        if check.get('ruleId') != SUSPENSE and check.get('status') != 'PASS':
            issues.append('unresolved_strict_rule:' + str(check.get('ruleId')))
    suspense = next((c for c in checks if c.get('ruleId') == SUSPENSE), {})
    balances = suspense.get('openBalances')
    if not isinstance(balances, dict) or suspense.get('openAccountsCount') != len(balances):
        issues.append('invalid_suspense_balances')
        balances = {}
    if suspense.get('status') != ('FAIL' if balances else 'PASS'):
        issues.append('inconsistent_suspense_status')
    if not balances:
        return {'ok': not issues, 'issues': issues, 'pending': pending}
    if snapshot.get('ok') is not True or not fresh(snapshot.get('generatedAt'), now):
        issues.append('native_snapshot_not_fresh_complete')
    folder = report.get('folderId')
    coverage = [c for c in snapshot.get('coverage', []) if c.get('folderId') == folder]
    expected_months = set(range(1, now.month + 1))
    try:
        for c in coverage:
            start = c['period']['startDate']
            month = int(start[5:7])
            expected_start = f'{now.year}-{month:02}-01'
            expected_end = now.date().isoformat() if month == now.month else f'{now.year}-{month:02}-{calendar.monthrange(now.year, month)[1]:02}'
            if start != expected_start or c['period']['endDate'] != expected_end or c.get('complete') is not True:
                issues.append('incomplete_native_period_coverage')
        actual_months = {int(c['period']['startDate'][5:7]) for c in coverage
                         if c.get('complete') is True and c['period']['startDate'].startswith(str(now.year))}
        end = max(c['period']['endDate'] for c in coverage)
        if actual_months != expected_months or end != now.date().isoformat():
            issues.append('incomplete_native_period_coverage')
    except (KeyError, ValueError):
        issues.append('incomplete_native_period_coverage')
    native = [x for x in snapshot.get('lines', []) if x.get('folderId') == folder]
    native_ids = [x.get('lineId') for x in native]
    if sum(c.get('lines', -1) for c in coverage) != len(native):
        issues.append('native_coverage_line_count_mismatch')
    if None in native_ids or len(native_ids) != len(set(native_ids)):
        issues.append('duplicate_native_line_ids')
    if not isinstance(queue, list):
        issues.append('invalid_guidance_queue')
        queue = []
    for account, balance in balances.items():
        lines = [x for x in native if x.get('account') == account]
        opened = [x for x in lines if not x.get('matchedId') and not x.get('matchedLetter')]
        if not account.startswith('473') or not opened:
            issues.append('missing_open_suspense_lines:' + account)
            continue
        try:
            actual_balance = -sum((money(x['amount']) for x in lines), Decimal('0'))
            if actual_balance != money(balance) or money(balance) == 0:
                issues.append('native_balance_drift:' + account)
        except (ValueError, ArithmeticError, KeyError):
            issues.append('invalid_native_amount:' + account)
        routes = [a for a in queue if isinstance(a, dict) and
                  (a.get('data') or {}).get('folderId') == folder and
                  (a.get('data') or {}).get('account') == account]
        routed = []
        for action in routes:
            data = action.get('data') or {}
            if (action.get('owner') != 'agent' or action.get('actionType') != 'prepare_operator_guided_accounting_case'
                    or action.get('actionableNow') is not True or not action.get('target') or not action.get('dedupeKey')
                    or not action.get('doneCondition') or data.get('mutationAllowed') is not False
                    or data.get('externalSendAllowed') is not False
                    or not BLOCKED_EFFECTS.issubset(set(data.get('blockedEffects') or []))
                    or not set(data.get('allowedEffects') or []).issubset(ALLOWED_EFFECTS)):
                issues.append('unsafe_or_incomplete_suspense_route:' + account)
            routed.extend(data.get('canonicalLines') or [])
        if Counter(x.get('lineId') for x in routed) != Counter(x['lineId'] for x in opened):
            issues.append('suspense_route_missing_or_duplicate:' + account)
        originals = {x['lineId']: x for x in opened}
        for line in routed:
            original = originals.get(line.get('lineId'))
            if original is None or any(line.get(k) != original.get(k) for k in
                                       ('folderId', 'entryId', 'account', 'accountId', 'subAccountId', 'amount')):
                issues.append('suspense_route_native_drift:' + account)
        pending.append({'folderId': folder, 'account': account, 'balance': balance,
                        'lineIds': [x['lineId'] for x in opened],
                        'actionIds': [a.get('id') for a in routes], 'status': 'pending_document_research'})
    return {'ok': not issues, 'issues': sorted(set(issues)), 'pending': pending,
            'businessCompletionStatus': 'blocked_incomplete_work' if pending else 'complete_verified'}
