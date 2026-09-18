import importlib.util
import io
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('staging_retention', Path(__file__).parents[1] / 'staging-retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)

installer_spec = importlib.util.spec_from_file_location(
    'install_staging_retention',
    Path(__file__).parents[1] / 'install-staging-retention.py',
)
installer = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(installer)


class StagingRetentionTests(unittest.TestCase):
    @staticmethod
    def create_bundle(parent, bundle_identifier=retention.PRODUCTION_BUNDLE_IDENTIFIER, name='Robb Agents.app'):
        bundle = parent / name
        contents = bundle / 'Contents'
        contents.mkdir(parents=True)
        (contents / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': bundle_identifier,
        }))
        return bundle

    def test_keeps_two_newest_and_preserves_partial_and_unrelated_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ['20260901-a', '20260902-b', '20260903-c', '20260904-d']:
                (root / name).mkdir()
                (root / name / 'bundle').write_text('fixture')
                time.sleep(0.01)
            (root / '.partial-current').mkdir()
            (root / 'notes').mkdir()
            preview = retention.prune(root)
            self.assertEqual(len(preview['removed']), 2)
            self.assertTrue((root / '20260901-a').exists())
            result = retention.prune(root, True)
            self.assertEqual(result['kept'], ['20260904-d', '20260903-c'])
            self.assertFalse((root / '20260901-a').exists())
            self.assertTrue((root / '.partial-current').exists())
            self.assertTrue((root / 'notes').exists())
            self.assertEqual(retention.prune(root, True)['removed'], [])

    def test_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outside = root / 'outside'
            outside.mkdir()
            (root / '20260901-link').symlink_to(outside, target_is_directory=True)
            self.assertEqual(retention.prune(root, True)['removed'], [])
            with self.assertRaises(ValueError):
                retention.prune(root / '20260901-link', True)

    @unittest.skipUnless(os.name == 'posix' and retention.fcntl is not None, 'POSIX backup only')
    def test_backup_verifies_source_and_copy_with_absolute_system_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            source = self.create_bundle(temp_path / 'installed')
            root = temp_path / 'backups'
            root.mkdir()
            commands = []

            def run(command, check):
                commands.append(command)
                self.assertTrue(check)
                if command[0] == str(retention.DITTO):
                    shutil.copytree(command[1], command[2])
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.object(retention, 'SOURCE_BUNDLE', source), \
                    mock.patch.object(retention.subprocess, 'run', side_effect=run):
                checkpoint = retention.backup(root)

            self.assertEqual([command[0] for command in commands], [
                '/usr/bin/codesign',
                '/usr/bin/ditto',
                '/usr/bin/codesign',
            ])
            retention.verify_production_identity(checkpoint / 'Robb Agents.app')
            manifest = checkpoint / 'backup.json'
            self.assertTrue(manifest.is_file())
            self.assertEqual(retention.candidates(root), [checkpoint])
            self.assertEqual(list(root.glob('.partial-*')), [])

    @unittest.skipUnless(os.name == 'posix' and retention.fcntl is not None, 'POSIX backup only')
    def test_bad_bundle_is_neither_published_nor_followed_by_pruning(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            source = self.create_bundle(temp_path / 'installed', 'io.example.wrong')
            root = temp_path / 'backups'
            root.mkdir()
            existing = []
            for name in ['20260901-a', '20260902-b', '20260903-c']:
                checkpoint = root / name
                checkpoint.mkdir()
                existing.append(checkpoint)

            argv = ['staging-retention.py', '--backup-app', '--root', str(root)]
            with mock.patch.object(retention, 'SOURCE_BUNDLE', source), \
                    mock.patch.object(retention.subprocess, 'run') as run, \
                    mock.patch.object(sys, 'argv', argv), \
                    mock.patch('sys.stdout', new_callable=io.StringIO), \
                    self.assertRaisesRegex(ValueError, 'Unexpected bundle identity'):
                retention.main()

            run.assert_not_called()
            self.assertTrue(all(checkpoint.is_dir() for checkpoint in existing))
            self.assertEqual(list(root.glob('.partial-*')), [])

    @unittest.skipUnless(os.name == 'posix' and retention.fcntl is not None, 'POSIX backup only')
    def test_copy_with_changed_identity_is_not_published(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            source = self.create_bundle(temp_path / 'installed')
            root = temp_path / 'backups'
            root.mkdir()
            commands = []

            def run(command, check):
                commands.append(command)
                self.assertTrue(check)
                if command[0] == str(retention.DITTO):
                    copied_bundle = Path(command[2])
                    shutil.copytree(command[1], copied_bundle)
                    (copied_bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({
                        'CFBundleIdentifier': 'io.example.changed',
                    }))
                return subprocess.CompletedProcess(command, 0)

            with mock.patch.object(retention, 'SOURCE_BUNDLE', source), \
                    mock.patch.object(retention.subprocess, 'run', side_effect=run), \
                    self.assertRaisesRegex(ValueError, 'Unexpected bundle identity'):
                retention.backup(root)

            self.assertEqual([command[0] for command in commands], [
                '/usr/bin/codesign',
                '/usr/bin/ditto',
            ])
            self.assertEqual(retention.candidates(root), [])
            self.assertEqual(list(root.glob('.partial-*')), [])

    @unittest.skipUnless(os.name == 'posix' and retention.fcntl is not None, 'POSIX import only')
    def test_unsigned_legacy_bundle_is_not_imported_or_followed_by_pruning(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            applications = temp_path / 'Applications'
            applications.mkdir()
            source = self.create_bundle(
                applications,
                name='Robb Agents.app.previous-unsigned',
            )
            root = temp_path / 'backups'
            root.mkdir()
            existing = []
            for name in ['20260901-a', '20260902-b', '20260903-c']:
                checkpoint = root / name
                checkpoint.mkdir()
                existing.append(checkpoint)

            signature_error = subprocess.CalledProcessError(1, '/usr/bin/codesign')
            argv = ['staging-retention.py', '--import-legacy', '--apply', '--root', str(root)]
            with mock.patch.object(retention, 'LEGACY_APPLICATIONS_ROOT', applications), \
                    mock.patch.object(retention.subprocess, 'run', side_effect=signature_error) as run, \
                    mock.patch.object(sys, 'argv', argv), \
                    mock.patch('sys.stdout', new_callable=io.StringIO), \
                    self.assertRaises(subprocess.CalledProcessError):
                retention.main()

            run.assert_called_once_with([
                '/usr/bin/codesign',
                '--verify',
                '--deep',
                '--strict',
                str(source),
            ], check=True)
            self.assertTrue(source.is_dir())
            self.assertTrue(all(checkpoint.is_dir() for checkpoint in existing))
            self.assertEqual(list(root.glob('.partial-*')), [])

    def test_locking_and_backup_fail_closed_without_posix_support(self):
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(retention, 'fcntl', None), \
                self.assertRaisesRegex(RuntimeError, 'only supported on POSIX'):
            retention.backup(Path(temp))

    def test_installer_fails_closed_outside_macos_before_writing(self):
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(installer.sys, 'platform', 'linux'), \
                mock.patch.object(installer.Path, 'home', return_value=Path(temp)), \
                mock.patch.object(installer, 'atomic_copy') as copy, \
                mock.patch.object(installer, 'atomic_write_plist') as write_plist, \
                mock.patch.object(installer.subprocess, 'run') as run, \
                self.assertRaisesRegex(RuntimeError, 'only supported on macOS'):
            installer.install()

        copy.assert_not_called()
        write_plist.assert_not_called()
        run.assert_not_called()

    def test_installer_uses_absolute_launchctl_and_publishes_files_atomically(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            results = [
                subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 0),
                subprocess.CompletedProcess([], 0),
            ]
            with mock.patch.object(installer.sys, 'platform', 'darwin'), \
                    mock.patch.object(installer.Path, 'home', return_value=home), \
                    mock.patch.object(installer.subprocess, 'run', side_effect=results) as run:
                installer.install()

            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual([command[0] for command in commands], ['/bin/launchctl'] * 4)
            self.assertEqual([command[1] for command in commands], [
                'print',
                'bootout',
                'bootstrap',
                'print',
            ])
            support = home / 'Library/Application Support/Robb Agents/Maintenance'
            installed_script = support / 'staging-retention.py'
            self.assertTrue(installed_script.is_file())
            self.assertEqual(installed_script.stat().st_mode & 0o777, 0o700)
            plist = home / 'Library/LaunchAgents/io.robinswood.robbagents.staging-retention.plist'
            configuration = plistlib.loads(plist.read_bytes())
            self.assertEqual(configuration['ProgramArguments'], [
                sys.executable,
                str(installed_script),
                '--apply',
            ])
            self.assertEqual(list(home.rglob('*.partial-*')), [])


if __name__ == '__main__':
    unittest.main()
