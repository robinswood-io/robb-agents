from __future__ import annotations

import datetime as dt
from pathlib import Path
import sys

from robb_staging_common import (
    APP_NAME,
    StagingError,
    verify_clean_checkout,
    cleanup_partial_best_effort,
)
from robb_staging_bundles import (
    create_qualified_retention_helper,
    cleanup_qualified_retention_helper,
    validate_bundle,
    assert_same_bundle_copy,
    bundle_fingerprint_mismatches,
    backup_current_app,
)
from robb_staging_publication import (
    publish_checkpoint_best_effort,
)
from robb_staging_runtime import (
    assert_application_stopped,
    quit_application,
    verify_runtime,
    launch_and_verify_runtime,
    rollback_exchange,
)

def install_locked(
    self,
    candidate_app: Path,
    expected_commit: str,
    artifact_commit: str,
    *,
    require_candidate_developer_id: bool,
) -> dict[str, object]:
    preflight = self.preflight(
        candidate_app,
        expected_commit,
        artifact_commit,
        require_candidate_developer_id=require_candidate_developer_id,
    )
    checkout_commit = str(preflight["checkoutCommit"])
    bundle_commit = str(preflight["artifactCommit"])
    candidate_fingerprint = preflight["candidateIdentity"]
    current_fingerprint = preflight["currentIdentity"]
    if not isinstance(candidate_fingerprint, dict) or not isinstance(current_fingerprint, dict):
        raise StagingError("Internal preflight did not return bundle fingerprints")
    retention_helper_sha256 = str(preflight["retentionHelperSha256"])
    qualified_snapshot_root, qualified_helper = create_qualified_retention_helper(
        self.repo,
        expected_commit=checkout_commit,
        expected_helper_sha256=retention_helper_sha256,
        installed_script=self.installed_retention_script,
        runner=self.runner,
    )
    partial_root: Path | None = None
    partial_cleanup_authorized = False
    partial_requires_locked_cleanup = False
    previous: Path | None = None
    exchange_attempted = False
    exchange_uncertain = False
    swapped = False
    candidate_launch_attempted = False
    current_stop_attempted = False
    checkpoint: Path | None = None
    backup_fingerprint: dict[str, str] | None = None
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    failed = self.target_app.parent / f".Robb Agents.app.failed-{stamp}"
    try:
        # Stage on the destination volume before stopping the application.
        partial_root, staged_app, staged_fingerprint = self._stage_candidate(
            candidate_app,
            bundle_commit,
        )
        assert_same_bundle_copy(
            candidate_fingerprint,
            staged_fingerprint,
            description="Destination-volume staged candidate",
        )

        # The retention helper validates the source/copy signatures and prunes
        # only after publishing the new checkpoint. Validate the checkpoint
        # with the stronger ASAR/fuse/runtime contract as well.
        checkpoint = backup_current_app(
            self.repo,
            self.backup_root,
            qualified_helper=qualified_helper,
            expected_commit=checkout_commit,
            expected_helper_sha256=retention_helper_sha256,
            installed_script=self.installed_retention_script,
            runner=self.runner,
        )
        backup_fingerprint = validate_bundle(
            self.repo,
            checkpoint / APP_NAME,
            expected_commit=None,
            runner=self.runner,
        )
        assert_same_bundle_copy(
            current_fingerprint,
            backup_fingerprint,
            description="Managed rollback checkpoint",
        )
        partial_cleanup_authorized = True

        # Close the race between the first preflight and the actual swap.
        verify_clean_checkout(self.repo, checkout_commit, self.runner)

        current_stop_attempted = True
        quit_application(
            self.target_app,
            self.lock_file,
            timeout=self.quit_timeout,
            runner=self.runner,
        )
        stopped_current_fingerprint = validate_bundle(
            self.repo,
            self.target_app,
            expected_commit=None,
            runner=self.runner,
        )
        assert_same_bundle_copy(
            current_fingerprint,
            stopped_current_fingerprint,
            description="Stopped installed application",
        )
        verify_clean_checkout(self.repo, checkout_commit, self.runner)
        try:
            assert_application_stopped(self.target_app, self.lock_file, self.runner)
        except BaseException:
            # The old runtime has already reopened itself; never launch a
            # second copy from the recovery path.
            raise

        # Both paths are on /Applications' volume. renamex_np(RENAME_SWAP)
        # guarantees that a crash cannot expose a missing target path.
        previous = staged_app
        if failed.exists():
            raise StagingError("A transaction path already exists; refusing to overwrite it")
        # From this point the partial may contain the only immediate copy
        # of the old app. Cleanup needs a fresh checkpoint confirmation.
        partial_cleanup_authorized = False
        partial_requires_locked_cleanup = True
        exchange_attempted = True
        # renamex_np can commit before Python observes its return (or an
        # interrupt). From the instant the syscall starts, conservatively
        # assume the candidate may become externally launchable at the
        # production path; no later error may auto-open old code.
        candidate_launch_attempted = True
        self.swapper(self.target_app, previous)
        swapped = True

        installed_identity = validate_bundle(
            self.repo,
            self.target_app,
            expected_commit=bundle_commit,
            runner=self.runner,
        )
        assert_same_bundle_copy(
            candidate_fingerprint,
            installed_identity,
            description="Installed candidate",
        )
        runtime = launch_and_verify_runtime(
            self.target_app,
            self.profile_root,
            timeout=self.launch_timeout,
            runner=self.runner,
        )
        # This is the transaction commit point. A concurrent source edit
        # before it causes an automatic bundle rollback.
        verify_clean_checkout(self.repo, checkout_commit, self.runner)
        swapped = False
        previous = None

        if checkpoint is None:
            raise StagingError("Internal error: verified backup checkpoint is missing")
        (
            checkpoint,
            checkpoint_confirmed,
            retention_warning,
            transaction_cleanup_warning,
            transaction_partial_state,
        ) = publish_checkpoint_best_effort(
            self.repo,
            checkpoint,
            self.backup_root,
            timeout=self.retention_lock_timeout,
            runner=self.runner,
            reason="installed-previous-app",
            expected_fingerprint=backup_fingerprint,
            qualified_helper=qualified_helper,
            expected_commit=checkout_commit,
            expected_helper_sha256=retention_helper_sha256,
            installed_script=self.installed_retention_script,
            transaction_partial=partial_root,
        )

        transaction_partial_preserved = transaction_partial_state == "validated"
        transaction_partial_exists = transaction_partial_state in (
            "validated",
            "present-unverified",
        )
        if not checkpoint_confirmed:
            if transaction_partial_preserved:
                transaction_cleanup_warning = (
                    f"Immediate previous app remains fully validated at {partial_root}: no existing, fully validated "
                    f"managed checkpoint was confirmed. {retention_warning or transaction_cleanup_warning or ''}"
                ).strip()
            elif transaction_partial_exists:
                transaction_cleanup_warning = (
                    f"Transaction evidence remains at {partial_root}, but it is not a verified complete "
                    f"copy of the previous app. {retention_warning or transaction_cleanup_warning or ''}"
                ).strip()
            else:
                transaction_cleanup_warning = (
                    "The transaction copy was removed while the validated checkpoint was still protected, "
                    f"but its final path could not be confirmed; inspect {checkpoint}. "
                    f"{retention_warning or transaction_cleanup_warning or ''}"
                ).strip()
        elif transaction_cleanup_warning is None and transaction_partial_exists:
            transaction_cleanup_warning = (
                f"Transaction directory remains at {partial_root}: cleanup completion was not confirmed"
            )
        transaction_partial_path = partial_root
        partial_root = None
        return {
            "status": "installed",
            **preflight,
            "installedIdentity": installed_identity,
            "backupCheckpoint": str(checkpoint) if checkpoint_confirmed else None,
            "backupCheckpointConfirmed": checkpoint_confirmed,
            "backupCheckpointRecoveryPath": str(checkpoint),
            "runtime": runtime,
            "retentionWarning": retention_warning,
            "transactionCleanupWarning": transaction_cleanup_warning,
            "transactionPartialPreserved": transaction_partial_preserved,
            "transactionPartialExists": transaction_partial_exists,
            "transactionPartialRecoveryPath": (
                str(transaction_partial_path) if transaction_partial_preserved else None
            ),
            "transactionPartialEvidencePath": (
                str(transaction_partial_path) if transaction_partial_exists else None
            ),
            "visualInspectionRequired": True,
            "coldReopenRequired": True,
        }
    except BaseException as install_error:
        # Destructive cleanup is fail-closed on every exception path and is
        # re-authorized only by a checkpoint confirmation below.
        partial_cleanup_authorized = False
        # A Python interrupt can arrive after renamex_np completed but
        # before `swapped = True`. Determine the on-disk state before any
        # cleanup so the old application can never be deleted by mistake.
        if exchange_attempted and not swapped and previous is not None:
            try:
                target_fingerprint = validate_bundle(
                    self.repo,
                    self.target_app,
                    expected_commit=None,
                    runner=self.runner,
                )
                previous_fingerprint = validate_bundle(
                    self.repo,
                    previous,
                    expected_commit=None,
                    runner=self.runner,
                )
                candidate_equals_current = not bundle_fingerprint_mismatches(
                    candidate_fingerprint,
                    current_fingerprint,
                )
                if candidate_equals_current:
                    # Both outcomes are equivalent; the target is the same
                    # validated bundle and the transaction copy is expendable.
                    swapped = False
                    partial_requires_locked_cleanup = False
                    candidate_launch_attempted = False
                elif (
                    not bundle_fingerprint_mismatches(candidate_fingerprint, target_fingerprint)
                    and not bundle_fingerprint_mismatches(current_fingerprint, previous_fingerprint)
                ):
                    swapped = True
                    candidate_launch_attempted = True
                elif (
                    not bundle_fingerprint_mismatches(current_fingerprint, target_fingerprint)
                    and not bundle_fingerprint_mismatches(candidate_fingerprint, previous_fingerprint)
                ):
                    swapped = False
                    partial_requires_locked_cleanup = False
                    candidate_launch_attempted = False
                else:
                    exchange_uncertain = True
            except BaseException:
                exchange_uncertain = True
        if exchange_uncertain:
            swapped = True  # suppress destructive cleanup of either bundle
            raise StagingError(
                f"Atomic exchange outcome is uncertain after {install_error}; preserve "
                f"target {self.target_app}, transaction directory {partial_root}, and "
                f"managed checkpoint {checkpoint}."
            ) from install_error
        if swapped and previous is not None:
            rollback_error: Exception | None = None
            old_runtime: dict[str, int | str] | None = None
            try:
                quit_application(
                    self.target_app,
                    self.lock_file,
                    timeout=self.quit_timeout,
                    runner=self.runner,
                )
                rollback_exchange(self.target_app, previous, failed, self.swapper)
                partial_requires_locked_cleanup = False
                previous = None
                restored_identity = validate_bundle(
                    self.repo,
                    self.target_app,
                    expected_commit=None,
                    runner=self.runner,
                )
                assert_same_bundle_copy(
                    current_fingerprint,
                    restored_identity,
                    description="Automatically restored application",
                )
                # Once a candidate has been launched it may have migrated
                # the real profile. Do not expose that profile to old code
                # automatically; leave the restored bundle stopped.
                if not candidate_launch_attempted:
                    old_runtime = launch_and_verify_runtime(
                        self.target_app,
                        self.profile_root,
                        timeout=self.launch_timeout,
                        runner=self.runner,
                    )
                swapped = False
            except BaseException as error:
                rollback_error = error
            if rollback_error:
                raise StagingError(
                    f"Installation failed ({install_error}); automatic rollback also failed ({rollback_error}). "
                    f"Preserve {previous or failed} and restore checkpoint {checkpoint} manually."
                ) from install_error
            checkpoint_warning: str | None = None
            if checkpoint is not None and checkpoint.exists() and backup_fingerprint is not None:
                checkpoint, checkpoint_confirmed, checkpoint_warning, _, _ = publish_checkpoint_best_effort(
                    self.repo,
                    checkpoint,
                    self.backup_root,
                    timeout=self.retention_lock_timeout,
                    runner=self.runner,
                    reason="installation-failed-app-restored",
                    expected_fingerprint=backup_fingerprint,
                    qualified_helper=qualified_helper,
                    expected_commit=checkout_commit,
                    expected_helper_sha256=retention_helper_sha256,
                    installed_script=self.installed_retention_script,
                )
                partial_cleanup_authorized = checkpoint_confirmed
            raise StagingError(
                f"Installation failed and the previous app was restored. "
                f"Failed candidate preserved at {failed}. "
                + (
                    "The restored app was intentionally left stopped because the candidate was launched; "
                    "inspect profile-schema compatibility before reopening. "
                    if candidate_launch_attempted
                    else f"The restored runtime was relaunched as pid {old_runtime and old_runtime.get('pid')}. "
                )
                + str(install_error)
                + (f" {checkpoint_warning}" if checkpoint_warning else "")
            ) from install_error

        # Failures after a proven stop but before a candidate reached the
        # production path must not leave the unchanged old app offline.
        if current_stop_attempted and not candidate_launch_attempted:
            try:
                stopped_identity = validate_bundle(
                    self.repo,
                    self.target_app,
                    expected_commit=None,
                    runner=self.runner,
                )
                assert_same_bundle_copy(
                    current_fingerprint,
                    stopped_identity,
                    description="Pre-exchange recovery application",
                )
                try:
                    assert_application_stopped(
                        self.target_app,
                        self.lock_file,
                        self.runner,
                    )
                except StagingError:
                    # The unchanged old runtime may have reopened after the
                    # earlier stop proof. Verify it instead of issuing a
                    # second open request.
                    verify_runtime(
                        self.target_app,
                        self.lock_file,
                        launched_after_ms=0,
                        timeout=self.launch_timeout,
                        runner=self.runner,
                    )
                else:
                    launch_and_verify_runtime(
                        self.target_app,
                        self.profile_root,
                        timeout=self.launch_timeout,
                        runner=self.runner,
                    )
            except BaseException as recovery_error:
                raise StagingError(
                    f"Installation failed ({install_error}); unchanged previous app "
                    f"could not be relaunched ({recovery_error})."
                ) from install_error
        checkpoint_warning = None
        if checkpoint is not None and checkpoint.exists() and backup_fingerprint is not None:
            checkpoint, checkpoint_confirmed, checkpoint_warning, _, _ = publish_checkpoint_best_effort(
                self.repo,
                checkpoint,
                self.backup_root,
                timeout=self.retention_lock_timeout,
                runner=self.runner,
                reason="installation-aborted-before-exchange",
                expected_fingerprint=backup_fingerprint,
                qualified_helper=qualified_helper,
                expected_commit=checkout_commit,
                expected_helper_sha256=retention_helper_sha256,
                installed_script=self.installed_retention_script,
            )
            # When the partial may hold the immediate old-app copy, a
            # BaseException between successful finalization and clearing
            # `partial_root` must preserve it. Only
            # publish_checkpoint_best_effort may remove that copy while
            # the checkpoint is hidden under the shared retention lock.
            partial_cleanup_authorized = (
                checkpoint_confirmed and not partial_requires_locked_cleanup
            )
        elif checkpoint is not None and checkpoint.exists():
            checkpoint_warning = (
                f"Unvalidated checkpoint remains protected from retention at {checkpoint}"
            )
        if isinstance(install_error, StagingError):
            if checkpoint_warning:
                raise StagingError(f"{install_error}. {checkpoint_warning}") from install_error
            raise
        detail = str(install_error)
        if checkpoint_warning:
            detail += f". {checkpoint_warning}"
        raise StagingError(detail) from install_error
    finally:
        if partial_root is not None and partial_cleanup_authorized:
            cleanup_warning = cleanup_partial_best_effort(partial_root, self.target_app.parent)
            if cleanup_warning:
                print(f"WARNING: {cleanup_warning}", file=sys.stderr)
        elif partial_root is not None and partial_root.exists():
            print(
                f"WARNING: preserving unresolved transaction directory at {partial_root}",
                file=sys.stderr,
            )
        try:
            cleanup_qualified_retention_helper(qualified_snapshot_root)
        except BaseException as error:
            print(
                f"WARNING: qualified retention helper snapshot remains at {qualified_snapshot_root}: {error}",
                file=sys.stderr,
            )
