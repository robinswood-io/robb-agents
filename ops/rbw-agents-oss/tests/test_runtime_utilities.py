"""Offline configuration, report and manual dispatch contracts."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import override
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
for directory in ('scripts', 'packages', 'apps/orchestrator-temporal'):
    sys.path.insert(0, str(ROOT / directory))

import run_workflow as manual
from evergreen_offline_test_guard import assert_no_external_attempts
from lib import agent_runtime, config_mutation, wrapper_sdk
from pydantic import JsonValue, TypeAdapter


class RuntimeUtilitiesTests(unittest.TestCase):
    directory: Path = Path()

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def test_config_mutation_preserves_original_backup_and_file_mode(self) -> None:
        path = self.directory / 'config.json'
        _ = path.write_text('{"original":true}')
        path.chmod(0o600)
        with (patch.object(config_mutation, 'ROOT', self.directory),
              patch.object(config_mutation, 'ARCHIVE_ROOT', self.directory / 'archive'),
              patch.object(config_mutation, 'LOCK_DIR', self.directory / 'locks')):
            with config_mutation.ConfigMutation('qa', root=self.directory) as mutation:
                mutation.write_json(path, {'revision': 1})
                mutation.write_json(path, {'revision': 2})
                backup = mutation.backup(path)
                self.assertIsNotNone(backup)
                if backup is None:
                    self.fail('Expected one original backup')
                self.assertEqual(backup.read_text(), '{"original":true}')
            self.assertEqual(config_mutation.load_json(path), {'revision': 2})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list(self.directory.rglob('*.bak'))), 1)
        self.assertFalse(list(self.directory.glob('*.tmp')))

    def test_config_lock_releases_after_failure_without_suppressing_it(self) -> None:
        with patch.object(config_mutation, 'LOCK_DIR', self.directory):
            with self.assertRaisesRegex(RuntimeError, 'qa-failure'), config_mutation.ConfigMutation('qa'):
                raise RuntimeError('qa-failure')
            with config_mutation.config_lock('next-qa') as lock:
                self.assertTrue(lock.is_file())

    def test_runtime_records_stage_and_elapsed_time_even_on_error(self) -> None:
        captured: list[dict[str, JsonValue]] = []
        with (self.assertRaisesRegex(ValueError, 'qa-stage'),
              agent_runtime.run_context('qa', budget_seconds=-1) as context,
              agent_runtime.stage(context, 'prepare')):
            captured.append(context)
            raise ValueError('qa-stage')
        context = captured[0]
        self.assertTrue(context['budgetExceeded'])
        self.assertIn('elapsedSeconds', context)
        timings = TypeAdapter(dict[str, JsonValue]).validate_python(context['stageTimings'])
        self.assertIn('prepare', timings)

    def test_report_and_history_keep_blocking_reasons(self) -> None:
        report = agent_runtime.standard_report(capability_id='qa', ok=False,
                                               blocking_reasons=['human_review_required'])
        path, history = self.directory / 'report.json', self.directory / 'history.jsonl'
        agent_runtime.write_report_and_history(path, history, report)
        self.assertEqual(agent_runtime.read_json(path, None), report)
        self.assertEqual(TypeAdapter(dict[str, JsonValue]).validate_json(history.read_bytes())['blockingReasons'],
                         ['human_review_required'])
        _ = path.write_text('invalid JSON')
        self.assertEqual(agent_runtime.read_json(path, {'fallback': True}), {'fallback': True})

    def test_wrapper_error_emits_a_failed_report_and_nonzero_exit(self) -> None:
        def fail() -> dict[str, JsonValue]:
            raise ValueError('qa-wrapper')

        with (patch.object(wrapper_sdk, 'OPS', self.directory), redirect_stdout(io.StringIO()),
              self.assertLogs(wrapper_sdk.logger, level='ERROR')):
            code = wrapper_sdk.safe_main('qa', fail)
        self.assertEqual(code, 1)
        data = TypeAdapter(dict[str, JsonValue]).validate_json((self.directory / 'qa-last.json').read_bytes())
        self.assertIs(data['ok'], False)
        self.assertEqual(data['status'], 'failed')
        self.assertIn('qa-wrapper', (self.directory / 'qa-last.md').read_text())

    def test_manual_policy_merges_defaults_and_preserves_duplicate_protection(self) -> None:
        path = self.directory / 'policy.json'
        _ = path.write_text(json.dumps({'defaults': {'adminTaskQueue': 'qa-admin'}}))
        with patch.object(manual, 'ADMIN_QUEUE_POLICY', path):
            policy = manual._load_policy()
        self.assertEqual(manual._task_queue_for('temporal-register-schedules', {}, policy),
                         ('qa-admin', 'admin-wrapper-queue-policy'))
        self.assertTrue(manual._duplicate_protected('temporal-register-schedules', policy))
        self.assertEqual(manual._task_queue_for('business-qa', {'taskQueue': 'business'}, policy),
                         ('business', 'manifest'))
        self.assertEqual(manual._task_queue_for('agent-task-context-enriched-campaign-executor', {}, policy),
                         ('sync', 'manual-sync-override-2026-06-15'))

    def test_manual_rows_accept_both_manifest_shapes_and_discard_nonobjects(self) -> None:
        path = self.directory / 'manifest.json'
        for data in ([{'legacy_id': 'qa'}, 'ignored'], {'campaigns': [{'legacy_id': 'qa'}, None]}):
            _ = path.write_text(json.dumps(data))
            self.assertEqual(manual._load_rows(path), [{'legacy_id': 'qa'}])


def tearDownModule() -> None:
    assert_no_external_attempts()


if __name__ == '__main__':
    _ = unittest.main()
