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

from .install_staging_retention_fixtures import (
    installer,
    production_renameatx_np,
    SimulatedProcessDeath,
    emulate_renameatx_np,
    stat_mode,
    LaunchctlRunner,
    InstallStagingRetentionTestCase,
)


class InstallStagingRetentionRecoveryTests(InstallStagingRetentionTestCase):
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
