#!/usr/bin/env python3
"""Regression checks plus current native findings/queue contract; pending findings stay pending."""
from __future__ import annotations
import calendar
import argparse
import copy
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from inqom_expert_compliance_gate import MANDATORY, SUSPENSE, BLOCKED_EFFECTS, validate_report

NOW = datetime(2026, 10, 5, 8, 30, tzinfo=timezone.utc)
STAMP = NOW.isoformat()

def fixture():
    account = '4731SUPPLIER'
    line = {'folderId': 18627, 'entryId': 10, 'lineId': 20, 'account': account,
            'accountId': 473, 'subAccountId': 42, 'amount': -125,
            'matchedId': None, 'matchedLetter': None}
    checks = [{'ruleId': rule, 'status': 'PASS'} for rule in MANDATORY]
    suspense = next(c for c in checks if c['ruleId'] == SUSPENSE)
    suspense.update(status='FAIL', openBalances={account: 125}, openAccountsCount=1)
    report = {'timestamp': STAMP, 'folderId': 18627, 'overallStatus': 'FAIL', 'checks': checks}
    coverage = [{'folderId': 18627, 'complete': True, 'lines': int(month == 10),
                 'period': {'startDate': f'2026-{month:02}-01',
                            'endDate': '2026-10-05' if month == 10 else f'2026-{month:02}-{calendar.monthrange(2026, month)[1]:02}'}}
                for month in range(1, 11)]
    snapshot = {'generatedAt': STAMP, 'ok': True, 'coverage': coverage, 'lines': [line]}
    action = {'id': 'a', 'owner': 'agent', 'actionType': 'prepare_operator_guided_accounting_case',
              'actionableNow': True, 'target': 'inqom:18627:case', 'dedupeKey': 'case',
              'doneCondition': 'native evidence checked', 'data': {
                  'folderId': 18627, 'account': account, 'canonicalLines': [copy.deepcopy(line)],
                  'mutationAllowed': False, 'externalSendAllowed': False,
                  'blockedEffects': sorted(BLOCKED_EFFECTS), 'allowedEffects': ['writes_reports']}}
    return report, snapshot, [action]

class ComplianceGateTests(unittest.TestCase):
    def check(self, edit, issue):
        report, snapshot, queue = fixture()
        edit(report, snapshot, queue)
        result = validate_report(report, snapshot, queue, NOW)
        self.assertFalse(result['ok'])
        self.assertTrue(any(issue in x for x in result['issues']), result)
    def test_documented_suspense_continues_but_remains_incomplete(self):
        report, snapshot, queue = fixture()
        result = validate_report(report, snapshot, queue, NOW)
        self.assertTrue(result['ok'], result)
        self.assertEqual(report['overallStatus'], 'FAIL')
        self.assertEqual(result['businessCompletionStatus'], 'blocked_incomplete_work')
        self.assertEqual(result['pending'][0]['lineIds'], [20])
    def test_strict_cash_rule_still_blocks(self):
        self.check(lambda r,s,q: r['checks'][0].update(status='FAIL'), 'unresolved_strict_rule')
    def test_warning_remains_blocking(self):
        self.check(lambda r,s,q: r['checks'][0].update(status='WARNING'), 'unresolved_strict_rule')
    def test_missing_native_control_blocks(self):
        self.check(lambda r,s,q: r['checks'].pop(), 'mandatory_native_checks')
    def test_overwritten_envelope_blocks(self):
        self.check(lambda r,s,q: r.update(checks={}), 'missing_native_checks')
    def test_stale_snapshot_blocks(self):
        self.check(lambda r,s,q: s.update(generatedAt='2026-10-04T08:30:00Z'), 'native_snapshot_not_fresh')
    def test_missing_month_blocks(self):
        self.check(lambda r,s,q: s['coverage'].pop(0), 'incomplete_native_period')
    def test_truncated_month_blocks(self):
        self.check(lambda r,s,q: s['coverage'][0]['period'].update(endDate='2026-01-28'), 'incomplete_native_period')
    def test_uncovered_native_line_blocks(self):
        self.check(lambda r,s,q: q.clear(), 'suspense_route_missing')
    def test_duplicate_route_blocks(self):
        self.check(lambda r,s,q: q.append(copy.deepcopy(q[0])), 'suspense_route_missing_or_duplicate')
    def test_mutation_permission_blocks(self):
        self.check(lambda r,s,q: q[0]['data'].update(mutationAllowed=True), 'unsafe_or_incomplete')
    def test_external_delivery_blocks(self):
        self.check(lambda r,s,q: q[0]['data'].update(externalSendAllowed=True), 'unsafe_or_incomplete')
    def test_native_balance_drift_blocks(self):
        self.check(lambda r,s,q: s['lines'][0].update(amount=-126), 'native_balance_drift')
    def test_already_lettered_line_blocks(self):
        self.check(lambda r,s,q: s['lines'][0].update(matchedId=44), 'missing_open_suspense')
    def test_route_native_drift_blocks(self):
        self.check(lambda r,s,q: q[0]['data']['canonicalLines'][0].update(entryId=11), 'suspense_route_native_drift')
    def test_inconsistent_status_blocks(self):
        self.check(lambda r,s,q: r.update(overallStatus='PASS'), 'inconsistent_overall_status')

def main():
    args = argparse.ArgumentParser()
    args.add_argument('--unit-only', action='store_true')
    options = args.parse_args()
    result = unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(ComplianceGateTests))
    if not result.wasSuccessful():
        return 1
    if options.unit_only:
        return 0
    # One native read, preserving its original checks before report-envelope writers run.
    from inqom_accounting_expert_rules_guardian import run_guardian
    workspace = Path(os.environ.get('RBW_OSS_WORKSPACE', os.environ.get('CRAFT_WORKSPACE_DIR',
                         '/home/craft/.craft-agent/workspaces/my-workspace-2')))
    ops = workspace / 'campaigns' / 'ops'
    native = run_guardian()
    snapshot = json.loads((ops / 'inqom-operator-guidance-native-snapshot.json').read_text())
    queue = json.loads((ops / 'inqom-operator-guidance-action-queue.json').read_text())
    contract = validate_report(native, snapshot, queue)
    report = {'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
              'ok': contract['ok'], 'status': 'pending_document_research' if contract['pending'] else 'checked',
              'summary': f"expert_compliance_contract: tests={result.testsRun} pending={len(contract['pending'])} issues={len(contract['issues'])}",
              'counts': {'tests': result.testsRun, 'pendingAccounts': len(contract['pending']), 'failed': len(contract['issues'])},
              'blockingReasons': contract['issues'], 'nativeFindings': native,
              'pending': contract['pending'], 'stateSemantics': {
                  'businessCompletionStatus': contract.get('businessCompletionStatus', 'blocked_incomplete_work')},
              'checks': {'nativeControlsRetained': True, 'pendingRoutesValidated': contract['ok'],
                         'mutationsExecuted': False}}
    (ops / 'inqom-expert-compliance-contract-tests.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ['ok', 'status', 'summary', 'counts', 'blockingReasons']}, ensure_ascii=False))
    return 0 if contract['ok'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
