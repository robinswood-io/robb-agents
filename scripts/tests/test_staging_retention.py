import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from contextlib import redirect_stderr, redirect_stdout


spec = importlib.util.spec_from_file_location(
    'staging_retention',
    Path(__file__).parents[1] / 'staging-retention.py',
)
retention = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(retention)


COMMIT = 'a' * 40
ALLOW_SIGNATURE = lambda _bundle: True


def completed(stdout='', stderr='', returncode=0):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def create_bundle(app, *, bundle_id=retention.APP_ID):
    contents = app / 'Contents'
    executable = contents / 'MacOS/Robb Agents'
    archive = contents / 'Resources/app.asar'
    executable.parent.mkdir(parents=True)
    archive.parent.mkdir(parents=True)
    executable.write_bytes(b'arm64 executable fixture')
    archive.write_bytes(b'asar fixture')
    with (contents / 'Info.plist').open('wb') as stream:
        plistlib.dump({
            'CFBundleIdentifier': bundle_id,
            'CFBundleExecutable': 'Robb Agents',
            'CFBundleShortVersionString': '1.0.0',
        }, stream)


def bundle_fingerprint(app):
    return {
        'bundleIdentifier': retention.APP_ID,
        'executable': 'Robb Agents',
        'version': '1.0.0',
        'buildCommit': COMMIT,
        'buildChannel': 'production',
        'buildDirty': 'false',
        'architecture': 'Mach-O 64-bit executable arm64',
        'signatureKind': 'adhoc',
        'asarSha256': retention.sha256_file(app / 'Contents/Resources/app.asar'),
        'executableSha256': retention.sha256_file(app / 'Contents/MacOS/Robb Agents'),
        'infoPlistSha256': retention.sha256_file(app / 'Contents/Info.plist'),
        'bundleTreeSha256': retention.sha256_tree(app),
    }


def create_checkpoint(root, created, *, version=2, bundle_id=retention.APP_ID):
    created = created.astimezone(datetime.timezone.utc)
    checkpoint = root / created.strftime('%Y%m%d-%H%M%S-%f')
    app = checkpoint / retention.APP_NAME
    create_bundle(app, bundle_id=bundle_id)
    manifest = {
        'version': version,
        'createdAt': created.isoformat(),
        'source': '/Applications/Robb Agents.app',
    }
    if version == 2:
        manifest['validation'] = retention.strong_validation_manifest(bundle_fingerprint(app))
    (checkpoint / 'backup.json').write_text(json.dumps(manifest), encoding='utf-8')
    return checkpoint


