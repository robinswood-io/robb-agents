"""Offline bridge contracts: persisted evidence and duplicate prevention."""
from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import override
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
for directory in ('scripts', 'packages', 'apps/orchestrator-temporal'):
    sys.path.insert(0, str(ROOT / directory))

import event_bridge as events
import runtime_v2_bridge as runtime
from evergreen_offline_test_guard import assert_no_external_attempts
from pydantic import JsonValue, TypeAdapter


class EventRuntimeBridgeTests(unittest.TestCase):
    directory: Path = Path()

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.addCleanup(setattr, events, 'DEDUPE_LEDGER', events.DEDUPE_LEDGER)
        events.DEDUPE_LEDGER = self.directory / 'ledger.jsonl'

    def test_equivalent_objects_deduplicate_but_other_agents_do_not(self) -> None:
        first: dict[str, JsonValue] = {'id': 'QA-1', 'status': 'done'}
        reordered: dict[str, JsonValue] = {'status': 'done', 'id': 'QA-1'}
        key = events._canonical_event_key('SessionEnd', 'qa-a', first)
        self.assertEqual(key, events._canonical_event_key('SessionEnd', 'qa-a', reordered))
        self.assertNotEqual(key, events._canonical_event_key('SessionEnd', 'qa-b', first))
        self.assertNotEqual(key, events._canonical_event_key('FlagChange', 'qa-a', first))

    def test_ledger_restores_recent_keys_and_ignores_invalid_rows(self) -> None:
        rows: list[JsonValue] = [
            {'event_key': 'recent', 'ts_unix': 99999},
            {'event_key': 'expired', 'ts_unix': 1},
            {'event_key': ['invalid'], 'ts_unix': 99999},
            {'event_key': 'bad-time', 'ts_unix': {}},
            ['not-an-object'],
        ]
        _ = events.DEDUPE_LEDGER.write_text('broken JSON\n' + '\n'.join(json.dumps(row) for row in rows))
        with patch.object(time, 'time', return_value=100000):
            keys = events._load_recent_dedupe_keys()
            self.assertEqual(keys, {'recent': 99999.0})
            self.assertTrue(events._is_recent_duplicate(keys, 'recent'))
            self.assertFalse(events._is_recent_duplicate({'expired': 1}, 'expired'))
            self.assertFalse(events._is_recent_duplicate(keys, 'missing'))

    def test_append_and_prune_keep_latest_duplicate_evidence(self) -> None:
        with patch.object(time, 'time', return_value=100000):
            events._append_dedupe_ledger('qa-key', 'SessionEnd', 'qa', 'started', 'workflow-qa')
            self.assertEqual(events._load_recent_dedupe_keys(), {'qa-key': 100000.0})
        self.addCleanup(setattr, events, 'MAX_IN_MEMORY_KEYS', events.MAX_IN_MEMORY_KEYS)
        events.MAX_IN_MEMORY_KEYS = 2
        keys = {'old': 1.0, 'middle': 2.0, 'new': 3.0}
        events._prune_in_memory(keys)
        self.assertEqual(keys, {'middle': 2.0, 'new': 3.0})

    def test_reports_distinguish_success_business_failure_timeout_and_block(self) -> None:
        decision: dict[str, JsonValue] = {'legacy_id': '../qa', 'backend': 'argv', 'env': {'Z': 'z', 'A': 'a'}}
        cases: list[tuple[dict[str, JsonValue], str, str]] = [
            ({'ok': True, 'exitCode': 0}, 'execution', 'passed'),
            ({'ok': False, 'businessFailure': True}, 'execution', 'business_failed'),
            ({'ok': False, 'timeout': True}, 'execution', 'timeout'),
            ({'ok': False, 'errorType': 'Denied'}, 'preflight', 'blocked'),
            ({'ok': False, 'exitCode': 2}, 'execution', 'technical_failed'),
        ]
        for result, stage, status in cases:
            with self.subTest(status=status), patch.object(runtime, '_RUNTIME_REPORTS', self.directory):
                report = runtime._write_runtime_report(decision, result, stage=stage)
                path = runtime.runtime_report_path('../qa')
                self.assertEqual(path.parent, self.directory)
                self.assertEqual(report['status'], status)
                persisted = TypeAdapter(dict[str, JsonValue]).validate_json(path.read_bytes())
                self.assertEqual(persisted, report)
                checks = TypeAdapter(dict[str, JsonValue]).validate_python(report['checks'])
                self.assertEqual(checks['manifestEnvKeys'], ['A', 'Z'])
                history = path.with_name(path.name.replace('-last.json', '-history.jsonl'))
                latest = TypeAdapter(dict[str, JsonValue]).validate_json(history.read_text().splitlines()[-1])
                self.assertEqual(latest['status'], status)
                self.assertEqual(latest['counts'], report['counts'])
        self.assertFalse(list(self.directory.glob('*.tmp')))


def tearDownModule() -> None:
    assert_no_external_attempts()


if __name__ == '__main__':
    _ = unittest.main()
