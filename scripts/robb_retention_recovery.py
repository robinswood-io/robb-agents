from __future__ import annotations

import json
import logging
import plistlib
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from robb_retention_atomic import (
    delete_verified_quarantine,
    quarantine_and_unlink,
    quarantine_path,
    swap_verified,
    verified_replace,
)
from robb_retention_files import (
    ARTIFACT_NAMES,
    JOURNAL_CONTRACT,
    JOURNAL_NAME,
    LABEL,
    ArtifactState,
    Checkpoint,
    IdentityRecord,
    JournalArtifact,
    RetentionJournal,
    Runner,
    fsync_directory,
    is_record,
    mark_checkpoint,
    snapshot_regular_file,
)
from robb_retention_journal import (
    identity_matches,
    launchctl,
    load_journal_file,
    load_pending_journal,
    service_is_loaded,
    unload_for_rollback,
)

logger = logging.getLogger(__name__)


def _artifact_state(artifact: JournalArtifact, *, require_restore_backup: bool,
                    allow_partial_staged: bool = False) -> ArtifactState:
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

def validate_transaction_state(journal: RetentionJournal) -> dict[str, ArtifactState]:
    require_restore_backup = journal['phase'] != 'committed'
    return {
        name: _artifact_state(
            journal[name], require_restore_backup=require_restore_backup,
            allow_partial_staged=journal['phase'] == 'initializing',
        ) for name in ARTIFACT_NAMES
    }

