"""Install, compile, validate and clean canaries entirely inside a temporary root."""
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
for directory in ('scripts', 'packages'):
    sys.path.insert(0, str(ROOT / directory))
import oss_architecture_v2_catalog as catalog_report
import oss_runtime_v2_queue_canary_manage as canary
from evergreen_offline_test_guard import assert_no_external_attempts
from lib import config_mutation
from pydantic import JsonValue, TypeAdapter

OBJECT = TypeAdapter(dict[str, JsonValue])
ROWS = TypeAdapter(list[dict[str, JsonValue]])

class CanaryTests(unittest.TestCase):
    @override
    def tearDown(self) -> None:
        assert_no_external_attempts()

    @contextmanager
    def workspace(self, root: Path, count: int = 193, approved_count: int = 193) -> Generator[tuple[Path, Path]]:
        config = root / 'config'
        registry = config / 'registry'
        registry.mkdir(parents=True)
        baseline = config / 'agents-v2/baseline.json'
        baseline.parent.mkdir()
        _ = baseline.write_text(json.dumps({'manifestCount': approved_count}))
        manifest = config / 'command-manifest.json'
        side = registry / 'side-effects-policy.json'
        base: list[dict[str, JsonValue]] = []
        policies: list[dict[str, JsonValue]] = []
        for index in range(count):
            agent = f'qa-{index}'
            base.append({'legacy_id': agent, 'name': agent, 'triggerType': 'ManualDirectOnly', 'execution': {'backend': 'argv', 'argv': [str(root / '.venv/bin/python'), str(root / 'scripts/qa.py')], 'cwd': str(root), 'timeout_seconds': 60}})
            policies.append({'legacy_id': agent, 'classified': True, 'requiresHumanApprovalForApply': True, 'scheduleAllowed': False})
        _ = manifest.write_text(json.dumps({'base': base}))
        _ = side.write_text(json.dumps({'capabilities': policies}))
        with patch.multiple(canary, ROOT=root, MANIFEST=manifest, SIDE_EFFECTS=side, OPS=root / 'ops', PYTHON=str(root / '.venv/bin/python'), SCRIPT=str(root / 'scripts/qa.py')), patch.multiple(config_mutation, ROOT=root, CONFIG=config, ARCHIVE_ROOT=root / 'archive', LOCK_DIR=root / '.locks'):
            yield manifest, side

    def test_install_compile_validate_cleanup_preserves_base_and_approval_policy(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.workspace(Path(directory)) as (manifest, side):
            before_manifest = OBJECT.validate_json(manifest.read_bytes())
            before_policy = OBJECT.validate_json(side.read_bytes())
            installed = canary.install()
            self.assertTrue(installed['ok'])
            validation = OBJECT.validate_python(installed['validation'])
            self.assertTrue(validation['ok'])
            self.assertEqual(OBJECT.validate_python(validation['counts'])['agents'], 198)
            after = OBJECT.validate_json(manifest.read_bytes())
            self.assertEqual(after['base'], before_manifest['base'])
            added = ROWS.validate_python(after[canary.SECTION])
            self.assertEqual([row['task_queue'] for row in added], list(canary.QUEUES))
            self.assertTrue(all(row['triggerType'] == 'ManualDirectOnly' for row in added))
            policies = ROWS.validate_python(OBJECT.validate_json(side.read_bytes())['capabilities'])
            self.assertEqual(policies[:193], before_policy['capabilities'])
            cleaned = canary.cleanup()
            self.assertTrue(cleaned['ok'])
            self.assertEqual(OBJECT.validate_python(cleaned['validation'])['ok'], True)
            self.assertEqual(OBJECT.validate_json(manifest.read_bytes())['base'], before_manifest['base'])
            self.assertNotIn(canary.SECTION, OBJECT.validate_json(manifest.read_bytes()))
            self.assertEqual(OBJECT.validate_json(side.read_bytes())['capabilities'], before_policy['capabilities'])
            root = Path(directory)
            with patch.multiple(catalog_report, ROOT=root, OUT_JSON=root / 'catalog-report.json', OUT_MD=root / 'catalog-report.md', HISTORY=root / 'catalog-history.jsonl'), redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    catalog_report.main()
                self.assertEqual(result.exception.code, 0)
            report = OBJECT.validate_json((root / 'catalog-report.json').read_bytes())
            self.assertTrue(report['ok'])
            self.assertEqual(OBJECT.validate_python(report['counts'])['agents'], 193)
            self.assertEqual(len((root / 'catalog-history.jsonl').read_text().splitlines()), 1)
            self.assertTrue((root / 'catalog-report.md').read_text().startswith('# OSS Architecture'))

    def test_public_192_baseline_install_and_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.workspace(Path(directory), count=192, approved_count=192) as (manifest, _side):
            installed = canary.install()
            self.assertTrue(installed['ok'])
            self.assertEqual(OBJECT.validate_python(installed['counts'])['manifest'], 197)
            self.assertTrue(canary.cleanup()['ok'])
            self.assertEqual(len(ROWS.validate_python(OBJECT.validate_json(manifest.read_bytes())['base'])), 192)

    def test_invalid_approved_baseline_cannot_be_inferred_from_current_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.workspace(Path(directory)) as (manifest, side):
            baseline = Path(directory) / 'config/agents-v2/baseline.json'
            before = manifest.read_bytes(), side.read_bytes()
            baseline.unlink()
            with self.assertRaises(FileNotFoundError):
                _ = canary.install()
            invalid_values: list[JsonValue] = [0, -1, True, '193', None]
            for value in invalid_values:
                _ = baseline.write_text(json.dumps({'manifestCount': value}))
                with self.assertRaises((TypeError, ValueError)):
                    _ = canary.install()
            self.assertEqual((manifest.read_bytes(), side.read_bytes()), before)

    def test_invalid_baseline_is_rejected_before_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.workspace(Path(directory), 192) as (manifest, side):
            before = (manifest.read_bytes(), side.read_bytes())
            with self.assertRaisesRegex(RuntimeError, '193-row argv-only'):
                _ = canary.install()
            self.assertEqual((manifest.read_bytes(), side.read_bytes()), before)

if __name__ == '__main__':
    _ = unittest.main()
