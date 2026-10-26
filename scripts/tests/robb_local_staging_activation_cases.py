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


class LocalStagingActivationTests(LocalStagingTestCase):
    def test_backup_mismatch_aborts_before_quit_or_swap(self):
        with tempfile.TemporaryDirectory() as temp:
            installer, target, candidate, checkpoint, stage_candidate = self.make_transaction(Path(temp))
            (checkpoint / staging.APP_NAME / "marker").write_text("different", encoding="utf-8")
            with (
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ) as publish,
                patch_staging("quit_application") as stop,
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(
                        checkpoint,
                        True,
                        None,
                        "Transaction directory remains: fixture cleanup denied",
                        "validated",
                    ),
                ) as publish,
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, False, "checkpoint lost", None, "validated"),
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    side_effect=cleanup_then_lose_confirmation,
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    side_effect=leave_incomplete_evidence,
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    side_effect=interrupt_after_checkpoint_rename,
                ) as publish,
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle",
                    side_effect=lambda _repo, app, **_kwargs: fingerprint(app),
                ),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort", side_effect=publish),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime", side_effect=launch),
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=validate),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime") as launch,
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
                patch_staging("verify_clean_checkout", side_effect=checkout_results),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                patch_staging("quit_application"),
                patch_staging("launch_and_verify_runtime",
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
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", side_effect=lambda _repo, app, **_kwargs: fingerprint(app)),
                patch_staging("backup_current_app", return_value=checkpoint),
                patch_staging("publish_checkpoint_best_effort",
                    return_value=(checkpoint, True, None, None, None),
                ),
                patch_staging("quit_application"),
                patch_staging("assert_application_stopped",
                    side_effect=staging.StagingError("application reopened"),
                ),
                patch_staging("verify_runtime",
                    return_value={"pid": 123, "startedAt": 456, "command": "old"},
                ) as verify_existing,
                patch_staging("launch_and_verify_runtime") as launch,
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
                patch_staging("verify_clean_checkout",
                    side_effect=checkout_results,
                ),
                patch_staging("validate_bundle",
                    side_effect=lambda _repo, app, **_kwargs: fingerprint(app),
                ),
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
                with self.assertRaisesRegex(staging.StagingError, "checkout changed after stop"):
                    installer.install(candidate, COMMIT)

            self.assertEqual((target / "marker").read_text(encoding="utf-8"), "old")
            launch.assert_called_once_with(
                target,
                installer.profile_root,
                timeout=installer.launch_timeout,
                runner=installer.runner,
            )
