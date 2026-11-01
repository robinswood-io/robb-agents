#!/usr/bin/env python3
from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Generator
from contextlib import AbstractContextManager, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Self

from pydantic import JsonValue, TypeAdapter

ROOT = Path('/srv/rbw-agents-oss')
CONFIG = ROOT / 'config'
ARCHIVE_ROOT = ROOT / 'archive'
LOCK_DIR = ROOT / '.locks'
PROTECTED_CONFIG_FILES = [
    CONFIG / 'command-manifest.json',
    CONFIG / 'automation-mapping.json',
    CONFIG / 'temporal/schedules.json',
    CONFIG / 'temporal/ready-schedules.json',
    CONFIG / 'temporal/event-triggers.json',
    CONFIG / 'registry/manifest-only-policy.json',
    CONFIG / 'registry/script-coverage-policy.json',
    CONFIG / 'registry/schedule-readiness-policy.json',
    CONFIG / 'registry/side-effects-policy.json',
    CONFIG / 'registry/runtime-status-policy.json',
    CONFIG / 'registry/config-mutation-policy.json',
    CONFIG / 'registry/report-contract-coverage-policy.json',
    CONFIG / 'registry/temporal-execution-slo-policy.json',
]


def now_utc() -> datetime:
    return datetime.now(UTC)


def now_iso() -> str:
    return now_utc().isoformat().replace('+00:00', 'Z')


def month_dir(dt: datetime | None = None) -> str:
    dt = dt or now_utc()
    return f'{dt.year:04d}-{dt.month:02d}'


def load_json(path: Path, default: JsonValue = None) -> JsonValue:
    try:
        return TypeAdapter(JsonValue).validate_json(path.read_bytes())
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def atomic_write_text(path: Path, content: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    old_mode = None
    if path.exists():
        old_mode = path.stat().st_mode & 0o777
    fd, tmp_name = tempfile.mkstemp(prefix=f'.{path.name}.', suffix='.tmp', dir=str(path.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            _ = f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        path.chmod(mode if mode is not None else old_mode if old_mode is not None else 0o644)
    finally:
        if tmp.exists():
            tmp.unlink()


def atomic_write_json(path: Path, data: JsonValue, mode: int | None = None) -> None:
    atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + '\n', mode=mode)


def archive_backup(path: Path, batch_id: str, *, move: bool = False) -> Path | None:
    if not path.exists():
        return None
    rel = path.relative_to(ROOT)
    dest = ARCHIVE_ROOT / month_dir() / batch_id / rel
    dest = dest.with_name(dest.name + f'.{now_utc().strftime("%Y%m%dT%H%M%SZ")}.bak')
    dest.parent.mkdir(parents=True, exist_ok=True)
    if move:
        _ = shutil.move(str(path), str(dest))
    else:
        _ = shutil.copy2(path, dest)
    return dest


@contextmanager
def config_lock(reason: str = 'config-mutation') -> Generator[Path]:
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    lock_path = LOCK_DIR / 'config-mutation.lock'
    with lock_path.open('w', encoding='utf-8') as lock:
        _ = lock.write(f'{now_iso()} {reason}\n')
        lock.flush()
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield lock_path
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


class ConfigMutation:
    """Safe helper for OSS config changes.

    Required pattern for future patchers:
      with ConfigMutation('batch-id') as mut:
          data = mut.load_json(CONFIG / 'command-manifest.json')
          ...
          mut.write_json(CONFIG / 'command-manifest.json', data)
          mut.validate(['/srv/rbw-agents-oss/.venv/bin/python', 'scripts/oss_structural_guard.py'])

    Guarantees:
    - single process lock under /srv/rbw-agents-oss/.locks
    - prechange backups under /srv/rbw-agents-oss/archive/YYYY-MM/<batch>/
    - atomic writes; no active-tree .bak files
    """

    batch_id: str
    root: Path
    backups: dict[str, str | None]
    _ctx: AbstractContextManager[Path]

    def __init__(self, batch_id: str, *, root: Path = ROOT) -> None:
        self.batch_id = batch_id
        self.root = root
        self.backups = {}
        self._ctx = config_lock(self.batch_id)

    def __enter__(self) -> Self:
        self._ctx = config_lock(self.batch_id)
        _ = self._ctx.__enter__()
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None) -> None:
        _ = self._ctx.__exit__(exc_type, exc, tb)

    def backup(self, path: Path) -> Path | None:
        path = Path(path)
        if str(path) not in self.backups:
            dest = archive_backup(path, self.batch_id, move=False)
            self.backups[str(path)] = str(dest) if dest else None
        backup_path = self.backups[str(path)]
        return Path(backup_path) if backup_path else None

    def load_json(self, path: Path, default: JsonValue = None) -> JsonValue:
        return load_json(path, default)

    def write_json(self, path: Path, data: JsonValue) -> None:
        _ = self.backup(Path(path))
        atomic_write_json(Path(path), data)

    def write_text(self, path: Path, content: str, mode: int | None = None) -> None:
        _ = self.backup(Path(path))
        atomic_write_text(Path(path), content, mode=mode)

    def validate(self, command: list[str], *, cwd: Path | None = ROOT, timeout: int = 300) -> dict[str, JsonValue]:
        proc = subprocess.run(command, cwd=str(cwd) if cwd else None, text=True, capture_output=True, timeout=timeout, check=False)
        return {
            'cmd': list(command),
            'returncode': proc.returncode,
            'ok': proc.returncode == 0,
            'stdout': proc.stdout[-4000:],
            'stderr': proc.stderr[-4000:],
        }


def expected_manifest_count(root: Path) -> int:
    """Read the approved project baseline; never infer it from the current manifest."""
    baseline = TypeAdapter(dict[str, JsonValue]).validate_json(
        (root / 'config/agents-v2/baseline.json').read_bytes())
    count = baseline.get('manifestCount')
    if isinstance(count, bool) or not isinstance(count, int):
        raise TypeError('approved_manifest_count_must_be_an_integer')
    if count <= 0:
        raise ValueError('approved_manifest_count_must_be_positive')
    return count
