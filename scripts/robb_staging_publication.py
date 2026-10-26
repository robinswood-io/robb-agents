from __future__ import annotations

from pathlib import Path
from typing import Callable, Iterator, Mapping, Sequence

from robb_staging_common import (
    APP_NAME,
    Runner,
    resolve_managed_backup_root,
    exclusive_file_lock,
    cleanup_partial_best_effort,
)
from robb_staging_bundles import (
    validate_bundle,
    assert_same_bundle_copy,
)
from robb_staging_checkpoints import (
    retention_lock_file,
    is_confirmed_managed_checkpoint,
    republish_rollback_checkpoint_locked,
    prune_backups,
    checkpoint_directory_identity,
    find_checkpoint_by_identity,
)

def publish_checkpoint_best_effort(
    repo: Path,
    checkpoint: Path,
    backup_root: Path,
    *,
    timeout: float,
    runner: Runner,
    reason: str,
    expected_fingerprint: Mapping[str, str],
    qualified_helper: Path,
    expected_commit: str,
    expected_helper_sha256: str,
    installed_script: Path,
    transaction_partial: Path | None = None,
) -> tuple[Path, bool, str | None, str | None, str | None]:
    """Finalize safely, keeping a checkpoint protected until old-copy cleanup."""
    root = resolve_managed_backup_root(backup_root)
    operation_error: BaseException | None = None
    cleanup_warning: str | None = None
    partial_state = (
        "present-unverified" if transaction_partial is not None and transaction_partial.exists()
        else "absent" if transaction_partial is not None
        else None
    )
    surviving = checkpoint
    with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
        try:
            identity = checkpoint_directory_identity(checkpoint)
        except BaseException as error:
            return checkpoint, False, f"Checkpoint is missing before finalization: {error}", None, partial_state

        # Revalidate while retention is excluded. When this is an install
        # transaction the checkpoint is still hidden and therefore non-prunable.
        try:
            protected_fingerprint = validate_bundle(
                repo,
                checkpoint / APP_NAME,
                expected_commit=None,
                runner=runner,
            )
            assert_same_bundle_copy(
                expected_fingerprint,
                protected_fingerprint,
                description="Protected managed rollback checkpoint",
            )
        except BaseException as error:
            return checkpoint, False, f"Checkpoint at {checkpoint} could not be revalidated: {error}", None, partial_state

        try:
            if checkpoint.name.startswith(".rollback-held-"):
                republish_rollback_checkpoint_locked(
                    checkpoint,
                    root,
                    original=checkpoint,
                    validated_fingerprint=protected_fingerprint,
                    reason=reason,
                )
        except BaseException as error:
            operation_error = error

        # os.replace may have committed even when the call raised/interrupted.
        # Recover the directory by immutable filesystem identity, not stale path.
        try:
            recovered = find_checkpoint_by_identity(root, identity)
        except BaseException as error:
            detail = operation_error or error
            return checkpoint, False, f"Cannot recover checkpoint identity after finalization: {detail}", cleanup_warning, partial_state
        if recovered is None:
            detail = f" after {operation_error}" if operation_error else ""
            return checkpoint, False, f"Checkpoint disappeared during retention finalization{detail}", cleanup_warning, partial_state
        surviving = recovered
        try:
            surviving_fingerprint = validate_bundle(
                repo,
                surviving / APP_NAME,
                expected_commit=None,
                runner=runner,
            )
            assert_same_bundle_copy(
                expected_fingerprint,
                surviving_fingerprint,
                description="Finalized managed rollback checkpoint",
            )
        except BaseException as error:
            return surviving, False, f"Checkpoint at {surviving} could not be revalidated: {error}", cleanup_warning, partial_state
        if not is_confirmed_managed_checkpoint(surviving, surviving_fingerprint):
            detail = f" after {operation_error}" if operation_error else ""
            return (
                surviving,
                False,
                f"Checkpoint remains outside the prunable managed inventory{detail}: {surviving}",
                cleanup_warning,
                partial_state,
            )

    warnings: list[str] = []
    if operation_error is not None:
        warnings.append(
            f"Checkpoint recovered at {surviving} after retention finalization error: {operation_error}"
        )
    prune_result: dict[str, object] | None = None
    try:
        prune_result = prune_backups(
            repo,
            root,
            qualified_helper=qualified_helper,
            expected_commit=expected_commit,
            expected_helper_sha256=expected_helper_sha256,
            installed_script=installed_script,
            runner=runner,
        )
    except BaseException as error:
        warnings.append(f"Checkpoint is valid but retention pruning failed: {error}")

    # Reacquire the common lock after pruning and prove that this exact inode is
    # still a managed checkpoint. Keep the immediate old-app copy until this
    # post-prune proof succeeds; a divergent/concurrent prune can therefore
    # never make both recovery paths disappear.
    try:
        with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
            recovered = find_checkpoint_by_identity(root, identity)
            if recovered is None:
                return (
                    surviving,
                    False,
                    "; ".join(warnings + ["Checkpoint disappeared during post-prune confirmation"]),
                    cleanup_warning,
                    partial_state,
                )
            surviving = recovered
            post_prune_fingerprint = validate_bundle(
                repo,
                surviving / APP_NAME,
                expected_commit=None,
                runner=runner,
            )
            assert_same_bundle_copy(
                expected_fingerprint,
                post_prune_fingerprint,
                description="Post-prune managed rollback checkpoint",
            )
            if not is_confirmed_managed_checkpoint(surviving, post_prune_fingerprint):
                return (
                    surviving,
                    False,
                    "; ".join(warnings + [f"Checkpoint is no longer managed after pruning: {surviving}"]),
                    cleanup_warning,
                    partial_state,
                )
            if prune_result is not None:
                kept = prune_result.get("kept")
                if not isinstance(kept, list) or surviving.name not in kept:
                    return (
                        surviving,
                        False,
                        "; ".join(warnings + [
                            f"Retention receipt did not keep the finalized checkpoint: {surviving}"
                        ]),
                        cleanup_warning,
                        partial_state,
                    )

            # Only now abandon the transaction copy, while the exact surviving
            # checkpoint is protected by the same lock as the LaunchAgent.
            if transaction_partial is not None:
                cleanup_warning = cleanup_partial_best_effort(
                    transaction_partial,
                    transaction_partial.parent,
                )
                if not transaction_partial.exists():
                    partial_state = "absent"
                else:
                    try:
                        remaining_fingerprint = validate_bundle(
                            repo,
                            transaction_partial / APP_NAME,
                            expected_commit=None,
                            runner=runner,
                        )
                        assert_same_bundle_copy(
                            expected_fingerprint,
                            remaining_fingerprint,
                            description="Remaining transaction rollback copy",
                        )
                        partial_state = "validated"
                    except BaseException as error:
                        partial_state = "present-unverified"
                        detail = f"remaining transaction copy is incomplete or unverified: {error}"
                        cleanup_warning = (
                            f"{cleanup_warning}; {detail}" if cleanup_warning else detail
                        )
    except BaseException as error:
        return (
            surviving,
            False,
            "; ".join(warnings + [f"Post-prune checkpoint confirmation failed: {error}"]),
            cleanup_warning,
            partial_state,
        )
    return surviving, True, "; ".join(warnings) or None, cleanup_warning, partial_state
