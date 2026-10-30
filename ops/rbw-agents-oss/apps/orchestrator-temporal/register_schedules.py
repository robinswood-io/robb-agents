from __future__ import annotations

import argparse
import asyncio
import json
import logging
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

from activity_compaction import JSON_ADAPTER, JsonObject
from pydantic import JsonValue, TypeAdapter, ValidationError
from schedule_archive import schedule_archive_row as _schedule_archive_row

sys.path.insert(0, "/srv/rbw-agents-oss/scripts")
from lib.config_mutation import ConfigMutation
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleSpec,
    ScheduleState,
)
from workflows import RbwAutomationWorkflow

__all__ = ["_policy_task_queue", "_run_timeout_seconds", "upsert_schedules"]

WORKER_SERVICE = "rbw-agents-oss-worker.service"
ROOT = Path('/srv/rbw-agents-oss')
ADMIN_QUEUE_POLICY = ROOT / 'config' / 'admin-wrapper-queue-policy.json'
READY_SCHEDULES = ROOT / 'config' / 'temporal' / 'ready-schedules.json'
ARCHIVE_ROOT = ROOT / 'archive'
logger = logging.getLogger(__name__)
OBJECT_ADAPTER = TypeAdapter(JsonObject)
ROWS_ADAPTER = TypeAdapter(list[JsonObject])

def _payload(item: JsonObject) -> JsonObject:
    value = item.get("payload")
    return value if isinstance(value, dict) else {}

