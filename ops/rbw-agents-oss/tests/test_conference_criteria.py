"""Regression evidence for approved eligibility and learning boundaries."""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import evergreen_offline_test_guard as offline_guard
from scotland_executive_conference_eligibility import eligible
from scotland_executive_conference_learning import learn
from scotland_executive_conference_october import save, suppressed
from scotland_executive_conference_types import CampaignItem, CampaignProof

T = datetime(2026, 10, 1, 8, 20, tzinfo=UTC)


def tearDownModule() -> None:
    offline_guard.assert_no_external_attempts()


class CampaignCriteriaTests(unittest.TestCase):
    def test_suppression_keeps_bounce_cooldown_and_address_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'suppression.json'
            save(path, {'records': [
                {'status': 'bounced_invalid_email', 'email': 'BOUNCED@company.example'},
                {'status': 'cooldown_90_days', 'email': 'COOLDOWN@company.example'},
                {'active': True, 'email': None, 'value': 'FALLBACK@company.example'},
            ]})
            self.assertEqual(suppressed(path), {
                'bounced@company.example', 'cooldown@company.example', 'fallback@company.example',
            })
            save(path, {'records': 'invalid_collection'})
            with self.assertRaises(TypeError):
                _ = suppressed(path)

    def test_accept_all_missing_accept_all_and_low_scores_block(self) -> None:
        item: CampaignItem = {
            'id': 'qa', 'email': 'executive@company.example', 'domain': 'company.example',
            'company': 'QA', 'firstName': 'QA', 'relevance': 'QA', 'role': 'Chief Marketing Officer',
            'employeeMinimum': 36, 'employeeEvidenceUrl': 'https://company.example/headcount',
            'scottishHeadquarters': True, 'corporateType': 'limited_company',
            'roleEvidenceUrl': 'https://company.example/team', 'legalEvidenceUrl': 'https://company.example/legal',
            'locationEvidenceUrl': 'https://company.example/location', 'roleCheckedAt': T.isoformat(),
        }
        proof: CampaignProof = {'checkedAt': T.isoformat(), 'result': 'valid', 'acceptAll': False, 'score': 90}
        self.assertEqual(eligible(item, proof, T), [])
        changes: tuple[CampaignProof, ...] = ({'acceptAll': True}, {'score': 89}, {'result': 'accept_all'})
        for change in changes:
            changed: CampaignProof = proof.copy()
            changed.update(change)
            self.assertIn('deliverability_stale_or_unproven', eligible(item, changed, T))
        del proof['acceptAll']
        self.assertIn('deliverability_stale_or_unproven', eligible(item, proof, T))

    def test_learning_preserves_maturation_copy_scope_and_historical_draws(self) -> None:
        with closing(sqlite3.connect(':memory:')) as db:
            db.row_factory = sqlite3.Row
            _ = db.executescript(
                'CREATE TABLE touches(item TEXT,step TEXT,state TEXT,variant TEXT,created TEXT,draft TEXT);'
                + 'CREATE TABLE replies(item TEXT,kind TEXT);'
            )
            for variant in ('A', 'B'):
                for number in range(12):
                    item = variant + str(number)
                    _ = db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?)', (
                        item, 'initial', 'sent_verified', variant, T.isoformat(),
                        '{"subject":"QA","body":"QA","copyVersion":"qa-v1"}',
                    ))
                    if variant == 'A' and number < 6:
                        _ = db.execute('INSERT INTO replies VALUES(?,?)', (item, 'qualified_need'))
            immature = learn(db, T + timedelta(days=4), 'qa-v1')  # Monday: two working days.
            self.assertEqual(immature['arms']['A']['maturedCompanies'], 0)
            self.assertEqual(immature['probabilityABeatsB'], .5)
            matured = learn(db, T + timedelta(days=5), 'qa-v1')
            self.assertEqual(matured['arms']['A']['maturedCompanies'], 12)
            self.assertEqual(matured['winner'], 'A')
            self.assertEqual(matured['probabilityABeatsB'], 0.9976)
            self.assertEqual(matured['reward'], 'one_qualified_need_per_company')
            self.assertFalse(matured['opensUsed'])
            self.assertFalse(matured['automaticBudgetOrAudienceChanges'])
            changed = learn(db, T + timedelta(days=7), 'qa-v2')
            self.assertEqual(changed['arms']['A']['maturedCompanies'], 0)
            self.assertEqual(changed['arms']['B']['maturedCompanies'], 0)
            self.assertIsNone(changed['winner'])
