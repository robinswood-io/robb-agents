"""Preserve original Temporal payload bytes before removing an orphan schedule."""
from __future__ import annotations

import base64

from activity_compaction import JsonObject
from pydantic import JsonValue
from temporalio.client import ScheduleActionStartWorkflow, ScheduleDescription


def schedule_archive_row(schedule_id: str, desc: ScheduleDescription) -> JsonObject:
    action = desc.schedule.action
    if not isinstance(action, ScheduleActionStartWorkflow):
        raise TypeError("Unsupported schedule action cannot be archived safely")
    spec = desc.schedule.spec
    state = desc.schedule.state
    raw = desc.raw_description.SerializeToString()
    args: list[JsonValue] = []
    for payload in desc.raw_description.schedule.action.start_workflow.input.payloads:
        metadata: JsonObject = {k: v.decode('utf-8', errors='replace') for k, v in payload.metadata.items()}
        args.append({'metadata': metadata, 'dataBase64': base64.b64encode(payload.data).decode('ascii')})
    return {
        'scheduleId': schedule_id,
        'workflowId': action.id,
        'workflowType': action.workflow,
        'taskQueue': action.task_queue,
        'runTimeoutSeconds': int(action.run_timeout.total_seconds()) if action.run_timeout else None,
        'taskTimeoutSeconds': int(action.task_timeout.total_seconds()) if action.task_timeout else None,
        'args': args,
        'cronExpressions': list(spec.cron_expressions),
        'calendarsRepr': repr(list(spec.calendars)),
        'timeZone': spec.time_zone_name,
        'paused': state.paused,
        'note': state.note,
        'rawDescriptionProtoBase64': base64.b64encode(raw).decode('ascii'),
    }
