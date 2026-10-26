from __future__ import annotations

import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sys
import tempfile
from typing import Callable, Iterator, Mapping, Sequence

from robb_staging_common import (
    APP_ID,
    APP_NAME,
    MAIN_COMMIT_PROBE,
    StagingError,
    Runner,
    resolve_managed_backup_root,
    run_command,
    require_exact_commit,
    verify_clean_checkout,
    require_bundle,
    sha256_file,
    sha256_tree,
)

def read_bundle_identity(app: Path) -> dict[str, str]:
    app = require_bundle(app)
    plist_path = app / "Contents/Info.plist"
    try:
        with plist_path.open("rb") as stream:
            plist = plistlib.load(stream)
    except (OSError, plistlib.InvalidFileException) as error:
        raise StagingError(f"Cannot read application identity from {plist_path}: {error}") from error
    identity = plist.get("CFBundleIdentifier")
    executable = plist.get("CFBundleExecutable")
    if identity != APP_ID or executable != "Robb Agents":
        raise StagingError(
            f"Unexpected application identity at {app}: "
            f"CFBundleIdentifier={identity!r}, CFBundleExecutable={executable!r}"
        )
    return {
        "bundleIdentifier": identity,
        "executable": executable,
        "version": str(plist.get("CFBundleShortVersionString", "")),
    }

def verify_installed_retention_helper(repo: Path, installed_script: Path) -> str:
    source = repo.resolve() / "scripts/staging-retention.py"
    if source.is_symlink() or not source.is_file():
        raise StagingError(f"Missing repository retention helper: {source}")
    if installed_script.is_symlink() or not installed_script.is_file():
        raise StagingError(
            "The retention LaunchAgent helper is missing or unsafe; run "
            "python3 scripts/install-staging-retention.py before staging"
        )
    source_hash = sha256_file(source)
    if sha256_file(installed_script) != source_hash:
        raise StagingError(
            "The installed retention helper is stale; run "
            "python3 scripts/install-staging-retention.py and retry"
        )
    return source_hash

def verify_qualified_source_state(
    repo: Path,
    *,
    expected_commit: str,
    expected_helper_sha256: str,
    installed_script: Path,
    runner: Runner,
) -> None:
    verify_clean_checkout(repo, expected_commit, runner)
    current_hash = verify_installed_retention_helper(repo, installed_script)
    if current_hash != expected_helper_sha256:
        raise StagingError(
            "Retention helper qualification changed after preflight; refusing backup/prune"
        )

def create_qualified_retention_helper(
    repo: Path,
    *,
    expected_commit: str,
    expected_helper_sha256: str,
    installed_script: Path,
    runner: Runner,
) -> tuple[Path, Path]:
    """Snapshot already-qualified helper bytes outside the mutable checkout."""
    verify_qualified_source_state(
        repo,
        expected_commit=expected_commit,
        expected_helper_sha256=expected_helper_sha256,
        installed_script=installed_script,
        runner=runner,
    )
    snapshot_root = Path(tempfile.mkdtemp(prefix=".robb-qualified-retention-"))
    snapshot = snapshot_root / "staging-retention.py"
    try:
        shutil.copyfile(repo.resolve() / "scripts/staging-retention.py", snapshot)
        snapshot.chmod(0o500)
        if snapshot.is_symlink() or sha256_file(snapshot) != expected_helper_sha256:
            raise StagingError("Qualified retention helper snapshot failed hash verification")
    except BaseException:
        shutil.rmtree(snapshot_root, ignore_errors=True)
        raise
    return snapshot_root, snapshot

def cleanup_qualified_retention_helper(snapshot_root: Path) -> None:
    resolved = snapshot_root.resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if resolved.parent != temp_root or not resolved.name.startswith(".robb-qualified-retention-"):
        raise StagingError(f"Refusing to clean unexpected helper snapshot: {snapshot_root}")
    shutil.rmtree(resolved)