def _required_text(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise TypeError("Schedule field must be text")
    return value

class Arguments(argparse.Namespace):
    manifest: str = "/srv/rbw-agents-oss/config/temporal/schedules.json"
    no_replace: bool = False
    inspect_orphans: bool = False
    prune_orphans: bool = False
    skip_worker_restart: bool = False

DEFAULT_LLM_CONNECTION = "openrouter"
DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

# Critical inbound-mail autonomy chain that must remain fully autonomous.
CRITICAL_MAIL_AUTONOMY_SCHEDULES = [
    {
        "legacy_id": "inbound-email-sellsy-task-sync",
        "name": "Synchronisation réponses email entrantes vers tâches Sellsy",
        "task_queue": "campaigns",
        "cron": "10,40 8-19 * * 1-5",
    },
    {
        "legacy_id": "mail-autonomy-guard",
        "name": "Garde-fou autonomie mail entrant",
        "task_queue": "campaigns",
        "cron": "15,45 8-19 * * 1-5",
    },
    {
        "legacy_id": "mail-autonomy-regression-tests",
        "name": "Tests anti-régression autonomie mail",
        "task_queue": "campaigns",
        "cron": "25 8,12,16,19 * * 1-5",
    },
    {
        "legacy_id": "client-incident-autonomy-loop",
        "name": "Client Incident Autonomy — email → diagnostic → réparation → réponse contrôlée",
        "task_queue": "campaigns",
        "cron": "0 9,14,20 * * *",
    },
    {
        "legacy_id": "client-incident-autonomy-tests",
        "name": "Client Incident Autonomy — guardrail tests",
        "task_queue": "campaigns",
        "cron": "28 9,14,20 * * *",
    },
    {
        "legacy_id": "client-incident-autonomy-guard",
        "name": "Client Incident Autonomy — guard de fraîcheur, cadence et secrets",
        "task_queue": "campaigns",
        "cron": "35 9,14,20 * * *",
    },
    {
        "legacy_id": "bmb-wordpress-structural-audit",
        "name": "BMB WordPress — audit structurel read-only",
        "task_queue": "campaigns",
        "cron": "45 9,14,20 * * *",
    },
]


def _manifest_rows(path: Path) -> list[JsonObject]:
    if not path.exists():
        return []
    data = JSON_ADAPTER.validate_json(path.read_bytes())
    rows: list[JsonObject] = []
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                rows.extend([row for row in value if isinstance(row, dict)])
    elif isinstance(data, list):
        rows.extend([row for row in data if isinstance(row, dict)])
    return rows


def _timeout_lookup() -> dict[str, int]:
    rows = _manifest_rows(Path('/srv/rbw-agents-oss/config/command-manifest.json'))
    rows += _manifest_rows(Path('/srv/rbw-agents-oss/config/automation-mapping.json'))
    out: dict[str, int] = {}
    for row in rows:
        legacy_id = row.get('legacy_id')
        timeout = row.get('timeout_seconds')
        if legacy_id and isinstance(timeout, int) and timeout > 0:
            out[str(legacy_id)] = timeout
    return out


def _run_timeout_seconds(item: JsonObject, timeouts: dict[str, int]) -> int:
    explicit = item.get('run_timeout_seconds')
    if isinstance(explicit, int) and explicit > 0:
        return explicit
    payload = _payload(item)
    legacy_id = payload.get('legacy_id')
    wrapper_timeout = timeouts.get(str(legacy_id), 900)
    # Give the workflow room to record completion/failure and alerts, but keep
    # poisoned/stuck executions bounded by Temporal itself.
    return max(600, min(int(wrapper_timeout) + 900, 3600))


def _load_json(path: Path) -> JsonObject:
    if not path.exists():
        return {}
    try:
        data = JSON_ADAPTER.validate_json(path.read_bytes())
        return data if isinstance(data, dict) else {}
    except (OSError, UnicodeError, ValidationError):
        return {}


def _write_json(path: Path, data: JsonObject) -> None:
    with ConfigMutation('register-schedules') as mutation:
        mutation.write_json(path, data)


def _load_admin_queue_policy() -> JsonObject:
    defaults: JsonObject = {
        'defaults': {'adminTaskQueue': 'watchdog'},
        'watchdogQueueWrappers': ['temporal-register-schedules'],
    }
    data = _load_json(ADMIN_QUEUE_POLICY)
    if not data:
        return defaults
    out = defaults.copy()
    out.update(data)
    merged_defaults = OBJECT_ADAPTER.validate_python(defaults.get('defaults') or {})
    merged_defaults.update(OBJECT_ADAPTER.validate_python(data.get('defaults') or {}))
    out['defaults'] = merged_defaults
    return out


def _policy_task_queue(item: JsonObject, policy: JsonObject) -> tuple[str, str]:
    payload = _payload(item)
    legacy_id = str(payload.get('legacy_id') or item.get('legacy_id') or '')
    if legacy_id and legacy_id in TypeAdapter(list[str]).validate_python(policy.get('watchdogQueueWrappers') or []):
        return str(OBJECT_ADAPTER.validate_python(policy.get('defaults') or {}).get('adminTaskQueue') or 'watchdog'), 'admin-wrapper-queue-policy'
    return str(item.get('task_queue') or 'default'), 'schedule-config'


def _ensure_critical_mail_autonomy_entries() -> JsonObject:
    """Validate critical mail schedules and self-heal ready-schedules only.

    V8 invariant: register_schedules must not mutate schedules.json. The only
    source of Temporal schedule config is automation-mapping -> builder ->
    schedules.json. If a critical schedule is missing from schedules.json, report
    it and let the regression guard fail rather than silently creating config
    outside source-of-truth.
    """
    schedules_path = Path('/srv/rbw-agents-oss/config/temporal/schedules.json')
    ready_path = Path('/srv/rbw-agents-oss/config/temporal/ready-schedules.json')

    schedules_data = _load_json(schedules_path)
    schedule_rows = schedules_data.get('schedules', [])
    if not isinstance(schedule_rows, list):
        schedule_rows = []

    ready_data = _load_json(ready_path)
    ready_rows = ready_data.setdefault('schedules', [])
    if not isinstance(ready_rows, list):
        ready_rows = []
        ready_data['schedules'] = ready_rows
    ready_items = ready_data.setdefault('items', [])
    if not isinstance(ready_items, list):
        ready_items = []
        ready_data['items'] = ready_items

    missing_schedules: list[str] = []
    added_ready_schedules: list[str] = []
    added_ready_items: list[str] = []

    for cfg in CRITICAL_MAIL_AUTONOMY_SCHEDULES:
        legacy_id = cfg['legacy_id']
        name = cfg['name']
        sid = f"sched.{legacy_id}"
        workflow_id = f"rbw.{legacy_id}"

        if not any(isinstance(row, dict) and row.get('schedule_id') == sid for row in schedule_rows):
            missing_schedules.append(legacy_id)

        if not any(isinstance(row, dict) and row.get('legacy_id') == legacy_id for row in ready_rows):
            ready_rows.append(
                {
                    'schedule_id': sid,
                    'legacy_id': legacy_id,
                    'name': name,
                    'workflow_id': workflow_id,
                    'cron': cfg['cron'],
                    'timezone': 'Europe/Paris',
                }
            )
            added_ready_schedules.append(legacy_id)

        if not any(isinstance(item, dict) and item.get('capability_id') == legacy_id for item in ready_items):
            ready_items.append(
                {
                    'capability_id': legacy_id,
                    'mode': 'temporal',
                    'workflow_id': workflow_id,
                    'schedule_id': sid,
                }
            )
            added_ready_items.append(legacy_id)

    if added_ready_schedules or added_ready_items:
        _write_json(ready_path, ready_data)

    return {
        'missingSchedules': list[JsonValue](missing_schedules),
        'addedSchedules': [],
        'addedReadySchedules': list[JsonValue](added_ready_schedules),
        'addedReadyItems': list[JsonValue](added_ready_items),
        'schedulesJsonMutated': False,
    }


def _prune_ready_schedule_ids(schedule_ids: set[str]) -> JsonObject:
    data = _load_json(READY_SCHEDULES)
    if not data or not schedule_ids:
        return {'changed': False, 'removed': 0}
    removed = 0
    for key in ('schedules', 'items'):
        rows = data.get(key)
        if not isinstance(rows, list):
            continue
        kept: list[JsonValue] = []
        for row in rows:
            if isinstance(row, dict) and str(row.get('schedule_id') or '') in schedule_ids:
                removed += 1
            else:
                kept.append(row)
        data[key] = kept
    if removed:
        data['updatedAt'] = datetime.now(UTC).isoformat().replace('+00:00', 'Z')
        data['updatedBy'] = 'register-schedules-prune-orphans'
        _write_json(READY_SCHEDULES, data)
    return {'changed': bool(removed), 'removed': removed}


async def prune_orphan_schedules(client: Client, configured_ids: set[str], apply: bool) -> JsonObject:
    iterator = await client.list_schedules()
    live_ids = {row.id async for row in iterator}
    orphan_ids = sorted(live_ids - configured_ids)
    archive_rows: list[JsonValue] = []
    inspect_errors: list[JsonValue] = []
    for schedule_id in orphan_ids:
        try:
            desc = await client.get_schedule_handle(schedule_id).describe()
            archive_rows.append(_schedule_archive_row(schedule_id, desc))
        except Exception as exc:
            logger.exception("Unable to inspect schedule before reconciliation")
            inspect_errors.append({'scheduleId': schedule_id, 'error': repr(exc)})
    stamp = datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')
    archive_path = ARCHIVE_ROOT / datetime.now(UTC).strftime('%Y-%m') / 'temporal-schedule-reconcile' / f'{stamp}-orphans.json'
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    _ = archive_path.write_text(json.dumps({'generatedAt': datetime.now(UTC).isoformat().replace('+00:00', 'Z'), 'configuredCount': len(configured_ids), 'liveCountBefore': len(live_ids), 'orphanScheduleIds': list[JsonValue](orphan_ids), 'schedules': archive_rows, 'inspectErrors': inspect_errors}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    deleted: list[str] = []
    delete_errors: list[JsonValue] = []
    if apply and not inspect_errors:
        for schedule_id in orphan_ids:
            try:
                await client.get_schedule_handle(schedule_id).delete()
                deleted.append(schedule_id)
            except Exception as exc:
                logger.exception("Unable to remove archived schedule")
                delete_errors.append({'scheduleId': schedule_id, 'error': repr(exc)})
    live_after = set(live_ids)
    for _ in range(20 if deleted else 1):
        live_after_iterator = await client.list_schedules()
        live_after = {row.id async for row in live_after_iterator}
        if not (live_after - configured_ids):
            break
        await asyncio.sleep(0.5)
    ready_cleanup: JsonObject = _prune_ready_schedule_ids(set(deleted)) if deleted and not delete_errors else {'changed': False, 'removed': 0}
    return {
        'apply': apply,
        'configuredCount': len(configured_ids),
        'liveCountBefore': len(live_ids),
        'liveCountAfter': len(live_after),
        'orphanScheduleIds': list[JsonValue](orphan_ids),
        'deleted': list[JsonValue](deleted),
        'remainingOrphans': list[JsonValue](sorted(live_after - configured_ids)),
        'inspectErrors': inspect_errors,
        'deleteErrors': delete_errors,
        'readyScheduleCleanup': ready_cleanup,
        'archivePath': str(archive_path),
        'ok': not inspect_errors and not delete_errors and (not apply or not (live_after - configured_ids)),
    }


async def upsert_schedules(manifest_path: Path, replace: bool = True, prune_orphans: bool = False, inspect_orphans: bool = False) -> JsonObject:
    client = await Client.connect("127.0.0.1:57233")
    data = OBJECT_ADAPTER.validate_json(manifest_path.read_bytes())
    schedules = ROWS_ADAPTER.validate_python(data.get("schedules", []))
    timeouts = _timeout_lookup()
    queue_policy = _load_admin_queue_policy()
    created = 0
    replaced = 0
    skipped = 0
    failed = 0
    policy_forced_queues: list[JsonObject] = []

    for item in schedules:
        sid = _required_text(item["schedule_id"])
        payload = OBJECT_ADAPTER.validate_python(item.get("payload", {}))
        task_queue, queue_source = _policy_task_queue(item, queue_policy)
        if queue_source == 'admin-wrapper-queue-policy' and task_queue != item.get('task_queue'):
            policy_forced_queues.append({
                'schedule_id': sid,
                'legacy_id': payload.get('legacy_id'),
                'from': item.get('task_queue'),
                'to': task_queue,
            })
        action = ScheduleActionStartWorkflow(
            RbwAutomationWorkflow.run,
            payload,
            id=_required_text(item["workflow_id"]),
            task_queue=task_queue,
            run_timeout=timedelta(seconds=_run_timeout_seconds(item, timeouts)),
            task_timeout=timedelta(seconds=30),
        )
        spec = ScheduleSpec(
            cron_expressions=[_required_text(item["cron"]) ],
            time_zone_name=_required_text(item.get("timezone", "Europe/Paris")),
        )
        state = ScheduleState(paused=not bool(item.get("enabled", True)))
        sch = Schedule(action=action, spec=spec, state=state)

        try:
            handle = client.get_schedule_handle(sid)
            _ = await handle.describe()
            if replace:
                await handle.delete()
                _ = await client.create_schedule(sid, sch)
                replaced += 1
            else:
                skipped += 1
        except Exception:
            logger.exception("Unable to read or replace schedule; attempting creation")
            try:
                _ = await client.create_schedule(sid, sch)
                created += 1
            except Exception:
                logger.exception("Unable to create schedule")
                failed += 1

    result: JsonObject = {
        "total": len(schedules),
        "created": created,
        "replaced": replaced,
        "skipped": skipped,
        "failed": failed,
        "policyForcedQueues": list[JsonValue](policy_forced_queues),
    }
    if prune_orphans or inspect_orphans:
        result['pruneOrphans'] = await prune_orphan_schedules(client, {str(item['schedule_id']) for item in schedules}, apply=prune_orphans)
    return result


def restart_worker_service() -> JsonObject:
    """Restart worker after schedule/worker changes.

    This admin wrapper is run outside Temporal by the OSS MCP source. Restarting
    the worker is required for worker.py/activity.py concurrency/logging fixes to
    take effect and to clear sticky-cache/deadlock slots.
    """
    attempts = [
        ["systemctl", "restart", WORKER_SERVICE],
        ["sudo", "-n", "systemctl", "restart", WORKER_SERVICE],
    ]
    last = None
    for cmd in attempts:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
        last = proc
        if proc.returncode == 0:
            status = subprocess.run(
                ["systemctl", "is-active", WORKER_SERVICE],
                capture_output=True,
                check=False,
                text=True,
                timeout=20,
            )
            return {
                "ok": status.returncode == 0 and status.stdout.strip() == "active",
                "command": " ".join(cmd),
                "exitCode": proc.returncode,
                "stdout": proc.stdout[-1000:],
                "stderr": proc.stderr[-1000:],
                "isActive": status.stdout.strip(),
            }
    return {
        "ok": False,
        "command": " / ".join(" ".join(cmd) for cmd in attempts),
        "exitCode": last.returncode if last else 1,
        "stdout": (last.stdout if last else "")[-1000:],
        "stderr": (last.stderr if last else "no restart attempted")[-1000:],
        "isActive": None,
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument(
        "--manifest",
        default="/srv/rbw-agents-oss/config/temporal/schedules.json",
    )
    _ = parser.add_argument("--no-replace", action="store_true")
    _ = parser.add_argument("--inspect-orphans", action="store_true", help="Archive and report live schedules absent from the authoritative manifest without deleting")
    _ = parser.add_argument("--prune-orphans", action="store_true", help="Archive and delete live schedules absent from the authoritative manifest")
    _ = parser.add_argument("--skip-worker-restart", action="store_true")
    args = parser.parse_args(namespace=Arguments())

    ensure_result = _ensure_critical_mail_autonomy_entries()
    result = await upsert_schedules(Path(args.manifest), replace=not args.no_replace, prune_orphans=args.prune_orphans, inspect_orphans=args.inspect_orphans)
    result["criticalMailAutonomy"] = ensure_result
    if not args.skip_worker_restart:
        result["workerRestart"] = restart_worker_service()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raw_prune = result.get('pruneOrphans')
    prune_result = raw_prune if isinstance(raw_prune, dict) else {}
    if result.get('failed') or (prune_result and not prune_result.get('ok')):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
