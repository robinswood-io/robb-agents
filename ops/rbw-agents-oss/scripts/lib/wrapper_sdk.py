#!/usr/bin/env python3
from __future__ import annotations

import json
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    json.loads(tmp.read_text(encoding='utf-8'))
    tmp.replace(path)


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(content, encoding='utf-8')
    tmp.replace(path)


def report_paths(slug: str) -> tuple[Path, Path]:
    return OPS / f'{slug}-last.json', OPS / f'{slug}-last.md'


def write_report(slug: str, payload: dict[str, Any], title: str | None = None) -> dict[str, str]:
    payload.setdefault('generatedAt', now_iso())
    payload.setdefault('ok', True)
    payload.setdefault('status', 'passed' if payload.get('ok') else 'failed')
    json_path, md_path = report_paths(slug)
    atomic_write_json(json_path, payload)
    lines = [f'# {title or slug}', '', f'- Generated at: {payload.get("generatedAt")}', f'- Status: **{payload.get("status")}**', f'- OK: **{payload.get("ok")}**']
    counts = payload.get('counts')
    if isinstance(counts, dict):
        lines += ['', '## Counts']
        for key, value in counts.items():
            lines.append(f'- {key}: `{value}`')
    errors = payload.get('errors')
    warnings = payload.get('warnings')
    if errors:
        lines += ['', '## Errors'] + [f'- `{json.dumps(e, ensure_ascii=False)}`' for e in errors[:50]]
    if warnings:
        lines += ['', '## Warnings'] + [f'- `{json.dumps(w, ensure_ascii=False)}`' for w in warnings[:50]]
    write_text(md_path, '\n'.join(lines) + '\n')
    return {'reportJson': str(json_path), 'reportMd': str(md_path)}


def safe_main(slug: str, fn: Callable[[], dict[str, Any]], title: str | None = None, fail_exit: bool = False) -> int:
    try:
        payload = fn()
        payload.setdefault('ok', True)
        write_report(slug, payload, title=title)
        print(json.dumps({'ok': payload.get('ok'), 'status': payload.get('status'), 'artifacts': payload.get('artifacts')}, ensure_ascii=False))
        return 1 if fail_exit and not payload.get('ok') else 0
    except Exception as exc:
        payload = {
            'ok': False,
            'status': 'failed',
            'generatedAt': now_iso(),
            'errors': [{'type': exc.__class__.__name__, 'message': str(exc), 'traceback': traceback.format_exc()[-4000:]}],
        }
        artifacts = write_report(slug, payload, title=title)
        print(json.dumps({'ok': False, 'status': 'failed', 'artifacts': artifacts}, ensure_ascii=False))
        return 1
