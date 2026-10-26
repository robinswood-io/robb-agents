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


class LocalStagingRecoveryTests(LocalStagingTestCase):
    def test_atomic_exchange_failure_keeps_original_target(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            installer.swapper = mock.Mock(side_effect=OSError("atomic swap denied"))
            with (
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ) as publish,
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime", side_effect=KeyboardInterrupt()),
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
            with patch_staging("validate_bundle", side_effect=staging.StagingError("invalid staged copy")):
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

            with patch_staging("validate_bundle", side_effect=validate):
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
            with patch_staging("validate_bundle",
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
            with patch_staging("validate_bundle", return_value=fingerprint(app)):
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
                patch_staging("validate_bundle", return_value=expected),
                patch_staging("cleanup_partial_best_effort", side_effect=cleanup_while_locked),
                patch_staging("prune_backups",
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
                patch_staging("validate_bundle", return_value=expected),
                patch_staging("prune_backups",
                    return_value={"apply": True, "kept": []},
                ),
                patch_staging("cleanup_partial_best_effort") as cleanup,
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
