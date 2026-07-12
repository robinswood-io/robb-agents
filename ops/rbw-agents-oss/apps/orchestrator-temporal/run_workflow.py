from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from temporalio.client import Client

from workflows import RbwAutomationWorkflow

ROOT = Path('/srv/rbw-agents-oss')
ADMIN_QUEUE_POLICY = ROOT / 'config/admin-wrapper-queue-policy.json'
DEFAULT_POLICY = {
    'defaults': {
        'manualDuplicatePolicy': 'skip_if_running',
        'manualDuplicateAgeMinutes': 45,
        'adminTaskQueue': 'watchdog',
    },
    'watchdogQueueWrappers': ['temporal-register-schedules'],
    'duplicateProtectedWrappers': ['temporal-register-schedules'],
}

# 2026-06-15: current systemd worker is running non-watchdog queues; manual
# dispatches for the agent-task context/posts executor were getting starved on
# watchdog (activity scheduled, never started). Keep this override narrow so
# scheduled/admin watchdog semantics are not changed globally.
MANUAL_SYNC_QUEUE_OVERRIDES = {
    'agent-task-context-enriched-campaign-executor',
    'agent-task-context-enriched-campaign-executor-overnight',
}

TRANSIENT_TEMPORAL_MARKERS = (
    'too many clients',
    'context deadline exceeded',
    'shard status unknown',
    'StatusCode.UNAVAILABLE',
    'RPCStatusCode.UNAVAILABLE',
    'RPCError',
    'DeadlineExceeded',
)


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _load_policy() -> dict:
    policy = DEFAULT_POLICY.copy()
    loaded = _load_json(ADMIN_QUEUE_POLICY)
    if loaded:
        policy.update(loaded)
        defaults = dict(DEFAULT_POLICY.get('defaults') or {})
        defaults.update(loaded.get('defaults') or {})
        policy['defaults'] = defaults
    return policy


def _load_rows(path: Path):
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding='utf-8'))
    rows = []
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                rows.extend([r for r in value if isinstance(r, dict)])
    elif isinstance(data, list):
        rows.extend([r for r in data if isinstance(r, dict)])
    return rows


def _lookup(legacy_id: str) -> dict:
    rows = _load_rows(ROOT / 'config' / 'command-manifest.json') + _load_rows(ROOT / 'config' / 'automation-mapping.json')
    merged = {}
    for row in rows:
        if row.get('legacy_id') == legacy_id:
            merged.update(row)
    return merged


def _task_queue_for(legacy_id: str, row: dict, policy: dict) -> tuple[str, str]:
    if legacy_id in MANUAL_SYNC_QUEUE_OVERRIDES:
        return 'sync', 'manual-sync-override-2026-06-15'
    admin_queue = (policy.get('defaults') or {}).get('adminTaskQueue') or 'watchdog'
    watchdog_wrappers = set(policy.get('watchdogQueueWrappers') or [])
    if legacy_id in watchdog_wrappers:
        return str(admin_queue), 'admin-wrapper-queue-policy'
    return str(row.get('task_queue') or row.get('taskQueue') or 'default'), 'manifest'


def _duplicate_protected(legacy_id: str, policy: dict) -> bool:
    return legacy_id in set(policy.get('duplicateProtectedWrappers') or [])


def _parse_flags(argv: list[str]) -> dict:
    return {
        'force': '--force' in argv,
        'no_dedupe': '--no-dedupe' in argv,
        'start_only': '--start-only' in argv,
    }


def _env_float(name: str, default: float, minimum: float = 0.1) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
        return max(value, minimum)
    except Exception:
        return default


def _is_transient_temporal_error(exc: BaseException) -> bool:
    text = repr(exc)
    return any(marker in text for marker in TRANSIENT_TEMPORAL_MARKERS)


async def _find_running_duplicate(client: Client, legacy_id: str, max_age_minutes: float) -> dict | None:
    now = datetime.now(timezone.utc)
    prefix = f'manual-{legacy_id}-'
    scheduled_prefix = f'rbw.{legacy_id}'
    try:
        async for wf in client.list_workflows('ExecutionStatus="Running"'):
            wf_id = str(wf.id)
            if not (wf_id.startswith(prefix) or wf_id.startswith(scheduled_prefix)):
                continue
            start = wf.start_time
            age_minutes = None
            if start:
                age_minutes = (now - start.astimezone(timezone.utc)).total_seconds() / 60
            if age_minutes is None or age_minutes <= max_age_minutes:
                return {
                    'workflowId': wf.id,
                    'runId': wf.run_id,
                    'taskQueue': getattr(wf, 'task_queue', None),
                    'startTime': start.isoformat() if start else None,
                    'ageMinutes': round(age_minutes, 1) if age_minutes is not None else None,
                }
    except Exception as exc:
        return {'dedupeVisibilityError': repr(exc)}
    return None


async def _connect_client() -> Client:
    timeout = _env_float('RBW_TEMPORAL_CLIENT_CONNECT_TIMEOUT_SECONDS', 8.0, 1.0)
    return await asyncio.wait_for(Client.connect('127.0.0.1:57233'), timeout=timeout)


