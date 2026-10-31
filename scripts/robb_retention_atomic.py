from __future__ import annotations

import ctypes
import os
import stat
import sys
from pathlib import Path
from typing import cast

from robb_retention_files import (
    RENAME_EXCL,
    RENAME_SWAP,
    FileIdentity,
    FileSnapshot,
    fsync_directory,
    snapshot_regular_file,
)


def before_verified_path_mutation(_operation: str, _path: Path) -> None:
    """Test seam immediately before fd-relative mutation revalidation."""

def before_atomic_rename(
    _operation: str,
    _source: Path,
    _destination: Path,
) -> None:
    """Test seam after entry validation and immediately before renameatx_np."""

def after_atomic_rename(
    _operation: str,
    _source: Path,
    _destination: Path,
) -> None:
    """Test seam immediately after renameatx_np, before durability/validation."""

def open_owned_directory(directory: Path) -> int:
    flags = os.O_RDONLY
    if hasattr(os, 'O_DIRECTORY'):
        flags |= os.O_DIRECTORY
    if hasattr(os, 'O_CLOEXEC'):
        flags |= os.O_CLOEXEC
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(directory, flags)
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeError(f'Refusing unsafe transaction directory: {directory}')
    return descriptor

def revalidate_directory_entry(
    directory_descriptor: int,
    name: str,
    expected: FileIdentity,
    *,
    description: str,
) -> None:
    try:
        info = os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
    except FileNotFoundError as error:
        raise RuntimeError(f'{description} disappeared before mutation: {name}') from error
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or (info.st_dev, info.st_ino) != (expected.device, expected.inode)
    ):
        raise RuntimeError(f'{description} changed before mutation: {name}')

def renameatx_np(
    directory_descriptor: int,
    source_name: str,
    destination_name: str,
    flags: int,
) -> None:
    if sys.platform != 'darwin':
        raise RuntimeError('Transactional rename requires macOS renameatx_np')
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameatx_np
    except AttributeError as error:
        raise RuntimeError('macOS renameatx_np is unavailable; refusing mutation') from error
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                       ctypes.c_uint]
    rename.restype = ctypes.c_int
    result = cast(int, rename(
        directory_descriptor,
        os.fsencode(source_name),
        directory_descriptor,
        os.fsencode(destination_name),
        flags,
    ))
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), source_name, destination_name)

def quarantine_path(path: Path) -> Path:
    return path.with_name(f'{path.name}.transaction-quarantine')

def delete_verified_quarantine(
    path: Path,
    snapshot: FileSnapshot,
    *,
    operation: str,
) -> None:
    directory_descriptor = open_owned_directory(path.parent)
    try:
        revalidate_directory_entry(
            directory_descriptor,
            path.name,
            snapshot.identity,
            description='Transaction quarantine',
        )
        before_verified_path_mutation(f'{operation}:quarantine-unlink', path)
        revalidate_directory_entry(
            directory_descriptor,
            path.name,
            snapshot.identity,
            description='Transaction quarantine',
        )
        # Moving into a validated quarantine prevents an unexpected inode from
        # being deleted after the earlier pathname check. A hostile same-UID
        # process can still race this final fstatat/unlinkat pair; that residual
        # macOS pathname limitation is documented in the staging runbook.
        os.unlink(path.name, dir_fd=directory_descriptor)
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)

def quarantine_and_unlink(
    path: Path,
    snapshot: FileSnapshot,
    *,
    operation: str,
    quarantine: Path | None = None,
) -> None:
    quarantine = quarantine or quarantine_path(path)
    if quarantine.parent != path.parent:
        raise RuntimeError('Transaction quarantine must share the source directory')
    existing_quarantine = snapshot_regular_file(quarantine, require_owner=True)
    if existing_quarantine is not None:
        if path.exists() or path.is_symlink():
            raise RuntimeError(f'Both transaction file and quarantine exist: {path}')
        if existing_quarantine.identity != snapshot.identity:
            raise RuntimeError(f'Refusing unowned transaction quarantine: {quarantine}')
        delete_verified_quarantine(
            quarantine, existing_quarantine, operation=operation,
        )
        return

    before_verified_path_mutation(operation, path)
    directory_descriptor = open_owned_directory(path.parent)
    try:
        revalidate_directory_entry(
            directory_descriptor,
            path.name,
            snapshot.identity,
            description='Transaction delete source',
        )
        try:
            _ = os.stat(quarantine.name, dir_fd=directory_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError(f'Transaction quarantine already exists: {quarantine}')
        before_atomic_rename(operation, path, quarantine)
        renameatx_np(directory_descriptor, path.name, quarantine.name, RENAME_EXCL)
        after_atomic_rename(operation, path, quarantine)
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)

    moved = snapshot_regular_file(quarantine, require_owner=True)
    if moved is None or moved.identity != snapshot.identity:
        directory_descriptor = open_owned_directory(path.parent)
        try:
            try:
                renameatx_np(
                    directory_descriptor,
                    quarantine.name,
                    path.name,
                    RENAME_EXCL,
                )
                os.fsync(directory_descriptor)
            except OSError:
                pass
        finally:
            os.close(directory_descriptor)
        raise RuntimeError(f'Transaction delete source changed before quarantine: {path}')
    delete_verified_quarantine(quarantine, moved, operation=operation)

