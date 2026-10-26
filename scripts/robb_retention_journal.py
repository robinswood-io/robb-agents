from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
from typing import TypeAlias, Callable, Sequence

from robb_retention_files import (
    JsonValue,
    LABEL,
    Runner,
    LAUNCHCTL_NOT_FOUND,
    LAUNCHCTL_NO_SUCH_PROCESS,
    JOURNAL_NAME,
    JOURNAL_CONTRACT,
    JOURNAL_VERSION,
    JOURNAL_PHASES,
    TOKEN_RE,
    IDENTITY_KEYS,
    ARTIFACT_KEYS,
    JOURNAL_KEYS,
    FileIdentity,
    FileSnapshot,
    sha256_bytes,
    snapshot_regular_file,
    fsync_directory,
)
from robb_retention_atomic import (
    quarantine_path,
    verified_replace,
    write_owned_file,
)

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

def _is_plain_int(value: JsonValue) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)

def validate_identity_record(value: JsonValue, *, allow_unpublished: bool) -> dict[str, JsonValue]:
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

def identity_matches(identity: FileIdentity, record: dict[str, JsonValue], *,
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

def replacement_expectation(data: bytes, mode: int) -> dict[str, JsonValue]:
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
                plist_bytes: bytes) -> dict[str, JsonValue]:
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

def validate_journal(value: JsonValue, *, support: Path, agents: Path) -> dict[str, JsonValue]:
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

def journal_bytes(journal: dict[str, JsonValue]) -> bytes:
    return (json.dumps(journal, sort_keys=True, separators=(',', ':')) + '\n').encode()

def load_journal_file(path: Path, *, support: Path, agents: Path) -> dict[str, JsonValue]:
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

def write_journal(journal: dict[str, JsonValue], *, support: Path, agents: Path,
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

def load_pending_journal(*, support: Path, agents: Path) -> dict[str, JsonValue] | None:
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
    valid_candidates: list[tuple[Path, dict[str, JsonValue]]] = []
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

def create_backup(target: Path, backup: Path, expected: dict[str, JsonValue]) -> None:
    if backup.exists() or backup.is_symlink():
        raise RuntimeError(f'Transaction backup already exists: {backup}')
    os.link(target, backup, follow_symlinks=False)
    fsync_directory(backup.parent)
    snapshot = snapshot_regular_file(backup, require_owner=True)
    if snapshot is None or not identity_matches(snapshot.identity, expected, require_inode=True):
        raise RuntimeError(f'Transaction backup does not match its source: {backup}')
