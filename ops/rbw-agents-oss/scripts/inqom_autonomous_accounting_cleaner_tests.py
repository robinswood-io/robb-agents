#!/usr/bin/env python3
"""
inqom_autonomous_accounting_cleaner_tests.py
--------------------------------------------
Tests de non-régression pour l'auto-nettoyeur et module de remédiation OSS.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path('/srv/rbw-agents-oss')
sys.path.append(str(ROOT / 'scripts'))

from inqom_autonomous_accounting_cleaner import run_autonomous_cleaner

class InqomAutonomousCleanerTests(unittest.TestCase):
    def test_cleaner_execution_and_health(self):
        """Le cleaner doit exécuter son cycle, vérifier Guardian et retourner un statut sain."""
        res = run_autonomous_cleaner()
        self.assertIn('folderId', res)
        self.assertIn('actionsTaken', res)
        self.assertIn('errors', res)
        self.assertEqual(len(res['errors']), 0, f"Erreurs rencontrées lors du cycle de nettoyage: {res['errors']}")
        self.assertEqual(res.get('guardianStatus'), 'PASS', f"Le statut Guardian post-cleaner doit être PASS, obtenu: {res.get('guardianStatus')}")

if __name__ == '__main__':
    unittest.main()
