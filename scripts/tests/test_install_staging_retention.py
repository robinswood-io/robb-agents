from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    'install_staging_retention',
    Path(__file__).parents[1] / 'install-staging-retention.py',
)
installer = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)
production_renameatx_np = installer.renameatx_np


class SimulatedProcessDeath(BaseException):
    pass


_emulated_rename_counter = 0


def emulate_renameatx_np(
    directory_descriptor: int,
    source_name: str,
    destination_name: str,
    flags: int,
) -> None:
    """Deterministic non-macOS test double; production remains fail-closed."""
    global _emulated_rename_counter
    if flags == installer.RENAME_EXCL:
        try:
            os.stat(
                destination_name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(destination_name)
        os.rename(
            source_name,
            destination_name,
            src_dir_fd=directory_descriptor,
            dst_dir_fd=directory_descriptor,
        )
        return
    if flags != installer.RENAME_SWAP:
        raise AssertionError(f'Unexpected emulated rename flags: {flags}')
    _emulated_rename_counter += 1
    temporary_name = f'.rename-swap-test-{os.getpid()}-{_emulated_rename_counter}'
    os.rename(
        source_name,
        temporary_name,
        src_dir_fd=directory_descriptor,
        dst_dir_fd=directory_descriptor,
    )
    os.rename(
        destination_name,
        source_name,
        src_dir_fd=directory_descriptor,
        dst_dir_fd=directory_descriptor,
    )
    os.rename(
        temporary_name,
        destination_name,
        src_dir_fd=directory_descriptor,
        dst_dir_fd=directory_descriptor,
    )


def stat_mode(path: Path) -> int:
    return installer.stat.S_IMODE(path.stat().st_mode)


class LaunchctlRunner:
    def __init__(
        self,
        *,
        loaded: bool,
        fail_bootstrap_call: int | None = None,
        fail_print_call: int | None = None,
        fail_print_from_call: int | None = None,
    ) -> None:
        self.loaded = loaded
        self.fail_bootstrap_call = fail_bootstrap_call
        self.fail_print_call = fail_print_call
        self.fail_print_from_call = fail_print_from_call
        self.bootstrap_calls = 0
        self.print_calls = 0
        self.calls: list[list[str]] = []

    def __call__(
        self,
        arguments: list[str],
        *,
        check: bool,
        capture_output: bool = False,
    ) -> subprocess.CompletedProcess:
        del capture_output
        self.calls.append(arguments)
        action = arguments[1]
        if action == 'print':
            self.print_calls += 1
            if (
                self.print_calls == self.fail_print_call
                or (
                    self.fail_print_from_call is not None
                    and self.print_calls >= self.fail_print_from_call
                )
            ):
                returncode = 5
            else:
                returncode = 0 if self.loaded else installer.LAUNCHCTL_NOT_FOUND
        elif action == 'bootout':
            if self.loaded:
                self.loaded = False
                returncode = 0
            else:
                returncode = installer.LAUNCHCTL_NO_SUCH_PROCESS
        elif action == 'bootstrap':
            self.bootstrap_calls += 1
            if self.bootstrap_calls == self.fail_bootstrap_call:
                raise subprocess.CalledProcessError(1, arguments)
            self.loaded = True
            returncode = 0
        else:
            raise AssertionError(f'Unexpected launchctl action: {action}')
        if check and returncode:
            raise subprocess.CalledProcessError(returncode, arguments)
        return subprocess.CompletedProcess(arguments, returncode)


class InstallStagingRetentionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.renameatx_patch = None
        if sys.platform != 'darwin':
            self.renameatx_patch = mock.patch.object(
                installer,
                'renameatx_np',
                side_effect=emulate_renameatx_np,
            )
            self.renameatx_patch.start()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / 'repository-staging-retention.py'
        self.source.write_bytes(b'#!/usr/bin/env python3\nprint("new")\n')
        self.support = self.root / 'Library/Application Support/Robb Agents/Maintenance'
        self.agents = self.root / 'Library/LaunchAgents'
        self.support.mkdir(parents=True)
        self.agents.mkdir(parents=True)
        self.script = self.support / 'staging-retention.py'
        self.plist = self.agents / f'{installer.LABEL}.plist'
        self.old_script = b'#!/usr/bin/env python3\nprint("old")\n'
        self.old_configuration = {
            'Label': installer.LABEL,
            'ProgramArguments': ['/old/python', str(self.script), '--apply'],
            'RunAtLoad': True,
        }
        self.old_plist = plistlib.dumps(self.old_configuration)
        self.script.write_bytes(self.old_script)
        self.script.chmod(0o700)
        self.plist.write_bytes(self.old_plist)

    def tearDown(self) -> None:
        self.temporary.cleanup()
        if self.renameatx_patch is not None:
            self.renameatx_patch.stop()

    def run_install(
        self,
        runner: LaunchctlRunner,
        *,
        checkpoint=None,
    ) -> dict[str, str]:
        return installer.install(
            source_script=self.source,
            support=self.support,
            agents=self.agents,
            python_executable='/new/python',
            runner=runner,
            checkpoint=checkpoint,
        )

    def assert_no_transaction_artifacts(self) -> None:
        self.assertFalse((self.support / installer.JOURNAL_NAME).exists())
        self.assertFalse(installer.quarantine_path(
            self.support / installer.JOURNAL_NAME
        ).exists())
        self.assertEqual(
            list(self.support.glob(f'{installer.JOURNAL_NAME}.next-*')),
            [],
        )
        self.assertEqual(list(self.support.glob('.staging-retention.install-*')), [])
        self.assertEqual(list(self.agents.glob(f'.{installer.LABEL}.install-*')), [])

    def recover_under_lock(
        self,
        runner: LaunchctlRunner,
        *,
        checkpoint=None,
    ) -> str | None:
        lock_path = self.support / installer.INSTALL_LOCK_NAME
        with installer.open_install_lock(lock_path) as lock:
            installer.fcntl.flock(
                lock,
                installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB,
            )
            return installer.recover_pending_installation(
                support=self.support,
                agents=self.agents,
                runner=runner,
                checkpoint=checkpoint,
            )

    def assert_previous_state_restored(
        self,
        runner: LaunchctlRunner,
        *,
        minimum_bootstraps: int = 1,
    ) -> None:
        self.assertEqual(self.script.read_bytes(), self.old_script)
        self.assertEqual(self.plist.read_bytes(), self.old_plist)
        self.assertTrue(runner.loaded)
        self.assertGreaterEqual(runner.bootstrap_calls, minimum_bootstraps)
        self.assert_no_transaction_artifacts()

    def test_publishes_verified_helper_and_plist_before_loading(self) -> None:
        runner = LaunchctlRunner(loaded=True)

        result = self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.source.read_bytes())
        configuration = plistlib.loads(self.plist.read_bytes())
        self.assertEqual(
            configuration['ProgramArguments'],
            ['/new/python', str(self.script), '--apply'],
        )
        self.assertEqual(result['sha256'], installer.sha256_file(self.source))
        self.assertTrue(runner.loaded)
        self.assertEqual(runner.bootstrap_calls, 1)
        self.assert_no_transaction_artifacts()

    def test_production_rename_fails_closed_outside_macos(self) -> None:
        with mock.patch.object(installer.sys, 'platform', 'linux'):
            with self.assertRaisesRegex(RuntimeError, 'requires macOS'):
                production_renameatx_np(-1, 'source', 'destination', installer.RENAME_EXCL)

    def test_write_failure_happens_before_bootout_and_leaves_old_state_untouched(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        original_write = installer.write_owned_file

        def fail_plist_stage(path: Path, data: bytes, mode: int):
            if Path(path).parent == self.agents and Path(path).name.endswith('.new-data'):
                raise OSError('simulated plist write failure')
            return original_write(path, data, mode)

        with mock.patch.object(installer, 'write_owned_file', side_effect=fail_plist_stage):
            with self.assertRaisesRegex(OSError, 'simulated plist write failure'):
                self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.old_script)
        self.assertEqual(self.plist.read_bytes(), self.old_plist)
        self.assertTrue(runner.loaded)
        self.assertFalse(any(call[1] == 'bootout' for call in runner.calls))
        self.assert_no_transaction_artifacts()

    def test_atomic_plist_publication_failure_restores_files_and_service(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        original_swap = installer.swap_verified
        failed = False

        def fail_new_plist_swap(
            source: Path,
            destination: Path,
            source_snapshot,
            destination_snapshot,
            *,
            operation: str,
        ) -> None:
            nonlocal failed
            source_path = Path(source)
            if (
                not failed
                and Path(destination) == self.plist
                and source_path.name.startswith(f'.{installer.LABEL}.install-')
                and source_path.name.endswith('.new-data')
            ):
                failed = True
                raise OSError('simulated atomic plist publication failure')
            original_swap(
                source,
                destination,
                source_snapshot,
                destination_snapshot,
                operation=operation,
            )

        with mock.patch.object(installer, 'swap_verified', side_effect=fail_new_plist_swap):
            with self.assertRaisesRegex(OSError, 'simulated atomic plist publication failure'):
                self.run_install(runner)

        self.assertTrue(failed)
        self.assert_previous_state_restored(runner)

    def test_quarantine_rejects_substitution_after_revalidation_without_deleting_it(self) -> None:
        path = self.support / 'known-cleanup-artifact'
        held = self.support / 'held-known-cleanup-artifact'
        path.write_bytes(b'known transaction bytes')
        path.chmod(0o600)
        snapshot = installer.snapshot_regular_file(path, require_owner=True)
        assert snapshot is not None

        def substitute_after_revalidation(
            operation: str,
            source: Path,
            destination: Path,
        ) -> None:
            if operation != 'test-delete-race':
                return
            source.rename(held)
            source.write_bytes(b'external bytes')
            source.chmod(0o600)

        with mock.patch.object(
            installer,
            'before_atomic_rename',
            side_effect=substitute_after_revalidation,
        ):
            with self.assertRaisesRegex(RuntimeError, 'changed before quarantine'):
                installer.quarantine_and_unlink(
                    path,
                    snapshot,
                    operation='test-delete-race',
                )

        self.assertEqual(held.read_bytes(), b'known transaction bytes')
        self.assertEqual(path.read_bytes(), b'external bytes')
        self.assertFalse(installer.quarantine_path(path).exists())

    def test_swap_rejects_substitution_after_revalidation_without_losing_entries(self) -> None:
        source = self.support / 'known-swap-source'
        destination = self.support / 'known-swap-destination'
        held = self.support / 'held-swap-destination'
        source.write_bytes(b'source bytes')
        destination.write_bytes(b'destination bytes')
        source_snapshot = installer.snapshot_regular_file(source, require_owner=True)
        destination_snapshot = installer.snapshot_regular_file(
            destination, require_owner=True,
        )
        assert source_snapshot is not None
        assert destination_snapshot is not None

        def substitute_after_revalidation(
            operation: str,
            _source: Path,
            swap_destination: Path,
        ) -> None:
            if operation != 'test-swap-race':
                return
            swap_destination.rename(held)
            swap_destination.write_bytes(b'external bytes')

        with mock.patch.object(
            installer,
            'before_atomic_rename',
            side_effect=substitute_after_revalidation,
        ):
            with self.assertRaisesRegex(RuntimeError, 'swap verification failed'):
                installer.swap_verified(
                    source,
                    destination,
                    source_snapshot,
                    destination_snapshot,
                    operation='test-swap-race',
                )

        self.assertEqual(destination.read_bytes(), b'source bytes')
        self.assertEqual(source.read_bytes(), b'external bytes')
        self.assertEqual(held.read_bytes(), b'destination bytes')

    def test_process_death_after_quarantine_move_resumes_verified_deletion(self) -> None:
        path = self.support / 'known-crash-cleanup-artifact'
        path.write_bytes(b'known transaction bytes')
        path.chmod(0o600)
        snapshot = installer.snapshot_regular_file(path, require_owner=True)
        assert snapshot is not None

        def die_after_move(operation: str, _source: Path, _destination: Path) -> None:
            if operation == 'test-quarantine-crash':
                raise SimulatedProcessDeath(operation)

        with mock.patch.object(
            installer,
            'after_atomic_rename',
            side_effect=die_after_move,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                installer.quarantine_and_unlink(
                    path,
                    snapshot,
                    operation='test-quarantine-crash',
                )

        self.assertFalse(path.exists())
        self.assertTrue(installer.quarantine_path(path).exists())
        installer.quarantine_and_unlink(
            path,
            snapshot,
            operation='test-quarantine-crash-recovery',
        )
        self.assertFalse(installer.quarantine_path(path).exists())

    def test_first_install_recovery_removes_last_target_quarantine_after_process_death(self) -> None:
        self.script.unlink()
        self.plist.unlink()
        runner = LaunchctlRunner(loaded=False, fail_bootstrap_call=1)
        rollback_moves = 0

        def die_after_second_rollback_quarantine(
            operation: str,
            _source: Path,
            _destination: Path,
        ) -> None:
            nonlocal rollback_moves
            if operation != 'rollback-remove-replacement':
                return
            rollback_moves += 1
            if rollback_moves == 2:
                raise SimulatedProcessDeath(operation)

        with mock.patch.object(
            installer,
            'after_atomic_rename',
            side_effect=die_after_second_rollback_quarantine,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                self.run_install(runner)

        journal = installer.load_pending_journal(
            support=self.support,
            agents=self.agents,
        )
        assert journal is not None
        plist_quarantine = Path(f'{journal["plist"]["staged"]}.rollback-quarantine')
        self.assertEqual(rollback_moves, 2)
        self.assertFalse(self.script.exists())
        self.assertFalse(self.plist.exists())
        self.assertTrue(plist_quarantine.exists())

        self.assertEqual(self.recover_under_lock(runner), 'rolled_back')
        self.assertFalse(plist_quarantine.exists())
        self.assertFalse(runner.loaded)
        self.assert_no_transaction_artifacts()

    def test_bootstrap_failure_restores_files_and_rebootstraps_previous_service(self) -> None:
        runner = LaunchctlRunner(loaded=True, fail_bootstrap_call=1)

        with self.assertRaises(subprocess.CalledProcessError):
            self.run_install(runner)

        self.assert_previous_state_restored(runner, minimum_bootstraps=2)

    def test_failed_first_install_removes_new_files_and_remains_unloaded(self) -> None:
        self.script.unlink()
        self.plist.unlink()
        runner = LaunchctlRunner(loaded=False, fail_bootstrap_call=1)

        with self.assertRaises(subprocess.CalledProcessError):
            self.run_install(runner)

        self.assertFalse(self.script.exists())
        self.assertFalse(self.plist.exists())
        self.assertFalse(runner.loaded)
        self.assertEqual(runner.bootstrap_calls, 1)
        self.assert_no_transaction_artifacts()

    def test_print_failure_unloads_new_service_then_restores_previous_service(self) -> None:
        runner = LaunchctlRunner(loaded=True, fail_print_call=2)

        with self.assertRaises(subprocess.CalledProcessError):
            self.run_install(runner)

        self.assert_previous_state_restored(runner, minimum_bootstraps=2)
        self.assertGreaterEqual(
            sum(call[1] == 'bootout' for call in runner.calls),
            2,
        )

    def test_persistent_print_failure_is_fail_closed_after_unloading_new_service(self) -> None:
        self.script.unlink()
        self.plist.unlink()
        runner = LaunchctlRunner(loaded=False, fail_print_from_call=2)

        with self.assertRaisesRegex(RuntimeError, 'rollback incomplete'):
            self.run_install(runner)

        self.assertFalse(runner.loaded)
        self.assertFalse(self.script.exists())
        self.assertFalse(self.plist.exists())
        self.assertEqual(
            sum(call[1] == 'bootout' for call in runner.calls),
            1,
        )

    def test_refuses_to_unload_a_service_without_a_restorable_plist(self) -> None:
        self.plist.unlink()
        runner = LaunchctlRunner(loaded=True)

        with self.assertRaisesRegex(RuntimeError, 'no complete restorable files'):
            self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.old_script)
        self.assertTrue(runner.loaded)
        self.assertFalse(any(call[1] == 'bootout' for call in runner.calls))

    def test_concurrent_install_is_rejected_before_snapshot_or_service_mutation(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        lock_path = self.support / installer.INSTALL_LOCK_NAME

        with installer.open_install_lock(lock_path) as lock:
            installer.fcntl.flock(lock, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'already running'):
                self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.old_script)
        self.assertEqual(self.plist.read_bytes(), self.old_plist)
        self.assertTrue(runner.loaded)
        self.assertEqual(runner.calls, [])

    def test_process_death_at_each_precommit_boundary_recovers_previous_inode(self) -> None:
        phases = (
            'journal_initialized',
            'script_backup_created',
            'plist_backup_created',
            'script_staged',
            'plist_staged',
            'artifacts_prepared',
            'service_booted_out',
            'service_stopped',
            'script_replaced',
            'script_published',
            'plist_replaced',
            'plist_published',
            'bootstrap_returned',
            'bootstrap_succeeded',
            'service_printed',
            'service_verified',
        )
        for phase in phases:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                source = base / 'source.py'
                support = base / 'Library/Application Support/Robb Agents/Maintenance'
                agents = base / 'Library/LaunchAgents'
                support.mkdir(parents=True)
                agents.mkdir(parents=True)
                script = support / 'staging-retention.py'
                plist = agents / f'{installer.LABEL}.plist'
                source.write_bytes(self.source.read_bytes())
                script.write_bytes(self.old_script)
                script.chmod(0o751)
                plist.write_bytes(plistlib.dumps({
                    'Label': installer.LABEL,
                    'ProgramArguments': ['/old/python', str(script), '--apply'],
                }))
                plist.chmod(0o640)
                script_inode = script.stat().st_ino
                plist_inode = plist.stat().st_ino
                runner = LaunchctlRunner(loaded=True)
                seen: list[str] = []

                def die_at_boundary(name: str) -> None:
                    seen.append(name)
                    if name == phase:
                        raise SimulatedProcessDeath(name)

                with self.assertRaises(SimulatedProcessDeath):
                    installer.install(
                        source_script=source,
                        support=support,
                        agents=agents,
                        python_executable='/new/python',
                        runner=runner,
                        checkpoint=die_at_boundary,
                    )
                self.assertIn(phase, seen)

                with installer.open_install_lock(
                    support / installer.INSTALL_LOCK_NAME
                ) as lock:
                    installer.fcntl.flock(
                        lock,
                        installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB,
                    )
                    outcome = installer.recover_pending_installation(
                        support=support,
                        agents=agents,
                        runner=runner,
                    )

                self.assertEqual(outcome, 'rolled_back')
                self.assertEqual(script.read_bytes(), self.old_script)
                self.assertEqual(script.stat().st_ino, script_inode)
                self.assertEqual(stat_mode(script), 0o751)
                self.assertEqual(plist.stat().st_ino, plist_inode)
                self.assertEqual(stat_mode(plist), 0o640)
                self.assertTrue(runner.loaded)
                self.assertFalse((support / installer.JOURNAL_NAME).exists())
                self.assertEqual(list(support.glob('.staging-retention.install-*')), [])
                self.assertEqual(list(agents.glob(f'.{installer.LABEL}.install-*')), [])

    def test_process_death_immediately_after_publication_swap_recovers_previous_inode(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        script_inode = self.script.stat().st_ino
        plist_inode = self.plist.stat().st_ino

        def die_after_publish_swap(
            operation: str,
            _source: Path,
            destination: Path,
        ) -> None:
            if operation == 'publish-artifact-swap' and destination == self.script:
                raise SimulatedProcessDeath(operation)

        with mock.patch.object(
            installer,
            'after_atomic_rename',
            side_effect=die_after_publish_swap,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.source.read_bytes())
        self.assertEqual(self.recover_under_lock(runner), 'rolled_back')
        self.assertEqual(self.script.stat().st_ino, script_inode)
        self.assertEqual(self.plist.stat().st_ino, plist_inode)
        self.assert_previous_state_restored(runner)

    def test_second_recovery_resumes_process_death_immediately_after_rollback_swap(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        script_inode = self.script.stat().st_ino
        plist_inode = self.plist.stat().st_ino

        def die_after_script_publication(name: str) -> None:
            if name == 'script_replaced':
                raise SimulatedProcessDeath(name)

        with self.assertRaises(SimulatedProcessDeath):
            self.run_install(runner, checkpoint=die_after_script_publication)

        def die_after_rollback_swap(
            operation: str,
            _source: Path,
            destination: Path,
        ) -> None:
            if operation == 'rollback-swap' and destination == self.script:
                raise SimulatedProcessDeath(operation)

        with mock.patch.object(
            installer,
            'after_atomic_rename',
            side_effect=die_after_rollback_swap,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                self.recover_under_lock(runner)

        self.assertEqual(self.script.read_bytes(), self.old_script)
        self.assertEqual(self.recover_under_lock(runner), 'rolled_back')
        self.assertEqual(self.script.stat().st_ino, script_inode)
        self.assertEqual(self.plist.stat().st_ino, plist_inode)
        self.assert_previous_state_restored(runner)

    def test_recovery_accepts_journal_swap_completed_before_process_death(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        journal_swaps = 0

        def die_after_second_journal_publish(
            operation: str,
            _source: Path,
            _destination: Path,
        ) -> None:
            nonlocal journal_swaps
            if operation != 'publish-journal':
                return
            journal_swaps += 1
            if journal_swaps == 2:
                raise SimulatedProcessDeath(operation)

        with mock.patch.object(
            installer,
            'after_atomic_rename',
            side_effect=die_after_second_journal_publish,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                self.run_install(runner)

        self.assertEqual(journal_swaps, 2)
        self.assertEqual(self.recover_under_lock(runner), 'rolled_back')
        self.assert_previous_state_restored(runner, minimum_bootstraps=0)

    def test_process_death_mid_update_journal_write_removes_proven_partial(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        original_write = installer.write_owned_file
        journal_writes = 0
        partial_path: Path | None = None

        def die_mid_second_journal_write(path: Path, data: bytes, mode: int):
            nonlocal journal_writes, partial_path
            path = Path(path)
            if installer.JOURNAL_NAME in path.name and '.next-' in path.name:
                journal_writes += 1
                if journal_writes == 2:
                    partial_path = path
                    descriptor = os.open(
                        path,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        mode,
                    )
                    try:
                        os.fchmod(descriptor, mode)
                        os.write(descriptor, data[:8])
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                    raise SimulatedProcessDeath('mid update journal write')
            return original_write(path, data, mode)

        with mock.patch.object(
            installer,
            'write_owned_file',
            side_effect=die_mid_second_journal_write,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                self.run_install(runner)

        self.assertEqual(journal_writes, 2)
        self.assertIsNotNone(partial_path)
        assert partial_path is not None
        self.assertTrue(partial_path.exists())
        self.assertEqual(self.recover_under_lock(runner), 'rolled_back')
        self.assertFalse(partial_path.exists())
        self.assert_previous_state_restored(runner, minimum_bootstraps=0)

    def test_process_death_during_committed_cleanup_is_idempotent(self) -> None:
        phases = (
            'committed',
            'cleanup_script_artifacts',
            'cleanup_plist_artifacts',
            'cleanup_next_journal',
            'before_journal_remove',
            'journal_removed',
        )
        for phase in phases:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                source = base / 'source.py'
                support = base / 'Library/Application Support/Robb Agents/Maintenance'
                agents = base / 'Library/LaunchAgents'
                support.mkdir(parents=True)
                agents.mkdir(parents=True)
                script = support / 'staging-retention.py'
                plist = agents / f'{installer.LABEL}.plist'
                source.write_bytes(self.source.read_bytes())
                script.write_bytes(self.old_script)
                script.chmod(0o700)
                plist.write_bytes(self.old_plist)
                runner = LaunchctlRunner(loaded=True)

                def die_at_boundary(name: str) -> None:
                    if name == phase:
                        raise SimulatedProcessDeath(name)

                with self.assertRaises(SimulatedProcessDeath):
                    installer.install(
                        source_script=source,
                        support=support,
                        agents=agents,
                        python_executable='/new/python',
                        runner=runner,
                        checkpoint=die_at_boundary,
                    )
                with installer.open_install_lock(
                    support / installer.INSTALL_LOCK_NAME
                ) as lock:
                    installer.fcntl.flock(
                        lock,
                        installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB,
                    )
                    outcome = installer.recover_pending_installation(
                        support=support,
                        agents=agents,
                        runner=runner,
                    )
                if phase == 'journal_removed':
                    self.assertIsNone(outcome)
                else:
                    self.assertEqual(outcome, 'committed')
                self.assertEqual(script.read_bytes(), source.read_bytes())
                self.assertEqual(
                    plistlib.loads(plist.read_bytes())['ProgramArguments'][0],
                    '/new/python',
                )
                self.assertTrue(runner.loaded)
                self.assertFalse((support / installer.JOURNAL_NAME).exists())

    def test_recovery_refuses_to_delete_an_unproven_replacement(self) -> None:
        runner = LaunchctlRunner(loaded=True)

        def die_after_script_replace(name: str) -> None:
            if name == 'script_replaced':
                raise SimulatedProcessDeath(name)

        with self.assertRaises(SimulatedProcessDeath):
            self.run_install(runner, checkpoint=die_after_script_replace)
        self.script.write_bytes(b'externally-replaced-state\n')

        with self.assertRaisesRegex(RuntimeError, 'unowned transaction target'):
            self.recover_under_lock(runner)

        self.assertEqual(self.script.read_bytes(), b'externally-replaced-state\n')
        self.assertTrue((self.support / installer.JOURNAL_NAME).exists())

    def test_process_death_mid_staged_write_removes_only_journal_owned_partial(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        original_write = installer.write_owned_file

        def die_mid_script_write(path: Path, data: bytes, mode: int):
            path = Path(path)
            if path.parent == self.support and path.name.endswith('.new'):
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
                try:
                    os.fchmod(descriptor, mode)
                    os.write(descriptor, data[: max(1, len(data) // 2)])
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                raise SimulatedProcessDeath('mid staged write')
            return original_write(path, data, mode)

        with mock.patch.object(
            installer,
            'write_owned_file',
            side_effect=die_mid_script_write,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                self.run_install(runner)

        self.assertEqual(self.recover_under_lock(runner), 'rolled_back')
        self.assert_previous_state_restored(runner, minimum_bootstraps=0)

    def test_unproven_partial_initial_journal_is_preserved_but_does_not_block(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        original_write = installer.write_owned_file
        partial_path: Path | None = None

        def die_mid_initial_journal(path: Path, data: bytes, mode: int):
            nonlocal partial_path
            path = Path(path)
            if installer.JOURNAL_NAME in path.name and '.next-' in path.name:
                partial_path = path
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
                try:
                    os.fchmod(descriptor, mode)
                    os.write(descriptor, data[:8])
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                raise SimulatedProcessDeath('mid initial journal write')
            return original_write(path, data, mode)

        with mock.patch.object(
            installer,
            'write_owned_file',
            side_effect=die_mid_initial_journal,
        ):
            with self.assertRaises(SimulatedProcessDeath):
                self.run_install(runner)

        self.assertIsNotNone(partial_path)
        assert partial_path is not None
        original_partial = partial_path.read_bytes()
        result = self.run_install(runner)

        self.assertEqual(result['sha256'], installer.sha256_file(self.source))
        self.assertEqual(partial_path.read_bytes(), original_partial)
        self.assertTrue(runner.loaded)

    def test_rollback_preserves_inode_mode_and_extended_attributes(self) -> None:
        if sys.platform != 'darwin':
            self.skipTest('macOS metadata contract')
        self.script.chmod(0o751)
        self.plist.chmod(0o640)
        attribute = 'com.robinswood.staging-retention-test'
        try:
            subprocess.run(
                ['/usr/bin/xattr', '-w', attribute, 'helper-value', str(self.script)],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ['/usr/bin/xattr', '-w', attribute, 'plist-value', str(self.plist)],
                check=True,
                capture_output=True,
            )
        except subprocess.CalledProcessError as error:
            self.skipTest(f'xattrs unavailable: {error}')
        script_inode = self.script.stat().st_ino
        plist_inode = self.plist.stat().st_ino
        runner = LaunchctlRunner(loaded=True, fail_bootstrap_call=1)

        with self.assertRaises(subprocess.CalledProcessError):
            self.run_install(runner)

        self.assertEqual(self.script.stat().st_ino, script_inode)
        self.assertEqual(self.plist.stat().st_ino, plist_inode)
        self.assertEqual(stat_mode(self.script), 0o751)
        self.assertEqual(stat_mode(self.plist), 0o640)
        self.assertEqual(
            subprocess.run(
                ['/usr/bin/xattr', '-p', attribute, str(self.script)],
                check=True,
                capture_output=True,
            ).stdout.rstrip(b'\n'),
            b'helper-value',
        )
        self.assertEqual(
            subprocess.run(
                ['/usr/bin/xattr', '-p', attribute, str(self.plist)],
                check=True,
                capture_output=True,
            ).stdout.rstrip(b'\n'),
            b'plist-value',
        )


if __name__ == '__main__':
    unittest.main()
