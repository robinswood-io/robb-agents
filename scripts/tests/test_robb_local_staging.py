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


SCRIPT = Path(__file__).parents[1] / "robb-local-staging.py"
SPEC = importlib.util.spec_from_file_location("robb_local_staging", SCRIPT)
staging = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(staging)


COMMIT = "a" * 40


def completed(stdout="", stderr="", returncode=0):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def fingerprint(app: Path):
    marker = (app / "marker").read_text(encoding="utf-8")
    return {
        "bundleIdentifier": staging.APP_ID,
        "executable": "Robb Agents",
        "version": "1.0.0",
        "buildCommit": COMMIT,
        "buildChannel": "production",
        "buildDirty": "false",
        "architecture": "Mach-O 64-bit executable arm64",
        "signatureKind": "adhoc",
        "asarSha256": marker,
        "executableSha256": marker,
        "infoPlistSha256": marker,
        "bundleTreeSha256": staging.sha256_tree(app),
    }


class GitRunner:
    def __init__(self, *, status="", commit=COMMIT):
        self.status = status
        self.commit = commit

    def __call__(self, args, **_kwargs):
        if args[1:3] == ["status", "--porcelain"]:
            return completed(self.status)
        if args[1:3] == ["rev-parse", "HEAD"]:
            return completed(self.commit + "\n")
        raise AssertionError(args)


