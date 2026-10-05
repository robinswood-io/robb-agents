#!/usr/bin/env python3
"""
inqom_accounting_expert_rules_guardian_tests.py
-----------------------------------------------
Tests de non-régression pour le guardian des règles comptables d'experts Inqom.
Vérifie les 15 règles d'or comptables, fiscales et de trésorerie.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path('/srv/rbw-agents-oss')
sys.path.append(str(ROOT / 'scripts'))
sys.path.append(str(Path(__file__).parent))

from inqom_accounting_expert_rules_guardian import run_guardian

class InqomExpertRulesGuardianTests(unittest.TestCase):
    def test_guardian_overall_status_pass(self):
        """Le guardian doit s'exécuter et renvoyer un statut global PASS."""
        report = run_guardian()
        self.assertIn('overallStatus', report)
        self.assertEqual(report['overallStatus'], 'PASS', f"Guardian failed with report: {json.dumps(report, indent=2)}")

    def test_guardian_has_mandatory_checks(self):
        """Le guardian doit comporter les 15 vérifications fondamentales d'experts."""
        report = run_guardian()
        checks = {c['ruleId']: c['status'] for c in report.get('checks', [])}
        mandatory = [
            'PCG-5802-ZERO-BALANCE',
            'PCG-5800-ZERO-BALANCE',
            'PCG-451-GROUP-INTEGRITY',
            'PCG-473-SUSPENSE-CLEARING',
            'PCG-42-43-PAYROLL-NOMENCLATURE',
            'PCG-421-EMPLOYEE-SEGREGATION',
            'PCG-411-MISPLACED-SUPPLIERS',
            'PCG-TYPO-ACCOUNT-INTEGRITY',
            'PCG-6-NO-NET-CREDIT-EXPENSE',
            'PCG-4111-GOCARDLESS-CLEARING',
            'PCG-NUMERIC-ACCOUNT-8DIGITS',
            'PCG-DUPLICATE-AUXILIARY-CLEARING',
            'CASH-FLOW-STRICT-PHYSICAL-SEPARATION',
            'GOCARDLESS-CLEARING-ZERO-DRIFT',
            'TAX-AND-VAT-CASH-BASIS-DOCTRINE',
        ]
        for m in mandatory:
            self.assertIn(m, checks, f"Check manquant : {m}")
            self.assertEqual(checks[m], 'PASS', f"Check {m} doit être PASS, obtenu : {checks[m]}")

if __name__ == '__main__':
    unittest.main()
