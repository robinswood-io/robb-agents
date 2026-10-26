#!/usr/bin/env python3
"""Fail-closed installer and rollback helper for Robb Agents local staging.

This command is intentionally limited to the production-identity staging target
on this Mac. It never edits the profile and never force-kills the application.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from typing import Callable, Iterator, Mapping, Sequence

from robb_staging_common import (
    APP_ID,
    APP_NAME,
    TARGET_APP,
    PROFILE_ROOT,
    BACKUP_ROOT,
    INSTALLED_RETENTION_SCRIPT,
    COMMIT_RE,
    PROFILE_COMPATIBILITY_CONFIRMATION,
    STRONG_VALIDATION_CONTRACT,
    FINGERPRINT_KEYS,
    LEGACY_BACKUP_PREFIXES,
    CHECKPOINT_NAME_RE,
    MAIN_COMMIT_PROBE,
    StagingError,
    Runner,
    Swapper,
    resolve_managed_backup_root,
    require_positive_timeout,
    exclusive_file_lock,
    atomic_swap_bundles,
    run_command,
    require_exact_commit,
    verify_clean_checkout,
    require_bundle,
    sha256_file,
    sha256_tree,
    safe_remove_partial,
    cleanup_partial_best_effort,
)
from robb_staging_bundles import (
    read_bundle_identity,
    verify_installed_retention_helper,
    verify_qualified_source_state,
    create_qualified_retention_helper,
    cleanup_qualified_retention_helper,
    validate_bundle,
    assert_same_bundle_copy,
    bundle_fingerprint_mismatches,
    parse_created_backup,
    backup_current_app,
)
from robb_staging_checkpoints import (
    retention_lock_file,
    protect_rollback_checkpoint,
    protect_rollback_checkpoint_locked,
    protect_and_validate_rollback_checkpoint,
    next_checkpoint_time,
    strong_validation_manifest,
    valid_backup_source,
    is_confirmed_managed_checkpoint,
    republish_rollback_checkpoint_locked,
    republish_rollback_checkpoint,
    prune_backups,
    checkpoint_directory_identity,
    find_checkpoint_by_identity,
)
from robb_staging_publication import (
    publish_checkpoint_best_effort,
)
from robb_staging_runtime import (
    parse_runtime_lock,
    process_is_alive,
    bundle_processes,
    assert_application_stopped,
    wait_until_stopped,
    quit_application,
    verify_runtime,
    launch_and_verify_runtime,
    rollback_exchange,
)
from robb_staging_transaction import (
    install_locked,
)

class LocalStagingInstaller:
    def __init__(
        self,
        *,
        repo: Path,
        target_app: Path = TARGET_APP,
        profile_root: Path = PROFILE_ROOT,
        backup_root: Path = BACKUP_ROOT,
        runner: Runner = run_command,
        swapper: Swapper = atomic_swap_bundles,
        transaction_lock_file: Path | None = None,
        installed_retention_script: Path = INSTALLED_RETENTION_SCRIPT,
        quit_timeout: float = 45,
        launch_timeout: float = 45,
        retention_lock_timeout: float = 60,
    ) -> None:
        self.repo = repo.resolve()
        self.target_app = target_app
        self.profile_root = profile_root
        self.backup_root = resolve_managed_backup_root(backup_root)
        self.runner = runner
        self.swapper = swapper
        self.transaction_lock_file = transaction_lock_file or (
            self.backup_root.parent / ".robb-local-staging.transaction.lock"
        )
        self.installed_retention_script = installed_retention_script
        self.quit_timeout = require_positive_timeout(quit_timeout, "quit timeout")
        self.launch_timeout = require_positive_timeout(launch_timeout, "launch timeout")
        self.retention_lock_timeout = require_positive_timeout(
            retention_lock_timeout,
            "retention lock timeout",
        )

    @property
    def lock_file(self) -> Path:
        return self.profile_root.resolve() / "robb-electron/.server.lock"

    def preflight(
        self,
        candidate_app: Path,
        expected_commit: str,
        artifact_commit: str | None = None,
        *,
        require_candidate_developer_id: bool = True,
    ) -> dict[str, object]:
        retention_helper_sha256 = verify_installed_retention_helper(
            self.repo,
            self.installed_retention_script,
        )
        checkout_commit = verify_clean_checkout(self.repo, expected_commit, self.runner)
        bundle_commit = require_exact_commit(artifact_commit or checkout_commit)
        candidate_identity = validate_bundle(
            self.repo,
            candidate_app,
            expected_commit=bundle_commit,
            require_developer_id=require_candidate_developer_id,
            runner=self.runner,
        )
        current_identity = validate_bundle(
            self.repo,
            self.target_app,
            expected_commit=None,
            runner=self.runner,
        )
        return {
            "checkoutCommit": checkout_commit,
            "artifactCommit": bundle_commit,
            "candidate": str(candidate_app.resolve()),
            "candidateIdentity": candidate_identity,
            "target": str(self.target_app.resolve()),
            "currentIdentity": current_identity,
            "profile": str(self.profile_root.resolve()),
            "retentionHelperSha256": retention_helper_sha256,
        }

    def _stage_candidate(
        self,
        candidate_app: Path,
        artifact_commit: str,
    ) -> tuple[Path, Path, dict[str, str]]:
        partial_root = Path(tempfile.mkdtemp(
            prefix=f".partial-robb-staging-{artifact_commit[:12]}-",
            dir=self.target_app.parent,
        ))
        staged_app = partial_root / APP_NAME
        try:
            self.runner(
                ["/usr/bin/ditto", str(candidate_app.resolve()), str(staged_app)],
                timeout=600,
            )
            staged_fingerprint = validate_bundle(
                self.repo,
                staged_app,
                expected_commit=artifact_commit,
                runner=self.runner,
            )
            return partial_root, staged_app, staged_fingerprint
        except Exception as stage_error:
            warning = cleanup_partial_best_effort(partial_root, self.target_app.parent)
            if warning:
                raise StagingError(f"Candidate staging failed ({stage_error}); {warning}") from stage_error
            raise

    def _install_locked(
        self, candidate_app: Path, expected_commit: str, artifact_commit: str, *,
        require_candidate_developer_id: bool,
    ) -> dict[str, object]:
        return install_locked(
            self, candidate_app, expected_commit, artifact_commit,
            require_candidate_developer_id=require_candidate_developer_id,
        )

    def install(self, candidate_app: Path, expected_commit: str) -> dict[str, object]:
        commit = require_exact_commit(expected_commit)
        with exclusive_file_lock(self.transaction_lock_file):
            return self._install_locked(
                candidate_app,
                commit,
                commit,
                require_candidate_developer_id=True,
            )

    def verify(
        self,
        expected_commit: str,
        artifact_commit: str | None = None,
    ) -> dict[str, object]:
        checkout_commit = verify_clean_checkout(self.repo, expected_commit, self.runner)
        bundle_commit = require_exact_commit(artifact_commit or checkout_commit)
        identity = validate_bundle(
            self.repo,
            self.target_app,
            expected_commit=bundle_commit,
            runner=self.runner,
        )
        runtime = verify_runtime(
            self.target_app,
            self.lock_file,
            launched_after_ms=0,
            timeout=self.launch_timeout,
            runner=self.runner,
        )
        return {
            "status": "verified",
            "checkoutCommit": checkout_commit,
            "artifactCommit": bundle_commit,
            "target": str(self.target_app.resolve()),
            "identity": identity,
            "profile": str(self.profile_root.resolve()),
            "runtime": runtime,
        }

    def rollback(
        self,
        checkpoint: Path,
        expected_commit: str,
        artifact_commit: str,
        *,
        profile_compatible: bool,
    ) -> dict[str, object]:
        if not profile_compatible:
            raise StagingError(
                "Rollback requires an explicit profile-schema compatibility confirmation"
            )
        checkout = require_exact_commit(expected_commit)
        artifact = require_exact_commit(artifact_commit)
        with exclusive_file_lock(self.transaction_lock_file):
            verify_clean_checkout(self.repo, checkout, self.runner)
            root = resolve_managed_backup_root(self.backup_root)
            if checkpoint.is_symlink():
                raise StagingError("Rollback checkpoint must not be a symlink")
            original_checkpoint = checkpoint.resolve()
            if original_checkpoint.parent != root:
                raise StagingError(f"Rollback checkpoint must be one direct child of {root}")
            held, selected_fingerprint = protect_and_validate_rollback_checkpoint(
                self.repo,
                original_checkpoint,
                root,
                expected_commit=artifact,
                timeout=self.retention_lock_timeout,
                runner=self.runner,
            )
            try:
                result = self._install_locked(
                    held / APP_NAME,
                    checkout,
                    artifact,
                    require_candidate_developer_id=False,
                )
            except BaseException as error:
                raise StagingError(
                    f"Rollback did not complete; selected checkpoint is protected from retention at {held}: {error}"
                ) from error

            retention_helper_sha256 = str(result["retentionHelperSha256"])
            try:
                qualified_snapshot_root, qualified_helper = create_qualified_retention_helper(
                    self.repo,
                    expected_commit=checkout,
                    expected_helper_sha256=retention_helper_sha256,
                    installed_script=self.installed_retention_script,
                    runner=self.runner,
                )
            except BaseException as error:
                retained = held
                retained_confirmed = False
                retention_warning = (
                    f"Rollback succeeded but checkpoint finalization was skipped because source "
                    f"qualification changed: {error}"
                )
            else:
                try:
                    retained, retained_confirmed, retention_warning, _, _ = publish_checkpoint_best_effort(
                        self.repo,
                        held,
                        root,
                        timeout=self.retention_lock_timeout,
                        runner=self.runner,
                        reason="explicit-rollback",
                        expected_fingerprint=selected_fingerprint,
                        qualified_helper=qualified_helper,
                        expected_commit=checkout,
                        expected_helper_sha256=retention_helper_sha256,
                        installed_script=self.installed_retention_script,
                    )
                finally:
                    try:
                        cleanup_qualified_retention_helper(qualified_snapshot_root)
                    except BaseException as error:
                        print(
                            f"WARNING: qualified retention helper snapshot remains at "
                            f"{qualified_snapshot_root}: {error}",
                            file=sys.stderr,
                        )
            result["status"] = "rolled-back"
            result["sourceCheckpoint"] = str(original_checkpoint)
            result["restoredCheckpoint"] = str(retained) if retained_confirmed else None
            result["restoredCheckpointConfirmed"] = retained_confirmed
            result["restoredCheckpointRecoveryPath"] = str(retained)
            retention_warnings = [
                warning
                for warning in (result.get("retentionWarning"), retention_warning)
                if isinstance(warning, str) and warning
            ]
            result["retentionWarning"] = "; ".join(retention_warnings) or None
            return result

def default_repo() -> Path:
    return Path(__file__).resolve().parents[1]

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("preflight", "install", "verify", "rollback"))
    parser.add_argument(
        "--expected-commit",
        required=True,
        help="Exact 40-character HEAD of the clean checkout executing this helper",
    )
    parser.add_argument(
        "--artifact-commit",
        help="Exact embedded bundle commit; defaults to HEAD and is required for rollback",
    )
    parser.add_argument("--repo", type=Path, default=default_repo())
    parser.add_argument("--candidate-app", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--confirm-target", help=f"Required for mutations; enter {APP_ID}")
    parser.add_argument(
        "--confirm-profile-compatible",
        help=(
            "Required for rollback after reviewing profile migrations; enter "
            f"{PROFILE_COMPATIBILITY_CONFIRMATION}"
        ),
    )
    parser.add_argument("--quit-timeout", type=float, default=45)
    parser.add_argument("--launch-timeout", type=float, default=45)
    return parser

def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if sys.platform != "darwin":
        raise StagingError("Local production-profile staging is supported only on macOS")
    if os.geteuid() == 0:
        raise StagingError("Never run local staging with sudo/root; it would select the wrong HOME and profile")
    script_repo = default_repo().resolve()
    if args.repo.resolve() != script_repo:
        raise StagingError(f"--repo must be the checkout containing this helper: {script_repo}")
    checkout_commit = require_exact_commit(args.expected_commit)
    artifact_commit = require_exact_commit(args.artifact_commit) if args.artifact_commit else None
    installer = LocalStagingInstaller(
        repo=args.repo,
        quit_timeout=args.quit_timeout,
        launch_timeout=args.launch_timeout,
    )
    candidate = args.candidate_app or (
        args.repo.resolve() / "apps/electron/release/mac-arm64/Robb Agents.app"
    )

    if args.mode == "preflight":
        result = installer.preflight(candidate, checkout_commit, artifact_commit)
    elif args.mode == "verify":
        result = installer.verify(checkout_commit, artifact_commit)
    else:
        if args.confirm_target != APP_ID:
            raise StagingError(f"{args.mode} requires --confirm-target {APP_ID}")
        if args.mode == "install":
            if artifact_commit is not None and artifact_commit != checkout_commit:
                raise StagingError(
                    "install requires the candidate artifact commit to equal the clean checkout HEAD"
                )
            result = installer.install(candidate, checkout_commit)
        else:
            if args.checkpoint is None:
                raise StagingError("rollback requires --checkpoint <managed checkpoint directory>")
            if artifact_commit is None:
                raise StagingError("rollback requires --artifact-commit <checkpoint build SHA>")
            result = installer.rollback(
                args.checkpoint,
                checkout_commit,
                artifact_commit,
                profile_compatible=(
                    args.confirm_profile_compatible == PROFILE_COMPATIBILITY_CONFIRMATION
                ),
            )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except StagingError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
