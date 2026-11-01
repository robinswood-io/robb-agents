from __future__ import annotations

import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import cast, override
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
try:
    import install_staging_retention as installer
    import robb_retention_atomic as atomic
    import robb_retention_journal as journal
    import robb_retention_recovery as recovery
finally:
    _ = sys.path.pop(0)
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
            _ = os.stat(
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
        self.loaded: bool = loaded
        self.fail_bootstrap_call: int | None = fail_bootstrap_call
        self.fail_print_call: int | None = fail_print_call
        self.fail_print_from_call: int | None = fail_print_from_call
        self.bootstrap_calls: int = 0
        self.print_calls: int = 0
        self.calls: list[list[str]] = []

    def __call__(
        self,
        arguments: list[str],
        *,
        check: bool,
        capture_output: bool = False,
    ) -> subprocess.CompletedProcess[str]:
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
        return subprocess.CompletedProcess[str](arguments, returncode)


class InstallStagingRetentionTestCase(unittest.TestCase):
    temporary: tempfile.TemporaryDirectory[str] | None = None

    @property
    def root(self) -> Path:
        if self.temporary is None:
            raise RuntimeError("Retention fixture is not set up")
        return Path(self.temporary.name)

    @property
    def source(self) -> Path:
        return self.root / 'repository-staging-retention.py'

    @property
    def support(self) -> Path:
        return self.root / 'Library/Application Support/Robb Agents/Maintenance'

    @property
    def agents(self) -> Path:
        return self.root / 'Library/LaunchAgents'

    @property
    def script(self) -> Path:
        return self.support / 'staging-retention.py'

    @property
    def plist(self) -> Path:
        return self.agents / f'{installer.LABEL}.plist'

    @property
    def old_script(self) -> bytes:
        return b'#!/usr/bin/env python3\nprint("old")\n'

    @property
    def old_configuration(self) -> dict[str, object]:
        return {'Label': installer.LABEL,
                'ProgramArguments': ['/old/python', str(self.script), '--apply'],
                'RunAtLoad': True}

    @property
    def old_plist(self) -> bytes:
        return plistlib.dumps(self.old_configuration)


    @override
    def setUp(self) -> None:
        if sys.platform != 'darwin':
            renameatx_patch = mock.patch.object(
                atomic,
                'renameatx_np',
                side_effect=emulate_renameatx_np,
            )
            _ = cast(object, renameatx_patch.start())
            self.addCleanup(renameatx_patch.stop)
        self.temporary = tempfile.TemporaryDirectory()
        _ = self.source.write_bytes(b'#!/usr/bin/env python3\nprint("new")\n')
        self.support.mkdir(parents=True)
        self.agents.mkdir(parents=True)
        _ = self.script.write_bytes(self.old_script)
        self.script.chmod(0o700)
        _ = self.plist.write_bytes(self.old_plist)

    @override
    def tearDown(self) -> None:
        if self.temporary is not None:
            self.temporary.cleanup()
            self.temporary = None

    def run_install(
        self,
        runner: LaunchctlRunner,
        *,
        checkpoint: Callable[[str], None] | None = None,
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
        checkpoint: Callable[[str], None] | None = None,
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

__all__ = [
    'InstallStagingRetentionTestCase',
    'LaunchctlRunner',
    'SimulatedProcessDeath',
    'atomic',
    'installer',
    'journal',
    'production_renameatx_np',
    'recovery',
    'stat_mode',
]
