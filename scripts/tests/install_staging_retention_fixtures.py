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


class InstallStagingRetentionTestCase(unittest.TestCase):
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
