"""Offline checks using real Temporal DTOs; never connect to a Temporal server."""
from __future__ import annotations

import base64
import sys
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for directory in ('scripts', 'packages', 'apps/orchestrator-temporal'):
    sys.path.insert(0, str(ROOT / directory))

from evergreen_offline_test_guard import assert_no_external_attempts
from pydantic import JsonValue
from register_schedules import _policy_task_queue, _run_timeout_seconds
from schedule_archive import schedule_archive_row
from temporalio.api.workflowservice.v1 import DescribeScheduleResponse
from temporalio.client import (
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleDescription,
    ScheduleInfo,
    ScheduleSpec,
    ScheduleState,
)
from temporalio.common import TypedSearchAttributes
from temporalio.converter import DataConverter


def tearDownModule() -> None:
    assert_no_external_attempts()


class TemporalArchiveTests(unittest.TestCase):
    def test_archive_preserves_original_wire_payload_and_restore_metadata(self) -> None:
        raw = DescribeScheduleResponse()
        payload_bytes = b'{"requirement":"complete-report","amount":0}'
        _ = raw.schedule.action.start_workflow.input.payloads.add(
            metadata={'encoding': b'json/plain'}, data=payload_bytes,
        )
        description = ScheduleDescription(
            id='sched.qa',
            schedule=Schedule(
                action=ScheduleActionStartWorkflow(
                    'QAMission', {'requirement': 'complete-report', 'amount': 0},
                    id='workflow.qa', task_queue='qa',
                    run_timeout=timedelta(minutes=10), task_timeout=timedelta(seconds=30),
                ),
                spec=ScheduleSpec(cron_expressions=['0 9 * * *'], time_zone_name='Europe/Paris'),
                state=ScheduleState(paused=True, note='QA only'),
            ),
            info=ScheduleInfo(
                num_actions=0, num_actions_missed_catchup_window=0,
                num_actions_skipped_overlap=0, running_actions=[], recent_actions=[],
                next_action_times=[], created_at=datetime(2026, 10, 30, tzinfo=UTC),
                last_updated_at=None,
            ),
            typed_search_attributes=TypedSearchAttributes([]), search_attributes={},
            data_converter=DataConverter.default, raw_description=raw,
        )
        result = schedule_archive_row('sched.qa', description)
        self.assertEqual(result['args'], [{
            'metadata': {'encoding': 'json/plain'},
            'dataBase64': base64.b64encode(payload_bytes).decode('ascii'),
        }])
        self.assertEqual(result['rawDescriptionProtoBase64'],
                         base64.b64encode(raw.SerializeToString()).decode('ascii'))
        self.assertEqual(result['workflowId'], 'workflow.qa')
        self.assertEqual(result['taskQueue'], 'qa')
        self.assertEqual(result['runTimeoutSeconds'], 600)
        self.assertEqual(result['taskTimeoutSeconds'], 30)
        self.assertEqual(result['cronExpressions'], ['0 9 * * *'])
        self.assertEqual(result['timeZone'], 'Europe/Paris')
        self.assertTrue(result['paused'])
        self.assertEqual(result['note'], 'QA only')

    def test_poisoned_runs_remain_bounded_without_overriding_explicit_timeout(self) -> None:
        self.assertEqual(_run_timeout_seconds({'payload': {'legacy_id': 'qa'}}, {'qa': 10000}), 3600)
        self.assertEqual(_run_timeout_seconds({'payload': {'legacy_id': 'qa'}}, {'qa': 90}), 990)
        self.assertEqual(_run_timeout_seconds({'run_timeout_seconds': 120}, {}), 120)

    def test_admin_queue_policy_does_not_reassign_business_schedules(self) -> None:
        policy: dict[str, JsonValue] = {'defaults': {'adminTaskQueue': 'watchdog'}, 'watchdogQueueWrappers': ['admin']}
        self.assertEqual(_policy_task_queue({'payload': {'legacy_id': 'admin'}}, policy),
                         ('watchdog', 'admin-wrapper-queue-policy'))
        self.assertEqual(_policy_task_queue({'task_queue': 'campaigns', 'payload': {'legacy_id': 'business'}}, policy),
                         ('campaigns', 'schedule-config'))


if __name__ == '__main__':
    _ = unittest.main()