def _unlink_known(
    path: Path,
    expected: IdentityRecord,
    *,
    require_inode: bool,
    quarantine: Path | None = None,
    operation: str = 'cleanup',
    alternatives: Sequence[tuple[IdentityRecord, bool]] = (),
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
        delete_verified_quarantine(quarantine, snapshot, operation=operation)
        return
    quarantine_and_unlink(
        path,
        snapshot,
        operation=operation,
        quarantine=quarantine,
    )

def unlink_staged_artifact(
    artifact: JournalArtifact,
    state: ArtifactState,
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
        if expected is None:
            raise RuntimeError('Displaced staged file has no recorded previous identity')
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

def publish_artifact(artifact: JournalArtifact) -> None:
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

def restore_artifact(artifact: JournalArtifact, *, allow_partial_staged: bool) -> None:
    state = _artifact_state(
        artifact,
        require_restore_backup=True,
        allow_partial_staged=allow_partial_staged,
    )
    target, backup, _staged = map(Path, (
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

def remove_reserved_next_journal(journal: RetentionJournal) -> None:
    path = Path(journal['nextJournal'])
    candidate = path if path.exists() or path.is_symlink() else quarantine_path(path)
    snapshot = snapshot_regular_file(candidate, require_owner=True)
    if snapshot is None:
        return
    if (snapshot.identity.mode != 0o600
            or path.parent != Path(journal['script']['target']).parent):
        raise RuntimeError(f'Refusing to delete unowned journal staging file: {path}')
    try:
        candidate_journal = cast(object, json.loads(snapshot.data))
    except (UnicodeDecodeError, json.JSONDecodeError):
        candidate_journal = None
    if is_record(candidate_journal) and (
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
        delete_verified_quarantine(
            candidate, snapshot, operation='cleanup-next-journal',
        )

def remove_main_journal(journal: RetentionJournal, *, support: Path, agents: Path) -> None:
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
        delete_verified_quarantine(
            candidate, snapshot, operation='cleanup-main-journal',
        )

def cleanup_transaction_artifacts(journal: RetentionJournal, *, support: Path,
                                  agents: Path,
                                  checkpoint: Checkpoint | None = None) -> None:
    states = validate_transaction_state(journal)
    for name in ARTIFACT_NAMES:
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
        mark_checkpoint(checkpoint, f'cleanup_{name}_artifacts')
    remove_reserved_next_journal(journal)
    mark_checkpoint(checkpoint, 'cleanup_next_journal')
    mark_checkpoint(checkpoint, 'before_journal_remove')
    remove_main_journal(journal, support=support, agents=agents)
    mark_checkpoint(checkpoint, 'journal_removed')

def recover_pending_installation(*, support: Path, agents: Path, runner: Runner,
                                 checkpoint: Checkpoint | None = None) -> str | None:
    journal = load_pending_journal(support=support, agents=agents)
    if journal is None:
        return None
    target, domain = journal['target'], journal['domain']
    states = validate_transaction_state(journal)
    if journal['phase'] == 'committed':
        if any(states[name]['targetKind'] != 'replacement' for name in ARTIFACT_NAMES):
            raise RuntimeError('Committed retention installation no longer matches its journal')
        if not service_is_loaded(runner, target):
            raise RuntimeError('Committed retention LaunchAgent is not loaded')
        cleanup_transaction_artifacts(
            journal, support=support, agents=agents, checkpoint=checkpoint,
        )
        return 'committed'

    expected_kinds = {
        name: 'previous' if journal[name]['previous'] is not None else 'absent'
        for name in ARTIFACT_NAMES
    }
    pair_is_previous = all(
        states[name]['targetKind'] == expected_kinds[name]
        for name in ARTIFACT_NAMES
    )
    if pair_is_previous:
        loaded = service_is_loaded(runner, target)
        if loaded == journal['previousLoaded']:
            # A preparation failure or a previous interrupted recovery may
            # already have restored the public paths. Still run per-artifact
            # restoration so a process death after target -> quarantine on a
            # first install cannot orphan the replacement when both targets
            # now look absent.
            for name in ARTIFACT_NAMES:
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
        logger.exception("Failure during recover_pending_installation")
        errors.append(f'cannot unload failed LaunchAgent: {error}')
    for name in ARTIFACT_NAMES:
        try:
            restore_artifact(
                journal[name], allow_partial_staged=journal['phase'] == 'initializing',
            )
        except Exception as error:
            logger.exception("Failure during recover_pending_installation")
            errors.append(f'cannot restore {journal[name]["target"]}: {error}')

    restored_pair = False
    try:
        final_states = validate_transaction_state(journal)
        restored_pair = all(
            final_states[name]['targetKind'] == expected_kinds[name]
            for name in ARTIFACT_NAMES
        )
        if not restored_pair:
            errors.append('helper/plist pair did not return to its previous state')
        else:
            fsync_directory(Path(journal['script']['target']).parent)
            fsync_directory(Path(journal['plist']['target']).parent)
    except Exception as error:
        logger.exception("Failure during recover_pending_installation")
        errors.append(f'cannot verify restored transaction state: {error}')

    # Never bootstrap against a partly restored helper/plist pair.
    if restored_pair and journal['previousLoaded']:
        try:
            plist_snapshot = snapshot_regular_file(
                Path(journal['plist']['target']), require_owner=True,
            )
            if plist_snapshot is None:
                raise RuntimeError('previous LaunchAgent plist is missing')
            configuration = cast(object, plistlib.loads(plist_snapshot.data))
            if not is_record(configuration) or configuration.get('Label') != LABEL:
                raise RuntimeError('previous LaunchAgent plist has an unexpected identity')
            _ = launchctl(runner, ['bootstrap', domain, journal['plist']['target']], check=True)
            _ = launchctl(runner, ['print', target], check=True)
        except Exception as error:
            logger.exception("Failure during recover_pending_installation")
            errors.append(f'cannot rebootstrap previous LaunchAgent: {error}')
    elif restored_pair:
        try:
            if service_is_loaded(runner, target):
                errors.append('failed LaunchAgent remains loaded after rollback')
        except Exception as error:
            logger.exception("Failure during recover_pending_installation")
            errors.append(f'cannot confirm unloaded rollback state: {error}')
    if errors:
        raise RuntimeError('; '.join(errors))
    cleanup_transaction_artifacts(
        journal, support=support, agents=agents, checkpoint=checkpoint,
    )
    return 'rolled_back'
