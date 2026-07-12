from __future__ import annotations
import asyncio
import argparse
import base64
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

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

WORKER_SERVICE = "rbw-agents-oss-worker.service"
ROOT = Path('/srv/rbw-agents-oss')
ADMIN_QUEUE_POLICY = ROOT / 'config' / 'admin-wrapper-queue-policy.json'
READY_SCHEDULES = ROOT / 'config' / 'temporal' / 'ready-schedules.json'
ARCHIVE_ROOT = ROOT / 'archive'
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


def _manifest_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    rows: list[dict] = []
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


def _run_timeout_seconds(item: dict, timeouts: dict[str, int]) -> int:
    explicit = item.get('run_timeout_seconds')
    if isinstance(explicit, int) and explicit > 0:
        return explicit
    payload = item.get('payload') if isinstance(item.get('payload'), dict) else {}
    legacy_id = payload.get('legacy_id')
    wrapper_timeout = timeouts.get(str(legacy_id), 900)
    # Give the workflow room to record completion/failure and alerts, but keep
    # poisoned/stuck executions bounded by Temporal itself.
    return max(600, min(int(wrapper_timeout) + 900, 3600))


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_json(path: Path, data: dict) -> None:
    with ConfigMutation('register-schedules') as mutation:
        mutation.write_json(path, data)


def _load_admin_queue_policy() -> dict:
    defaults = {
        'defaults': {'adminTaskQueue': 'watchdog'},
        'watchdogQueueWrappers': ['temporal-register-schedules'],
    }
    data = _load_json(ADMIN_QUEUE_POLICY)
    if not data:
        return defaults
    out = defaults.copy()
    out.update(data)
    merged_defaults = dict(defaults.get('defaults') or {})
    merged_defaults.update(data.get('defaults') or {})
    out['defaults'] = merged_defaults
    return out


def _policy_task_queue(item: dict, policy: dict) -> tuple[str, str]:
    payload = item.get('payload') if isinstance(item.get('payload'), dict) else {}
    legacy_id = str(payload.get('legacy_id') or item.get('legacy_id') or '')
    if legacy_id and legacy_id in set(policy.get('watchdogQueueWrappers') or []):
        return str((policy.get('defaults') or {}).get('adminTaskQueue') or 'watchdog'), 'admin-wrapper-queue-policy'
    return str(item.get('task_queue') or 'default'), 'schedule-config'


def _ensure_critical_mail_autonomy_entries() -> dict:
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
        'missingSchedules': missing_schedules,
        'addedSchedules': [],
        'addedReadySchedules': added_ready_schedules,
        'addedReadyItems': added_ready_items,
        'schedulesJsonMutated': False,
    }


def _schedule_archive_row(schedule_id: str, desc) -> dict:
    action = desc.schedule.action
    spec = desc.schedule.spec
    state = desc.schedule.state
    raw = desc.raw_description.SerializeToString() if getattr(desc, 'raw_description', None) is not None else b''
    args = []
    for payload in list(getattr(action, 'args', None) or []):
        metadata = {str(k): bytes(v).decode('utf-8', errors='replace') for k, v in dict(payload.metadata).items()}
        args.append({'metadata': metadata, 'dataBase64': base64.b64encode(bytes(payload.data)).decode('ascii')})
    return {
        'scheduleId': schedule_id,
        'workflowId': getattr(action, 'id', None),
        'workflowType': str(getattr(action, 'workflow', None) or ''),
        'taskQueue': getattr(action, 'task_queue', None),
        'runTimeoutSeconds': int(getattr(action, 'run_timeout', timedelta(0)).total_seconds()) if getattr(action, 'run_timeout', None) else None,
        'taskTimeoutSeconds': int(getattr(action, 'task_timeout', timedelta(0)).total_seconds()) if getattr(action, 'task_timeout', None) else None,
        'args': args,
        'cronExpressions': list(getattr(spec, 'cron_expressions', None) or []),
        'calendarsRepr': repr(list(getattr(spec, 'calendars', None) or [])),
        'timeZone': getattr(spec, 'time_zone_name', None),
        'paused': bool(getattr(state, 'paused', False)),
        'note': getattr(state, 'note', None),
        'rawDescriptionProtoBase64': base64.b64encode(raw).decode('ascii'),
    }


