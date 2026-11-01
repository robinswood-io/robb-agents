from __future__ import annotations

import hashlib
import os
import re
import stat
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypeAlias, TypedDict, TypeGuard, cast

JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]

LABEL = 'io.robinswood.robbagents.staging-retention'

SUPPORT = Path.home() / 'Library/Application Support/Robb Agents/Maintenance'

AGENTS = Path.home() / 'Library/LaunchAgents'

Runner = Callable[..., subprocess.CompletedProcess[str]]

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

    def to_record(self) -> IdentityRecord:
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

def mark_checkpoint(checkpoint: Checkpoint | None, name: str) -> None:
    if checkpoint is not None:
        checkpoint(name)


class IdentityRecord(TypedDict):
    device: int | None
    inode: int | None
    owner: int
    group: int
    mode: int
    flags: int
    size: int
    sha256: str
    xattrsSha256: str


class JournalArtifact(TypedDict):
    target: str
    backup: str
    staged: str
    previous: IdentityRecord | None
    replacement: IdentityRecord


class RetentionJournal(TypedDict):
    contract: str
    version: int
    token: str
    phase: str
    label: str
    domain: str
    target: str
    previousLoaded: bool
    nextJournal: str
    script: JournalArtifact
    plist: JournalArtifact


class ArtifactState(TypedDict):
    target: FileSnapshot | None
    targetKind: str
    backup: FileSnapshot | None
    backupKind: str
    staged: FileSnapshot | None
    stagedKind: str
    stagedOwnedPartial: bool


ARTIFACT_NAMES: tuple[Literal['script'], Literal['plist']] = ('script', 'plist')


def is_record(value: object) -> TypeGuard[dict[str, object]]:
    return isinstance(value, dict) and all(isinstance(key, str) for key in cast(dict[object, object], value))
