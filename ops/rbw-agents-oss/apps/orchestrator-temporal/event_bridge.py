from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Protocol, cast

from pydantic import JsonValue, TypeAdapter

if TYPE_CHECKING:
    from nats.aio.msg import Msg
    from nats.aio.subscription import Subscription
from datetime import UTC, datetime
from pathlib import Path

from nats.aio.client import Client as NATS
from temporalio.client import Client

logger = logging.getLogger(__name__)


class Subscriber(Protocol):
    """The callback subscription used here; the SDK also has an untyped future API."""

    async def subscribe(self, subject: str, *, cb: Callable[[Msg], Awaitable[None]]) -> Subscription: ...


EVENT_MANIFEST = Path('/srv/rbw-agents-oss/config/temporal/event-triggers.json')
DEDUPE_LEDGER = Path('/srv/rbw-agents-oss/logs/event-bridge-dedupe.jsonl')
SUBJECT_MAP = {
    'FlagChange': 'rbw.flag_change',
    'SessionEnd': 'rbw.session_end',
}

DEDUPE_TTL_SECONDS = int(os.getenv('RBW_EVENT_DEDUPE_TTL_SECONDS', '21600'))  # 6h
MAX_IN_MEMORY_KEYS = int(os.getenv('RBW_EVENT_DEDUPE_MAX_KEYS', '10000'))


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _canonical_event_key(trigger_type: str, legacy_id: str, event: dict[str, JsonValue]) -> str:
    payload = {
        'trigger_type': trigger_type,
        'legacy_id': legacy_id,
        'event': event,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def _load_recent_dedupe_keys() -> dict[str, float]:
    if not DEDUPE_LEDGER.exists():
        return {}

    now = time.time()
    cutoff = now - DEDUPE_TTL_SECONDS
    keys: dict[str, float] = {}

    try:
        for line in DEDUPE_LEDGER.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            try:
                row = TypeAdapter(dict[str, JsonValue]).validate_json(line)
            except ValueError:
                continue
            key = row.get('event_key')
            ts = row.get('ts_unix')
            if not isinstance(key, str) or not key or not isinstance(ts, (str, int, float)):
                continue
            try:
                tsf = float(ts)
            except ValueError:
                continue
            if tsf >= cutoff:
                keys[key] = tsf
    except OSError as exc:
        print(f"[event-bridge] failed loading dedupe ledger: {exc}", flush=True)

    return keys


def _append_dedupe_ledger(event_key: str, trigger_type: str, legacy_id: str, status: str, workflow_id: str | None) -> None:
    DEDUPE_LEDGER.parent.mkdir(parents=True, exist_ok=True)
    row = {
        'ts': _now_iso(),
        'ts_unix': time.time(),
        'event_key': event_key,
        'trigger_type': trigger_type,
        'legacy_id': legacy_id,
        'status': status,
        'workflow_id': workflow_id,
    }
    with DEDUPE_LEDGER.open('a', encoding='utf-8') as f:
        _ = f.write(json.dumps(row, ensure_ascii=False) + '\n')


def _prune_in_memory(keys: dict[str, float]) -> None:
    if len(keys) <= MAX_IN_MEMORY_KEYS:
        return
    # Keep the newest keys only.
    newest = sorted(keys.items(), key=lambda kv: kv[1], reverse=True)[:MAX_IN_MEMORY_KEYS]
    keys.clear()
    keys.update(dict(newest))


def _is_recent_duplicate(keys: dict[str, float], event_key: str) -> bool:
    ts = keys.get(event_key)
    if ts is None:
        return False
    return (time.time() - ts) <= DEDUPE_TTL_SECONDS


async def main() -> None:
    manifest = TypeAdapter(dict[str, JsonValue]).validate_json(EVENT_MANIFEST.read_bytes())
    mapping = TypeAdapter(list[dict[str, JsonValue]]).validate_python(manifest.get('triggers', []))
    by_trigger: dict[str, list[dict[str, JsonValue]]] = {}
    for row in mapping:
        if not row.get('enabled', True):
            continue
        trigger_type = row['triggerType']
        if not isinstance(trigger_type, str):
            raise TypeError('triggerType must be a string')
        by_trigger.setdefault(trigger_type, []).append(row)

    dedupe_keys = _load_recent_dedupe_keys()
    print(f"[event-bridge] loaded {len(dedupe_keys)} recent dedupe keys", flush=True)

    temporal = await Client.connect('127.0.0.1:57233')
    nc = NATS()
    await nc.connect(
        servers=['nats://127.0.0.1:14222'],
        name='rbw-event-bridge',
        reconnect_time_wait=2,
        max_reconnect_attempts=-1,
    )

    async def mk_handler(trigger_type: str) -> Callable[[Msg], Awaitable[None]]:
        async def handler(msg: Msg) -> None:
            try:
                event = TypeAdapter(dict[str, JsonValue]).validate_json(msg.data)
            except ValueError as exc:
                print(f"[event-bridge] invalid JSON for {trigger_type}: {exc}", flush=True)
                return

            rows = by_trigger.get(trigger_type, [])
            if not rows:
                return

            for row in rows:
                legacy_id = row.get('legacy_id') or '<unknown>'
                if not isinstance(legacy_id, str):
                    raise TypeError('legacy_id must be a string')
                workflow_base = row.get('workflow_id') or f"rbw.{legacy_id}"

                try:
                    event_key = _canonical_event_key(trigger_type, legacy_id, event)

                    if _is_recent_duplicate(dedupe_keys, event_key):
                        print(
                            f"[event-bridge] skipped duplicate trigger_type={trigger_type} legacy_id={legacy_id} key={event_key[:12]}",
                            flush=True,
                        )
                        continue

                    workflow_id = f"{workflow_base}-{event_key[:12]}"
                    payload: dict[str, JsonValue] = {
                        'legacy_id': legacy_id,
                        'name': row.get('name'),
                        'event': event,
                    }

                    try:
                        task_queue = row.get('task_queue', 'default')
                        if not isinstance(task_queue, str):
                            raise TypeError('task_queue must be a string')
                        _ = await temporal.start_workflow(
                            'RbwAutomationWorkflow',
                            payload,
                            id=workflow_id,
                            task_queue=task_queue,
                        )
                        dedupe_keys[event_key] = time.time()
                        _append_dedupe_ledger(event_key, trigger_type, legacy_id, 'started', workflow_id)
                        print(
                            f"triggered {workflow_id} from {trigger_type} key={event_key[:12]}",
                            flush=True,
                        )
                    except Exception as exc:
                        logger.exception("Temporal event dispatch failed")
                        msg_text = str(exc).lower()
                        if 'already' in msg_text and 'workflow' in msg_text:
                            dedupe_keys[event_key] = time.time()
                            _append_dedupe_ledger(event_key, trigger_type, legacy_id, 'already_started', workflow_id)
                            print(
                                f"[event-bridge] duplicate already started workflow_id={workflow_id}",
                                flush=True,
                            )
                        else:
                            print(
                                f"[event-bridge] trigger failed trigger_type={trigger_type} legacy_id={legacy_id} err={exc}",
                                flush=True,
                            )
                except Exception as exc:
                    logger.exception("Event handler failed")
                    print(
                        f"[event-bridge] handler error trigger_type={trigger_type} legacy_id={legacy_id} err={exc}",
                        flush=True,
                    )

            _prune_in_memory(dedupe_keys)

        return handler

    subscriber = cast(Subscriber, nc)
    for trigger_type, subject in SUBJECT_MAP.items():
        _ = await subscriber.subscribe(subject, cb=await mk_handler(trigger_type))
        print(f"subscribed: {subject} ({trigger_type})", flush=True)

    while True:
        await asyncio.sleep(3600)


if __name__ == '__main__':
    asyncio.run(main())

__all__ = ["_append_dedupe_ledger", "_canonical_event_key", "_is_recent_duplicate", "_load_recent_dedupe_keys", "_prune_in_memory", "main"]
