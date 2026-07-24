from __future__ import annotations

import asyncio
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from temporalio.client import Client
from temporalio.worker import Worker

from workflows import RbwAutomationWorkflow
from activities import run_legacy_automation


def _queue_default_activity_slots(queue: str) -> int:
    if queue == 'watchdog':
        return 4
    if queue == 'campaigns':
        return 8
    if queue in {'ao', 'sync'}:
        return 5
    return 6


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
        if value < minimum:
            return minimum
        return value
    except Exception:
        return default


async def _on_fatal_error(exc: BaseException) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "component": "temporal-worker",
        "level": "error",
        "event": "fatal_worker_error",
        "error": repr(exc),
    }
    print(json.dumps(payload, ensure_ascii=False), flush=True)


async def _run_queue_worker(client: Client, temporal_host: str, queue: str) -> None:
    # Keep defaults conservative. The previous worker allowed a large sticky
    # workflow cache + high workflow-task concurrency for every queue in the
    # same process. Under schedule bursts this produced TMPRL1101 deadlock
    # detections and "Task not found when completing" cascades, leaving slots
    # permanently used and making campaign schedules stale. These defaults can
    # still be overridden explicitly from the service environment, but safe OSS
    # autonomy should not rely on high concurrency.
    max_cached_workflows = _env_int("TEMPORAL_MAX_CACHED_WORKFLOWS", 0, minimum=0)
    # V9: watchdog runs self-healing/observability jobs and is sensitive to
    # bursty manual + scheduled diagnostics. Keep its workflow task concurrency
    # deliberately low so activations stay tiny and do not trigger TMPRL1101
    # cascades under restarts/bursts. Other queues keep conservative defaults.
    queue_key = queue.upper().replace('-', '_')
    default_wf_tasks = 2 if queue == 'watchdog' else 6
    default_activities = _queue_default_activity_slots(queue)
    max_concurrent_workflow_tasks = _env_int(f"TEMPORAL_{queue_key}_MAX_CONCURRENT_WORKFLOW_TASKS", _env_int("TEMPORAL_MAX_CONCURRENT_WORKFLOW_TASKS", default_wf_tasks, minimum=1), minimum=1)
    max_concurrent_activities = _env_int(f"TEMPORAL_{queue_key}_MAX_CONCURRENT_ACTIVITIES", _env_int("TEMPORAL_MAX_CONCURRENT_ACTIVITIES", default_activities, minimum=1), minimum=1)
    max_concurrent_workflow_task_polls = _env_int(f"TEMPORAL_{queue_key}_MAX_CONCURRENT_WORKFLOW_TASK_POLLS", _env_int("TEMPORAL_MAX_CONCURRENT_WORKFLOW_TASK_POLLS", 1, minimum=1), minimum=1)
    max_concurrent_activity_task_polls = _env_int(f"TEMPORAL_{queue_key}_MAX_CONCURRENT_ACTIVITY_TASK_POLLS", _env_int("TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_POLLS", 1, minimum=1), minimum=1)
    graceful_shutdown_seconds = _env_int("TEMPORAL_GRACEFUL_SHUTDOWN_SECONDS", 30, minimum=0)

    worker = Worker(
        client,
        task_queue=queue,
        workflows=[RbwAutomationWorkflow],
        activities=[run_legacy_automation],
        max_cached_workflows=max_cached_workflows,
        max_concurrent_workflow_tasks=max_concurrent_workflow_tasks,
        max_concurrent_activities=max_concurrent_activities,
        max_concurrent_workflow_task_polls=max_concurrent_workflow_task_polls,
        max_concurrent_activity_task_polls=max_concurrent_activity_task_polls,
        graceful_shutdown_timeout=timedelta(seconds=graceful_shutdown_seconds),
        on_fatal_error=_on_fatal_error,
    )

    print(
        (
            f"Temporal worker connected to {temporal_host}, queue={queue}, "
            f"max_cached_workflows={max_cached_workflows}, "
            f"max_concurrent_workflow_tasks={max_concurrent_workflow_tasks}, "
            f"max_concurrent_activities={max_concurrent_activities}, "
            f"wf_polls={max_concurrent_workflow_task_polls}, "
            f"act_polls={max_concurrent_activity_task_polls}"
        ),
        flush=True,
    )

    await worker.run()


async def main() -> None:
    temporal_host = os.getenv("TEMPORAL_HOST", "127.0.0.1:57233")
    queue_env = os.getenv("TEMPORAL_TASK_QUEUES", "default,campaigns,ao,sync,watchdog")
    queues = [q.strip() for q in queue_env.split(",") if q.strip()]

    # V22: async activities offload blocking subprocess/alert/context work via
    # asyncio.to_thread(). Bound the default executor per worker process so a
    # burst of wrappers cannot create unbounded thread pressure. Dedicated
    # per-queue systemd workers mean this sizing is queue-local.
    default_threads = sum(_queue_default_activity_slots(q) for q in queues) + max(2, len(queues))
    threadpool_workers = _env_int("TEMPORAL_THREADPOOL_WORKERS", default_threads, minimum=2)
    asyncio.get_running_loop().set_default_executor(ThreadPoolExecutor(max_workers=threadpool_workers, thread_name_prefix="rbw-temporal"))
    print(f"Temporal worker threadpool configured: queues={queues}, max_workers={threadpool_workers}", flush=True)

    client = await Client.connect(temporal_host)
    await asyncio.gather(*(_run_queue_worker(client, temporal_host, queue) for queue in queues))


if __name__ == "__main__":
    asyncio.run(main())
