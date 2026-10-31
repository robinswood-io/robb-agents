import functools
import json
import tempfile
from collections.abc import Mapping
from pathlib import Path
from unittest import mock

from .robb_local_staging_fixtures import (
    COMMIT,
    LocalStagingTestCase,
    checkpoint_listing,
    completed_command,
    fingerprint,
    patch_staging,
    staging,
)


class LocalStagingCheckpointsTests(LocalStagingTestCase):
    def test_checkpoint_finalization_recovers_path_after_interrupt_post_rename(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            held = base / "backups/.rollback-held-backup-fixture"
            (held / staging.APP_NAME).mkdir(parents=True)
            _ = (held / staging.APP_NAME / "marker").write_text("old", encoding="utf-8")
            _ = (held / "backup.json").write_text(
                json.dumps({
                    "version": 1,
                    "createdAt": "2026-09-01T00:00:00+00:00",
                    "source": "/Applications/Robb Agents.app",
                }),
                encoding="utf-8",
            )
            expected = fingerprint(held / staging.APP_NAME)
            real_republish = staging.republish_rollback_checkpoint_locked

            def interrupt_after_rename(held: Path, backup_root: Path, *, original: Path,
                                       validated_fingerprint: Mapping[str, str], reason: str = "explicit-rollback") -> None:
                _ = real_republish(held, backup_root, original=original,
                                   validated_fingerprint=validated_fingerprint, reason=reason)
                raise KeyboardInterrupt("fixture interrupt after rename")

            with (
                patch_staging("validate_bundle", return_value=expected),
                patch_staging("republish_rollback_checkpoint_locked",
                    side_effect=interrupt_after_rename,
                ),
                patch_staging("prune_backups",
                    side_effect=functools.partial(checkpoint_listing, held.parent),
                ),
            ):
                path, confirmed, warning, cleanup_warning, partial_state = staging.publish_checkpoint_best_effort(
                    base / "repo",
                    held,
                    held.parent,
                    timeout=0.1,
                    runner=completed_command,
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
            assert isinstance(warning, str)
            self.assertIn("fixture interrupt after rename", warning)
            self.assertIsNone(cleanup_warning)
            self.assertIsNone(partial_state)

    def test_checkpoint_without_managed_manifest_is_never_confirmed_or_pruned(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            held = base / "backups/.rollback-held-missing-manifest"
            app = held / staging.APP_NAME
            app.mkdir(parents=True)
            _ = (app / "marker").write_text("old", encoding="utf-8")
            expected = fingerprint(app)
            with (
                patch_staging("validate_bundle", return_value=expected),
                patch_staging("prune_backups") as prune,
            ):
                path, confirmed, warning, _, _ = staging.publish_checkpoint_best_effort(
                    base / "repo",
                    held,
                    held.parent,
                    timeout=0.1,
                    runner=completed_command,
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
            assert isinstance(warning, str)
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
            retention_hash = staging.sha256_file(installer.repo / "scripts/staging_retention.py")
            with (
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("protect_and_validate_rollback_checkpoint",
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
                patch_staging("publish_checkpoint_best_effort",
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
                require_candidate_developer_id=False,
            )
            self.assertEqual(protect.call_args.kwargs["expected_commit"], old_commit)

    def test_verify_accepts_artifact_commit_distinct_from_clean_checkout(self):
        old_commit = "b" * 40
        with tempfile.TemporaryDirectory() as temp:
            installer, _target, _candidate, _checkpoint, _stage_candidate = self.make_transaction(Path(temp))
            with (
                patch_staging("verify_clean_checkout", return_value=COMMIT),
                patch_staging("validate_bundle", return_value={}) as validate,
                patch_staging("verify_runtime",
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
                _ = installer.rollback(checkpoint, COMMIT, "b" * 40, profile_compatible=False)

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
            with (
                patch_staging('verify_clean_checkout', return_value=COMMIT),
                self.assertRaisesRegex(staging.StagingError, 'direct child'),
            ):
                _ = installer.rollback(
                    outside,
                    COMMIT,
                    "b" * 40,
                    profile_compatible=True,
                )