def validate_bundle(
    repo: Path,
    app: Path,
    *,
    expected_commit: str | None,
    require_developer_id: bool = False,
    runner: Runner = run_command,
) -> dict[str, str]:
    app = require_bundle(app)
    identity = read_bundle_identity(app)
    binary = app / "Contents/MacOS/Robb Agents"
    resources = app / "Contents/Resources"
    archive = resources / "app.asar"
    validator = repo.resolve() / "scripts/validate-electron-package-security.ts"
    if not validator.is_file():
        raise StagingError(f"Missing package security validator: {validator}")

    runner(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
    signature_result = runner(["/usr/bin/codesign", "-dv", "--verbose=4", str(app)])
    signature_details = f"{signature_result.stdout}\n{signature_result.stderr}"
    if "Signature=adhoc" in signature_details:
        signature_kind = "adhoc"
    elif re.search(r"^Authority=Developer ID Application:", signature_details, re.MULTILINE):
        signature_kind = "developer-id"
    else:
        raise StagingError(f"Unsupported application signing identity at {app}")
    if require_developer_id and signature_kind != "developer-id":
        raise StagingError("Local-production staging candidate requires a stable Developer ID Application signature")
    validator_env = os.environ.copy()
    if expected_commit:
        validator_env["ROBB_BUILD_COMMIT"] = require_exact_commit(expected_commit)
    else:
        validator_env.pop("ROBB_BUILD_COMMIT", None)
    runner(
        [
            "bun",
            str(validator),
            "--binary",
            str(binary),
            "--resources-dir",
            str(resources),
        ],
        cwd=repo.resolve(),
        env=validator_env,
        timeout=600,
    )
    commit_probe = runner(
        [
            "node",
            "--input-type=module",
            "--eval",
            MAIN_COMMIT_PROBE,
            str(archive),
            require_exact_commit(expected_commit) if expected_commit else "",
        ],
        cwd=repo.resolve(),
    )
    try:
        provenance = json.loads(commit_probe.stdout)
    except json.JSONDecodeError as error:
        raise StagingError("Packaged main process returned invalid build provenance") from error
    if not isinstance(provenance, dict):
        raise StagingError("Packaged main process returned invalid build provenance")
    embedded_commit = require_exact_commit(str(provenance.get("buildCommit", "")))
    if provenance.get("buildChannel") != "production" or provenance.get("buildDirty") is not False:
        raise StagingError(f"Candidate is not a clean production-channel build: {provenance}")
    architecture = runner(["/usr/bin/file", "-b", str(binary)]).stdout.strip()
    if not re.search(r"(?:^|[\s,\[])arm64(?:$|[\s,\]])", architecture):
        raise StagingError(f"Local staging requires an arm64 application binary, found: {architecture}")
    return {
        **identity,
        "buildCommit": embedded_commit,
        "buildChannel": "production",
        "buildDirty": "false",
        "architecture": architecture,
        "signatureKind": signature_kind,
        "asarSha256": sha256_file(archive),
        "executableSha256": sha256_file(binary),
        "infoPlistSha256": sha256_file(app / "Contents/Info.plist"),
        "bundleTreeSha256": sha256_tree(app),
    }

def assert_same_bundle_copy(
    source: Mapping[str, str],
    copy: Mapping[str, str],
    *,
    description: str,
) -> None:
    mismatches = bundle_fingerprint_mismatches(source, copy)
    if mismatches:
        raise StagingError(f"{description} differs from its source: {', '.join(mismatches)}")

def bundle_fingerprint_mismatches(
    source: Mapping[str, str],
    copy: Mapping[str, str],
) -> list[str]:
    compared = (
        "bundleIdentifier",
        "executable",
        "version",
        "buildCommit",
        "buildChannel",
        "buildDirty",
        "architecture",
        "signatureKind",
        "asarSha256",
        "executableSha256",
        "infoPlistSha256",
        "bundleTreeSha256",
    )
    return [name for name in compared if source.get(name) != copy.get(name)]

def parse_created_backup(stdout: str, backup_root: Path) -> Path:
    root = resolve_managed_backup_root(backup_root)
    created: str | None = None
    for line in stdout.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and isinstance(payload.get("created"), str):
            created = payload["created"]
            break
    if not created:
        raise StagingError("staging-retention did not report the created checkpoint")
    raw_checkpoint = Path(created).expanduser()
    if raw_checkpoint.is_symlink():
        raise StagingError(f"Backup checkpoint must not be a symlink: {raw_checkpoint}")
    checkpoint = raw_checkpoint.resolve()
    if checkpoint.parent != root or checkpoint.is_symlink():
        raise StagingError(f"Backup checkpoint escaped the managed backup root: {checkpoint}")
    backup_app = checkpoint / APP_NAME
    require_bundle(backup_app)
    return checkpoint

def backup_current_app(
    repo: Path,
    backup_root: Path,
    *,
    qualified_helper: Path,
    expected_commit: str,
    expected_helper_sha256: str,
    installed_script: Path,
    runner: Runner = run_command,
) -> Path:
    root = resolve_managed_backup_root(backup_root)
    verify_qualified_source_state(
        repo,
        expected_commit=expected_commit,
        expected_helper_sha256=expected_helper_sha256,
        installed_script=installed_script,
        runner=runner,
    )
    if qualified_helper.is_symlink() or sha256_file(qualified_helper) != expected_helper_sha256:
        raise StagingError("Qualified retention helper snapshot changed before backup")
    result = runner(
        [
            sys.executable,
            str(qualified_helper),
            "--backup-app",
            "--no-prune",
            "--hold-created",
            "--defer-strong-validation",
            "--root",
            str(root),
        ],
        cwd=repo.resolve(),
        timeout=600,
    )
    checkpoint = parse_created_backup(result.stdout, root)
    try:
        verify_qualified_source_state(
            repo,
            expected_commit=expected_commit,
            expected_helper_sha256=expected_helper_sha256,
            installed_script=installed_script,
            runner=runner,
        )
        if sha256_file(qualified_helper) != expected_helper_sha256:
            raise StagingError("Qualified retention helper snapshot changed during backup")
    except BaseException as error:
        raise StagingError(
            f"Source qualification changed during backup; checkpoint remains protected at {checkpoint}: {error}"
        ) from error
    return checkpoint
