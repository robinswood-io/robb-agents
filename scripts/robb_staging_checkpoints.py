from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from typing import Callable, Iterator, Mapping, Sequence

from robb_staging_common import (
    APP_NAME,
    STRONG_VALIDATION_CONTRACT,
    FINGERPRINT_KEYS,
    LEGACY_BACKUP_PREFIXES,
    CHECKPOINT_NAME_RE,
    StagingError,
    Runner,
    resolve_managed_backup_root,
    exclusive_file_lock,
    run_command,
    require_bundle,
    sha256_file,
)
from robb_staging_bundles import (
    verify_qualified_source_state,
    validate_bundle,
)

def retention_lock_file(backup_root: Path) -> Path:
    root = resolve_managed_backup_root(backup_root)
    return root.parent / f".{root.name}.retention.lock"

def protect_rollback_checkpoint(
    checkpoint: Path,
    backup_root: Path,
    *,
    timeout: float,
) -> Path:
    """Hide a selected old checkpoint from concurrent retention pruning."""
    root = resolve_managed_backup_root(backup_root)
    checkpoint = checkpoint.resolve()
    with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
        return protect_rollback_checkpoint_locked(checkpoint, root)

def protect_rollback_checkpoint_locked(checkpoint: Path, root: Path) -> Path:
    """Rename a checkpoint while the caller holds the retention lock."""
    if checkpoint.parent != root or checkpoint.is_symlink():
        raise StagingError(f"Rollback checkpoint must be one direct child of {root}")
    require_bundle(checkpoint / APP_NAME)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    held = root / f".rollback-held-{stamp}-{os.getpid()}"
    if held.exists():
        raise StagingError(f"Rollback hold path already exists: {held}")
    try:
        os.replace(checkpoint, held)
    except OSError as error:
        raise StagingError(f"Cannot protect rollback checkpoint {checkpoint}: {error}") from error
    return held

def protect_and_validate_rollback_checkpoint(
    repo: Path,
    checkpoint: Path,
    backup_root: Path,
    *,
    expected_commit: str,
    timeout: float,
    runner: Runner,
) -> tuple[Path, dict[str, str]]:
    """Hide a selected checkpoint before any long-running strong validation."""
    root = resolve_managed_backup_root(backup_root)
    checkpoint = checkpoint.resolve()
    with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
        held = protect_rollback_checkpoint_locked(checkpoint, root)
        try:
            fingerprint = validate_bundle(
                repo,
                held / APP_NAME,
                expected_commit=expected_commit,
                runner=runner,
            )
            manifest_path = held / "backup.json"
            if manifest_path.is_symlink():
                raise StagingError(f"Rollback checkpoint manifest must not be a symlink: {manifest_path}")
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise StagingError(f"Rollback checkpoint manifest is missing or invalid: {manifest_path}") from error
            if not isinstance(manifest, dict) or not valid_backup_source(manifest.get("source")):
                raise StagingError(
                    f"Rollback checkpoint manifest has no recognized /Applications source: {manifest_path}"
                )
        except BaseException as error:
            raise StagingError(
                f"Rollback checkpoint validation failed; it remains protected from retention at {held}: {error}"
            ) from error
    return held, fingerprint

def next_checkpoint_time(backup_root: Path) -> dt.datetime:
    """Choose a timestamp newer than every published checkpoint, despite clock drift."""
    backup_root = resolve_managed_backup_root(backup_root)
    latest = time.time()
    for path in backup_root.iterdir():
        if path.is_symlink() or not path.is_dir() or not re.match(r"^\d{8}-", path.name):
            continue
        timestamp: float
        manifest_path = path / "backup.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            created_at = manifest.get("createdAt") if isinstance(manifest, dict) else None
            if not isinstance(created_at, str):
                raise ValueError("createdAt missing")
            timestamp = dt.datetime.fromisoformat(created_at).timestamp()
        except (OSError, ValueError, json.JSONDecodeError):
            stat = path.stat()
            timestamp = getattr(stat, "st_birthtime", stat.st_mtime)
        latest = max(latest, timestamp)
    return dt.datetime.fromtimestamp(latest + 0.001, dt.timezone.utc)

def strong_validation_manifest(fingerprint: Mapping[str, str]) -> dict[str, object]:
    if set(fingerprint) != FINGERPRINT_KEYS or any(
        not isinstance(value, str) or not value for value in fingerprint.values()
    ):
        raise StagingError("Strong checkpoint validation fingerprint is incomplete")
    return {
        "contract": STRONG_VALIDATION_CONTRACT,
        "fingerprint": dict(fingerprint),
    }

def valid_backup_source(value: object) -> bool:
    if not isinstance(value, str):
        return False
    source = Path(value)
    return source.parent == Path("/Applications") and (
        source.name == APP_NAME or source.name.startswith(LEGACY_BACKUP_PREFIXES)
    )

def is_confirmed_managed_checkpoint(
    checkpoint: Path,
    fingerprint: Mapping[str, str],
) -> bool:
    """Prove that a path is eligible for the standalone retention inventory."""
    match = CHECKPOINT_NAME_RE.fullmatch(checkpoint.name)
    manifest_path = checkpoint / "backup.json"
    if match is None or checkpoint.is_symlink() or manifest_path.is_symlink():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("version") != 2:
            return False
        if not valid_backup_source(manifest.get("source")):
            return False
        created_at = manifest.get("createdAt")
        if not isinstance(created_at, str):
            return False
        created = dt.datetime.fromisoformat(created_at)
        if created.tzinfo is None:
            return False
        created_utc = created.astimezone(dt.timezone.utc)
        if created_utc.strftime("%Y%m%d-%H%M%S") != f"{match.group('date')}-{match.group('time')}":
            return False
        suffix = match.group("suffix")
        if suffix.isdigit() and suffix != f"{created_utc.microsecond:06d}":
            return False
        return manifest.get("validation") == strong_validation_manifest(fingerprint)
    except (OSError, ValueError, json.JSONDecodeError):
        return False

