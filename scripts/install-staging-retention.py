#!/usr/bin/env python3
"""Transactionally install this user's Robb staging retention LaunchAgent."""
from __future__ import annotations

from dataclasses import dataclass
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import stat
import subprocess
import sys
from typing import Any, Callable, Sequence


LABEL = 'io.robinswood.robbagents.staging-retention'
SUPPORT = Path.home() / 'Library/Application Support/Robb Agents/Maintenance'
AGENTS = Path.home() / 'Library/LaunchAgents'
Runner = Callable[..., subprocess.CompletedProcess]
Checkpoint = Callable[[str], None]
LAUNCHCTL_NOT_FOUND = 113
LAUNCHCTL_NO_SUCH_PROCESS = 3
INSTALL_LOCK_NAME = '.install-staging-retention.lock'
JOURNAL_NAME = '.install-staging-retention.transaction.json'
JOURNAL_CONTRACT = 'robb-staging-retention-install.v1'
JOURNAL_VERSION = 1
JOURNAL_PHASES = {
    'initializing', 'prepared', 'service_stopped', 'script_published',
    'plist_published', 'bootstrap_succeeded', 'service_verified', 'committed',
}
TOKEN_RE = re.compile(r'^[0-9a-f]{32}$')
IDENTITY_KEYS = {
    'device', 'inode', 'owner', 'group', 'mode', 'flags', 'size', 'sha256',
    'xattrsSha256',
}
ARTIFACT_KEYS = {'target', 'backup', 'staged', 'previous', 'replacement'}
JOURNAL_KEYS = {
    'contract', 'version', 'token', 'phase', 'label', 'domain', 'target',
    'previousLoaded', 'nextJournal', 'script', 'plist',
}
VOLATILE_XATTRS = {'com.apple.provenance'}
RENAME_SWAP = 0x00000002
RENAME_EXCL = 0x00000004


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    owner: int
    group: int
    mode: int
    flags: int
    size: int
    sha256: str
    xattrs_sha256: str

    def to_record(self) -> dict[str, int | str]:
        return {
            'device': self.device, 'inode': self.inode, 'owner': self.owner,
            'group': self.group, 'mode': self.mode, 'flags': self.flags,
            'size': self.size, 'sha256': self.sha256,
            'xattrsSha256': self.xattrs_sha256,
        }


@dataclass(frozen=True)
class FileSnapshot:
    data: bytes
    identity: FileIdentity

    @property
    def mode(self) -> int:
        return self.identity.mode


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def xattrs_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    if hasattr(os, 'listxattr') and hasattr(os, 'getxattr'):
        attributes = {
            name: os.getxattr(path, name, follow_symlinks=False)
            for name in os.listxattr(path, follow_symlinks=False)
        }
    elif sys.platform == 'darwin':
        listed = subprocess.run(
            ['/usr/bin/xattr', str(path)], check=True, capture_output=True,
        )
        attributes = {}
        for raw_name in listed.stdout.decode('utf-8', errors='strict').splitlines():
            value = subprocess.run(
                ['/usr/bin/xattr', '-px', raw_name, str(path)],
                check=True, capture_output=True,
            ).stdout
            attributes[raw_name] = bytes.fromhex(b''.join(value.split()).decode('ascii'))
    else:
        attributes = {}
    for name in sorted(name for name in attributes if name not in VOLATILE_XATTRS):
        encoded_name = os.fsencode(name)
        value = attributes[name]
        digest.update(len(encoded_name).to_bytes(4, 'big'))
        digest.update(encoded_name)
        digest.update(len(value).to_bytes(8, 'big'))
        digest.update(value)
    return digest.hexdigest()


def _open_regular_for_read(path: Path, *, require_owner: bool):
    flags = os.O_RDONLY
    if hasattr(os, 'O_CLOEXEC'):
        flags |= os.O_CLOEXEC
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    elif path.is_symlink():
        raise RuntimeError(f'Refusing symlink LaunchAgent file: {path}')
    descriptor = os.open(path, flags)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        raise RuntimeError(f'Refusing non-regular LaunchAgent file: {path}')
    if require_owner and info.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeError(f'Refusing LaunchAgent file not owned by this user: {path}')
    return os.fdopen(descriptor, 'rb'), info


def snapshot_regular_file(path: Path, *, require_owner: bool = False) -> FileSnapshot | None:
    try:
        stream, before = _open_regular_for_read(path, require_owner=require_owner)
    except FileNotFoundError:
        return None
    with stream:
        data = stream.read()
        after = os.fstat(stream.fileno())
        attributes_hash = xattrs_sha256(path)
        path_info = path.lstat()
    def stable_fields(info: os.stat_result) -> tuple[int, ...]:
        return (
            info.st_dev, info.st_ino, info.st_uid, info.st_gid,
            stat.S_IMODE(info.st_mode), getattr(info, 'st_flags', 0),
            info.st_size, info.st_mtime_ns, info.st_ctime_ns,
        )
    if (stable_fields(before) != stable_fields(after)
            or stable_fields(path_info) != stable_fields(after)
            or len(data) != after.st_size):
        raise RuntimeError(f'LaunchAgent file changed while being inspected: {path}')
    return FileSnapshot(data, FileIdentity(
        after.st_dev, after.st_ino, after.st_uid, after.st_gid,
        stat.S_IMODE(after.st_mode), getattr(after, 'st_flags', 0),
        after.st_size, sha256_bytes(data), attributes_hash,
    ))


