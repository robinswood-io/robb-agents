"""Offline contracts for native Temporal result compaction and risk classification."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / 'apps/orchestrator-temporal'))
sys.path.insert(0, str(ROOT / 'scripts'))
import activity_compaction as compact
import oss_architecture_v2_policy as policy


class ActivityCompactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name) / 'config.json'
        self.config_patch = patch.object(compact, 'RTK_TOKEN_CONFIG', self.config)
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)
        self.env_patch = patch.dict(os.environ, {'RBW_TEMPORAL_RTK_TOKEN_OPTIMIZATION': '1'})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def test_invalid_optional_config_uses_native_defaults(self):
        self.config.write_text('{invalid')
        cfg = compact._load_rtk_token_config()
        self.assertTrue(cfg['enabled'])
        self.assertEqual(cfg['previewCharBudget'], 900)

    def test_small_output_does_not_grow_temporal_history(self):
        result = compact._rtk_optimize_output('mission completed', stream='stdout', ok=True)
        self.assertEqual(result['preview'], 'mission completed')
        self.assertLessEqual(result['previewBytes'], result['originalBytes'])

    def test_error_observation_keeps_failure_and_timeout_diagnostics(self):
        result = compact._compact_result_observation({
            'ok': False, 'exitCode': 9, 'timeout': True, 'businessFailure': True,
            'errorType': 'MissingRequirement', 'error': 'report absent',
            'jsonStatus': {'status': 'blocked', 'missing': ['report']},
            'stderr': 'report absent',
        })
        self.assertFalse(result['ok'])
        self.assertEqual(result['exitCode'], 9)
        self.assertTrue(result['timeout'])
        self.assertTrue(result['businessFailure'])
        self.assertEqual(result['errorType'], 'MissingRequirement')
        self.assertEqual(result['jsonStatus']['status'], 'blocked')
        self.assertEqual(result['stderrPreview'], 'report absent')

    def test_temporal_failure_keeps_operator_context_and_alert(self):
        result = compact._compact_temporal_return_payload(
            {'completedAt': '2026-10-26T10:00:00Z', 'alert': {'sent': False}},
            {'ok': False, 'exitCode': 3, 'error': 'connector unavailable'},
            legacy_id='qa-offline', name='QA mission', command='qa-read-only',
        )
        self.assertEqual(result['name'], 'QA mission')
        self.assertEqual(result['command'], 'qa-read-only')
        self.assertEqual(result['error'], 'connector unavailable')
        self.assertEqual(result['alert'], {'sent': False})

    def test_disabled_compaction_returns_original_payload(self):
        self.config.write_text(json.dumps({'compactTemporalResult': False}))
        original = {'ok': True, 'native': 'payload'}
        result = compact._compact_temporal_return_payload(
            original, {'ok': True}, legacy_id='qa', name=None, command=None,
        )
        self.assertIs(result, original)

    def test_financial_mutation_and_outbound_effects_retain_human_gates(self):
        finance = policy.classify_side_effect({'legacy_id': 'inqom-dispatch', 'command': '--apply'}, False)
        outbound = policy.classify_side_effect({'legacy_id': 'gmail-send', 'command': 'prepare'}, True)
        self.assertEqual(finance['mutationMode'], 'human_approved_apply_only')
        self.assertTrue(finance['requiresHumanApprovalForApply'])
        self.assertTrue(outbound['requiresHumanApprovalForExternalSend'])
        self.assertFalse(finance['scheduleAllowed'])


if __name__ == '__main__':
    unittest.main()
