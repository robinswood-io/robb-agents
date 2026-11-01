"""Build the actual manifest against isolated config with real backup and locking."""
import io
import json
import sys
import tempfile
import unittest
from collections.abc import Generator
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from typing import override
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_temporal_schedule_manifest as builder
from evergreen_offline_test_guard import assert_no_external_attempts
from lib import config_mutation
from pydantic import JsonValue, TypeAdapter, ValidationError

OBJECT = TypeAdapter(dict[str, JsonValue])
ROWS = TypeAdapter(list[dict[str, JsonValue]])

class BuilderTests(unittest.TestCase):
    @override
    def tearDown(self) -> None:
        assert_no_external_attempts()

    @contextmanager
    def paths(self, root: Path) -> Generator[tuple[Path, Path, Path]]:
        config = root / 'config'
        mapping = config / 'automation-mapping.json'
        schedules = config / 'temporal/schedules.json'
        policy = config / 'admin-wrapper-queue-policy.json'
        config.mkdir()
        with patch.multiple(builder, ROOT=root, mapping_path=mapping, out_path=schedules, admin_policy_path=policy), patch.multiple(config_mutation, ROOT=root, CONFIG=config, ARCHIVE_ROOT=root / 'archive', LOCK_DIR=root / '.locks'), patch.dict('os.environ', {'RBW_DISABLE_SCHEDULE_AUTOFOLD': '0'}):
            yield mapping, schedules, policy

    def test_full_build_preserves_mapping_and_folds_existing_with_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)) as (mapping, schedules, policy):
            root = Path(directory)
            schedules.parent.mkdir()
            original = json.dumps([
                {'legacy_id': 'existing', 'triggerType': 'SchedulerTick', 'cron': '0 8 * * *', 'enabled': False},
                {'legacy_id': 'existing', 'triggerType': 'SchedulerTick', 'cron': '0 9 * * *'},
                {'legacy_id': 'event-only', 'triggerType': 'Event'}])
            _ = mapping.write_text(original)
            _ = schedules.write_text(json.dumps({'schedules': [
                {'payload': {'legacy_id': 'ovh-domain-qa', 'model': 'qa-model'}, 'cron': '*/5 * * * *', 'enabled': False},
                {'payload': {'legacy_id': 'unmapped-qa'}, 'cron': '0 1 * * *', 'task_queue': 'qa'}]}))
            _ = policy.write_text(json.dumps({'defaults': {'adminTaskQueue': 'watchdog'}, 'watchdogQueueWrappers': []}))
            with redirect_stdout(io.StringIO()):
                builder.main()
            result = ROWS.validate_python(OBJECT.validate_json(schedules.read_bytes())['schedules'])
            self.assertEqual(len(result), 3)
            first, ovh, ordinary = result
            self.assertEqual(first['cron'], '0 8 * * *')
            self.assertFalse(first['enabled'])
            self.assertEqual(ovh['task_queue'], 'watchdog')
            self.assertFalse(ovh['enabled'])
            self.assertEqual(ordinary['task_queue'], 'qa')
            mapped = ROWS.validate_json(mapping.read_bytes())
            self.assertEqual(len(mapped), 5)
            updated_policy = OBJECT.validate_json(policy.read_bytes())
            self.assertEqual(updated_policy['watchdogQueueWrappers'], ['ovh-domain-qa'])
            backups = list((root / 'archive').rglob('automation-mapping.json.*.bak'))
            self.assertTrue(backups)
            self.assertTrue(any(backup.read_text() == original for backup in backups))

    def test_missing_or_invalid_mapping_never_replaces_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)) as (mapping, schedules, _policy):
            root = Path(directory)
            schedules.parent.mkdir()
            original = '{"schedules":[{"schedule_id":"preserve-me"}]}'
            _ = schedules.write_text(original)
            with self.assertRaises(FileNotFoundError):
                builder.main()
            self.assertEqual(schedules.read_text(), original)
            for invalid in ['invalid json', '{}', '[null]']:
                _ = mapping.write_text(invalid)
                with self.assertRaises(ValidationError):
                    builder.main()
                self.assertEqual(schedules.read_text(), original)
            self.assertFalse((root / 'archive').exists())

if __name__ == '__main__':
    _ = unittest.main()
