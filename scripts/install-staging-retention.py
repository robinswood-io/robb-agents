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
from typing import TypeAlias, Callable, Sequence

from robb_retention_files import (
    JsonValue,
    LABEL,
    SUPPORT,
    AGENTS,
    Runner,
    Checkpoint,
    LAUNCHCTL_NOT_FOUND,
    LAUNCHCTL_NO_SUCH_PROCESS,
    INSTALL_LOCK_NAME,
    JOURNAL_NAME,
    JOURNAL_CONTRACT,
    JOURNAL_VERSION,
    JOURNAL_PHASES,
    TOKEN_RE,
    IDENTITY_KEYS,
    ARTIFACT_KEYS,
    JOURNAL_KEYS,
    VOLATILE_XATTRS,
    RENAME_SWAP,
    RENAME_EXCL,
    FileIdentity,
    FileSnapshot,
    sha256_bytes,
    xattrs_sha256,
    _open_regular_for_read,
    snapshot_regular_file,
    sha256_file,
    open_install_lock,
    fsync_directory,
    _mark,
)
from robb_retention_atomic import (
    before_verified_path_mutation,
    before_atomic_rename,
    after_atomic_rename,
    open_owned_directory,
    revalidate_directory_entry,
    renameatx_np,
    quarantine_path,
    _delete_verified_quarantine,
    quarantine_and_unlink,
    swap_verified,
    verified_replace,
    write_owned_file,
)
from robb_retention_journal import (
    launchctl,
    service_is_loaded,
    unload_for_rollback,
    _is_plain_int,
    validate_identity_record,
    identity_matches,
    replacement_expectation,
    transaction_paths,
    new_journal,
    validate_journal,
    journal_bytes,
    load_journal_file,
    write_journal,
    load_pending_journal,
    create_backup,
)
from robb_retention_recovery import (
    _artifact_state,
    validate_transaction_state,
    _unlink_known,
    unlink_staged_artifact,
    publish_artifact,
    restore_artifact,
    remove_reserved_next_journal,
    remove_main_journal,
    cleanup_transaction_artifacts,
    recover_pending_installation,
)

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
