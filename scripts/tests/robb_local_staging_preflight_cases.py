from .robb_local_staging_fixtures import patch_staging
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest import mock

from .robb_local_staging_fixtures import (
    staging,
    COMMIT,
    completed,
    fingerprint,
    GitRunner,
    LocalStagingTestCase,
)


class LocalStagingTests(LocalStagingTestCase):
    @unittest.skipUnless(staging.sys.platform == "darwin", "Darwin renamex_np contract")
    def test_darwin_atomic_swap_never_removes_either_path(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            left = base / "left"
            right = base / "right"
            left.mkdir()
            right.mkdir()
            (left / "marker").write_text("old", encoding="utf-8")
            (right / "marker").write_text("new", encoding="utf-8")
            staging.atomic_swap_bundles(left, right)
            self.assertEqual((left / "marker").read_text(), "new")
            self.assertEqual((right / "marker").read_text(), "old")

    def test_main_commit_probe_requires_build_provenance_field(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            archive = base / "app.asar"
            fake_asar = base / "node_modules/@electron/asar"
            fake_asar.mkdir(parents=True)
            (fake_asar / "package.json").write_text(
                json.dumps({"type": "module", "exports": "./index.js"}),
                encoding="utf-8",
            )
            (fake_asar / "index.js").write_text(
                "import { readFileSync } from 'node:fs';"
                "export function extractFile(archive) { return readFileSync(archive); }",
                encoding="utf-8",
            )

            def pack(main_source):
                archive.write_text(main_source, encoding="utf-8")

            def probe():
                return subprocess.run(
                    [
                        "node",
                        "--input-type=module",
                        "--eval",
                        staging.MAIN_COMMIT_PROBE,
                        str(archive),
                        COMMIT,
                    ],
                    cwd=base,
                    text=True,
                    capture_output=True,
                    check=False,
                )

            production_source = (
                'function resolveAppChannel(isPackaged, declaredChannel = "production") {}\n'
                f'const platform = {{ buildCommit: "{COMMIT}", '
                'buildChannel: APP_CHANNEL, '
                'buildDirty: false ? true : true ? false : void 0 };'
            )
            pack(production_source)
            result = probe()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["buildChannel"], "production")
            pack(production_source.replace("APP_CHANNEL", "APP_CHANNEL2"))
            self.assertEqual(probe().returncode, 0)
            pack(f'const releaseNotes = "mentions {COMMIT}";')
            self.assertNotEqual(probe().returncode, 0)
            pack(production_source.replace('"production"', '"development"'))
            self.assertNotEqual(probe().returncode, 0)
            pack(production_source.replace("buildDirty: false ? true : true ? false", "buildDirty: void 0"))
            self.assertNotEqual(probe().returncode, 0)

    def test_clean_checkout_requires_no_untracked_files_and_exact_commit(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            self.assertEqual(staging.verify_clean_checkout(repo, COMMIT, GitRunner()), COMMIT)
            with self.assertRaisesRegex(staging.StagingError, "completely clean"):
                staging.verify_clean_checkout(repo, COMMIT, GitRunner(status="?? secret.ts\n"))
            with self.assertRaisesRegex(staging.StagingError, "commit mismatch"):
                staging.verify_clean_checkout(repo, COMMIT, GitRunner(commit="b" * 40))
            with self.assertRaisesRegex(staging.StagingError, "40-character"):
                staging.verify_clean_checkout(repo, "abc", GitRunner())

    def test_stopped_app_accepts_only_a_dead_runtime_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            lock = base / ".server.lock"
            app = base / staging.APP_NAME
            runner = lambda _command: completed(stdout="")
            lock.write_text(json.dumps({"pid": 999_999_999, "startedAt": 1}), encoding="utf-8")
            staging.wait_until_stopped(app, lock, timeout=0.1, runner=runner)
            staging.assert_application_stopped(app, lock, runner=runner)

            lock.write_text("invalid", encoding="utf-8")
            with self.assertRaisesRegex(staging.StagingError, "Runtime lock"):
                staging.assert_application_stopped(app, lock, runner=runner)
            with mock.patch("robb_staging_runtime.process_is_alive", return_value=True):
                lock.write_text(json.dumps({"pid": 123, "startedAt": 1}), encoding="utf-8")
                with self.assertRaisesRegex(staging.StagingError, "runtimeLockActive=True"):
                    staging.assert_application_stopped(app, lock, runner=runner)

    def test_bundle_requires_clean_production_arm64_and_local_candidate_signature(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            repo = base / "repo"
            (repo / "scripts").mkdir(parents=True)
            (repo / "scripts/validate-electron-package-security.ts").write_text("fixture")
            app = base / staging.APP_NAME
            contents = app / "Contents"
            resources = contents / "Resources"
            binary = contents / "MacOS/Robb Agents"
            resources.mkdir(parents=True)
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"binary")
            (resources / "app.asar").write_bytes(b"asar")
            (contents / "Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": staging.APP_ID,
                "CFBundleExecutable": "Robb Agents",
                "CFBundleShortVersionString": "1.0.0",
            }))

            def make_runner(*, signature="Signature=adhoc", architecture="Mach-O 64-bit executable arm64"):
                def runner(args, **_kwargs):
                    if args[0] == "/usr/bin/codesign" and "-dv" in args:
                        return completed(stderr=signature)
                    if args[0] in ("/usr/bin/codesign", "bun"):
                        return completed()
                    if args[0] == "node":
                        return completed(json.dumps({
                            "buildCommit": COMMIT,
                            "buildChannel": "production",
                            "buildDirty": False,
                        }))
                    if args[:2] == ["/usr/bin/file", "-b"]:
                        return completed(architecture)
                    raise AssertionError(args)
                return runner

            result = staging.validate_bundle(
                repo,
                app,
                expected_commit=COMMIT,
                require_developer_id=True,
                runner=make_runner(signature="Authority=Developer ID Application: Example (ABCDEFGHIJ)"),
            )
            self.assertEqual(result["signatureKind"], "developer-id")
            self.assertIn("arm64", result["architecture"])

            # Historical ad-hoc installations/backups remain verifiable for rollback.
            historical = staging.validate_bundle(repo, app, expected_commit=COMMIT, runner=make_runner())
            self.assertEqual(historical["signatureKind"], "adhoc")

            with self.assertRaisesRegex(staging.StagingError, "Developer ID Application"):
                staging.validate_bundle(
                    repo,
                    app,
                    expected_commit=COMMIT,
                    require_developer_id=True,
                    runner=make_runner(
                        signature="Signature=adhoc"
                    ),
                )
            with self.assertRaisesRegex(staging.StagingError, "requires an arm64"):
                staging.validate_bundle(
                    repo,
                    app,
                    expected_commit=COMMIT,
                    runner=make_runner(architecture="Mach-O 64-bit executable x86_64"),
                )

    def test_backup_receipt_must_resolve_to_direct_managed_child(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "backups"
            checkpoint = root / "20260911-good"
            (checkpoint / staging.APP_NAME).mkdir(parents=True)
            stdout = json.dumps({"created": str(checkpoint)}) + "\n" + json.dumps({"kept": []})
            self.assertEqual(staging.parse_created_backup(stdout, root), checkpoint.resolve())

            outside = base / "outside"
            (outside / staging.APP_NAME).mkdir(parents=True)
            with self.assertRaisesRegex(staging.StagingError, "escaped"):
                staging.parse_created_backup(json.dumps({"created": str(outside)}), root)

    def test_backup_helper_receives_the_exact_managed_root(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            repo = base / "repo"
            (repo / "scripts").mkdir(parents=True)
            source = repo / "scripts/staging-retention.py"
            source.write_text("fixture", encoding="utf-8")
            installed = base / "installed-retention.py"
            installed.write_text("fixture", encoding="utf-8")
            qualified = base / "qualified-retention.py"
            qualified.write_text("fixture", encoding="utf-8")
            expected_hash = staging.sha256_file(source)
            root = base / "custom backups"
            checkpoint = root / "20260911-good"
            (checkpoint / staging.APP_NAME).mkdir(parents=True)
            seen = []

            def runner(args, **_kwargs):
                seen.append(args)
                return completed(json.dumps({"created": str(checkpoint)}) + "\n")

            with patch_staging("verify_clean_checkout", return_value=COMMIT):
                created = staging.backup_current_app(
                    repo,
                    root,
                    qualified_helper=qualified,
                    expected_commit=COMMIT,
                    expected_helper_sha256=expected_hash,
                    installed_script=installed,
                    runner=runner,
                )
            self.assertEqual(created, checkpoint.resolve())
            self.assertIn("--no-prune", seen[0])
            self.assertIn("--hold-created", seen[0])
            self.assertIn("--defer-strong-validation", seen[0])
            self.assertEqual(Path(seen[0][1]), qualified)
            self.assertEqual(seen[0][-2:], ["--root", str(root.resolve())])

    def test_backup_helper_rejects_a_symlinked_parent_before_running(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            repo = base / "repo"
            (repo / "scripts").mkdir(parents=True)
            (repo / "scripts/staging-retention.py").write_text("fixture", encoding="utf-8")
            real_parent = base / "real-parent"
            real_parent.mkdir()
            alias_parent = base / "alias-parent"
            alias_parent.symlink_to(real_parent, target_is_directory=True)
            runner = mock.Mock()

            with self.assertRaisesRegex(staging.StagingError, "component must not be a symlink"):
                staging.backup_current_app(
                    repo,
                    alias_parent / "backups",
                    qualified_helper=repo / "scripts/staging-retention.py",
                    expected_commit=COMMIT,
                    expected_helper_sha256="0" * 64,
                    installed_script=repo / "scripts/staging-retention.py",
                    runner=runner,
                )
            runner.assert_not_called()

    def test_preflight_refuses_a_stale_installed_retention_helper(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            repo = base / "repo"
            (repo / "scripts").mkdir(parents=True)
            (repo / "scripts/staging-retention.py").write_text("new", encoding="utf-8")
            installed = base / "installed-staging-retention.py"
            installed.write_text("old", encoding="utf-8")
            installer = staging.LocalStagingInstaller(
                repo=repo,
                target_app=base / "Applications" / staging.APP_NAME,
                profile_root=base / "profile",
                backup_root=base / "backups",
                installed_retention_script=installed,
            )
            with self.assertRaisesRegex(staging.StagingError, "installed retention helper is stale"):
                installer.preflight(base / "candidate" / staging.APP_NAME, COMMIT)

    def test_helper_mutation_between_preflight_and_backup_executes_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            repo = base / "repo"
            (repo / "scripts").mkdir(parents=True)
            source = repo / "scripts/staging-retention.py"
            source.write_text("qualified", encoding="utf-8")
            installed = base / "installed-retention.py"
            installed.write_text("qualified", encoding="utf-8")
            qualified = base / "qualified-retention.py"
            qualified.write_text("qualified", encoding="utf-8")
            expected_hash = staging.verify_installed_retention_helper(repo, installed)
            source.write_text("mutated after preflight", encoding="utf-8")
            runner = mock.Mock()

            with (
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                self.assertRaisesRegex(staging.StagingError, "installed retention helper is stale"),
            ):
                staging.backup_current_app(
                    repo,
                    base / "backups",
                    qualified_helper=qualified,
                    expected_commit=COMMIT,
                    expected_helper_sha256=expected_hash,
                    installed_script=installed,
                    runner=runner,
                )
            runner.assert_not_called()

    def test_helper_mutation_after_final_git_check_blocks_prune_and_keeps_backups(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            repo = base / "repo"
            (repo / "scripts").mkdir(parents=True)
            source = repo / "scripts/staging-retention.py"
            source.write_text("qualified", encoding="utf-8")
            installed = base / "installed-retention.py"
            installed.write_text("qualified", encoding="utf-8")
            qualified = base / "qualified-retention.py"
            qualified.write_text("qualified", encoding="utf-8")
            expected_hash = staging.verify_installed_retention_helper(repo, installed)
            backup = base / "backups/20260901-120000-000001"
            backup.mkdir(parents=True)
            victim = backup / "must-remain"
            victim.write_text("rollback", encoding="utf-8")
            with patch_staging("verify_clean_checkout", return_value=COMMIT):
                staging.verify_qualified_source_state(
                    repo,
                    expected_commit=COMMIT,
                    expected_helper_sha256=expected_hash,
                    installed_script=installed,
                    runner=mock.Mock(),
                )
            source.write_text("mutated after final check", encoding="utf-8")
            runner = mock.Mock()

            with (
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                self.assertRaisesRegex(staging.StagingError, "installed retention helper is stale"),
            ):
                staging.prune_backups(
                    repo,
                    backup.parent,
                    qualified_helper=qualified,
                    expected_commit=COMMIT,
                    expected_helper_sha256=expected_hash,
                    installed_script=installed,
                    runner=runner,
                )
            runner.assert_not_called()
            self.assertEqual(victim.read_text(encoding="utf-8"), "rollback")

    def test_timeouts_must_be_finite_and_positive(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for value in (0, -1, float("inf"), float("nan")):
                with self.subTest(value=value):
                    with self.assertRaisesRegex(staging.StagingError, "finite positive"):
                        staging.LocalStagingInstaller(repo=base, quit_timeout=value)

    def test_transaction_lock_refuses_a_second_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            lock = Path(temp) / "transaction.lock"
            with staging.exclusive_file_lock(lock):
                with self.assertRaisesRegex(staging.StagingError, "holds"):
                    with staging.exclusive_file_lock(lock):
                        self.fail("second lock must not be acquired")

    def test_transaction_lock_never_follows_a_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            victim = base / "victim"
            victim.write_text("must remain intact", encoding="utf-8")
            lock = base / "transaction.lock"
            lock.symlink_to(victim)
            with self.assertRaisesRegex(staging.StagingError, "safely open"):
                with staging.exclusive_file_lock(lock):
                    self.fail("symlink lock must not be acquired")
            self.assertEqual(victim.read_text(encoding="utf-8"), "must remain intact")

    def test_runtime_lock_must_point_to_installed_target_and_current_start(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            app = base / staging.APP_NAME
            executable = app / "Contents/MacOS/Robb Agents"
            executable.parent.mkdir(parents=True)
            executable.write_text("fixture", encoding="utf-8")
            lock = base / "profile/robb-electron/.server.lock"
            lock.parent.mkdir(parents=True)
            now_ms = int(time.time() * 1000)
            lock.write_text(json.dumps({"pid": os.getpid(), "startedAt": now_ms}), encoding="utf-8")

            def runner(args, **_kwargs):
                self.assertEqual(args[:3], ["/bin/ps", "-p", str(os.getpid())])
                return completed(str(executable.resolve()) + "\n")

            result = staging.verify_runtime(
                app,
                lock,
                launched_after_ms=now_ms,
                timeout=0.5,
                runner=runner,
            )
            self.assertEqual(result["pid"], os.getpid())
            self.assertEqual(result["command"], str(executable.resolve()))

            lock.write_text(
                json.dumps({"pid": os.getpid(), "startedAt": now_ms - 1}),
                encoding="utf-8",
            )
            with mock.patch.object(staging.time, "sleep"):
                with self.assertRaisesRegex(staging.StagingError, "lock is stale"):
                    staging.verify_runtime(
                        app,
                        lock,
                        launched_after_ms=now_ms,
                        timeout=0.01,
                        runner=runner,
                    )

    def test_install_swaps_only_after_verified_backup_and_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            events = []

            def stop(*_args, **_kwargs):
                events.append("stopped")

            def launch(*_args, **_kwargs):
                events.append("launched")
                return {"pid": 123, "startedAt": 456, "command": "Robb Agents"}

            def finalize(*_args, **kwargs):
                shutil.rmtree(kwargs["transaction_partial"])
                return checkpoint, True, None, None, "absent"

            with (
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint) as backup,
                patch_staging("publish_checkpoint_best_effort",
                    side_effect=finalize,
                ) as publish,
                patch_staging("quit_application", side_effect=stop),
                patch_staging("launch_and_verify_runtime", side_effect=launch),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                result = installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "new")
            self.assertEqual(result["status"], "installed")
            self.assertEqual(result["checkoutCommit"], COMMIT)
            self.assertEqual(result["artifactCommit"], COMMIT)
            self.assertEqual(result["backupCheckpoint"], str(checkpoint))
            self.assertEqual(events, ["stopped", "launched"])
            backup.assert_called_once()
            publish.assert_called_once()
            self.assertEqual(publish.call_args.kwargs["reason"], "installed-previous-app")
            self.assertEqual(list(target.parent.glob(".Robb Agents.app.pre-staging-*")), [])
