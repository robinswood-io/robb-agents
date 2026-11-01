"""Exercise architecture refusals and rollback against temporary QA trees."""
from __future__ import annotations

import io
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

import oss_architecture_v2_debt_zero_guard as debt
import oss_architecture_v2_debt_zero_migrate as migration
import oss_architecture_v2_guard as guard
import oss_architecture_v2_install as installer
from evergreen_offline_test_guard import assert_no_external_attempts
from pydantic import JsonValue, TypeAdapter


class ArchitectureGuardTests(unittest.TestCase):
    directory: Path = Path()

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def test_schedule_fingerprint_tracks_cadence_and_ignores_order(self) -> None:
        first: dict[str, JsonValue] = {'schedule_id': 'qa-a', 'cron': '0 9 * * *',
                                       'payload': {'legacy_id': 'qa-agent'}}
        second: dict[str, JsonValue] = {'schedule_id': 'qa-b', 'cron': '0 10 * * *', 'enabled': False}
        for fingerprint in (guard.schedule_fingerprint, debt.fingerprint):
            initial = fingerprint([first, second])
            self.assertEqual(initial, fingerprint([second, first]))
            self.assertNotEqual(initial, fingerprint([{**first, 'cron': '0 11 * * *'}, second]))
            self.assertNotEqual(initial, fingerprint([first, {**second, 'enabled': True}]))
        self.assertEqual(guard.schedule_legacy(first), 'qa-agent')
        self.assertEqual(debt.schedule_legacy({'capability_id': 'fallback'}), 'fallback')

    def test_missing_baseline_and_canaries_remain_blocking(self) -> None:
        paths = {'ROOT': self.directory, 'OUT_JSON': self.directory / 'guard.json',
                 'OUT_MD': self.directory / 'guard.md', 'HISTORY': self.directory / 'history.jsonl',
                 'BASELINE': self.directory / 'baseline.json', 'MANIFEST': self.directory / 'manifest.json',
                 'SCHEDULES': self.directory / 'schedules.json', 'ACTIVITIES': self.directory / 'activities.py',
                 'SELFTEST': self.directory / 'selftest.json'}
        for name, previous in (
            ('ROOT', guard.ROOT), ('OUT_JSON', guard.OUT_JSON), ('OUT_MD', guard.OUT_MD),
            ('HISTORY', guard.HISTORY), ('BASELINE', guard.BASELINE), ('MANIFEST', guard.MANIFEST),
            ('SCHEDULES', guard.SCHEDULES), ('ACTIVITIES', guard.ACTIVITIES), ('SELFTEST', guard.SELFTEST),
        ):
            self.addCleanup(setattr, guard, name, previous)
            setattr(guard, name, paths[name])
        with (patch.object(guard, 'QUEUE_CANARIES', {'qa': self.directory / 'canary.json'}),
              redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as outcome):
            guard.main()
        self.assertEqual(outcome.exception.code, 1)
        report = TypeAdapter(dict[str, JsonValue]).validate_json(paths['OUT_JSON'].read_bytes())
        self.assertIs(report['ok'], False)
        self.assertEqual(report['status'], 'blocked')
        reasons = TypeAdapter(list[str]).validate_python(report['blockingReasons'])
        self.assertIn('architecture_v2_baseline_missing', reasons)
        self.assertIn('runtime_v2_selftest_not_verified', reasons)
        self.assertIn('runtime_v2_five_queue_argv_canary_not_verified', reasons)
        self.assertNotIn('unknown_id_not_fail_closed', reasons)

    def test_permission_audit_reports_qa_files_without_changing_them(self) -> None:
        directory = self.directory / 'secrets'
        directory.mkdir(mode=0o700)
        file = directory / 'qa-token.txt'
        _ = file.write_text('QA-only-placeholder')
        file.chmod(0o644)
        with patch.object(guard, 'ROOT', self.directory):
            issues = guard.sensitive_permission_issues()
        self.assertEqual(issues, [{'path': 'secrets/qa-token.txt', 'mode': '0o644', 'type': 'file'}])
        self.assertEqual(file.stat().st_mode & 0o777, 0o644)

    def test_unexecuted_seed_is_pending_and_never_overwrites_real_results(self) -> None:
        path = migration.seed_pending_report(self.directory, 'qa', '/qa/runtime-report.json')
        report = TypeAdapter(dict[str, JsonValue]).validate_json(path.read_bytes())
        self.assertIs(report['ok'], False)
        self.assertEqual(report['status'], 'pending_first_scheduled_run')
        counts = TypeAdapter(dict[str, JsonValue]).validate_python(report['counts'])
        self.assertEqual(counts['runs'], 0)
        checks = TypeAdapter(dict[str, JsonValue]).validate_python(report['checks'])
        self.assertEqual(checks['policyDecision'], 'not_executed')
        original = '{"ok":true,"status":"passed","verifiedQaResult":true}'
        _ = path.write_text(original)
        self.assertEqual(migration.seed_pending_report(self.directory, 'qa', '/qa/new.json'), path)
        self.assertEqual(path.read_text(), original)

    def test_command_migration_refuses_shell_and_unapproved_environment(self) -> None:
        for command in ('python3 qa.py && echo unsafe', 'python3 $(echo unsafe)', 'PATH=/tmp python3 qa.py'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                _ = migration.parse_direct_command({'legacy_id': 'qa', 'command': command})
        argv, env, display = migration.parse_direct_command({'legacy_id': 'qa', 'command': 'python3 qa.py'})
        self.assertEqual(argv, [migration.VENV_PYTHON, 'qa.py'])
        self.assertEqual(env, {})
        self.assertEqual(display, f'{migration.VENV_PYTHON} qa.py')

    def test_rollback_restores_archived_files_and_preserves_other_files(self) -> None:
        archive = self.directory / 'archive'
        original = archive / 'before' / 'config' / 'qa.json'
        original.parent.mkdir(parents=True)
        _ = original.write_text('original-qa')
        target = self.directory / 'config' / 'qa.json'
        target.parent.mkdir()
        _ = target.write_text('changed-qa')
        concurrent = target.parent / 'concurrent.json'
        _ = concurrent.write_text('keep-concurrent')
        with patch.object(installer, 'ROOT', self.directory), patch.object(installer, 'ARCHIVE', archive):
            self.assertEqual(installer.rollback_from_archive(), ['config/qa.json'])
        self.assertEqual(target.read_text(), 'original-qa')
        self.assertEqual(concurrent.read_text(), 'keep-concurrent')


def tearDownModule() -> None:
    assert_no_external_attempts()


if __name__ == '__main__':
    _ = unittest.main()
