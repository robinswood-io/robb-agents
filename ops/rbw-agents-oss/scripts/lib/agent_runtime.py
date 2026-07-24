#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(os.getenv('OSS_ROOT', '/srv/rbw-agents-oss'))
WS = Path(os.getenv('CRAFT_WORKSPACE', '/home/craft/.craft-agent/workspaces/my-workspace-2'))
OPS = WS / 'campaigns' / 'ops'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: str | Path, default: Any) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json_atomic(path: str | Path, payload: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f'.{p.name}.{uuid.uuid4().hex}.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(p)


def append_jsonl(path: str | Path, payload: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open('a', encoding='utf-8') as f:
        f.write(json.dumps(payload, ensure_ascii=False) + '\n')


def standard_report(
    *,
    capability_id: str,
    ok: bool = True,
    status: str = 'processed',
    summary: str = '',
    counts: dict[str, Any] | None = None,
    artifacts: dict[str, Any] | None = None,
    blocking_reasons: list[str] | None = None,
    warning_reasons: list[str] | None = None,
    checks: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    contract_version: str = 'oss-agent-report-envelope-v2',
    updated_by: str | None = None,
) -> dict[str, Any]:
    return {
        'generatedAt': now_iso(),
        'contractVersion': contract_version,
        'capabilityId': capability_id,
        'ok': bool(ok),
        'status': status,
        'summary': summary or f'{capability_id}: {status}',
        'counts': counts or {},
        'blockingReasons': blocking_reasons or [],
        'warningReasons': warning_reasons or [],
        'artifacts': artifacts or {},
        'checks': checks or {},
        'data': data or {},
        'updatedBy': updated_by or capability_id,
    }


@contextmanager
def run_context(capability_id: str, *, budget_seconds: int | None = None) -> Iterator[dict[str, Any]]:
    start = time.monotonic()
    ctx = {
        'capabilityId': capability_id,
        'idempotencyKey': f'{capability_id}:{now_iso()}',
        'budgetSeconds': budget_seconds,
        'stageTimings': {},
        'startedAt': now_iso(),
    }
    try:
        yield ctx
    finally:
        elapsed = round(time.monotonic() - start, 3)
        ctx['elapsedSeconds'] = elapsed
        ctx['budgetExceeded'] = bool(budget_seconds is not None and elapsed > budget_seconds)


@contextmanager
def stage(ctx: dict[str, Any], name: str) -> Iterator[None]:
    t = time.monotonic()
    try:
        yield
    finally:
        ctx.setdefault('stageTimings', {})[name] = round(time.monotonic() - t, 3)


def write_report_and_history(report_path: str | Path, history_path: str | Path, report: dict[str, Any]) -> None:
    write_json_atomic(report_path, report)
    append_jsonl(history_path, {
        'ts': report.get('generatedAt') or now_iso(),
        'capabilityId': report.get('capabilityId'),
        'ok': report.get('ok'),
        'status': report.get('status'),
        'summary': report.get('summary'),
        'counts': report.get('counts') or {},
        'blockingReasons': report.get('blockingReasons') or [],
    })
