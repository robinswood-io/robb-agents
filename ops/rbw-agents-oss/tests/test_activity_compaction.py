"""Offline contracts for native Temporal result compaction and risk classification."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import override

from pydantic import JsonValue, TypeAdapter

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / 'apps/orchestrator-temporal'))
sys.path.insert(0, str(ROOT / 'scripts'))
import activity_compaction as compact
import oss_architecture_v2_policy as policy


class ActivityCompactionTests(unittest.TestCase):
    config: Path = Path()
    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.config = Path(temporary.name) / 'config.json'
        self.addCleanup(setattr, compact, 'RTK_TOKEN_CONFIG', compact.RTK_TOKEN_CONFIG)
        compact.RTK_TOKEN_CONFIG = self.config
        old = os.environ.get('RBW_TEMPORAL_RTK_TOKEN_OPTIMIZATION')
        self.addCleanup(self.restore_environment, old)
        os.environ['RBW_TEMPORAL_RTK_TOKEN_OPTIMIZATION'] = '1'

    @staticmethod
    def restore_environment(previous: str | None) -> None:
        if previous is None:
            _ = os.environ.pop('RBW_TEMPORAL_RTK_TOKEN_OPTIMIZATION', None)
        else:
            os.environ['RBW_TEMPORAL_RTK_TOKEN_OPTIMIZATION'] = previous

    def test_invalid_optional_config_uses_native_defaults(self) -> None:
        _ = self.config.write_text('{invalid')
        cfg = compact._load_rtk_token_config()
        self.assertTrue(cfg['enabled'])
        self.assertEqual(cfg['previewCharBudget'], 900)

    def test_small_output_does_not_grow_temporal_history(self) -> None:
        result = compact._rtk_optimize_output('mission completed', stream='stdout', ok=True)
        self.assertEqual(result['preview'], 'mission completed')
        preview_bytes, original_bytes = result['previewBytes'], result['originalBytes']
        if not isinstance(preview_bytes, int) or not isinstance(original_bytes, int):
            self.fail('Byte metrics must be integers')
        self.assertLessEqual(preview_bytes, original_bytes)

    def test_error_observation_keeps_failure_and_timeout_diagnostics(self) -> None:
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
        status = result['jsonStatus']
        if not isinstance(status, dict):
            self.fail('Failure status must preserve its JSON object')
        self.assertEqual(status['status'], 'blocked')
        self.assertEqual(result['stderrPreview'], 'report absent')

    def test_temporal_failure_keeps_operator_context_and_alert(self) -> None:
        result = compact._compact_temporal_return_payload(
            {'completedAt': '2026-10-26T10:00:00Z', 'alert': {'sent': False}},
            {'ok': False, 'exitCode': 3, 'error': 'connector unavailable'},
            legacy_id='qa-offline', name='QA mission', command='qa-read-only',
        )
        self.assertEqual(result['name'], 'QA mission')
        self.assertEqual(result['command'], 'qa-read-only')
        self.assertEqual(result['error'], 'connector unavailable')
        self.assertEqual(result['alert'], {'sent': False})

    def test_disabled_compaction_returns_original_payload(self) -> None:
        _ = self.config.write_text(json.dumps({'compactTemporalResult': False}))
        original: dict[str, JsonValue] = {'ok': True, 'native': 'payload'}
        result = compact._compact_temporal_return_payload(
            original, {'ok': True}, legacy_id='qa', name=None, command=None,
        )
        self.assertIs(result, original)

    def test_financial_mutation_and_outbound_effects_retain_human_gates(self) -> None:
        finance = policy.classify_side_effect({'legacy_id': 'inqom-dispatch', 'command': '--apply'}, False)
        outbound = policy.classify_side_effect({'legacy_id': 'gmail-send', 'command': 'prepare'}, True)
        self.assertEqual(finance['mutationMode'], 'human_approved_apply_only')
        self.assertTrue(finance['requiresHumanApprovalForApply'])
        self.assertTrue(outbound['requiresHumanApprovalForExternalSend'])
        self.assertFalse(finance['scheduleAllowed'])


    def use_temporary_policy_paths(self) -> None:
        root = self.config.parent / 'policy'
        root.mkdir()
        for name, previous, replacement in (
            ('ROOT', policy.ROOT, root),
            ('ARCHIVE', policy.ARCHIVE, root / 'archive'),
            ('SIDE_EFFECTS', policy.SIDE_EFFECTS, root / 'side-effects.json'),
            ('MANIFEST_ONLY', policy.MANIFEST_ONLY, root / 'manifest-only.json'),
        ):
            self.addCleanup(setattr, policy, name, previous)
            setattr(policy, name, replacement)

    def test_policy_update_preserves_existing_human_gates_and_manual_scheduling(self) -> None:
        self.use_temporary_policy_paths()
        existing: dict[str, JsonValue] = {
            'legacy_id': 'gmail-send', 'requiresHumanApprovalForExternalSend': True,
            'scheduleAllowed': False, 'riskClass': 'high_custom', 'ownerNote': 'preserve me',
        }
        _ = policy.SIDE_EFFECTS.write_text(json.dumps({'capabilities': [existing]}))
        manifest: dict[str, JsonValue] = {'campaigns': [
            {'legacy_id': 'gmail-send', 'command': 'send'},
            {'legacy_id': 'inqom-dispatch', 'command': '--apply'},
        ]}
        changes: list[dict[str, JsonValue]] = []
        policy.update_side_effect_policy(manifest, [], changes)
        data = TypeAdapter(dict[str, JsonValue]).validate_json(policy.SIDE_EFFECTS.read_bytes())
        rows = TypeAdapter(list[dict[str, JsonValue]]).validate_python(data['capabilities'])
        by_id = {str(row['legacy_id']): row for row in rows}
        self.assertEqual(by_id['gmail-send'], existing)
        self.assertTrue(by_id['inqom-dispatch']['requiresHumanApprovalForApply'])
        self.assertFalse(by_id['inqom-dispatch']['scheduleAllowed'])
        policy.update_manifest_only_policy(manifest, [], [], changes)
        data = TypeAdapter(dict[str, JsonValue]).validate_json(policy.MANIFEST_ONLY.read_bytes())
        rows = TypeAdapter(list[dict[str, JsonValue]]).validate_python(data['acceptedManifestOnly'])
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['scheduleAllowed'] is False for row in rows))
        self.assertTrue(all(row['requiresExplicitReviewBeforeScheduling'] is True for row in rows))

    def test_invalid_policy_rows_fail_before_rewriting_existing_rules(self) -> None:
        self.use_temporary_policy_paths()
        original = '{"capabilities":[42]}'
        _ = policy.SIDE_EFFECTS.write_text(original)
        changes: list[dict[str, JsonValue]] = []
        with self.assertRaises(ValueError):
            policy.update_side_effect_policy({}, [], changes)
        self.assertEqual(policy.SIDE_EFFECTS.read_text(), original)
        self.assertEqual(changes, [])

if __name__ == '__main__':
    _ = unittest.main()