async def main():
    argv = sys.argv[1:]
    flags = _parse_flags(argv)
    positional = [arg for arg in argv if not arg.startswith('--')]
    legacy_id = positional[0] if positional else 'manual-test'

    policy = _load_policy()
    row = _lookup(legacy_id)
    payload = {
        'legacy_id': legacy_id,
        'name': row.get('name') or 'Manual workflow test',
        'llm_connection': row.get('llm_connection') or row.get('llmConnection'),
        'model': row.get('model'),
        'manualTrigger': True,
        'startOnlyTrigger': flags['start_only'],
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    task_queue, task_queue_source = _task_queue_for(legacy_id, row, policy)

    try:
        client = await _connect_client()
    except Exception as exc:
        print(json.dumps({
            'started': False,
            'ok': False,
            'status': 'temporal_dependency_degraded',
            'reason': 'temporal_client_connect_failed',
            'legacy_id': legacy_id,
            'task_queue': task_queue,
            'task_queue_source': task_queue_source,
            'errorType': exc.__class__.__name__,
            'error': repr(exc),
            'hint': 'Back off manual Temporal dispatch until Temporal/Postgres availability recovers.',
        }, ensure_ascii=False, indent=2))
        sys.exit(75 if _is_transient_temporal_error(exc) else 1)

    duplicate = None
    defaults = policy.get('defaults') or {}
    duplicate_policy = defaults.get('manualDuplicatePolicy') or 'skip_if_running'
    duplicate_age_minutes = float(defaults.get('manualDuplicateAgeMinutes') or 45)
    if duplicate_policy == 'skip_if_running' and not flags['force'] and not flags['no_dedupe']:
        should_dedupe = flags['start_only'] or _duplicate_protected(legacy_id, policy)
        if should_dedupe:
            dedupe_timeout = _env_float('RBW_MANUAL_DEDUPE_VISIBILITY_TIMEOUT_SECONDS', 4.0, 0.5)
            try:
                duplicate = await asyncio.wait_for(_find_running_duplicate(client, legacy_id, duplicate_age_minutes), timeout=dedupe_timeout)
            except Exception as exc:
                duplicate = {'dedupeVisibilityError': repr(exc), 'boundedBySeconds': dedupe_timeout}
            if duplicate and 'dedupeVisibilityError' not in duplicate:
                print(json.dumps({
                    'skipped': True,
                    'reason': 'duplicate_running_workflow',
                    'legacy_id': legacy_id,
                    'task_queue': task_queue,
                    'task_queue_source': task_queue_source,
                    'duplicate': duplicate,
                    'hint': 'Use --force to bypass duplicate protection.',
                }, ensure_ascii=False, indent=2))
                return

    rid = f"manual-{legacy_id}-{uuid.uuid4().hex[:10]}"
    try:
        handle = await client.start_workflow(
            RbwAutomationWorkflow.run,
            payload,
            id=rid,
            task_queue=task_queue,
        )
    except Exception as exc:
        print(json.dumps({
            'started': False,
            'ok': False,
            'status': 'temporal_dependency_degraded' if _is_transient_temporal_error(exc) else 'workflow_start_failed',
            'reason': 'start_workflow_failed',
            'legacy_id': legacy_id,
            'task_queue': task_queue,
            'task_queue_source': task_queue_source,
            'dedupe': {'visibility': duplicate},
            'errorType': exc.__class__.__name__,
            'error': repr(exc),
        }, ensure_ascii=False, indent=2))
        sys.exit(75 if _is_transient_temporal_error(exc) else 1)

    started_payload = {
        'started': True,
        'workflow_id': rid,
        'first_execution_run_id': handle.first_execution_run_id,
        'task_queue': task_queue,
        'task_queue_source': task_queue_source,
        'dedupe': {'visibility': duplicate},
    }
    if flags['start_only']:
        started_payload['startOnly'] = True
        print(json.dumps(started_payload, ensure_ascii=False, indent=2))
        return

    result_timeout = _env_float('RBW_MANUAL_WORKFLOW_RESULT_TIMEOUT_SECONDS', 90.0, 1.0)
    try:
        result = await asyncio.wait_for(handle.result(), timeout=result_timeout)
    except asyncio.TimeoutError:
        print(json.dumps({
            **started_payload,
            'ok': True,
            'status': 'result_deferred',
            'resultDeferred': True,
            'resultTimeoutSeconds': result_timeout,
            'summary': 'Workflow started; result polling intentionally stopped to avoid Temporal/Postgres client amplification.',
            'hint': 'Read the wrapper report artifact or workflow history after Temporal availability recovers.',
        }, ensure_ascii=False, indent=2))
        return
    except Exception as exc:
        if _is_transient_temporal_error(exc):
            print(json.dumps({
                **started_payload,
                'ok': True,
                'status': 'result_unavailable_temporal_degraded',
                'resultDeferred': True,
                'errorType': exc.__class__.__name__,
                'error': repr(exc),
                'summary': 'Workflow start succeeded but result/history polling failed due Temporal/Postgres availability; not treating dispatch as failed.',
                'hint': 'Read the wrapper report artifact or retry status after Temporal availability recovers.',
            }, ensure_ascii=False, indent=2))
            return
        raise

    print(json.dumps({
        'workflow_id': rid,
        'task_queue': task_queue,
        'task_queue_source': task_queue_source,
        'dedupe': {
            'enabled': _duplicate_protected(legacy_id, policy) and not flags['force'] and not flags['no_dedupe'],
            'visibility': duplicate,
        },
        'result': result,
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