def republish_rollback_checkpoint_locked(
    held: Path,
    backup_root: Path,
    *,
    original: Path,
    validated_fingerprint: Mapping[str, str],
    reason: str = "explicit-rollback",
) -> Path:
    """Publish a held checkpoint while the caller owns the retention lock."""
    root = resolve_managed_backup_root(backup_root)
    held = held.resolve()
    if held.parent != root or not held.name.startswith(".rollback-held-"):
        raise StagingError(f"Unexpected rollback hold path: {held}")
    require_bundle(held / APP_NAME)
    now = next_checkpoint_time(root)
    manifest_path = held / "backup.json"
    manifest: dict[str, object] = {}
    if manifest_path.is_file():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest.update(loaded)
        except (OSError, json.JSONDecodeError) as error:
            raise StagingError(f"Cannot refresh rollback checkpoint manifest: {error}") from error
    previous_created_at = manifest.get("createdAt")
    if not valid_backup_source(manifest.get("source")):
        raise StagingError(
            f"Rollback checkpoint manifest has no recognized /Applications source: {manifest_path}"
        )
    if isinstance(previous_created_at, str):
        manifest.setdefault("originalCreatedAt", previous_created_at)
    manifest.update({
        "version": 2,
        "createdAt": now.isoformat(),
        "refreshedFrom": str(original),
        "heldReason": reason,
        "validation": strong_validation_manifest(validated_fingerprint),
    })
    temporary_manifest = held / f".backup.json.partial-{os.getpid()}"
    try:
        with temporary_manifest.open("x", encoding="utf-8") as stream:
            json.dump(manifest, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_manifest, manifest_path)
    finally:
        if temporary_manifest.exists():
            temporary_manifest.unlink()
    published = root / now.strftime("%Y%m%d-%H%M%S-%f")
    if published.exists():
        raise StagingError(f"Refusing to overwrite rollback checkpoint: {published}")
    os.replace(held, published)
    return published

def republish_rollback_checkpoint(
    held: Path,
    backup_root: Path,
    *,
    original: Path,
    timeout: float,
    validated_fingerprint: Mapping[str, str],
    reason: str = "explicit-rollback",
) -> Path:
    """Publish a strongly validated held checkpoint as the newest backup."""
    root = resolve_managed_backup_root(backup_root)
    with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
        return republish_rollback_checkpoint_locked(
            held,
            root,
            original=original,
            validated_fingerprint=validated_fingerprint,
            reason=reason,
        )

def prune_backups(
    repo: Path,
    backup_root: Path,
    *,
    qualified_helper: Path,
    expected_commit: str,
    expected_helper_sha256: str,
    installed_script: Path,
    runner: Runner = run_command,
) -> dict[str, object]:
    root = resolve_managed_backup_root(backup_root)
    verify_qualified_source_state(
        repo,
        expected_commit=expected_commit,
        expected_helper_sha256=expected_helper_sha256,
        installed_script=installed_script,
        runner=runner,
    )
    if qualified_helper.is_symlink() or sha256_file(qualified_helper) != expected_helper_sha256:
        raise StagingError("Qualified retention helper snapshot changed before prune")
    result = runner(
        [sys.executable, str(qualified_helper), "--apply", "--root", str(root)],
        cwd=repo.resolve(),
        timeout=600,
    )
    verify_qualified_source_state(
        repo,
        expected_commit=expected_commit,
        expected_helper_sha256=expected_helper_sha256,
        installed_script=installed_script,
        runner=runner,
    )
    if sha256_file(qualified_helper) != expected_helper_sha256:
        raise StagingError("Qualified retention helper snapshot changed during prune")
    payloads: list[dict[str, object]] = []
    for line in result.stdout.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            payloads.append(payload)
    if not payloads or payloads[-1].get("apply") is not True:
        raise StagingError("staging-retention did not confirm applied retention")
    return payloads[-1]

def checkpoint_directory_identity(checkpoint: Path) -> tuple[int, int]:
    if checkpoint.is_symlink():
        raise StagingError(f"Checkpoint must not be a symlink: {checkpoint}")
    try:
        info = checkpoint.stat(follow_symlinks=False)
    except OSError as error:
        raise StagingError(f"Cannot stat checkpoint {checkpoint}: {error}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise StagingError(f"Checkpoint is not a real directory: {checkpoint}")
    return info.st_dev, info.st_ino

def find_checkpoint_by_identity(
    backup_root: Path,
    identity: tuple[int, int],
) -> Path | None:
    root = resolve_managed_backup_root(backup_root)
    try:
        children = list(root.iterdir())
    except OSError as error:
        raise StagingError(f"Cannot inspect managed backup root {root}: {error}") from error
    matches: list[Path] = []
    for child in children:
        if child.is_symlink():
            continue
        try:
            info = child.stat(follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == identity:
            matches.append(child)
    if len(matches) > 1:
        raise StagingError(f"Checkpoint identity is ambiguous under {root}: {matches}")
    return matches[0] if matches else None