class LocalStagingTests(unittest.TestCase):
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
                require_adhoc=True,
                runner=make_runner(),
            )
            self.assertEqual(result["signatureKind"], "adhoc")
            self.assertIn("arm64", result["architecture"])

            with self.assertRaisesRegex(staging.StagingError, "ad-hoc"):
                staging.validate_bundle(
                    repo,
                    app,
                    expected_commit=COMMIT,
                    require_adhoc=True,
                    runner=make_runner(
                        signature="Authority=Developer ID Application: Example (ABCDEFGHIJ)"
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

            with mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT):
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
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
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
            with mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT):
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
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
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

    def make_transaction(self, base: Path):
        repo = base / "repo"
        repo.mkdir()
        (repo / "scripts").mkdir()
        retention_source = repo / "scripts/staging-retention.py"
        retention_source.write_text("retention fixture\n", encoding="utf-8")
        installed_retention = base / "installed-staging-retention.py"
        installed_retention.write_text("retention fixture\n", encoding="utf-8")
        target_parent = base / "Applications"
        target = target_parent / staging.APP_NAME
        candidate = repo / "candidate" / staging.APP_NAME
        backup_root = base / "backups"
        checkpoint = backup_root / "20260911-old"
        profile = base / "profile"
        for app, value in ((target, "old"), (candidate, "new"), (checkpoint / staging.APP_NAME, "old")):
            app.mkdir(parents=True)
            (app / "marker").write_text(value, encoding="utf-8")
        def swapper(left, right):
            temporary = left.parent / ".test-atomic-swap"
            os.replace(left, temporary)
            os.replace(right, left)
            os.replace(temporary, right)

        installer = staging.LocalStagingInstaller(
            repo=repo,
            target_app=target,
            profile_root=profile,
            backup_root=backup_root,
            swapper=swapper,
            transaction_lock_file=base / ".transaction.lock",
            installed_retention_script=installed_retention,
            quit_timeout=0.1,
            launch_timeout=0.1,
        )

        def stage_candidate(source, commit):
            partial = Path(tempfile.mkdtemp(prefix=".partial-robb-staging-test-", dir=target_parent))
            staged = partial / staging.APP_NAME
            shutil.copytree(source, staged)
            return partial, staged, fingerprint(staged)

        return installer, target, candidate, checkpoint, stage_candidate

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
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint) as backup,
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    side_effect=finalize,
                ) as publish,
                mock.patch.object(staging, "quit_application", side_effect=stop),
                mock.patch.object(staging, "launch_and_verify_runtime", side_effect=launch),
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

    def test_backup_mismatch_aborts_before_quit_or_swap(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            (checkpoint / staging.APP_NAME / "marker").write_text("different", encoding="utf-8")
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ) as publish,
                mock.patch.object(staging, "quit_application") as stop,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "Managed rollback checkpoint differs"):
                    installer.install(candidate, COMMIT)

            stop.assert_not_called()
            publish.assert_called_once()
            self.assertEqual(
                publish.call_args.kwargs["reason"],
                "installation-aborted-before-exchange",
            )
            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            self.assertEqual(list(target.parent.glob(".Robb Agents.app.pre-staging-*")), [])
            self.assertEqual(list(target.parent.glob(".partial-robb-staging-*")), [])

    def test_old_copy_cleanup_failure_does_not_revert_valid_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            real_rmtree = shutil.rmtree

            def selective_rmtree(path, *args, **kwargs):
                path = Path(path)
                if path.name.startswith(".partial-robb-staging-"):
                    raise OSError("fixture cleanup denied")
                return real_rmtree(path, *args, **kwargs)

            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(
                        checkpoint,
                        True,
                        None,
                        "Transaction directory remains: fixture cleanup denied",
                        "validated",
                    ),
                ) as publish,
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "new"},
                ) as launch,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
                mock.patch.object(staging.shutil, "rmtree", side_effect=selective_rmtree),
            ):
                result = installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "new")
            publish.assert_called_once()
            self.assertIn("fixture cleanup denied", result["transactionCleanupWarning"])
            self.assertEqual(len(list(target.parent.glob(".partial-robb-staging-*"))), 1)
            launch.assert_called_once()

    def test_unconfirmed_finalization_preserves_the_immediate_old_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, False, "checkpoint lost", None, "validated"),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "new"},
                ),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                result = installer.install(candidate, COMMIT)

            partials = list(target.parent.glob(".partial-robb-staging-*"))
            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "new")
            self.assertEqual(len(partials), 1)
            self.assertEqual((partials[0] / staging.APP_NAME / "marker").read_text(), "old")
            self.assertIsNone(result["backupCheckpoint"])
            self.assertTrue(result["transactionPartialPreserved"])
            self.assertEqual(result["transactionPartialRecoveryPath"], str(partials[0]))

    def test_receipt_never_claims_preservation_after_locked_cleanup_completed(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))

            def cleanup_then_lose_confirmation(*_args, **kwargs):
                shutil.rmtree(kwargs["transaction_partial"])
                return checkpoint, False, "post-rename confirmation failed", None, "absent"

            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    side_effect=cleanup_then_lose_confirmation,
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "new"},
                ),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                result = installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "new")
            self.assertEqual(list(target.parent.glob(".partial-robb-staging-*")), [])
            self.assertFalse(result["transactionPartialPreserved"])
            self.assertIsNone(result["transactionPartialRecoveryPath"])
            self.assertIn("transaction copy was removed", result["transactionCleanupWarning"])
            self.assertNotIn("Immediate previous app preserved", result["transactionCleanupWarning"])

    def test_partial_cleanup_damage_is_reported_as_unverified_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))

            def leave_incomplete_evidence(*_args, **kwargs):
                partial = kwargs["transaction_partial"]
                (partial / staging.APP_NAME / "marker").unlink()
                return (
                    checkpoint,
                    True,
                    None,
                    "remaining transaction copy is incomplete",
                    "present-unverified",
                )

            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    side_effect=leave_incomplete_evidence,
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "new"},
                ),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                result = installer.install(candidate, COMMIT)

            self.assertFalse(result["transactionPartialPreserved"])
            self.assertTrue(result["transactionPartialExists"])
            self.assertIsNone(result["transactionPartialRecoveryPath"])
            self.assertIsNotNone(result["transactionPartialEvidencePath"])
            self.assertIn("incomplete", result["transactionCleanupWarning"])

    def test_interrupt_after_commit_never_retries_cleanup_from_a_stale_checkpoint_path(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            published = checkpoint.parent / "20260911-120000-000001"

            def interrupt_after_checkpoint_rename(*_args, **_kwargs):
                os.replace(checkpoint, published)
                raise KeyboardInterrupt("finalization interrupted after checkpoint rename")

            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    side_effect=interrupt_after_checkpoint_rename,
                ) as publish,
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "new"},
                ),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
                mock.patch.object(staging.sys, "stderr", io.StringIO()),
            ):
                with self.assertRaisesRegex(staging.StagingError, "finalization interrupted"):
                    installer.install(candidate, COMMIT)

            partials = list(target.parent.glob(".partial-robb-staging-*"))
            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "new")
            self.assertTrue(published.exists())
            self.assertEqual(publish.call_count, 1)
            self.assertEqual(len(partials), 1)
            self.assertEqual((partials[0] / staging.APP_NAME / "marker").read_text(), "old")

    def test_interrupt_after_confirmed_finalization_cannot_cleanup_old_copy_outside_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            publish_calls = 0

            class InterruptOnComparison:
                def __eq__(self, _other):
                    raise KeyboardInterrupt("interrupted after confirmed finalization")

            def publish(*_args, **_kwargs):
                nonlocal publish_calls
                publish_calls += 1
                if publish_calls == 1:
                    return checkpoint, True, None, None, InterruptOnComparison()
                return checkpoint, True, None, None, None

            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(
                    staging,
                    "validate_bundle",
                    side_effect=lambda _repo, app, **_kwargs: fingerprint(app),
                ),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(staging, "publish_checkpoint_best_effort", side_effect=publish),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "new"},
                ),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
                mock.patch.object(staging.sys, "stderr", io.StringIO()),
            ):
                with self.assertRaisesRegex(staging.StagingError, "confirmed finalization"):
                    installer.install(candidate, COMMIT)

            self.assertEqual(publish_calls, 2)
            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "new")
            partials = list(target.parent.glob(".partial-robb-staging-*"))
            self.assertEqual(len(partials), 1)
            self.assertEqual((partials[0] / staging.APP_NAME / "marker").read_text(), "old")

    def test_failed_launch_restores_old_app_and_preserves_failed_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            launches = [staging.StagingError("new runtime failed")]

            def launch(*_args, **_kwargs):
                outcome = launches.pop(0)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome

            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(staging, "launch_and_verify_runtime", side_effect=launch),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "intentionally left stopped"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            failed = list(target.parent.glob(".Robb Agents.app.failed-*"))
            self.assertEqual(len(failed), 1)
            self.assertEqual((failed[0] / "marker").read_text(encoding="utf-8"), "new")
            self.assertEqual(launches, [])

    def test_static_failure_after_swap_never_reopens_old_code_over_a_possibly_migrated_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))

            def validate(_repo, app, **_kwargs):
                identity = fingerprint(app)
                if app == target and (app / "marker").read_text(encoding="utf-8") == "new":
                    raise staging.StagingError("post-swap static validation failed after external open")
                return identity

            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=validate),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(staging, "launch_and_verify_runtime") as launch,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "intentionally left stopped"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            launch.assert_not_called()

    def test_final_dirty_checkout_rolls_back_and_leaves_old_app_stopped(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            checkout_results = [
                COMMIT,
                COMMIT,
                COMMIT,
                COMMIT,
                staging.StagingError("checkout became dirty"),
            ]

            with (
                mock.patch.object(staging, "verify_clean_checkout", side_effect=checkout_results),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "new"},
                ) as launch,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "intentionally left stopped"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            launch.assert_called_once()

    def test_reopen_before_exchange_aborts_without_swapping(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "assert_application_stopped",
                    side_effect=staging.StagingError("application reopened"),
                ),
                mock.patch.object(
                    staging,
                    "verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "old"},
                ) as verify_existing,
                mock.patch.object(staging, "launch_and_verify_runtime") as launch,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "application reopened"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            self.assertEqual(list(target.parent.glob(".Robb Agents.app.failed-*")), [])
            launch.assert_not_called()
            verify_existing.assert_called_once()

    def test_failure_after_confirmed_stop_before_exchange_relaunches_old_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            checkout_results = [
                COMMIT,
                COMMIT,
                COMMIT,
                staging.StagingError("checkout changed after stop"),
            ]
            with (
                mock.patch.object(
                    staging,
                    "verify_clean_checkout",
                    side_effect=checkout_results,
                ),
                mock.patch.object(
                    staging,
                    "validate_bundle",
                    side_effect=lambda _repo, app, **_kwargs: fingerprint(app),
                ),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 321, "startedAt": 654, "command": "old"},
                ) as launch,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "checkout changed after stop"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            launch.assert_called_once_with(
                target,
                installer.profile_root,
                timeout=installer.launch_timeout,
                runner=installer.runner,
            )

    def test_atomic_exchange_failure_keeps_original_target(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            installer.swapper = mock.Mock(side_effect=OSError("atomic swap denied"))
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 321, "startedAt": 654, "command": "old"},
                ) as launch,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "atomic swap denied"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            self.assertEqual(list(target.parent.glob(".partial-robb-staging-*")), [])
            launch.assert_called_once()

    def test_interrupt_after_rename_return_cannot_delete_the_old_app(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            working_swapper = installer.swapper
            swaps = 0

            def interrupt_after_first_swap(left, right):
                nonlocal swaps
                swaps += 1
                working_swapper(left, right)
                if swaps == 1:
                    raise KeyboardInterrupt()

            installer.swapper = interrupt_after_first_swap
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    return_value={"pid": 321, "startedAt": 654, "command": "old"},
                ) as launch,
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "previous app was restored"):
                    installer.install(candidate, COMMIT)

            self.assertEqual(swaps, 2)
            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            self.assertEqual(list(target.parent.glob(".partial-robb-staging-*")), [])
            launch.assert_not_called()

    def test_failed_automatic_rollback_preserves_the_old_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            working_swapper = installer.swapper
            swaps = 0

            def fail_second_swap(left, right):
                nonlocal swaps
                swaps += 1
                if swaps == 2:
                    raise OSError("rollback swap denied")
                working_swapper(left, right)

            installer.swapper = fail_second_swap
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ) as publish,
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(
                    staging,
                    "launch_and_verify_runtime",
                    side_effect=staging.StagingError("new runtime failed"),
                ),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
                mock.patch.object(staging.sys, "stderr", io.StringIO()),
            ):
                with self.assertRaisesRegex(staging.StagingError, "automatic rollback also failed"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "new")
            publish.assert_not_called()
            partials = list(target.parent.glob(".partial-robb-staging-*"))
            self.assertEqual(len(partials), 1)
            self.assertEqual((partials[0] / staging.APP_NAME / "marker").read_text(), "old")

    def test_keyboard_interrupt_after_swap_still_restores_the_old_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                mock.patch.object(staging, "backup_current_app", return_value=checkpoint),
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                mock.patch.object(staging, "quit_application"),
                mock.patch.object(staging, "launch_and_verify_runtime", side_effect=KeyboardInterrupt()),
                mock.patch.object(installer, "_stage_candidate", side_effect=stage_candidate),
            ):
                with self.assertRaisesRegex(staging.StagingError, "previous app was restored"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")

    def test_failed_destination_copy_is_cleaned_without_touching_target(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, _checkpoint, _stage_candidate = self.make_transaction(Path(temp))

            def runner(args, **_kwargs):
                if args[0] == "/usr/bin/ditto":
                    shutil.copytree(Path(args[1]), Path(args[2]))
                    return completed()
                raise AssertionError(args)

            installer.runner = runner
            with mock.patch.object(staging, "validate_bundle", side_effect=staging.StagingError("invalid staged copy")):
                with self.assertRaisesRegex(staging.StagingError, "invalid staged copy"):
                    installer._stage_candidate(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            self.assertEqual(list(target.parent.glob(".partial-robb-staging-*")), [])

    def test_selected_rollback_checkpoint_is_hidden_then_republished_as_newest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "backups"
            checkpoint = root / "20260901-old"
            (checkpoint / staging.APP_NAME).mkdir(parents=True)
            (checkpoint / staging.APP_NAME / "marker").write_text("old", encoding="utf-8")
            (checkpoint / "backup.json").write_text(
                json.dumps({
                    "version": 1,
                    "createdAt": "2026-09-01T00:00:00+00:00",
                    "source": "/Applications/Robb Agents.app",
                }),
                encoding="utf-8",
            )
            held = staging.protect_rollback_checkpoint(checkpoint, root, timeout=0.1)
            self.assertFalse(checkpoint.exists())
            self.assertTrue(held.name.startswith(".rollback-held-"))
            published = staging.republish_rollback_checkpoint(
                held,
                root,
                original=checkpoint,
                timeout=0.1,
                validated_fingerprint=fingerprint(held / staging.APP_NAME),
            )
            self.assertTrue((published / staging.APP_NAME).is_dir())
            self.assertFalse(held.exists())
            manifest = json.loads((published / "backup.json").read_text(encoding="utf-8"))
            self.assertEqual(Path(manifest["refreshedFrom"]).name, checkpoint.name)
            self.assertEqual(manifest["version"], 2)
            self.assertEqual(
                manifest["validation"]["contract"],
                staging.STRONG_VALIDATION_CONTRACT,
            )

    def test_rollback_checkpoint_is_hidden_while_strong_validation_runs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "backups"
            checkpoint = root / "20260901-old"
            app = checkpoint / staging.APP_NAME
            app.mkdir(parents=True)
            (app / "marker").write_text("old", encoding="utf-8")
            (checkpoint / "backup.json").write_text(
                json.dumps({
                    "version": 1,
                    "createdAt": "2026-09-01T00:00:00+00:00",
                    "source": "/Applications/Robb Agents.app",
                }),
                encoding="utf-8",
            )

            def validate(_repo, held_app, **_kwargs):
                self.assertFalse(checkpoint.exists())
                self.assertTrue(held_app.parent.name.startswith(".rollback-held-"))
                with self.assertRaisesRegex(staging.StagingError, "holds"):
                    with staging.exclusive_file_lock(
                        staging.retention_lock_file(root),
                        timeout=0,
                    ):
                        self.fail("validation must retain the exclusion lock")
                return fingerprint(held_app)

            with mock.patch.object(staging, "validate_bundle", side_effect=validate):
                held, selected = staging.protect_and_validate_rollback_checkpoint(
                    Path(temp) / "repo",
                    checkpoint,
                    root,
                    expected_commit=COMMIT,
                    timeout=0.1,
                    runner=lambda *_args, **_kwargs: completed(),
                )
            self.assertTrue(held.exists())
            self.assertEqual(selected, fingerprint(held / staging.APP_NAME))

    def test_failed_rollback_validation_leaves_the_checkpoint_hidden(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "backups"
            checkpoint = root / "20260901-old"
            (checkpoint / staging.APP_NAME).mkdir(parents=True)
            with mock.patch.object(
                staging,
                "validate_bundle",
                side_effect=staging.StagingError("invalid fuses"),
            ):
                with self.assertRaisesRegex(staging.StagingError, "remains protected"):
                    staging.protect_and_validate_rollback_checkpoint(
                        Path(temp) / "repo",
                        checkpoint,
                        root,
                        expected_commit=COMMIT,
                        timeout=0.1,
                        runner=lambda *_args, **_kwargs: completed(),
                    )
            self.assertFalse(checkpoint.exists())
            held = list(root.glob(".rollback-held-*"))
            self.assertEqual(len(held), 1)

    def test_rollback_checkpoint_without_managed_source_is_hidden_and_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "backups"
            checkpoint = root / "20260901-old"
            app = checkpoint / staging.APP_NAME
            app.mkdir(parents=True)
            (app / "marker").write_text("old", encoding="utf-8")
            with mock.patch.object(staging, "validate_bundle", return_value=fingerprint(app)):
                with self.assertRaisesRegex(staging.StagingError, "manifest is missing or invalid"):
                    staging.protect_and_validate_rollback_checkpoint(
                        Path(temp) / "repo",
                        checkpoint,
                        root,
                        expected_commit=COMMIT,
                        timeout=0.1,
                        runner=lambda *_args, **_kwargs: completed(),
                    )
            self.assertFalse(checkpoint.exists())
            self.assertEqual(len(list(root.glob(".rollback-held-*"))), 1)

    def test_checkpoint_lock_covers_validation_and_transaction_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "backups"
            held = root / ".rollback-held-backup-fixture"
            app = held / staging.APP_NAME
            app.mkdir(parents=True)
            (app / "marker").write_text("old", encoding="utf-8")
            (held / "backup.json").write_text(
                json.dumps({
                    "version": 1,
                    "createdAt": "2026-09-01T00:00:00+00:00",
                    "source": "/Applications/Robb Agents.app",
                }),
                encoding="utf-8",
            )
            partial = base / "Applications/.partial-robb-staging-fixture"
            (partial / staging.APP_NAME).mkdir(parents=True)
            (partial / staging.APP_NAME / "marker").write_text("old", encoding="utf-8")
            expected = fingerprint(app)
            real_cleanup = staging.cleanup_partial_best_effort

            def cleanup_while_locked(path, parent):
                with self.assertRaisesRegex(staging.StagingError, "holds"):
                    with staging.exclusive_file_lock(
                        staging.retention_lock_file(root),
                        timeout=0,
                    ):
                        self.fail("cleanup must retain the exclusion lock")
                return real_cleanup(path, parent)

            with (
                mock.patch.object(staging, "validate_bundle", return_value=expected),
                mock.patch.object(staging, "cleanup_partial_best_effort", side_effect=cleanup_while_locked),
                mock.patch.object(
                    staging,
                    "prune_backups",
                    side_effect=lambda *_args, **_kwargs: {
                        "apply": True,
                        "kept": [
                            path.name
                            for path in root.iterdir()
                            if staging.CHECKPOINT_NAME_RE.fullmatch(path.name)
                        ],
                    },
                ),
            ):
                path, confirmed, warning, cleanup_warning, partial_state = staging.publish_checkpoint_best_effort(
                    base / "repo",
                    held,
                    root,
                    timeout=0.1,
                    runner=lambda *_args, **_kwargs: completed(),
                    reason="test",
                    expected_fingerprint=expected,
                    qualified_helper=base / "qualified-retention.py",
                    expected_commit=COMMIT,
                    expected_helper_sha256="0" * 64,
                    installed_script=base / "installed-retention.py",
                    transaction_partial=partial,
                )
            self.assertTrue(path.exists())
            self.assertTrue(confirmed)
            self.assertIsNone(warning)
            self.assertIsNone(cleanup_warning)
            self.assertEqual(partial_state, "absent")
            self.assertFalse(partial.exists())

    def test_prune_receipt_must_keep_checkpoint_before_old_copy_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "backups"
            held = root / ".rollback-held-backup-fixture"
            app = held / staging.APP_NAME
            app.mkdir(parents=True)
            (app / "marker").write_text("old", encoding="utf-8")
            (held / "backup.json").write_text(
                json.dumps({
                    "version": 1,
                    "createdAt": "2026-09-01T00:00:00+00:00",
                    "source": "/Applications/Robb Agents.app",
                }),
                encoding="utf-8",
            )
            partial = base / "Applications/.partial-robb-staging-fixture"
            (partial / staging.APP_NAME).mkdir(parents=True)
            (partial / staging.APP_NAME / "marker").write_text("old", encoding="utf-8")
            expected = fingerprint(app)

            with (
                mock.patch.object(staging, "validate_bundle", return_value=expected),
                mock.patch.object(
                    staging,
                    "prune_backups",
                    return_value={"apply": True, "kept": []},
                ),
                mock.patch.object(staging, "cleanup_partial_best_effort") as cleanup,
            ):
                path, confirmed, warning, cleanup_warning, partial_state = (
                    staging.publish_checkpoint_best_effort(
                        base / "repo",
                        held,
                        root,
                        timeout=0.1,
                        runner=lambda *_args, **_kwargs: completed(),
                        reason="test",
                        expected_fingerprint=expected,
                        qualified_helper=base / "qualified-retention.py",
                        expected_commit=COMMIT,
                        expected_helper_sha256="0" * 64,
                        installed_script=base / "installed-retention.py",
                        transaction_partial=partial,
                    )
                )

            self.assertTrue(path.exists())
            self.assertFalse(confirmed)
            self.assertIn("did not keep", warning)
            self.assertIsNone(cleanup_warning)
            self.assertEqual(partial_state, "present-unverified")
            self.assertTrue(partial.exists())
            cleanup.assert_not_called()

    def test_checkpoint_finalization_recovers_path_after_interrupt_post_rename(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            held = base / "backups/.rollback-held-backup-fixture"
            (held / staging.APP_NAME).mkdir(parents=True)
            (held / staging.APP_NAME / "marker").write_text("old", encoding="utf-8")
            (held / "backup.json").write_text(
                json.dumps({
                    "version": 1,
                    "createdAt": "2026-09-01T00:00:00+00:00",
                    "source": "/Applications/Robb Agents.app",
                }),
                encoding="utf-8",
            )
            expected = fingerprint(held / staging.APP_NAME)
            real_republish = staging.republish_rollback_checkpoint_locked

            def interrupt_after_rename(*args, **kwargs):
                real_republish(*args, **kwargs)
                raise KeyboardInterrupt("fixture interrupt after rename")

            with (
                mock.patch.object(staging, "validate_bundle", return_value=expected),
                mock.patch.object(
                    staging,
                    "republish_rollback_checkpoint_locked",
                    side_effect=interrupt_after_rename,
                ),
                mock.patch.object(
                    staging,
                    "prune_backups",
                    side_effect=lambda *_args, **_kwargs: {
                        "apply": True,
                        "kept": [
                            path.name
                            for path in held.parent.iterdir()
                            if staging.CHECKPOINT_NAME_RE.fullmatch(path.name)
                        ],
                    },
                ),
            ):
                path, confirmed, warning, cleanup_warning, partial_state = staging.publish_checkpoint_best_effort(
                    base / "repo",
                    held,
                    held.parent,
                    timeout=0.1,
                    runner=lambda *_args, **_kwargs: completed(),
                    reason="test",
                    expected_fingerprint=expected,
                    qualified_helper=base / "qualified-retention.py",
                    expected_commit=COMMIT,
                    expected_helper_sha256="0" * 64,
                    installed_script=base / "installed-retention.py",
                )
            self.assertNotEqual(path, held)
            self.assertTrue(path.exists())
            self.assertFalse(held.exists())
            self.assertTrue(confirmed)
            self.assertIn("fixture interrupt after rename", warning)
            self.assertIsNone(cleanup_warning)
            self.assertIsNone(partial_state)

    def test_checkpoint_without_managed_manifest_is_never_confirmed_or_pruned(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            held = base / "backups/.rollback-held-missing-manifest"
            app = held / staging.APP_NAME
            app.mkdir(parents=True)
            (app / "marker").write_text("old", encoding="utf-8")
            expected = fingerprint(app)
            with (
                mock.patch.object(staging, "validate_bundle", return_value=expected),
                mock.patch.object(staging, "prune_backups") as prune,
            ):
                path, confirmed, warning, _, _ = staging.publish_checkpoint_best_effort(
                    base / "repo",
                    held,
                    held.parent,
                    timeout=0.1,
                    runner=lambda *_args, **_kwargs: completed(),
                    reason="test",
                    expected_fingerprint=expected,
                    qualified_helper=base / "qualified-retention.py",
                    expected_commit=COMMIT,
                    expected_helper_sha256="0" * 64,
                    installed_script=base / "installed-retention.py",
                )
            self.assertEqual(path, held.resolve())
            self.assertTrue(path.exists())
            self.assertFalse(confirmed)
            self.assertIn("outside the prunable managed inventory", warning)
            prune.assert_not_called()

    def test_rollback_separates_clean_checkout_and_checkpoint_commits(self):
        old_commit = "b" * 40
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            installer, _target, _candidate, checkpoint, _stage_candidate = self.make_transaction(base)
            held = installer.backup_root / ".rollback-held-fixture"
            retained = installer.backup_root / "20260911-refreshed"
            (held / staging.APP_NAME).mkdir(parents=True)
            (retained / staging.APP_NAME).mkdir(parents=True)
            selected = fingerprint(checkpoint / staging.APP_NAME)
            retention_hash = staging.sha256_file(installer.repo / "scripts/staging-retention.py")
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(
                    staging,
                    "protect_and_validate_rollback_checkpoint",
                    return_value=(held, selected),
                ) as protect,
                mock.patch.object(
                    installer,
                    "_install_locked",
                    return_value={
                        "status": "installed",
                        "retentionHelperSha256": retention_hash,
                    },
                ) as install,
                mock.patch.object(
                    staging,
                    "publish_checkpoint_best_effort",
                    return_value=(retained, True, None, None, None),
                ),
            ):
                result = installer.rollback(
                    checkpoint,
                    COMMIT,
                    old_commit,
                    profile_compatible=True,
                )

            self.assertEqual(result["status"], "rolled-back")
            self.assertEqual(result["restoredCheckpoint"], str(retained))
            install.assert_called_once_with(
                held / staging.APP_NAME,
                COMMIT,
                old_commit,
                require_candidate_adhoc=False,
            )
            self.assertEqual(protect.call_args.kwargs["expected_commit"], old_commit)

    def test_verify_accepts_artifact_commit_distinct_from_clean_checkout(self):
        old_commit = "b" * 40
        with tempfile.TemporaryDirectory() as temp:
            installer, _target, _candidate, _checkpoint, _stage_candidate = self.make_transaction(Path(temp))
            with (
                mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT),
                mock.patch.object(staging, "validate_bundle", return_value={}) as validate,
                mock.patch.object(
                    staging,
                    "verify_runtime",
                    return_value={"pid": 1, "startedAt": 2, "command": "target"},
                ),
            ):
                result = installer.verify(COMMIT, old_commit)
            self.assertEqual(result["checkoutCommit"], COMMIT)
            self.assertEqual(result["artifactCommit"], old_commit)
            self.assertEqual(validate.call_args.kwargs["expected_commit"], old_commit)

    def test_rollback_requires_profile_compatibility_confirmation(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, _target, _candidate, checkpoint, _stage_candidate = self.make_transaction(Path(temp))
            with self.assertRaisesRegex(staging.StagingError, "compatibility confirmation"):
                installer.rollback(checkpoint, COMMIT, "b" * 40, profile_compatible=False)

    def test_rollback_checkpoint_must_be_a_direct_managed_child(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            installer = staging.LocalStagingInstaller(
                repo=base / "repo",
                target_app=base / "Applications" / staging.APP_NAME,
                profile_root=base / "profile",
                backup_root=base / "backups",
            )
            outside = base / "outside"
            with mock.patch.object(staging, "verify_clean_checkout", return_value=COMMIT):
                with self.assertRaisesRegex(staging.StagingError, "direct child"):
                    installer.rollback(
                        outside,
                        COMMIT,
                        "b" * 40,
                        profile_compatible=True,
                    )


if __name__ == "__main__":
    unittest.main()
