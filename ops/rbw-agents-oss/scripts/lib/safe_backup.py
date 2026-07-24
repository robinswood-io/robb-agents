#!/usr/bin/env python3
from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/srv/rbw-agents-oss')


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def archive_path_for(source: Path, label: str = 'manual') -> Path:
    source = Path(source)
    try:
        rel = source.relative_to(ROOT)
    except Exception:
        rel = Path(source.name)
    month = datetime.now(timezone.utc).strftime('%Y-%m')
    return ROOT / 'archive' / month / label / rel.with_name(rel.name + '.' + utc_stamp() + '.bak')


def copy_to_archive(source: Path, label: str = 'manual') -> Path:
    source = Path(source)
    dest = archive_path_for(source, label)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    return dest


def move_to_archive(source: Path, label: str = 'manual') -> Path:
    source = Path(source)
    dest = archive_path_for(source, label)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(dest))
    return dest


def active_backup_files(root: Path = ROOT) -> list[Path]:
    roots = [root / 'config', root / 'config/temporal', root / 'scripts', root / 'apps/orchestrator-temporal']
    out: list[Path] = []
    for base in roots:
        if not base.exists():
            continue
        for p in base.rglob('*'):
            if p.is_file() and ('.bak' in p.name or p.name.endswith('~') or p.name.endswith('.old')):
                out.append(p)
    return sorted(out)
