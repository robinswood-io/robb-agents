"""Transactionally install this user's Robb staging retention LaunchAgent."""
from __future__ import annotations

import fcntl
import json
import logging
import os
import plistlib
import stat
import subprocess
import sys
from pathlib import Path
from typing import cast

from robb_retention_atomic import (
    quarantine_and_unlink,
    quarantine_path,
    renameatx_np,
    swap_verified,
    write_owned_file,
)
from robb_retention_files import (
    AGENTS,
    INSTALL_LOCK_NAME,
    JOURNAL_NAME,
    LABEL,
    LAUNCHCTL_NO_SUCH_PROCESS,
    LAUNCHCTL_NOT_FOUND,
    RENAME_EXCL,
    RENAME_SWAP,
    SUPPORT,
    Checkpoint,
    Runner,
    is_record,
    mark_checkpoint,
    open_install_lock,
    sha256_file,
    snapshot_regular_file,
)
from robb_retention_journal import (
    create_backup,
    launchctl,
    load_pending_journal,
    new_journal,
    service_is_loaded,
    write_journal,
)
from robb_retention_recovery import (
    publish_artifact,
    recover_pending_installation,
    validate_transaction_state,
)

logger = logging.getLogger(__name__)


def _install_unlocked(*, source_script: Path | None = None, support: Path = SUPPORT,
                      agents: Path = AGENTS, python_executable: str = sys.executable,
                      runner: Runner = subprocess.run,
                      checkpoint: Checkpoint | None = None) -> dict[str, str]:
    _ = recover_pending_installation(support=support, agents=agents, runner=runner)
    source = source_script or Path(__file__).with_name('staging_retention.py')
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
            previous_configuration = cast(object, plistlib.loads(previous_plist.data))
        except plistlib.InvalidFileException as error:
            raise RuntimeError('Loaded retention LaunchAgent plist is not restorable') from error
        if not is_record(previous_configuration) or previous_configuration.get('Label') != LABEL:
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
        mark_checkpoint(checkpoint, 'journal_initialized')
        for name in ('script', 'plist'):
            artifact = journal[name]
            if artifact['previous'] is not None:
                create_backup(Path(artifact['target']), Path(artifact['backup']), artifact['previous'])
            mark_checkpoint(checkpoint, f'{name}_backup_created')
        script_identity = write_owned_file(
            Path(journal['script']['staged']), source_snapshot.data, 0o700,
        )
        mark_checkpoint(checkpoint, 'script_staged')
        plist_identity = write_owned_file(Path(journal['plist']['staged']), plist_bytes, 0o600)
        mark_checkpoint(checkpoint, 'plist_staged')
        staged_plist = snapshot_regular_file(Path(journal['plist']['staged']), require_owner=True)
        if staged_plist is None or plistlib.loads(staged_plist.data) != configuration:
            raise RuntimeError('LaunchAgent plist staging copy failed verification')
        journal['script']['replacement'] = script_identity.to_record()
        journal['plist']['replacement'] = plist_identity.to_record()
        journal['phase'] = 'prepared'
        write_journal(journal, support=support, agents=agents)
        mark_checkpoint(checkpoint, 'artifacts_prepared')
        if was_loaded:
            _ = launchctl(runner, ['bootout', target], check=True)
        mark_checkpoint(checkpoint, 'service_booted_out')
        journal['phase'] = 'service_stopped'
        write_journal(journal, support=support, agents=agents)
        mark_checkpoint(checkpoint, 'service_stopped')
        publish_artifact(journal['script'])
        mark_checkpoint(checkpoint, 'script_replaced')
        journal['phase'] = 'script_published'
        write_journal(journal, support=support, agents=agents)
        mark_checkpoint(checkpoint, 'script_published')
        publish_artifact(journal['plist'])
        mark_checkpoint(checkpoint, 'plist_replaced')
        journal['phase'] = 'plist_published'
        write_journal(journal, support=support, agents=agents)
        mark_checkpoint(checkpoint, 'plist_published')
        states = validate_transaction_state(journal)
        if any(states[name]['targetKind'] != 'replacement' for name in ('script', 'plist')):
            raise RuntimeError('Published LaunchAgent files do not match their transaction')
        _ = launchctl(runner, ['bootstrap', domain, str(plist)], check=True)
        mark_checkpoint(checkpoint, 'bootstrap_returned')
        journal['phase'] = 'bootstrap_succeeded'
        write_journal(journal, support=support, agents=agents)
        mark_checkpoint(checkpoint, 'bootstrap_succeeded')
        _ = launchctl(runner, ['print', target], check=True)
        mark_checkpoint(checkpoint, 'service_printed')
        journal['phase'] = 'service_verified'
        write_journal(journal, support=support, agents=agents)
        mark_checkpoint(checkpoint, 'service_verified')
        journal['phase'] = 'committed'
        write_journal(journal, support=support, agents=agents)
        mark_checkpoint(checkpoint, 'committed')
    except Exception as error:
        try:
            outcome = recover_pending_installation(support=support, agents=agents, runner=runner)
        except Exception as rollback_error:
            logger.exception("Failure during _install_unlocked")
            raise RuntimeError(
                f'Retention LaunchAgent update failed ({error}); rollback incomplete: {rollback_error}'
            ) from error
        if outcome == 'committed':
            return result
        raise
    _ = recover_pending_installation(
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

__all__ = [
    'INSTALL_LOCK_NAME', 'JOURNAL_NAME', 'LABEL',
    'LAUNCHCTL_NOT_FOUND', 'LAUNCHCTL_NO_SUCH_PROCESS', 'RENAME_EXCL',
    'RENAME_SWAP', 'fcntl', 'install',
    'load_pending_journal', 'main', 'open_install_lock',
    'quarantine_and_unlink', 'quarantine_path', 'recover_pending_installation',
    'renameatx_np', 'sha256_file', 'snapshot_regular_file',
    'stat', 'swap_verified', 'sys',
    'write_owned_file',
]
