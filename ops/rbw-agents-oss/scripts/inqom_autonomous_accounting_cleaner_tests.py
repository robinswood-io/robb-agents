#!/usr/bin/env python3
"""Verify the existing cleaner result; regression tests never replay its mutations."""
from __future__ import annotations
import argparse
import copy
import json
import os
import unittest
from datetime import datetime, timezone
from pathlib import Path
from inqom_expert_compliance_gate import MANDATORY, SUSPENSE, fresh

def validate_cleaner(report, contract, now=None):
    now = now or datetime.now(timezone.utc)
    issues = []
    if not fresh(report.get('timestamp'), now) or not fresh(contract.get('generatedAt'), now):
        issues.append('stale_cleaner_or_compliance_contract')
    if report.get('folderId') != 18627:
        issues.append('unexpected_folder')
    if report.get('errors') != [] or not isinstance(report.get('actionsTaken'), list):
        issues.append('cleaner_errors_or_missing_actions')
    # Actual effects require native read-back evidence; do not infer success from a process exit.
    router = report.get('gocardlessRouterResult') or {}
    if report.get('actionsTaken') or router.get('actionsTaken') or router.get('mutated') or router.get('moved'):
        issues.append('native_effect_readback_required')
    native = contract.get('nativeFindings') or {}
    checks = native.get('checks')
    summary = report.get('guardianChecksSummary')
    if not isinstance(checks, list) or not isinstance(summary, dict):
        issues.append('missing_native_compliance_checks')
    else:
        statuses = {c['ruleId']: c['status'] for c in checks}
        if set(summary) != set(MANDATORY) or summary != statuses:
            issues.append('post_cleaner_guardian_drift')
        if any(status != 'PASS' for rule,status in summary.items() if rule != SUSPENSE):
            issues.append('post_cleaner_strict_rule_failure')
        if report.get('guardianStatus') != native.get('overallStatus'):
            issues.append('post_cleaner_guardian_status_drift')
    if contract.get('ok') is not True or contract.get('blockingReasons') != []:
        issues.append('compliance_contract_failed')
    if report.get('guardianStatus') == 'FAIL' and not contract.get('pending'):
        issues.append('unrouted_guardian_failure')
    return sorted(set(issues))

class CleanerResultTests(unittest.TestCase):
    def fixture(self):
        now = datetime.now(timezone.utc)
        statuses = {rule: 'PASS' for rule in MANDATORY}
        statuses[SUSPENSE] = 'FAIL'
        report = {'timestamp': now.isoformat(), 'folderId':18627, 'errors':[],
                  'actionsTaken':[], 'guardianStatus':'FAIL', 'guardianChecksSummary':statuses}
        contract = {'generatedAt':now.isoformat(), 'ok':True, 'blockingReasons':[],
                    'pending':[{'account':'4731SUPPLIER'}], 'nativeFindings':{
                        'overallStatus':'FAIL','checks':[{'ruleId':k,'status':v} for k,v in statuses.items()]}}
        return report,contract,now
    def test_pending_suspense_does_not_replay_cleaner(self):
        r,c,n=self.fixture()
        self.assertEqual(validate_cleaner(r,c,n),[])
    def test_cleaner_error_blocks(self):
        r,c,n=self.fixture();r['errors']=['API failure']
        self.assertIn('cleaner_errors_or_missing_actions',validate_cleaner(r,c,n))
    def test_actual_effect_requires_readback(self):
        r,c,n=self.fixture();r['actionsTaken']=[{'action':'merge_account'}]
        self.assertIn('native_effect_readback_required',validate_cleaner(r,c,n))
    def test_guardian_drift_blocks(self):
        r,c,n=self.fixture();r['guardianChecksSummary'][MANDATORY[0]]='FAIL'
        self.assertIn('post_cleaner_guardian_drift',validate_cleaner(r,c,n))
    def test_unrouted_failure_blocks(self):
        r,c,n=self.fixture();c['pending']=[]
        self.assertIn('unrouted_guardian_failure',validate_cleaner(r,c,n))
    def test_stale_result_blocks(self):
        r,c,n=self.fixture();r['timestamp']='2026-01-01T00:00:00Z'
        self.assertIn('stale_cleaner_or_compliance_contract',validate_cleaner(r,c,n))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--unit-only',action='store_true');args=parser.parse_args()
    tests=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(CleanerResultTests))
    if not tests.wasSuccessful():return 1
    if args.unit_only:return 0
    workspace=Path(os.environ.get('RBW_OSS_WORKSPACE',os.environ.get('CRAFT_WORKSPACE_DIR','/home/craft/.craft-agent/workspaces/my-workspace-2')))
    ops=workspace/'campaigns'/'ops'
    report=json.loads((ops/'inqom-autonomous-cleaner-last.json').read_text())
    contract=json.loads((ops/'inqom-expert-compliance-contract-tests.json').read_text())
    issues=validate_cleaner(report,contract)
    result={'generatedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
            'ok':not issues,'status':'verified_pending_documents' if not issues else 'blocked',
            'summary':f"cleaner_result_tests: tests={tests.testsRun} issues={len(issues)} cleaner_reexecuted=0",
            'counts':{'tests':tests.testsRun,'failed':len(issues),'pendingAccounts':len(contract.get('pending',[]))},
            'blockingReasons':issues,'checks':{'cleanerReexecuted':False,'mutationsExecuted':False},
            'stateSemantics':{'businessCompletionStatus':'blocked_incomplete_work' if contract.get('pending') else 'complete_verified'}}
    (ops/'inqom-autonomous-cleaner-result-tests.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False));return 0 if not issues else 1

if __name__=='__main__':
    raise SystemExit(main())
