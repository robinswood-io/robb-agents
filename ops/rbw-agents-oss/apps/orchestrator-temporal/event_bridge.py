from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from temporalio.client import Client

try:
    from nats.aio.client import Client as NATS
except Exception:
    NATS = None


EVENT_MANIFEST = Path('/srv/rbw-agents-oss/config/temporal/event-triggers.json')
DEDUPE_LEDGER = Path('/srv/rbw-agents-oss/logs/event-bridge-dedupe.jsonl')
SUBJECT_MAP = {
    'FlagChange': 'rbw.flag_change',
    'SessionEnd': 'rbw.session_end',
}

DEDUPE_TTL_SECONDS = int(os.getenv('RBW_EVENT_DEDUPE_TTL_SECONDS', '21600'))  # 6h
MAX_IN_MEMORY_KEYS = int(os.getenv('RBW_EVENT_DEDUPE_MAX_KEYS', '10000'))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_event_key(trigger_type: str, legacy_id: str, event: dict) -> str:
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
                row = json.loads(line)
            except Exception:
                continue
            key = row.get('event_key')
            ts = row.get('ts_unix')
            if not key or ts is None:
                continue
            try:
                tsf = float(ts)
            except Exception:
                continue
            if tsf >= cutoff:
                keys[key] = tsf
    except Exception as exc:
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
        f.write(json.dumps(row, ensure_ascii=False) + '\n')


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
    if NATS is None:
        raise RuntimeError('nats-py not installed. pip install nats-py')

    mapping = json.loads(EVENT_MANIFEST.read_text(encoding='utf-8')).get('triggers', [])
    by_trigger: dict[str, list[dict]] = {}
    for row in mapping:
        if not row.get('enabled', True):
            continue
        by_trigger.setdefault(row['triggerType'], []).append(row)

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

    async def mk_handler(trigger_type: str):
        async def handler(msg):
            try:
                event = json.loads(msg.data.decode('utf-8'))
            except Exception as exc:
                print(f"[event-bridge] invalid JSON for {trigger_type}: {exc}", flush=True)
                return

            rows = by_trigger.get(trigger_type, [])
            if not rows:
                return

            for row in rows:
                legacy_id = row.get('legacy_id') or '<unknown>'
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
                    payload = {
                        'legacy_id': legacy_id,
                        'name': row.get('name'),
                        'event': event,
                    }

                    try:
                        await temporal.start_workflow(
                            'RbwAutomationWorkflow',
                            payload,
                            id=workflow_id,
                            task_queue=row.get('task_queue', 'default'),
                        )
                        dedupe_keys[event_key] = time.time()
                        _append_dedupe_ledger(event_key, trigger_type, legacy_id, 'started', workflow_id)
                        print(
                            f"triggered {workflow_id} from {trigger_type} key={event_key[:12]}",
                            flush=True,
                        )
                    except Exception as exc:
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
                    print(
                        f"[event-bridge] handler error trigger_type={trigger_type} legacy_id={legacy_id} err={exc}",
                        flush=True,
                    )

            _prune_in_memory(dedupe_keys)

        return handler

    for trigger_type, subject in SUBJECT_MAP.items():
        await nc.subscribe(subject, cb=await mk_handler(trigger_type))
        print(f"subscribed: {subject} ({trigger_type})", flush=True)

    while True:
        await asyncio.sleep(3600)


if __name__ == '__main__':
    asyncio.run(main())
