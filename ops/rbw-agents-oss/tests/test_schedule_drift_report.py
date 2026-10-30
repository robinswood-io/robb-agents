"""Real report pipeline with Temporal descriptions supplied entirely offline."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import override
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
for directory in ('scripts', 'packages'):
    sys.path.insert(0, str(ROOT / directory))
import schedule_drift_report as drift
from evergreen_offline_test_guard import assert_no_external_attempts
from pydantic import JsonValue, TypeAdapter
from temporalio.api.workflowservice.v1 import DescribeScheduleResponse
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleDescription,
    ScheduleInfo,
    ScheduleSpec,
    ScheduleState,
)
from temporalio.common import TypedSearchAttributes
from temporalio.converter import DataConverter


def description(schedule_id: str, *, queue: str = 'default', paused: bool = False,
                cron: str = '0 9 * * *') -> ScheduleDescription:
    return ScheduleDescription(
        id=schedule_id,
        schedule=Schedule(action=ScheduleActionStartWorkflow('QA', id='workflow.qa', task_queue=queue),
                          spec=ScheduleSpec(cron_expressions=[cron]), state=ScheduleState(paused=paused)),
        info=ScheduleInfo(num_actions=0, num_actions_missed_catchup_window=0, num_actions_skipped_overlap=0,
                          running_actions=[], recent_actions=[], next_action_times=[],
                          created_at=datetime.now(UTC), last_updated_at=None),
        typed_search_attributes=TypedSearchAttributes([]), search_attributes={},
        data_converter=DataConverter.default, raw_description=DescribeScheduleResponse(),
    )


class QAHandle:
    value: ScheduleDescription

    def __init__(self, value: ScheduleDescription) -> None:
        self.value = value

    async def describe(self) -> ScheduleDescription:
        return self.value


class QAClient:
    descriptions: dict[str, ScheduleDescription]

    def __init__(self, descriptions: dict[str, ScheduleDescription]) -> None:
        self.descriptions = descriptions

    def get_schedule_handle(self, schedule_id: str) -> QAHandle:
        return QAHandle(self.descriptions[schedule_id])


class ScheduleDriftTests(unittest.IsolatedAsyncioTestCase):
    directory: Path = Path()
    ids: list[str]
    descriptions: dict[str, ScheduleDescription]

    @override
    def __init__(self, methodName: str = 'runTest') -> None:
        super().__init__(methodName)
        self.ids = []
        self.descriptions = {}

    @override
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.ids = sorted(drift.CRITICAL_MAIL_LEGACY_IDS)
        self.descriptions = {name: description(name) for name in self.ids}
        rows: list[dict[str, JsonValue]] = [
            {'schedule_id': name, 'payload': {'legacy_id': name}, 'cron': '0 9 * * *',
             'task_queue': 'default', 'enabled': True} for name in self.ids]
        _ = (self.directory / 'manifest.json').write_text(json.dumps({'schedules': rows}))
        _ = (self.directory / 'runs.jsonl').write_text('\n'.join(
            json.dumps({'ts': datetime.now(UTC).isoformat(), 'payload': {'legacy_id': name}}) for name in self.ids))
        old = (datetime.now(UTC) - timedelta(days=5)).timestamp()
        os.utime(self.directory / 'manifest.json', (old, old))

    async def run_report(self) -> dict[str, JsonValue]:
        client = QAClient(self.descriptions)

        async def connect(_target: str) -> QAClient:
            return client

        with patch.object(Client, 'connect', connect):
            return await drift.run(self.directory / 'manifest.json', self.directory / 'runs.jsonl',
                                   self.directory / 'control.json', self.directory / 'policy.json',
                                   self.directory / 'out.json', self.directory / 'out.md')

    async def test_full_report_and_compact_summary_agree_for_healthy_schedules(self) -> None:
        report = await self.run_report()
        self.assertIs(report['ok'], True)
        self.assertEqual(report['blockingReasons'], [])
        self.assertEqual(TypeAdapter(dict[str, JsonValue]).validate_json((self.directory / 'out.json').read_bytes()), report)
        self.assertIn('Aucun drift bloquant', (self.directory / 'out.md').read_text())
        compact = drift.compact_summary(report)
        self.assertNotIn('rows', compact)
        self.assertEqual(compact['counts'], report['counts'])

    async def test_live_drift_creates_action_and_survives_markdown_rendering(self) -> None:
        self.descriptions[self.ids[0]] = description(self.ids[0], queue='wrong-queue', paused=True, cron='0 2 * * *')
        report = await self.run_report()
        self.assertIs(report['ok'], False)
        reasons = TypeAdapter(list[str]).validate_python(report['blockingReasons'])
        self.assertIn('schedule_drift_detected', reasons)
        self.assertIn('schedule_task_queue_policy_drift', reasons)
        actions = TypeAdapter(list[dict[str, JsonValue]]).validate_python(report['actionQueue'])
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]['target'], self.ids[0])
        self.assertEqual(actions[0]['priority'], 'high')
        self.assertIn('paused mismatch', (self.directory / 'out.md').read_text())

    async def test_missing_runs_block_outside_the_existing_grace_period(self) -> None:
        (self.directory / 'runs.jsonl').unlink()
        report = await self.run_report()
        self.assertIs(report['ok'], False)
        reasons = TypeAdapter(list[str]).validate_python(report['blockingReasons'])
        self.assertIn('schedule_freshness_stale', reasons)
        self.assertTrue(report['actionQueue'])


def tearDownModule() -> None:
    assert_no_external_attempts()


if __name__ == '__main__':
    _ = unittest.main()