def swap_verified(
    source: Path,
    destination: Path,
    source_snapshot: FileSnapshot,
    destination_snapshot: FileSnapshot,
    *,
    operation: str,
) -> None:
    if source.parent != destination.parent:
        raise RuntimeError('Transaction swap requires one parent directory')
    before_verified_path_mutation(operation, destination)
    directory_descriptor = open_owned_directory(source.parent)
    try:
        revalidate_directory_entry(
            directory_descriptor, source.name, source_snapshot.identity,
            description='Transaction swap source',
        )
        revalidate_directory_entry(
            directory_descriptor, destination.name, destination_snapshot.identity,
            description='Transaction swap destination',
        )
        before_atomic_rename(operation, source, destination)
        renameatx_np(directory_descriptor, source.name, destination.name, RENAME_SWAP)
        after_atomic_rename(operation, source, destination)
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)

    moved_source = snapshot_regular_file(destination, require_owner=True)
    displaced_destination = snapshot_regular_file(source, require_owner=True)
    if (
        moved_source is not None
        and displaced_destination is not None
        and moved_source.identity == source_snapshot.identity
        and displaced_destination.identity == destination_snapshot.identity
    ):
        return
    # Both names remain present after an atomic swap. On any post-swap identity
    # mismatch, preserve both entries for journal recovery/manual inspection;
    # an attempted compensating swap would create a second race window.
    raise RuntimeError(f'Transaction swap verification failed: {source} <-> {destination}')

def verified_replace(
    source: Path,
    destination: Path,
    source_snapshot: FileSnapshot,
    destination_snapshot: FileSnapshot | None,
    *,
    operation: str,
) -> None:
    if source.parent != destination.parent:
        raise RuntimeError('Verified transaction replace requires one parent directory')
    if destination_snapshot is not None:
        swap_verified(
            source,
            destination,
            source_snapshot,
            destination_snapshot,
            operation=operation,
        )
        quarantine_and_unlink(
            source,
            destination_snapshot,
            operation=f'{operation}:displaced-destination',
        )
        return
    before_verified_path_mutation(operation, destination)
    directory_descriptor = open_owned_directory(source.parent)
    try:
        revalidate_directory_entry(
            directory_descriptor,
            source.name,
            source_snapshot.identity,
            description='Transaction replace source',
        )
        try:
            _ = os.stat(
                destination.name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            raise RuntimeError(f'Transaction replace destination changed: {destination}')
        before_atomic_rename(operation, source, destination)
        renameatx_np(
            directory_descriptor, source.name, destination.name, RENAME_EXCL,
        )
        after_atomic_rename(operation, source, destination)
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
    published = snapshot_regular_file(destination, require_owner=True)
    if published is None or published.identity != source_snapshot.identity:
        raise RuntimeError(f'Transaction exclusive rename verification failed: {destination}')

def write_owned_file(path: Path, data: bytes, mode: int) -> FileIdentity:
    """Create one exact transaction-owned file and make its entry durable."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, 'O_CLOEXEC'):
        flags |= os.O_CLOEXEC
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, mode)
    created = os.fstat(descriptor)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb') as stream:
            descriptor = -1
            _ = stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        current = snapshot_regular_file(path, require_owner=True)
        if current is not None and (current.identity.device, current.identity.inode) == (
            created.st_dev, created.st_ino,
        ):
            quarantine_and_unlink(
                path,
                current,
                operation='cleanup-failed-owned-write',
            )
        raise
    fsync_directory(path.parent)
    snapshot = snapshot_regular_file(path, require_owner=True)
    if snapshot is None or (snapshot.identity.device, snapshot.identity.inode) != (
        created.st_dev, created.st_ino,
    ):
        raise RuntimeError(f'Created transaction file was replaced unexpectedly: {path}')
    return snapshot.identity