def sha256_file(path: Path) -> str:
    snapshot = snapshot_regular_file(path)
    if snapshot is None:
        raise FileNotFoundError(path)
    return snapshot.identity.sha256


def open_install_lock(path: Path):
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, 'O_CLOEXEC'):
        flags |= os.O_CLOEXEC
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    elif path.is_symlink():
        raise RuntimeError(f'Installer lock must not be a symlink: {path}')
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise RuntimeError(f'Cannot safely open installer lock {path}: {error}') from error
    lock = os.fdopen(descriptor, 'r+')
    info = os.fstat(lock.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        lock.close()
        raise RuntimeError(f'Installer lock is not a regular user-owned file: {path}')
    return lock


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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
    result = rename(
        directory_descriptor,
        os.fsencode(source_name),
        directory_descriptor,
        os.fsencode(destination_name),
        flags,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), source_name, destination_name)


def quarantine_path(path: Path) -> Path:
    return path.with_name(f'{path.name}.transaction-quarantine')


def _delete_verified_quarantine(
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
        _delete_verified_quarantine(
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
            os.stat(quarantine.name, dir_fd=directory_descriptor, follow_symlinks=False)
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
    _delete_verified_quarantine(quarantine, moved, operation=operation)


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
            destination_info = os.stat(
                destination.name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            if destination_snapshot is not None:
                raise RuntimeError(
                    f'Transaction replace destination disappeared: {destination}'
                )
        else:
            if destination_snapshot is None or (
                not stat.S_ISREG(destination_info.st_mode)
                or destination_info.st_uid != os.getuid()
                or (destination_info.st_dev, destination_info.st_ino)
                != (
                    destination_snapshot.identity.device,
                    destination_snapshot.identity.inode,
                )
            ):
                raise RuntimeError(
                    f'Transaction replace destination changed: {destination}'
                )
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
            stream.write(data)
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


def launchctl(runner: Runner, arguments: Sequence[str], *, check: bool,
              capture_output: bool = False) -> subprocess.CompletedProcess:
    return runner(['launchctl', *arguments], check=check, capture_output=capture_output)


def service_is_loaded(runner: Runner, target: str) -> bool:
    result = launchctl(runner, ['print', target], check=False, capture_output=True)
    if result.returncode == 0:
        return True
    if result.returncode == LAUNCHCTL_NOT_FOUND:
        return False
    raise RuntimeError(
        f'Cannot determine whether LaunchAgent is loaded '
        f'(launchctl print exited {result.returncode})'
    )


def unload_for_rollback(runner: Runner, target: str) -> None:
    result = launchctl(runner, ['bootout', target], check=False, capture_output=True)
    if result.returncode not in (0, LAUNCHCTL_NO_SUCH_PROCESS):
        raise RuntimeError(f'launchctl bootout exited {result.returncode}')
    if service_is_loaded(runner, target):
        raise RuntimeError('LaunchAgent remains loaded after bootout')


def _is_plain_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_identity_record(value: Any, *, allow_unpublished: bool) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != IDENTITY_KEYS:
        raise RuntimeError('Transaction journal contains an invalid file identity')
    for key in ('owner', 'group', 'mode', 'flags', 'size'):
        if not _is_plain_int(value[key]) or value[key] < 0:
            raise RuntimeError('Transaction journal contains an invalid file identity')
    device, inode = value['device'], value['inode']
    if allow_unpublished and device is None and inode is None:
        pass
    elif not (_is_plain_int(device) and device >= 0 and _is_plain_int(inode) and inode > 0):
        raise RuntimeError('Transaction journal contains an invalid file identity')
    for key in ('sha256', 'xattrsSha256'):
        digest = value[key]
        if not isinstance(digest, str) or len(digest) != 64 or any(
            character not in '0123456789abcdef' for character in digest
        ):
            raise RuntimeError('Transaction journal contains an invalid file hash')
    if value['owner'] != os.getuid():
        raise RuntimeError('Transaction journal references a file owned by another user')
    return value


def identity_matches(identity: FileIdentity, record: dict[str, Any], *,
                     require_inode: bool) -> bool:
    fields = ('owner', 'group', 'mode', 'flags', 'size', 'sha256') if require_inode else (
        'owner', 'mode', 'size', 'sha256',
    )
    if any(getattr(identity, field) != record[field] for field in fields):
        return False
    if require_inode and identity.xattrs_sha256 != record['xattrsSha256']:
        return False
    return not require_inode or (identity.device, identity.inode) == (
        record['device'], record['inode'],
    )


def replacement_expectation(data: bytes, mode: int) -> dict[str, Any]:
    return {
        'device': None, 'inode': None, 'owner': os.getuid(),
        'group': os.getgid(), 'mode': mode, 'flags': 0,
        'size': len(data), 'sha256': sha256_bytes(data),
        'xattrsSha256': hashlib.sha256().hexdigest(),
    }


def transaction_paths(support: Path, agents: Path, token: str) -> dict[str, Path]:
    # LaunchAgents artifacts intentionally never end in .plist.
    return {
        'journal': support / JOURNAL_NAME,
        'nextJournal': support / f'{JOURNAL_NAME}.next-{token}',
        'scriptTarget': support / 'staging-retention.py',
        'scriptBackup': support / f'.staging-retention.install-{token}.backup',
        'scriptStaged': support / f'.staging-retention.install-{token}.new',
        'plistTarget': agents / f'{LABEL}.plist',
        'plistBackup': agents / f'.{LABEL}.install-{token}.backup-data',
        'plistStaged': agents / f'.{LABEL}.install-{token}.new-data',
    }


def new_journal(*, support: Path, agents: Path, domain: str, target: str,
                previous_loaded: bool, previous_script: FileSnapshot | None,
                previous_plist: FileSnapshot | None, script_bytes: bytes,
                plist_bytes: bytes) -> dict[str, Any]:
    token = secrets.token_hex(16)
    paths = transaction_paths(support, agents, token)
    return {
        'contract': JOURNAL_CONTRACT, 'version': JOURNAL_VERSION,
        'token': token, 'phase': 'initializing', 'label': LABEL,
        'domain': domain, 'target': target, 'previousLoaded': previous_loaded,
        'nextJournal': str(paths['nextJournal']),
        'script': {
            'target': str(paths['scriptTarget']), 'backup': str(paths['scriptBackup']),
            'staged': str(paths['scriptStaged']),
            'previous': previous_script.identity.to_record() if previous_script else None,
            'replacement': replacement_expectation(script_bytes, 0o700),
        },
        'plist': {
            'target': str(paths['plistTarget']), 'backup': str(paths['plistBackup']),
            'staged': str(paths['plistStaged']),
            'previous': previous_plist.identity.to_record() if previous_plist else None,
            'replacement': replacement_expectation(plist_bytes, 0o600),
        },
    }


def validate_journal(value: Any, *, support: Path, agents: Path) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != JOURNAL_KEYS:
        raise RuntimeError('Retention installer transaction journal has an invalid schema')
    if value['contract'] != JOURNAL_CONTRACT or value['version'] != JOURNAL_VERSION:
        raise RuntimeError('Retention installer transaction journal has an unknown contract')
    token = value['token']
    if not isinstance(token, str) or TOKEN_RE.fullmatch(token) is None:
        raise RuntimeError('Retention installer transaction journal has an invalid token')
    if value['phase'] not in JOURNAL_PHASES:
        raise RuntimeError('Retention installer transaction journal has an invalid phase')
    domain = f'gui/{os.getuid()}'
    target = f'{domain}/{LABEL}'
    if (value['label'] != LABEL or value['domain'] != domain
            or value['target'] != target or not isinstance(value['previousLoaded'], bool)):
        raise RuntimeError('Retention installer transaction journal has an unexpected identity')
    paths = transaction_paths(support, agents, token)
    if value['nextJournal'] != str(paths['nextJournal']):
        raise RuntimeError('Retention installer journal next path is outside its transaction')
    for name, prefix in (('script', 'script'), ('plist', 'plist')):
        artifact = value[name]
        if not isinstance(artifact, dict) or set(artifact) != ARTIFACT_KEYS:
            raise RuntimeError(f'Retention installer journal has an invalid {name} record')
        for field, suffix in (('target', 'Target'), ('backup', 'Backup'), ('staged', 'Staged')):
            if artifact[field] != str(paths[f'{prefix}{suffix}']):
                raise RuntimeError(f'Retention installer journal has an unsafe {name} path')
        if artifact['previous'] is not None:
            validate_identity_record(artifact['previous'], allow_unpublished=False)
        replacement = validate_identity_record(
            artifact['replacement'], allow_unpublished=value['phase'] == 'initializing',
        )
        if value['phase'] != 'initializing' and replacement['device'] is None:
            raise RuntimeError('Prepared transaction has no replacement inode')
    return value


def journal_bytes(journal: dict[str, Any]) -> bytes:
    return (json.dumps(journal, sort_keys=True, separators=(',', ':')) + '\n').encode()


def load_journal_file(path: Path, *, support: Path, agents: Path) -> dict[str, Any]:
    snapshot = snapshot_regular_file(path, require_owner=True)
    if snapshot is None:
        raise FileNotFoundError(path)
    if snapshot.identity.size > 64 * 1024:
        raise RuntimeError(f'Retention installer journal is unexpectedly large: {path}')
    try:
        value = json.loads(snapshot.data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f'Retention installer journal is invalid JSON: {path}') from error
    return validate_journal(value, support=support, agents=agents)


def write_journal(journal: dict[str, Any], *, support: Path, agents: Path,
                  initial: bool = False) -> None:
    validate_journal(journal, support=support, agents=agents)
    journal_path = support / JOURNAL_NAME
    next_path = Path(journal['nextJournal'])
    if next_path.exists() or next_path.is_symlink():
        raise RuntimeError(f'Retention installer journal staging path already exists: {next_path}')
    next_identity = write_owned_file(next_path, journal_bytes(journal), 0o600)
    next_snapshot = snapshot_regular_file(next_path, require_owner=True)
    if next_snapshot is None or next_snapshot.identity != next_identity:
        raise RuntimeError('Retention installer journal staging file changed unexpectedly')
    current_snapshot: FileSnapshot | None = None
    if initial and (journal_path.exists() or journal_path.is_symlink()):
        raise RuntimeError(f'Retention installer transaction already exists: {journal_path}')
    if not initial:
        current = load_journal_file(journal_path, support=support, agents=agents)
        if current['token'] != journal['token']:
            raise RuntimeError('Refusing to replace a different installer transaction journal')
        current_snapshot = snapshot_regular_file(journal_path, require_owner=True)
        if current_snapshot is None:
            raise RuntimeError('Retention installer journal disappeared before update')
    verified_replace(
        next_path,
        journal_path,
        next_snapshot,
        current_snapshot,
        operation='publish-journal',
    )


def load_pending_journal(*, support: Path, agents: Path) -> dict[str, Any] | None:
    journal_path = support / JOURNAL_NAME
    if journal_path.exists() or journal_path.is_symlink():
        return load_journal_file(journal_path, support=support, agents=agents)
    journal_quarantine = quarantine_path(journal_path)
    if journal_quarantine.exists() or journal_quarantine.is_symlink():
        return load_journal_file(
            journal_quarantine, support=support, agents=agents,
        )
    candidates = list(support.glob(f'{JOURNAL_NAME}.next-*'))
    if not candidates:
        return None
    valid_candidates: list[tuple[Path, dict[str, Any]]] = []
    for candidate in candidates:
        try:
            candidate_journal = load_journal_file(
                candidate, support=support, agents=agents,
            )
        except RuntimeError:
            # A killed first write cannot have mutated targets or launchd.
            # Preserve an unproven partial file for inspection, but do not let
            # it authorize deletion or permanently block a later transaction.
            continue
        if Path(candidate_journal['nextJournal']) == candidate:
            valid_candidates.append((candidate, candidate_journal))
    if not valid_candidates:
        return None
    if len(valid_candidates) != 1:
        raise RuntimeError('Multiple uncommitted retention installer journals require manual review')
    candidate, journal = valid_candidates[0]
    candidate_snapshot = snapshot_regular_file(candidate, require_owner=True)
    if candidate_snapshot is None:
        raise RuntimeError('Uncommitted retention installer journal disappeared')
    verified_replace(
        candidate,
        journal_path,
        candidate_snapshot,
        None,
        operation='promote-initial-journal',
    )
    return journal


def create_backup(target: Path, backup: Path, expected: dict[str, Any]) -> None:
    if backup.exists() or backup.is_symlink():
        raise RuntimeError(f'Transaction backup already exists: {backup}')
    os.link(target, backup, follow_symlinks=False)
    fsync_directory(backup.parent)
    snapshot = snapshot_regular_file(backup, require_owner=True)
    if snapshot is None or not identity_matches(snapshot.identity, expected, require_inode=True):
        raise RuntimeError(f'Transaction backup does not match its source: {backup}')


def _artifact_state(artifact: dict[str, Any], *, require_restore_backup: bool,
                    allow_partial_staged: bool = False) -> dict[str, Any]:
    previous = artifact['previous']
    replacement = artifact['replacement']
    replacement_has_inode = replacement['device'] is not None
    target_path, backup_path, staged_path = map(
        Path, (artifact['target'], artifact['backup'], artifact['staged'])
    )
    target = snapshot_regular_file(target_path, require_owner=True)
    backup = snapshot_regular_file(backup_path, require_owner=True)
    staged = snapshot_regular_file(staged_path, require_owner=True)
    if target is None:
        target_kind = 'absent'
    elif previous is not None and identity_matches(target.identity, previous, require_inode=True):
        target_kind = 'previous'
    elif replacement_has_inode and identity_matches(target.identity, replacement, require_inode=True):
        target_kind = 'replacement'
    else:
        raise RuntimeError(f'Refusing unowned transaction target state: {target_path}')
    backup_kind = 'absent'
    if backup is not None:
        if previous is not None and identity_matches(
            backup.identity, previous, require_inode=True,
        ):
            backup_kind = 'previous'
        elif (
            replacement_has_inode
            and target_kind == 'previous'
            and identity_matches(backup.identity, replacement, require_inode=True)
        ):
            # Recovery may have committed RENAME_SWAP before being killed.
            backup_kind = 'displacedReplacement'
        else:
            raise RuntimeError(f'Refusing unowned transaction backup state: {backup_path}')
    elif require_restore_backup and previous is not None and target_kind != 'previous':
        raise RuntimeError(f'Retention installer cannot restore missing backup: {backup_path}')
    staged_owned_partial = False
    staged_kind = 'absent'
    if staged is not None:
        if identity_matches(
            staged.identity, replacement, require_inode=replacement_has_inode,
        ):
            staged_kind = 'replacement'
        elif previous is not None and identity_matches(
            staged.identity, previous, require_inode=True,
        ) and target_kind in ('previous', 'replacement'):
            # Publication uses RENAME_SWAP, leaving the displaced previous
            # inode at the journal-owned staged path until commit/rollback.
            staged_kind = 'displacedPrevious'
        elif (
            allow_partial_staged
            and staged.identity.owner == replacement['owner']
            and staged.identity.mode == replacement['mode']
        ):
            # The initializing journal reserves this random direct-child path
            # before bytes are written. It may therefore own a short write
            # left by SIGKILL even though its content hash is incomplete.
            staged_owned_partial = True
            staged_kind = 'ownedPartial'
        else:
            raise RuntimeError(f'Refusing unowned staged transaction file: {staged_path}')
    return {
        'target': target, 'targetKind': target_kind, 'backup': backup,
        'backupKind': backup_kind, 'staged': staged, 'stagedKind': staged_kind,
        'stagedOwnedPartial': staged_owned_partial,
    }


def validate_transaction_state(journal: dict[str, Any]) -> dict[str, dict[str, Any]]:
    require_restore_backup = journal['phase'] != 'committed'
    return {
        name: _artifact_state(
            journal[name], require_restore_backup=require_restore_backup,
            allow_partial_staged=journal['phase'] == 'initializing',
        ) for name in ('script', 'plist')
    }


def _unlink_known(
    path: Path,
    expected: dict[str, Any],
    *,
    require_inode: bool,
    quarantine: Path | None = None,
    operation: str = 'cleanup',
    alternatives: Sequence[tuple[dict[str, Any], bool]] = (),
    allow_owned_partial: bool = False,
) -> None:
    quarantine = quarantine or quarantine_path(path)
    snapshot = snapshot_regular_file(path, require_owner=True)
    from_quarantine = False
    if snapshot is None:
        snapshot = snapshot_regular_file(quarantine, require_owner=True)
        if snapshot is None:
            return
        from_quarantine = True
    candidates = ((expected, require_inode), *alternatives)
    matched = any(
        identity_matches(snapshot.identity, record, require_inode=needs_inode)
        for record, needs_inode in candidates
    )
    if not matched and allow_owned_partial:
        matched = (
            snapshot.identity.owner == expected['owner']
            and snapshot.identity.mode == expected['mode']
        )
    if not matched:
        raise RuntimeError(f'Refusing to delete unowned transaction file: {path}')
    if from_quarantine:
        _delete_verified_quarantine(quarantine, snapshot, operation=operation)
        return
    quarantine_and_unlink(
        path,
        snapshot,
        operation=operation,
        quarantine=quarantine,
    )


def unlink_staged_artifact(
    artifact: dict[str, Any],
    state: dict[str, Any],
) -> None:
    staged = Path(artifact['staged'])
    replacement = artifact['replacement']
    previous = artifact['previous']
    if state['stagedOwnedPartial']:
        current = snapshot_regular_file(staged, require_owner=True)
        if current is None or (
            current.identity.owner != replacement['owner']
            or current.identity.mode != replacement['mode']
        ):
            raise RuntimeError(f'Refusing to delete unowned staged transaction file: {staged}')
        quarantine_and_unlink(
            staged,
            current,
            operation='cleanup-staged-partial',
        )
    else:
        expected = previous if state['stagedKind'] == 'displacedPrevious' else replacement
        alternatives = (
            ((previous, True),) if previous is not None and expected is replacement else ()
        )
        if expected is previous:
            alternatives = ((replacement, replacement['device'] is not None),)
        _unlink_known(
            staged,
            expected,
            require_inode=(
                True if state['stagedKind'] == 'displacedPrevious'
                else replacement['device'] is not None
            ),
            operation='cleanup-staged',
            alternatives=alternatives,
            allow_owned_partial=replacement['device'] is None,
        )


def publish_artifact(artifact: dict[str, Any]) -> None:
    state = _artifact_state(artifact, require_restore_backup=True)
    target = Path(artifact['target'])
    staged = Path(artifact['staged'])
    if state['stagedKind'] != 'replacement' or state['staged'] is None:
        raise RuntimeError(f'Transaction replacement is unavailable: {staged}')
    if state['targetKind'] == 'previous' and state['target'] is not None:
        swap_verified(
            staged,
            target,
            state['staged'],
            state['target'],
            operation='publish-artifact-swap',
        )
    elif state['targetKind'] == 'absent':
        verified_replace(
            staged,
            target,
            state['staged'],
            None,
            operation='publish-artifact-exclusive',
        )
    else:
        raise RuntimeError(f'Transaction target is not publishable: {target}')
    published = _artifact_state(artifact, require_restore_backup=True)
    if published['targetKind'] != 'replacement':
        raise RuntimeError(f'Transaction publication did not install replacement: {target}')


def restore_artifact(artifact: dict[str, Any], *, allow_partial_staged: bool) -> None:
    state = _artifact_state(
        artifact,
        require_restore_backup=True,
        allow_partial_staged=allow_partial_staged,
    )
    target, backup, staged = map(Path, (
        artifact['target'], artifact['backup'], artifact['staged'],
    ))
    previous, replacement = artifact['previous'], artifact['replacement']
    if previous is None:
        if state['targetKind'] == 'replacement':
            _unlink_known(
                target,
                replacement,
                require_inode=True,
                quarantine=Path(f'{artifact["staged"]}.rollback-quarantine'),
                operation='rollback-remove-replacement',
            )
        else:
            # Complete a kill after the replacement was quarantined but
            # before it was unlinked.
            _unlink_known(
                target,
                replacement,
                require_inode=True,
                quarantine=Path(f'{artifact["staged"]}.rollback-quarantine'),
                operation='rollback-remove-replacement',
            )
    elif state['targetKind'] != 'previous':
        if state['backup'] is None or state['target'] is None:
            raise RuntimeError(f'Rollback pair disappeared before restore: {target}')
        swap_verified(
            backup,
            target,
            state['backup'],
            state['target'],
            operation='rollback-swap',
        )
        restored = snapshot_regular_file(target, require_owner=True)
        if restored is None or not identity_matches(restored.identity, previous, require_inode=True):
            raise RuntimeError(f'Rollback did not restore the previous file: {target}')
        state = _artifact_state(
            artifact,
            require_restore_backup=True,
            allow_partial_staged=allow_partial_staged,
        )
    if previous is not None and state['backupKind'] != 'absent':
        backup_expected = (
            replacement if state['backupKind'] == 'displacedReplacement' else previous
        )
        _unlink_known(
            backup,
            backup_expected,
            require_inode=True,
            operation='rollback-cleanup-backup',
            alternatives=(
                (previous, True),
                (replacement, replacement['device'] is not None),
            ),
        )
    unlink_staged_artifact(artifact, state)


def remove_reserved_next_journal(journal: dict[str, Any]) -> None:
    path = Path(journal['nextJournal'])
    candidate = path if path.exists() or path.is_symlink() else quarantine_path(path)
    snapshot = snapshot_regular_file(candidate, require_owner=True)
    if snapshot is None:
        return
    if (snapshot.identity.mode != 0o600
            or path.parent != Path(journal['script']['target']).parent):
        raise RuntimeError(f'Refusing to delete unowned journal staging file: {path}')
    try:
        candidate_journal = json.loads(snapshot.data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        candidate_journal = None
    if isinstance(candidate_journal, dict) and (
        candidate_journal.get('token') != journal['token']
        or candidate_journal.get('contract') != JOURNAL_CONTRACT
    ):
        raise RuntimeError(f'Refusing unowned journal staging file: {candidate}')
    # Once the durable main journal names this exact random staging path, a
    # user-owned 0600 non-JSON file there is a journal write interrupted by a
    # process death. The initial write has no durable main journal and remains
    # deliberately unproven/preserved by load_pending_journal instead.
    if candidate == path:
        quarantine_and_unlink(
            path, snapshot, operation='cleanup-next-journal',
        )
    else:
        _delete_verified_quarantine(
            candidate, snapshot, operation='cleanup-next-journal',
        )


def remove_main_journal(journal: dict[str, Any], *, support: Path, agents: Path) -> None:
    path = support / JOURNAL_NAME
    candidate = path if path.exists() or path.is_symlink() else quarantine_path(path)
    current = load_journal_file(candidate, support=support, agents=agents)
    if current['token'] != journal['token']:
        raise RuntimeError('Refusing to delete a different installer transaction journal')
    snapshot = snapshot_regular_file(candidate, require_owner=True)
    if snapshot is None:
        raise RuntimeError('Installer transaction journal disappeared before cleanup')
    if candidate == path:
        quarantine_and_unlink(
            path, snapshot, operation='cleanup-main-journal',
        )
    else:
        _delete_verified_quarantine(
            candidate, snapshot, operation='cleanup-main-journal',
        )


def cleanup_transaction_artifacts(journal: dict[str, Any], *, support: Path,
                                  agents: Path,
                                  checkpoint: Checkpoint | None = None) -> None:
    states = validate_transaction_state(journal)
    for name in ('script', 'plist'):
        artifact = journal[name]
        previous, replacement = artifact['previous'], artifact['replacement']
        if previous is not None:
            _unlink_known(
                Path(artifact['backup']),
                previous,
                require_inode=True,
                operation='cleanup-backup',
                alternatives=((replacement, replacement['device'] is not None),),
            )
        elif Path(artifact['backup']).exists() or Path(artifact['backup']).is_symlink():
            raise RuntimeError(f'Refusing unexpected transaction backup: {artifact["backup"]}')
        unlink_staged_artifact(artifact, states[name])
        _mark(checkpoint, f'cleanup_{name}_artifacts')
    remove_reserved_next_journal(journal)
    _mark(checkpoint, 'cleanup_next_journal')
    _mark(checkpoint, 'before_journal_remove')
    remove_main_journal(journal, support=support, agents=agents)
    _mark(checkpoint, 'journal_removed')


def recover_pending_installation(*, support: Path, agents: Path, runner: Runner,
                                 checkpoint: Checkpoint | None = None) -> str | None:
    journal = load_pending_journal(support=support, agents=agents)
    if journal is None:
        return None
    target, domain = journal['target'], journal['domain']
    states = validate_transaction_state(journal)
    if journal['phase'] == 'committed':
        if any(states[name]['targetKind'] != 'replacement' for name in ('script', 'plist')):
            raise RuntimeError('Committed retention installation no longer matches its journal')
        if not service_is_loaded(runner, target):
            raise RuntimeError('Committed retention LaunchAgent is not loaded')
        cleanup_transaction_artifacts(
            journal, support=support, agents=agents, checkpoint=checkpoint,
        )
        return 'committed'

    expected_kinds = {
        name: 'previous' if journal[name]['previous'] is not None else 'absent'
        for name in ('script', 'plist')
    }
    pair_is_previous = all(
        states[name]['targetKind'] == expected_kinds[name]
        for name in ('script', 'plist')
    )
    if pair_is_previous:
        loaded = service_is_loaded(runner, target)
        if loaded == journal['previousLoaded']:
            # A preparation failure or a previous interrupted recovery may
            # already have restored the public paths. Still run per-artifact
            # restoration so a process death after target -> quarantine on a
            # first install cannot orphan the replacement when both targets
            # now look absent.
            for name in ('script', 'plist'):
                restore_artifact(
                    journal[name],
                    allow_partial_staged=journal['phase'] == 'initializing',
                )
            fsync_directory(Path(journal['script']['target']).parent)
            fsync_directory(Path(journal['plist']['target']).parent)
            cleanup_transaction_artifacts(
                journal, support=support, agents=agents, checkpoint=checkpoint,
            )
            return 'rolled_back'

    errors: list[str] = []
    try:
        unload_for_rollback(runner, target)
    except Exception as error:
        errors.append(f'cannot unload failed LaunchAgent: {error}')
    for name in ('script', 'plist'):
        try:
            restore_artifact(
                journal[name], allow_partial_staged=journal['phase'] == 'initializing',
            )
        except Exception as error:
            errors.append(f'cannot restore {journal[name]["target"]}: {error}')

    restored_pair = False
    try:
        final_states = validate_transaction_state(journal)
        restored_pair = all(
            final_states[name]['targetKind'] == expected_kinds[name]
            for name in ('script', 'plist')
        )
        if not restored_pair:
            errors.append('helper/plist pair did not return to its previous state')
        else:
            fsync_directory(Path(journal['script']['target']).parent)
            fsync_directory(Path(journal['plist']['target']).parent)
    except Exception as error:
        errors.append(f'cannot verify restored transaction state: {error}')

    # Never bootstrap against a partly restored helper/plist pair.
    if restored_pair and journal['previousLoaded']:
        try:
            plist_snapshot = snapshot_regular_file(
                Path(journal['plist']['target']), require_owner=True,
            )
            if plist_snapshot is None:
                raise RuntimeError('previous LaunchAgent plist is missing')
            configuration = plistlib.loads(plist_snapshot.data)
            if not isinstance(configuration, dict) or configuration.get('Label') != LABEL:
                raise RuntimeError('previous LaunchAgent plist has an unexpected identity')
            launchctl(runner, ['bootstrap', domain, journal['plist']['target']], check=True)
            launchctl(runner, ['print', target], check=True)
        except Exception as error:
            errors.append(f'cannot rebootstrap previous LaunchAgent: {error}')
    elif restored_pair:
        try:
            if service_is_loaded(runner, target):
                errors.append('failed LaunchAgent remains loaded after rollback')
        except Exception as error:
            errors.append(f'cannot confirm unloaded rollback state: {error}')
    if errors:
        raise RuntimeError('; '.join(errors))
    cleanup_transaction_artifacts(
        journal, support=support, agents=agents, checkpoint=checkpoint,
    )
    return 'rolled_back'


def _mark(checkpoint: Checkpoint | None, name: str) -> None:
    if checkpoint is not None:
        checkpoint(name)


def _install_unlocked(*, source_script: Path | None = None, support: Path = SUPPORT,
                      agents: Path = AGENTS, python_executable: str = sys.executable,
                      runner: Runner = subprocess.run,
                      checkpoint: Checkpoint | None = None) -> dict[str, str]:
    recover_pending_installation(support=support, agents=agents, runner=runner)
    source = source_script or Path(__file__).with_name('staging-retention.py')
    source_snapshot = snapshot_regular_file(source)
    if source_snapshot is None:
        raise RuntimeError(f'Missing repository retention helper: {source}')
    root = support.parent / 'Staging Backups'
    root.mkdir(parents=True, exist_ok=True)
    script, plist = support / 'staging-retention.py', agents / f'{LABEL}.plist'
    domain = f'gui/{os.getuid()}'
    target = f'{domain}/{LABEL}'
    configuration = {
        'Label': LABEL, 'ProgramArguments': [python_executable, str(script), '--apply'],
        'RunAtLoad': True, 'StartInterval': 3600, 'WatchPaths': [str(root)],
        'StandardOutPath': str(support / 'staging-retention.log'),
        'StandardErrorPath': str(support / 'staging-retention.err.log'),
    }
    plist_bytes = plistlib.dumps(configuration, fmt=plistlib.FMT_XML, sort_keys=True)
    previous_script = snapshot_regular_file(script, require_owner=True)
    previous_plist = snapshot_regular_file(plist, require_owner=True)
    was_loaded = service_is_loaded(runner, target)
    if was_loaded:
        if previous_script is None or previous_plist is None:
            raise RuntimeError('Loaded retention LaunchAgent has no complete restorable files; refusing replacement')
        try:
            previous_configuration = plistlib.loads(previous_plist.data)
        except plistlib.InvalidFileException as error:
            raise RuntimeError('Loaded retention LaunchAgent plist is not restorable') from error
        if not isinstance(previous_configuration, dict) or previous_configuration.get('Label') != LABEL:
            raise RuntimeError('Loaded retention LaunchAgent plist has an unexpected identity')
    journal = new_journal(
        support=support, agents=agents, domain=domain, target=target,
        previous_loaded=was_loaded, previous_script=previous_script,
        previous_plist=previous_plist, script_bytes=source_snapshot.data,
        plist_bytes=plist_bytes,
    )
    result = {'installed': str(script), 'sha256': source_snapshot.identity.sha256,
              'launchAgent': target}
    try:
        write_journal(journal, support=support, agents=agents, initial=True)
        _mark(checkpoint, 'journal_initialized')
        for name in ('script', 'plist'):
            artifact = journal[name]
            if artifact['previous'] is not None:
                create_backup(Path(artifact['target']), Path(artifact['backup']), artifact['previous'])
            _mark(checkpoint, f'{name}_backup_created')
        script_identity = write_owned_file(
            Path(journal['script']['staged']), source_snapshot.data, 0o700,
        )
        _mark(checkpoint, 'script_staged')
        plist_identity = write_owned_file(Path(journal['plist']['staged']), plist_bytes, 0o600)
        _mark(checkpoint, 'plist_staged')
        staged_plist = snapshot_regular_file(Path(journal['plist']['staged']), require_owner=True)
        if staged_plist is None or plistlib.loads(staged_plist.data) != configuration:
            raise RuntimeError('LaunchAgent plist staging copy failed verification')
        journal['script']['replacement'] = script_identity.to_record()
        journal['plist']['replacement'] = plist_identity.to_record()
        journal['phase'] = 'prepared'
        write_journal(journal, support=support, agents=agents)
        _mark(checkpoint, 'artifacts_prepared')
        if was_loaded:
            launchctl(runner, ['bootout', target], check=True)
        _mark(checkpoint, 'service_booted_out')
        journal['phase'] = 'service_stopped'
        write_journal(journal, support=support, agents=agents)
        _mark(checkpoint, 'service_stopped')
        publish_artifact(journal['script'])
        _mark(checkpoint, 'script_replaced')
        journal['phase'] = 'script_published'
        write_journal(journal, support=support, agents=agents)
        _mark(checkpoint, 'script_published')
        publish_artifact(journal['plist'])
        _mark(checkpoint, 'plist_replaced')
        journal['phase'] = 'plist_published'
        write_journal(journal, support=support, agents=agents)
        _mark(checkpoint, 'plist_published')
        states = validate_transaction_state(journal)
        if any(states[name]['targetKind'] != 'replacement' for name in ('script', 'plist')):
            raise RuntimeError('Published LaunchAgent files do not match their transaction')
        launchctl(runner, ['bootstrap', domain, str(plist)], check=True)
        _mark(checkpoint, 'bootstrap_returned')
        journal['phase'] = 'bootstrap_succeeded'
        write_journal(journal, support=support, agents=agents)
        _mark(checkpoint, 'bootstrap_succeeded')
        launchctl(runner, ['print', target], check=True)
        _mark(checkpoint, 'service_printed')
        journal['phase'] = 'service_verified'
        write_journal(journal, support=support, agents=agents)
        _mark(checkpoint, 'service_verified')
        journal['phase'] = 'committed'
        write_journal(journal, support=support, agents=agents)
        _mark(checkpoint, 'committed')
    except Exception as error:
        try:
            outcome = recover_pending_installation(support=support, agents=agents, runner=runner)
        except Exception as rollback_error:
            raise RuntimeError(
                f'Retention LaunchAgent update failed ({error}); rollback incomplete: {rollback_error}'
            ) from error
        if outcome == 'committed':
            return result
        raise
    recover_pending_installation(
        support=support, agents=agents, runner=runner, checkpoint=checkpoint,
    )
    return result


def install(*, source_script: Path | None = None, support: Path = SUPPORT,
            agents: Path = AGENTS, python_executable: str = sys.executable,
            runner: Runner = subprocess.run,
            checkpoint: Checkpoint | None = None) -> dict[str, str]:
    support.mkdir(parents=True, exist_ok=True)
    agents.mkdir(parents=True, exist_ok=True)
    lock_path = support / INSTALL_LOCK_NAME
    with open_install_lock(lock_path) as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another retention LaunchAgent installation is already running') from error
        try:
            return _install_unlocked(
                source_script=source_script, support=support, agents=agents,
                python_executable=python_executable, runner=runner,
                checkpoint=checkpoint,
            )
        finally:
            try:
                fcntl.flock(lock, fcntl.LOCK_UN)
            except OSError:
                pass


def main() -> int:
    print(json.dumps(install()))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
