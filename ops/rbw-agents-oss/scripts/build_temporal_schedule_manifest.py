#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lib.config_mutation import ConfigMutation

ROOT = Path('/srv/rbw-agents-oss')
mapping_path = ROOT / 'config/automation-mapping.json'
out_path = ROOT / 'config/temporal/schedules.json'
admin_policy_path = ROOT / 'config/admin-wrapper-queue-policy.json'
out_path.parent.mkdir(parents=True, exist_ok=True)


def _rows(data: Any) -> list[dict]:
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        out: list[dict] = []
        for value in data.values():
            if isinstance(value, list):
                out.extend([r for r in value if isinstance(r, dict)])
        return out
    return []


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> None:
    with ConfigMutation('build-temporal-schedule-manifest') as mutation:
        mutation.write_json(path, data)


def _backup(path: Path, label: str) -> None:
    # ConfigMutation writes an archive snapshot before every atomic replacement.
    return None


def _load_existing_schedules() -> list[dict]:
    if not out_path.exists():
        return []
    data = _read_json(out_path, {})
    return _rows(data.get('schedules', data) if isinstance(data, dict) else data)


def _load_admin_policy() -> dict:
    data = _read_json(admin_policy_path, {})
    if not isinstance(data, dict):
        data = {}
    defaults = data.get('defaults') if isinstance(data.get('defaults'), dict) else {}
    return {
        'raw': data,
        'adminTaskQueue': str(defaults.get('adminTaskQueue') or 'watchdog'),
        'watchdogQueueWrappers': set(str(x) for x in data.get('watchdogQueueWrappers', []) if x),
    }


def _task_queue_for_fold(legacy_id: str, schedule: dict, policy: dict) -> str:
    if legacy_id in policy['watchdogQueueWrappers']:
        return policy['adminTaskQueue']
    # OVH sentinel/diagnostic/remediation jobs are operational observability and
    # must not starve behind default/business workloads.
    if legacy_id.startswith('ovh-domain-'):
        return policy['adminTaskQueue']
    return str(schedule.get('task_queue') or 'default')


def _fold_existing_missing_mapping(mapping_rows: list[dict], existing_schedules: list[dict], policy: dict) -> tuple[list[dict], list[dict], bool]:
    existing_ids = {str(r.get('legacy_id')) for r in mapping_rows if isinstance(r, dict) and r.get('legacy_id')}
    folded: list[dict] = []
    policy_changed = False
    raw_policy = policy['raw'] if isinstance(policy.get('raw'), dict) else {}
    watchdog_list = list(raw_policy.get('watchdogQueueWrappers') or [])

    for schedule in existing_schedules:
        if not isinstance(schedule, dict):
            continue
        payload = schedule.get('payload') if isinstance(schedule.get('payload'), dict) else {}
        legacy_id = payload.get('legacy_id') or schedule.get('legacy_id')
        if not legacy_id:
            continue
        legacy_id = str(legacy_id)
        if legacy_id in existing_ids:
            continue
        task_queue = _task_queue_for_fold(legacy_id, schedule, policy)
        if legacy_id.startswith('ovh-domain-') and legacy_id not in watchdog_list:
            watchdog_list.append(legacy_id)
            policy['watchdogQueueWrappers'].add(legacy_id)
            policy_changed = True
        row = {
            'legacy_id': legacy_id,
            'name': payload.get('name') or schedule.get('name') or legacy_id,
            'triggerType': 'SchedulerTick',
            'cron': schedule.get('cron'),
            'timezone': schedule.get('timezone', 'Europe/Paris'),
            'enabled': schedule.get('enabled', True),
            'workflow_id': schedule.get('workflow_id') or f'rbw.{legacy_id}',
            'task_queue': task_queue,
            'llm_connection': payload.get('llm_connection') or 'openrouter',
            'model': payload.get('model') or 'nvidia/nemotron-3-super-120b-a12b:free',
        }
        mapping_rows.append(row)
        existing_ids.add(legacy_id)
        folded.append({'legacy_id': legacy_id, 'task_queue': task_queue, 'cron': schedule.get('cron')})

    if policy_changed:
        raw_policy['watchdogQueueWrappers'] = watchdog_list
        raw_policy['generatedAt'] = datetime.now(timezone.utc).isoformat()
        notes = raw_policy.setdefault('notes', [])
        note = 'V6 builder auto-folded OVH scheduled-missing mapping entries into watchdog queue policy.'
        if note not in notes:
            notes.append(note)
        _backup(admin_policy_path, 'builder-autofold-policy')
        _write_json(admin_policy_path, raw_policy)

    return mapping_rows, folded, policy_changed


mapping_data = _read_json(mapping_path, [])
if not isinstance(mapping_data, list):
    raise SystemExit('automation-mapping.json must be a list')
existing = _load_existing_schedules()
policy = _load_admin_policy()

# V6 invariant: schedules.json must be generated from mapping. If an autonomous
# component has written a new schedule directly to schedules.json, fold it into
# mapping first instead of preserving an unowned schedule entry.
if os.getenv('RBW_DISABLE_SCHEDULE_AUTOFOLD', '').lower() in {'1', 'true', 'yes'}:
    folded: list[dict] = []
    policy_changed = False
else:
    mapping_data, folded, policy_changed = _fold_existing_missing_mapping(mapping_data, existing, policy)
    if folded:
        _backup(mapping_path, 'builder-autofold-mapping')
        _write_json(mapping_path, mapping_data)

manifest: list[dict] = []
seen_schedule_ids: set[str] = set()
for r in mapping_data:
    if r.get('triggerType') != 'SchedulerTick':
        continue
    legacy_id = r.get('legacy_id')
    if not legacy_id:
        continue
    sid = f'sched.{legacy_id}'
    if sid in seen_schedule_ids:
        continue
    seen_schedule_ids.add(sid)
    manifest.append({
        'schedule_id': sid,
        'workflow_id': r.get('workflow_id') or f'rbw.{legacy_id}',
        'task_queue': r.get('task_queue', 'default'),
        'cron': r.get('cron'),
        'timezone': r.get('timezone', 'Europe/Paris'),
        'enabled': r.get('enabled', True),
        'payload': {
            'legacy_id': legacy_id,
            'name': r.get('name'),
            'llm_connection': r.get('llm_connection'),
            'model': r.get('model'),
        },
    })

_backup(out_path, 'build-strict')
_write_json(out_path, {'schedules': manifest})
print(json.dumps({
    'generatedFromMapping': len(manifest),
    'preservedExisting': 0,
    'foldedExistingIntoMapping': len(folded),
    'folded': folded,
    'policyChanged': policy_changed,
    'total': len(manifest),
    'outPath': str(out_path),
}, ensure_ascii=False))
