from __future__ import annotations

import plistlib
import subprocess
import tempfile
from pathlib import Path
from typing import cast
from unittest import mock

from scripts.robb_retention_files import FileSnapshot, is_record

from .install_staging_retention_fixtures import (
    InstallStagingRetentionTestCase,
    LaunchctlRunner,
    SimulatedProcessDeath,
    atomic,
    installer,
    journal,
    production_renameatx_np,
    recovery,
    stat_mode,
)


class InstallStagingRetentionTests(InstallStagingRetentionTestCase):
    def test_publishes_verified_helper_and_plist_before_loading(self) -> None:
        runner = LaunchctlRunner(loaded=True)

        result = self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.source.read_bytes())
        configuration = cast(object, plistlib.loads(self.plist.read_bytes()))
        assert is_record(configuration)
        self.assertEqual(
            configuration['ProgramArguments'],
            ['/new/python', str(self.script), '--apply'],
        )
        self.assertEqual(result['sha256'], installer.sha256_file(self.source))
        self.assertTrue(runner.loaded)
        self.assertEqual(runner.bootstrap_calls, 1)
        self.assert_no_transaction_artifacts()

    def test_production_rename_fails_closed_outside_macos(self) -> None:
        with (
            mock.patch.object(installer.sys, 'platform', 'linux'),
            self.assertRaisesRegex(RuntimeError, 'requires macOS'),
        ):
            production_renameatx_np(-1, 'source', 'destination', installer.RENAME_EXCL)

    def test_write_failure_happens_before_bootout_and_leaves_old_state_untouched(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        original_write = installer.write_owned_file

        def fail_plist_stage(path: Path, data: bytes, mode: int):
            if Path(path).parent == self.agents and Path(path).name.endswith('.new-data'):
                raise OSError('simulated plist write failure')
            return original_write(path, data, mode)

        with (
            mock.patch.object(installer, 'write_owned_file', side_effect=fail_plist_stage),
            mock.patch.object(journal, 'write_owned_file', side_effect=fail_plist_stage),
            self.assertRaisesRegex(OSError, 'simulated plist write failure'),
        ):
            _ = self.run_install(runner)

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
            source_snapshot: FileSnapshot,
            destination_snapshot: FileSnapshot,
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

        with (
            mock.patch.object(atomic, 'swap_verified', side_effect=fail_new_plist_swap),
            mock.patch.object(recovery, 'swap_verified', side_effect=fail_new_plist_swap),
            self.assertRaisesRegex(OSError, 'simulated atomic plist publication failure'),
        ):
            _ = self.run_install(runner)

        self.assertTrue(failed)
        self.assert_previous_state_restored(runner)

    def test_quarantine_rejects_substitution_after_revalidation_without_deleting_it(self) -> None:
        path = self.support / 'known-cleanup-artifact'
        held = self.support / 'held-known-cleanup-artifact'
        _ = path.write_bytes(b'known transaction bytes')
        path.chmod(0o600)
        snapshot = installer.snapshot_regular_file(path, require_owner=True)
        assert snapshot is not None

        def substitute_after_revalidation(
            operation: str,
            source: Path,
            _destination: Path,
        ) -> None:
            if operation != 'test-delete-race':
                return
            _ = source.rename(held)
            _ = source.write_bytes(b'external bytes')
            source.chmod(0o600)

        with mock.patch.object(
            atomic,
            'before_atomic_rename',
            side_effect=substitute_after_revalidation,
        ), self.assertRaisesRegex(RuntimeError, 'changed before quarantine'):
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
        _ = source.write_bytes(b'source bytes')
        _ = destination.write_bytes(b'destination bytes')
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
            _ = swap_destination.rename(held)
            _ = swap_destination.write_bytes(b'external bytes')

        with mock.patch.object(
            atomic,
            'before_atomic_rename',
            side_effect=substitute_after_revalidation,
        ), self.assertRaisesRegex(RuntimeError, 'swap verification failed'):
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
        _ = path.write_bytes(b'known transaction bytes')
        path.chmod(0o600)
        snapshot = installer.snapshot_regular_file(path, require_owner=True)
        assert snapshot is not None

        def die_after_move(operation: str, _source: Path, _destination: Path) -> None:
            if operation == 'test-quarantine-crash':
                raise SimulatedProcessDeath(operation)

        with mock.patch.object(
            atomic,
            'after_atomic_rename',
            side_effect=die_after_move,
        ), self.assertRaises(SimulatedProcessDeath):
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
            atomic,
            'after_atomic_rename',
            side_effect=die_after_second_rollback_quarantine,
        ), self.assertRaises(SimulatedProcessDeath):
            _ = self.run_install(runner)

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
            _ = self.run_install(runner)

        self.assert_previous_state_restored(runner, minimum_bootstraps=2)

    def test_failed_first_install_removes_new_files_and_remains_unloaded(self) -> None:
        self.script.unlink()
        self.plist.unlink()
        runner = LaunchctlRunner(loaded=False, fail_bootstrap_call=1)

        with self.assertRaises(subprocess.CalledProcessError):
            _ = self.run_install(runner)

        self.assertFalse(self.script.exists())
        self.assertFalse(self.plist.exists())
        self.assertFalse(runner.loaded)
        self.assertEqual(runner.bootstrap_calls, 1)
        self.assert_no_transaction_artifacts()

    def test_print_failure_unloads_new_service_then_restores_previous_service(self) -> None:
        runner = LaunchctlRunner(loaded=True, fail_print_call=2)

        with self.assertRaises(subprocess.CalledProcessError):
            _ = self.run_install(runner)

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
            _ = self.run_install(runner)

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
            _ = self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.old_script)
        self.assertTrue(runner.loaded)
        self.assertFalse(any(call[1] == 'bootout' for call in runner.calls))

    def test_concurrent_install_is_rejected_before_snapshot_or_service_mutation(self) -> None:
        runner = LaunchctlRunner(loaded=True)
        lock_path = self.support / installer.INSTALL_LOCK_NAME

        with installer.open_install_lock(lock_path) as lock:
            installer.fcntl.flock(lock, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'already running'):
                _ = self.run_install(runner)

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
                _ = source.write_bytes(self.source.read_bytes())
                _ = script.write_bytes(self.old_script)
                script.chmod(0o751)
                _ = plist.write_bytes(plistlib.dumps({
                    'Label': installer.LABEL,
                    'ProgramArguments': ['/old/python', str(script), '--apply'],
                }))
                plist.chmod(0o640)
                script_inode = script.stat().st_ino
                plist_inode = plist.stat().st_ino
                runner = LaunchctlRunner(loaded=True)
                seen: list[str] = []

                def die_at_boundary(name: str, expected_phase: str = phase, recorded: list[str] = seen) -> None:
                    recorded.append(name)
                    if name == expected_phase:
                        raise SimulatedProcessDeath(name)

                with self.assertRaises(SimulatedProcessDeath):
                    _ = installer.install(
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
            atomic,
            'after_atomic_rename',
            side_effect=die_after_publish_swap,
        ), self.assertRaises(SimulatedProcessDeath):
            _ = self.run_install(runner)

        self.assertEqual(self.script.read_bytes(), self.source.read_bytes())
        self.assertEqual(self.recover_under_lock(runner), 'rolled_back')
        self.assertEqual(self.script.stat().st_ino, script_inode)
        self.assertEqual(self.plist.stat().st_ino, plist_inode)
        self.assert_previous_state_restored(runner)