def _prune_ready_schedule_ids(schedule_ids: set[str]) -> dict:
    data = _load_json(READY_SCHEDULES)
    if not data or not schedule_ids:
        return {'changed': False, 'removed': 0}
    removed = 0
    for key in ('schedules', 'items'):
        rows = data.get(key)
        if not isinstance(rows, list):
            continue
        kept = []
        for row in rows:
            if isinstance(row, dict) and str(row.get('schedule_id') or '') in schedule_ids:
                removed += 1
            else:
                kept.append(row)
        data[key] = kept
    if removed:
        data['updatedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        data['updatedBy'] = 'register-schedules-prune-orphans'
        _write_json(READY_SCHEDULES, data)
    return {'changed': bool(removed), 'removed': removed}


async def prune_orphan_schedules(client: Client, configured_ids: set[str], apply: bool) -> dict:
    iterator = await client.list_schedules()
    live_ids = {row.id async for row in iterator}
    orphan_ids = sorted(live_ids - configured_ids)
    archive_rows = []
    inspect_errors = []
    for schedule_id in orphan_ids:
        try:
            desc = await client.get_schedule_handle(schedule_id).describe()
            archive_rows.append(_schedule_archive_row(schedule_id, desc))
        except Exception as exc:
            inspect_errors.append({'scheduleId': schedule_id, 'error': repr(exc)})
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    archive_path = ARCHIVE_ROOT / datetime.now(timezone.utc).strftime('%Y-%m') / 'temporal-schedule-reconcile' / f'{stamp}-orphans.json'
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    archive_path.write_text(json.dumps({'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'configuredCount': len(configured_ids), 'liveCountBefore': len(live_ids), 'orphanScheduleIds': orphan_ids, 'schedules': archive_rows, 'inspectErrors': inspect_errors}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    deleted = []
    delete_errors = []
    if apply and not inspect_errors:
        for schedule_id in orphan_ids:
            try:
                await client.get_schedule_handle(schedule_id).delete()
                deleted.append(schedule_id)
            except Exception as exc:
                delete_errors.append({'scheduleId': schedule_id, 'error': repr(exc)})
    live_after = set(live_ids)
    for _ in range(20 if deleted else 1):
        live_after_iterator = await client.list_schedules()
        live_after = {row.id async for row in live_after_iterator}
        if not (live_after - configured_ids):
            break
        await asyncio.sleep(0.5)
    ready_cleanup = _prune_ready_schedule_ids(set(deleted)) if deleted and not delete_errors else {'changed': False, 'removed': 0}
    return {
        'apply': apply,
        'configuredCount': len(configured_ids),
        'liveCountBefore': len(live_ids),
        'liveCountAfter': len(live_after),
        'orphanScheduleIds': orphan_ids,
        'deleted': deleted,
        'remainingOrphans': sorted(live_after - configured_ids),
        'inspectErrors': inspect_errors,
        'deleteErrors': delete_errors,
        'readyScheduleCleanup': ready_cleanup,
        'archivePath': str(archive_path),
        'ok': not inspect_errors and not delete_errors and (not apply or not (live_after - configured_ids)),
    }


async def upsert_schedules(manifest_path: Path, replace: bool = True, prune_orphans: bool = False, inspect_orphans: bool = False) -> dict:
    client = await Client.connect("127.0.0.1:57233")
    data = json.loads(manifest_path.read_text())
    schedules = data.get("schedules", [])
    timeouts = _timeout_lookup()
    queue_policy = _load_admin_queue_policy()
    created = 0
    replaced = 0
    skipped = 0
    failed = 0
    policy_forced_queues: list[dict] = []

    for item in schedules:
        sid = item["schedule_id"]
        payload = item.get("payload", {})
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
            id=item["workflow_id"],
            task_queue=task_queue,
            run_timeout=timedelta(seconds=_run_timeout_seconds(item, timeouts)),
            task_timeout=timedelta(seconds=30),
        )
        spec = ScheduleSpec(
            cron_expressions=[item["cron"]],
            time_zone_name=item.get("timezone", "Europe/Paris"),
        )
        state = ScheduleState(paused=not bool(item.get("enabled", True)))
        sch = Schedule(action=action, spec=spec, state=state)

        try:
            handle = client.get_schedule_handle(sid)
            await handle.describe()
            if replace:
                await handle.delete()
                await client.create_schedule(sid, sch)
                replaced += 1
            else:
                skipped += 1
        except Exception:
            try:
                await client.create_schedule(sid, sch)
                created += 1
            except Exception:
                failed += 1

    result = {
        "total": len(schedules),
        "created": created,
        "replaced": replaced,
        "skipped": skipped,
        "failed": failed,
        "policyForcedQueues": policy_forced_queues,
    }
    if prune_orphans or inspect_orphans:
        result['pruneOrphans'] = await prune_orphan_schedules(client, {str(item['schedule_id']) for item in schedules}, apply=prune_orphans)
    return result


def restart_worker_service() -> dict:
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
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        last = proc
        if proc.returncode == 0:
            status = subprocess.run(
                ["systemctl", "is-active", WORKER_SERVICE],
                capture_output=True,
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
    parser.add_argument(
        "--manifest",
        default="/srv/rbw-agents-oss/config/temporal/schedules.json",
    )
    parser.add_argument("--no-replace", action="store_true")
    parser.add_argument("--inspect-orphans", action="store_true", help="Archive and report live schedules absent from the authoritative manifest without deleting")
    parser.add_argument("--prune-orphans", action="store_true", help="Archive and delete live schedules absent from the authoritative manifest")
    parser.add_argument("--skip-worker-restart", action="store_true")
    args = parser.parse_args()

    ensure_result = _ensure_critical_mail_autonomy_entries()
    result = await upsert_schedules(Path(args.manifest), replace=not args.no_replace, prune_orphans=args.prune_orphans, inspect_orphans=args.inspect_orphans)
    result["criticalMailAutonomy"] = ensure_result
    if not args.skip_worker_restart:
        result["workerRestart"] = restart_worker_service()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    prune_result = result.get('pruneOrphans') if isinstance(result.get('pruneOrphans'), dict) else {}
    if result.get('failed') or (prune_result and not prune_result.get('ok')):
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