class StagingRetentionTests(unittest.TestCase):
    def test_retention_lock_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            victim = base / 'victim'
            victim.write_text('must remain intact')
            lock_path = base / 'retention.lock'
            lock_path.symlink_to(victim)
            with self.assertRaises((OSError, ValueError)):
                retention.open_lock(lock_path)
            self.assertEqual(victim.read_text(), 'must remain intact')

    def test_backup_can_defer_pruning_for_stronger_caller_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'backups'
            created = root / '.rollback-held-created'
            with (
                mock.patch.object(sys, 'argv', [
                    'staging-retention.py',
                    '--backup-app',
                    '--no-prune',
                    '--hold-created',
                    '--root',
                    str(root),
                ]),
                mock.patch.object(retention, 'backup', return_value=created) as backup,
                mock.patch.object(
                    retention,
                    'prune',
                    return_value={'kept': [], 'removed': [], 'apply': False},
                ) as prune,
                redirect_stdout(io.StringIO()),
            ):
                retention.main()
            backup.assert_called_once_with(root.resolve(), True)
            prune.assert_called_once_with(root.resolve(), False)

    def test_transaction_backup_can_defer_strong_validation_only_while_held(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'backups'
            created = root / '.rollback-held-created'
            with (
                mock.patch.object(sys, 'argv', [
                    'staging-retention.py',
                    '--backup-app',
                    '--no-prune',
                    '--hold-created',
                    '--defer-strong-validation',
                    '--root',
                    str(root),
                ]),
                mock.patch.object(retention, 'backup', return_value=created) as backup,
                mock.patch.object(
                    retention,
                    'prune',
                    return_value={'kept': [], 'removed': [], 'apply': False},
                ) as prune,
                redirect_stdout(io.StringIO()),
            ):
                retention.main()
            backup.assert_called_once_with(root.resolve(), True, None)
            prune.assert_called_once_with(root.resolve(), False)

    def test_deferred_strong_validation_requires_hidden_non_pruning_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'backups'
            with (
                mock.patch.object(sys, 'argv', [
                    'staging-retention.py',
                    '--backup-app',
                    '--defer-strong-validation',
                    '--root',
                    str(root),
                ]),
                redirect_stdout(io.StringIO()),
                redirect_stderr(io.StringIO()),
            ):
                with self.assertRaises(SystemExit):
                    retention.main()
            self.assertFalse(root.exists())

    def test_main_rejects_a_symlinked_backup_parent_before_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            real_parent = base / 'real-parent'
            real_parent.mkdir()
            alias_parent = base / 'alias-parent'
            alias_parent.symlink_to(real_parent, target_is_directory=True)
            with mock.patch.object(sys, 'argv', [
                'staging-retention.py',
                '--apply',
                '--root',
                str(alias_parent / 'backups'),
            ]):
                with self.assertRaisesRegex(ValueError, 'component must not be a symlink'):
                    retention.main()
            self.assertFalse((real_parent / 'backups').exists())

    def test_keeps_two_newest_strongly_validated_checkpoints_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            start = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)
            checkpoints = [
                create_checkpoint(root, start + datetime.timedelta(days=index, microseconds=index + 1))
                for index in range(4)
            ]
            (root / '.partial-current').mkdir()
            (root / 'notes').mkdir()
            preview = retention.prune(root, signature_verifier=ALLOW_SIGNATURE)
            self.assertEqual(preview['removed'], [checkpoints[1].name, checkpoints[0].name])
            result = retention.prune(root, True, signature_verifier=ALLOW_SIGNATURE)
            self.assertEqual(result['kept'], [checkpoints[3].name, checkpoints[2].name])
            self.assertFalse(checkpoints[0].exists())
            self.assertFalse(checkpoints[1].exists())
            self.assertTrue((root / '.partial-current').exists())
            self.assertTrue((root / 'notes').exists())

    def test_never_prunes_arbitrary_dated_or_legacy_v1_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            start = datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc)
            valid = [
                create_checkpoint(root, start + datetime.timedelta(days=index, microseconds=index + 1))
                for index in range(3)
            ]
            arbitrary = root / '20260910-120000-000001'
            arbitrary.mkdir()
            (arbitrary / 'personal-notes').write_text('never delete', encoding='utf-8')
            legacy_v1 = create_checkpoint(
                root,
                datetime.datetime(2026, 9, 11, 12, 0, 0, 2, tzinfo=datetime.timezone.utc),
                version=1,
            )

            result = retention.prune(root, True, signature_verifier=ALLOW_SIGNATURE)

            self.assertEqual(result['removed'], [valid[0].name])
            self.assertTrue(arbitrary.exists())
            self.assertTrue(legacy_v1.exists())

    def test_strong_proof_is_rechecked_against_bundle_bytes_and_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            created = datetime.datetime(2026, 9, 1, 1, 2, 3, 4, tzinfo=datetime.timezone.utc)
            checkpoint = create_checkpoint(root, created)
            self.assertIsNotNone(retention.managed_checkpoint(checkpoint, ALLOW_SIGNATURE))

            (checkpoint / retention.APP_NAME / 'Contents/Resources/app.asar').write_bytes(b'tampered')
            self.assertIsNone(retention.managed_checkpoint(checkpoint, ALLOW_SIGNATURE))

            wrong_identity = create_checkpoint(
                root,
                created + datetime.timedelta(days=1),
                bundle_id='com.example.not-production',
            )
            self.assertIsNone(retention.managed_checkpoint(wrong_identity, ALLOW_SIGNATURE))

            runtime_changed = create_checkpoint(
                root,
                created + datetime.timedelta(days=2),
            )
            external_runtime = (
                runtime_changed / retention.APP_NAME / 'Contents/Resources/app/dist/interceptor.cjs'
            )
            external_runtime.parent.mkdir(parents=True)
            external_runtime.write_text('changed after validation', encoding='utf-8')
            self.assertIsNone(retention.managed_checkpoint(runtime_changed, ALLOW_SIGNATURE))

    def test_backup_publishes_version_two_proof_only_after_strong_copy_match(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / 'backups'
            root.mkdir()
            source = base / retention.APP_NAME
            create_bundle(source)

            def runner(args, **_kwargs):
                if args[0] == '/usr/bin/ditto':
                    shutil.copytree(Path(args[1]), Path(args[2]))
                return completed()

            with mock.patch.object(retention.subprocess, 'run', side_effect=runner):
                checkpoint = retention.backup(
                    root,
                    fingerprint_validator=bundle_fingerprint,
                    source=source,
                )

            manifest = json.loads((checkpoint / 'backup.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['version'], 2)
            self.assertEqual(
                manifest['validation']['contract'],
                retention.STRONG_VALIDATION_CONTRACT,
            )
            # The production helper always records /Applications; the injected
            # source path above exists only to keep this unit test hermetic.
            manifest['source'] = '/Applications/Robb Agents.app'
            (checkpoint / 'backup.json').write_text(json.dumps(manifest), encoding='utf-8')
            self.assertIsNotNone(retention.managed_checkpoint(checkpoint, ALLOW_SIGNATURE))

    def test_new_backup_stays_newest_when_the_clock_moves_backwards(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / 'backups'
            root.mkdir()
            future = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)
            older = create_checkpoint(root, future)
            newer = create_checkpoint(root, future + datetime.timedelta(seconds=1))
            source = base / retention.APP_NAME
            create_bundle(source)

            def runner(args, **_kwargs):
                if args[0] == '/usr/bin/ditto':
                    shutil.copytree(Path(args[1]), Path(args[2]))
                return completed()

            with mock.patch.object(retention.subprocess, 'run', side_effect=runner):
                created = retention.backup(
                    root,
                    fingerprint_validator=bundle_fingerprint,
                    source=source,
                    clock=lambda: datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
                    signature_verifier=ALLOW_SIGNATURE,
                )
            manifest = json.loads((created / 'backup.json').read_text(encoding='utf-8'))
            self.assertGreater(
                datetime.datetime.fromisoformat(manifest['createdAt']),
                future + datetime.timedelta(seconds=1),
            )
            # Keep the production source constraint for managed/prune validation.
            manifest['source'] = '/Applications/Robb Agents.app'
            (created / 'backup.json').write_text(json.dumps(manifest), encoding='utf-8')

            result = retention.prune(root, True, signature_verifier=ALLOW_SIGNATURE)

            self.assertTrue(created.exists())
            self.assertTrue(newer.exists())
            self.assertFalse(older.exists())
            self.assertEqual(result['kept'][0], created.name)

    def test_does_not_follow_checkpoint_or_root_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / 'root'
            root.mkdir()
            outside = base / 'outside'
            outside.mkdir()
            (root / '20260901-120000-000001').symlink_to(outside, target_is_directory=True)
            self.assertEqual(
                retention.prune(root, True, signature_verifier=ALLOW_SIGNATURE)['removed'],
                [],
            )
            alias = base / 'root-alias'
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'component must not be a symlink'):
                retention.prune(alias, True, signature_verifier=ALLOW_SIGNATURE)

    def test_prune_session_scratch_dry_run_and_apply(self):
        with tempfile.TemporaryDirectory() as temp:
            workspaces = Path(temp) / 'workspaces'
            session = workspaces / 'ws-1/sessions/session-123'
            data = session / 'data'
            data.mkdir(parents=True)
            (session / 'session.jsonl').write_text('{"id":"session-123"}\n', encoding='utf-8')
            (session / 'plans').mkdir()
            (session / 'plans/plan.md').write_text('# Plan', encoding='utf-8')

            # 1. Old large directory (150MB, 20 days old)
            old_large = data / 'old-large-clone'
            old_large.mkdir()
            old_file = old_large / 'build.bin'
            old_file.write_bytes(b'x' * (150 * 1024)) # 150KB fixture for test, we'll set min_size_bytes to 100KB

            # 2. Recent large directory (150MB, 2 days old)
            recent_large = data / 'recent-large-clone'
            recent_large.mkdir()
            recent_file = recent_large / 'build.bin'
            recent_file.write_bytes(b'x' * (150 * 1024))

            # 3. Old small file (10KB, 20 days old)
            old_small = data / 'small.json'
            old_small.write_bytes(b'x' * 1024)

            now = datetime.datetime.now(datetime.timezone.utc)
            twenty_days_ago = (now - datetime.timedelta(days=20)).timestamp()
            two_days_ago = (now - datetime.timedelta(days=2)).timestamp()

            os.utime(old_file, (twenty_days_ago, twenty_days_ago))
            os.utime(old_large, (twenty_days_ago, twenty_days_ago))
            os.utime(recent_file, (two_days_ago, two_days_ago))
            os.utime(recent_large, (two_days_ago, two_days_ago))
            os.utime(old_small, (twenty_days_ago, twenty_days_ago))

            # Test Dry-run
            dry_run = retention.prune_session_scratch(
                workspaces_root=workspaces,
                min_size_bytes=100 * 1024,
                max_age_days=15,
                apply=False,
                now=now,
            )
            self.assertEqual(dry_run['scannedSessions'], 1)
            self.assertEqual(dry_run['prunedCount'], 1)
            self.assertEqual(dry_run['items'][0]['name'], 'old-large-clone')
            self.assertTrue(old_large.exists())

            # Test Apply
            applied = retention.prune_session_scratch(
                workspaces_root=workspaces,
                min_size_bytes=100 * 1024,
                max_age_days=15,
                apply=True,
                now=now,
            )
            self.assertEqual(applied['scannedSessions'], 1)
            self.assertEqual(applied['prunedCount'], 1)
            self.assertFalse(old_large.exists())
            self.assertTrue(recent_large.exists())
            self.assertTrue(old_small.exists())
            self.assertTrue((session / 'session.jsonl').exists())
            self.assertTrue((session / 'plans/plan.md').exists())


if __name__ == '__main__':
    unittest.main()
