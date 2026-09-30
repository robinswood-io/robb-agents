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


APP_ID = "io.robinswood.robbagents"
APP_NAME = "Robb Agents.app"
TARGET_APP = Path("/Applications/Robb Agents.app")
PROFILE_ROOT = Path.home() / ".craft-agent"
BACKUP_ROOT = Path.home() / "Library/Application Support/Robb Agents/Staging Backups"
INSTALLED_RETENTION_SCRIPT = (
    Path.home() / "Library/Application Support/Robb Agents/Maintenance/staging-retention.py"
)
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
PROFILE_COMPATIBILITY_CONFIRMATION = "profile-schema-compatible"
STRONG_VALIDATION_CONTRACT = "robb-local-staging.validate_bundle.v1"
FINGERPRINT_KEYS = {
    "bundleIdentifier", "executable", "version", "buildCommit", "buildChannel",
    "buildDirty", "architecture", "signatureKind", "asarSha256",
    "executableSha256", "infoPlistSha256", "bundleTreeSha256",
}
LEGACY_BACKUP_PREFIXES = (
    "Robb Agents.app.previous-",
    "Robb Agents.app.replaced-",
    ".Robb Agents.app.rollback-",
    ".Robb Agents.app.pre-staging-",
)
CHECKPOINT_NAME_RE = re.compile(
    r"^(?P<date>\d{8})-(?P<time>\d{6})-(?P<suffix>\d{6}|legacy-[A-Za-z0-9_-]+)$"
)
MAIN_COMMIT_PROBE = r"""
import { extractFile } from '@electron/asar';
const [archive, expected] = process.argv.slice(1);
const source = Buffer.from(extractFile(archive, 'dist/main.cjs')).toString('utf8');
const commits = [...new Set(
  [...source.matchAll(/buildCommit\s*:\s*["']([0-9a-f]{40})["']/gi)]
    .map((match) => match[1].toLowerCase()),
)];
if (commits.length !== 1) {
  console.error(`Packaged main process must declare exactly one 40-character buildCommit; found ${commits.length}`);
  process.exit(1);
}
if (expected && commits[0] !== expected.toLowerCase()) {
  console.error(`Packaged main process declares ${commits[0]}, expected ${expected}`);
  process.exit(1);
}
const channelMatches = [...source.matchAll(
  /function\s+resolveAppChannel\(isPackaged,\s*declaredChannel\s*=\s*["'](production|development)["']\)/g,
)].map((match) => match[1]);
if (channelMatches.length !== 1 || channelMatches[0] !== 'production') {
  console.error(`Packaged main process is not an unambiguous production-channel build: ${channelMatches}`);
  process.exit(1);
}
const cleanBuild = /buildChannel\s*:\s*APP_CHANNEL\s*,\s*buildDirty\s*:\s*false\s*\?\s*true\s*:\s*true\s*\?\s*false/g.test(source)
  || /buildChannel\s*:\s*APP_CHANNEL\s*,\s*buildDirty\s*:\s*false\s*[,}]/g.test(source);
if (!cleanBuild) {
  console.error('Packaged main process does not prove buildDirty=false');
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  buildCommit: commits[0],
  buildChannel: channelMatches[0],
  buildDirty: false,
}) + '\n');
""".strip()


class StagingError(RuntimeError):
    """A staging safety condition was not met."""


Runner = Callable[..., subprocess.CompletedProcess[str]]
Swapper = Callable[[Path, Path], None]


def resolve_managed_backup_root(backup_root: Path) -> Path:
    expanded = Path(os.path.abspath(os.path.expanduser(str(backup_root))))
    trusted_anchors = (Path.home().absolute(), Path(tempfile.gettempdir()).absolute())
    applicable = [anchor for anchor in trusted_anchors if expanded == anchor or anchor in expanded.parents]
    stop = max(applicable, key=lambda path: len(path.parts)) if applicable else Path(expanded.anchor)
    current = expanded
    while True:
        if current.is_symlink():
            raise StagingError(f"Managed backup path component must not be a symlink: {current}")
        if current == stop or current.parent == current:
            break
        current = current.parent
    return expanded.resolve()


def require_positive_timeout(value: float, name: str) -> float:
    if not math.isfinite(value) or value <= 0:
        raise StagingError(f"{name} must be a finite positive number")
    return value


@contextmanager
def exclusive_file_lock(lock_path: Path, *, timeout: float = 0) -> Iterator[None]:
    """Acquire a process-wide advisory lock without an unbounded wait."""
    timeout = max(0, timeout)
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise StagingError(f"Cannot create staging lock directory for {lock_path}: {error}") from error
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise StagingError(f"Cannot safely open staging lock {lock_path}: {error}") from error
    with os.fdopen(descriptor, "r+", encoding="utf-8") as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
            raise StagingError(f"Staging lock is not a regular file: {lock_path}")
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as error:
                if time.monotonic() >= deadline:
                    raise StagingError(f"Another staging/retention operation holds {lock_path}") from error
                time.sleep(0.1)
            except OSError as error:
                raise StagingError(f"Cannot acquire staging lock {lock_path}: {error}") from error
        try:
            yield
        finally:
            try:
                fcntl.flock(lock, fcntl.LOCK_UN)
            except OSError:
                # Closing the descriptor releases flock even if explicit
                # unlock fails; do not turn a committed install into failure.
                pass


def atomic_swap_bundles(left: Path, right: Path) -> None:
    """Atomically exchange two same-volume paths with Darwin renamex_np."""
    if sys.platform != "darwin":
        raise StagingError("Atomic application exchange requires macOS renamex_np")
    libc = ctypes.CDLL(None, use_errno=True)
    renamex_np = libc.renamex_np
    renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex_np.restype = ctypes.c_int
    rename_swap = 0x00000002
    result = renamex_np(os.fsencode(left), os.fsencode(right), rename_swap)
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), f"{left} <-> {right}")


def run_command(
    args: Sequence[str],
    *,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    check: bool = True,
    timeout: float = 180,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            list(args),
            cwd=cwd,
            env=dict(env) if env is not None else None,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise StagingError(f"Command timed out after {timeout}s: {' '.join(args)}") from error
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise StagingError(f"Command failed ({result.returncode}): {' '.join(args)}\n{detail}")
    return result


def require_exact_commit(value: str) -> str:
    commit = value.strip().lower()
    if not COMMIT_RE.fullmatch(commit):
        raise StagingError("Commit value must be an exact 40-character Git SHA")
    return commit


def verify_clean_checkout(repo: Path, expected_commit: str, runner: Runner = run_command) -> str:
    repo = repo.resolve()
    status = runner(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=repo,
    ).stdout
    if status.strip():
        raise StagingError("Local staging requires a completely clean checkout, including no untracked files")
    actual = runner(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip().lower()
    if actual != require_exact_commit(expected_commit):
        raise StagingError(f"Checkout commit mismatch: expected {expected_commit}, found {actual or 'none'}")
    return actual


def require_bundle(app: Path) -> Path:
    if app.is_symlink() or not app.is_dir():
        raise StagingError(f"Expected a real application bundle, not a symlink: {app}")
    return app.resolve()


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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise StagingError(f"Cannot hash {path}: {error}") from error
    return digest.hexdigest()


def sha256_tree(root: Path) -> str:
    """Hash every bundle entry without following symlinks."""
    digest = hashlib.sha256()

    def visit(directory: Path, relative_parent: Path) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as error:
            raise StagingError(f"Cannot inventory bundle directory {directory}: {error}") from error
        for entry in entries:
            relative = relative_parent / entry.name
            encoded_name = os.fsencode(str(relative))
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise StagingError(f"Cannot inspect bundle entry {entry.path}: {error}") from error
            digest.update(encoded_name + b"\0" + f"{stat.S_IMODE(info.st_mode):o}".encode() + b"\0")
            path = Path(entry.path)
            if stat.S_ISLNK(info.st_mode):
                digest.update(b"L\0" + os.fsencode(os.readlink(path)) + b"\0")
            elif stat.S_ISDIR(info.st_mode):
                digest.update(b"D\0")
                visit(path, relative)
            elif stat.S_ISREG(info.st_mode):
                digest.update(b"F\0" + sha256_file(path).encode() + b"\0")
            else:
                raise StagingError(f"Unsupported special file in application bundle: {path}")

    visit(root, Path())
    return digest.hexdigest()


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
    require_adhoc: bool = False,
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
    if require_adhoc and signature_kind != "adhoc":
        raise StagingError("Local-production staging candidate must use the expected ad-hoc signature")
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


def retention_lock_file(backup_root: Path) -> Path:
    root = resolve_managed_backup_root(backup_root)
    return root.parent / f".{root.name}.retention.lock"


def protect_rollback_checkpoint(
    checkpoint: Path,
    backup_root: Path,
    *,
    timeout: float,
) -> Path:
    """Hide a selected old checkpoint from concurrent retention pruning."""
    root = resolve_managed_backup_root(backup_root)
    checkpoint = checkpoint.resolve()
    with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
        return protect_rollback_checkpoint_locked(checkpoint, root)


def protect_rollback_checkpoint_locked(checkpoint: Path, root: Path) -> Path:
    """Rename a checkpoint while the caller holds the retention lock."""
    if checkpoint.parent != root or checkpoint.is_symlink():
        raise StagingError(f"Rollback checkpoint must be one direct child of {root}")
    require_bundle(checkpoint / APP_NAME)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    held = root / f".rollback-held-{stamp}-{os.getpid()}"
    if held.exists():
        raise StagingError(f"Rollback hold path already exists: {held}")
    try:
        os.replace(checkpoint, held)
    except OSError as error:
        raise StagingError(f"Cannot protect rollback checkpoint {checkpoint}: {error}") from error
    return held


def protect_and_validate_rollback_checkpoint(
    repo: Path,
    checkpoint: Path,
    backup_root: Path,
    *,
    expected_commit: str,
    timeout: float,
    runner: Runner,
) -> tuple[Path, dict[str, str]]:
    """Hide a selected checkpoint before any long-running strong validation."""
    root = resolve_managed_backup_root(backup_root)
    checkpoint = checkpoint.resolve()
    with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
        held = protect_rollback_checkpoint_locked(checkpoint, root)
        try:
            fingerprint = validate_bundle(
                repo,
                held / APP_NAME,
                expected_commit=expected_commit,
                runner=runner,
            )
            manifest_path = held / "backup.json"
            if manifest_path.is_symlink():
                raise StagingError(f"Rollback checkpoint manifest must not be a symlink: {manifest_path}")
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise StagingError(f"Rollback checkpoint manifest is missing or invalid: {manifest_path}") from error
            if not isinstance(manifest, dict) or not valid_backup_source(manifest.get("source")):
                raise StagingError(
                    f"Rollback checkpoint manifest has no recognized /Applications source: {manifest_path}"
                )
        except BaseException as error:
            raise StagingError(
                f"Rollback checkpoint validation failed; it remains protected from retention at {held}: {error}"
            ) from error
    return held, fingerprint


def next_checkpoint_time(backup_root: Path) -> dt.datetime:
    """Choose a timestamp newer than every published checkpoint, despite clock drift."""
    backup_root = resolve_managed_backup_root(backup_root)
    latest = time.time()
    for path in backup_root.iterdir():
        if path.is_symlink() or not path.is_dir() or not re.match(r"^\d{8}-", path.name):
            continue
        timestamp: float
        manifest_path = path / "backup.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            created_at = manifest.get("createdAt") if isinstance(manifest, dict) else None
            if not isinstance(created_at, str):
                raise ValueError("createdAt missing")
            timestamp = dt.datetime.fromisoformat(created_at).timestamp()
        except (OSError, ValueError, json.JSONDecodeError):
            stat = path.stat()
            timestamp = getattr(stat, "st_birthtime", stat.st_mtime)
        latest = max(latest, timestamp)
    return dt.datetime.fromtimestamp(latest + 0.001, dt.timezone.utc)


def strong_validation_manifest(fingerprint: Mapping[str, str]) -> dict[str, object]:
    if set(fingerprint) != FINGERPRINT_KEYS or any(
        not isinstance(value, str) or not value for value in fingerprint.values()
    ):
        raise StagingError("Strong checkpoint validation fingerprint is incomplete")
    return {
        "contract": STRONG_VALIDATION_CONTRACT,
        "fingerprint": dict(fingerprint),
    }


def valid_backup_source(value: object) -> bool:
    if not isinstance(value, str):
        return False
    source = Path(value)
    return source.parent == Path("/Applications") and (
        source.name == APP_NAME or source.name.startswith(LEGACY_BACKUP_PREFIXES)
    )


def is_confirmed_managed_checkpoint(
    checkpoint: Path,
    fingerprint: Mapping[str, str],
) -> bool:
    """Prove that a path is eligible for the standalone retention inventory."""
    match = CHECKPOINT_NAME_RE.fullmatch(checkpoint.name)
    manifest_path = checkpoint / "backup.json"
    if match is None or checkpoint.is_symlink() or manifest_path.is_symlink():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("version") != 2:
            return False
        if not valid_backup_source(manifest.get("source")):
            return False
        created_at = manifest.get("createdAt")
        if not isinstance(created_at, str):
            return False
        created = dt.datetime.fromisoformat(created_at)
        if created.tzinfo is None:
            return False
        created_utc = created.astimezone(dt.timezone.utc)
        if created_utc.strftime("%Y%m%d-%H%M%S") != f"{match.group('date')}-{match.group('time')}":
            return False
        suffix = match.group("suffix")
        if suffix.isdigit() and suffix != f"{created_utc.microsecond:06d}":
            return False
        return manifest.get("validation") == strong_validation_manifest(fingerprint)
    except (OSError, ValueError, json.JSONDecodeError):
        return False


def republish_rollback_checkpoint_locked(
    held: Path,
    backup_root: Path,
    *,
    original: Path,
    validated_fingerprint: Mapping[str, str],
    reason: str = "explicit-rollback",
) -> Path:
    """Publish a held checkpoint while the caller owns the retention lock."""
    root = resolve_managed_backup_root(backup_root)
    held = held.resolve()
    if held.parent != root or not held.name.startswith(".rollback-held-"):
        raise StagingError(f"Unexpected rollback hold path: {held}")
    require_bundle(held / APP_NAME)
    now = next_checkpoint_time(root)
    manifest_path = held / "backup.json"
    manifest: dict[str, object] = {}
    if manifest_path.is_file():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest.update(loaded)
        except (OSError, json.JSONDecodeError) as error:
            raise StagingError(f"Cannot refresh rollback checkpoint manifest: {error}") from error
    previous_created_at = manifest.get("createdAt")
    if not valid_backup_source(manifest.get("source")):
        raise StagingError(
            f"Rollback checkpoint manifest has no recognized /Applications source: {manifest_path}"
        )
    if isinstance(previous_created_at, str):
        manifest.setdefault("originalCreatedAt", previous_created_at)
    manifest.update({
        "version": 2,
        "createdAt": now.isoformat(),
        "refreshedFrom": str(original),
        "heldReason": reason,
        "validation": strong_validation_manifest(validated_fingerprint),
    })
    temporary_manifest = held / f".backup.json.partial-{os.getpid()}"
    try:
        with temporary_manifest.open("x", encoding="utf-8") as stream:
            json.dump(manifest, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_manifest, manifest_path)
    finally:
        if temporary_manifest.exists():
            temporary_manifest.unlink()
    published = root / now.strftime("%Y%m%d-%H%M%S-%f")
    if published.exists():
        raise StagingError(f"Refusing to overwrite rollback checkpoint: {published}")
    os.replace(held, published)
    return published


def republish_rollback_checkpoint(
    held: Path,
    backup_root: Path,
    *,
    original: Path,
    timeout: float,
    validated_fingerprint: Mapping[str, str],
    reason: str = "explicit-rollback",
) -> Path:
    """Publish a strongly validated held checkpoint as the newest backup."""
    root = resolve_managed_backup_root(backup_root)
    with exclusive_file_lock(retention_lock_file(root), timeout=timeout):
        return republish_rollback_checkpoint_locked(
            held,
            root,
            original=original,
            validated_fingerprint=validated_fingerprint,
            reason=reason,
        )


def prune_backups(
    repo: Path,
    backup_root: Path,
    *,
    qualified_helper: Path,
    expected_commit: str,
    expected_helper_sha256: str,
    installed_script: Path,
    runner: Runner = run_command,
) -> dict[str, object]:
    root = resolve_managed_backup_root(backup_root)
    verify_qualified_source_state(
        repo,
        expected_commit=expected_commit,
        expected_helper_sha256=expected_helper_sha256,
        installed_script=installed_script,
        runner=runner,
    )
    if qualified_helper.is_symlink() or sha256_file(qualified_helper) != expected_helper_sha256:
        raise StagingError("Qualified retention helper snapshot changed before prune")
    result = runner(
        [sys.executable, str(qualified_helper), "--apply", "--root", str(root)],
        cwd=repo.resolve(),
        timeout=600,
    )
    verify_qualified_source_state(
        repo,
        expected_commit=expected_commit,
        expected_helper_sha256=expected_helper_sha256,
        installed_script=installed_script,
        runner=runner,
    )
    if sha256_file(qualified_helper) != expected_helper_sha256:
        raise StagingError("Qualified retention helper snapshot changed during prune")
    payloads: list[dict[str, object]] = []
    for line in result.stdout.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            payloads.append(payload)
    if not payloads or payloads[-1].get("apply") is not True:
        raise StagingError("staging-retention did not confirm applied retention")
    return payloads[-1]


def checkpoint_directory_identity(checkpoint: Path) -> tuple[int, int]:
    if checkpoint.is_symlink():
        raise StagingError(f"Checkpoint must not be a symlink: {checkpoint}")
    try:
        info = checkpoint.stat(follow_symlinks=False)
    except OSError as error:
        raise StagingError(f"Cannot stat checkpoint {checkpoint}: {error}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise StagingError(f"Checkpoint is not a real directory: {checkpoint}")
    return info.st_dev, info.st_ino


def find_checkpoint_by_identity(
    backup_root: Path,
    identity: tuple[int, int],
) -> Path | None:
    root = resolve_managed_backup_root(backup_root)
    try:
        children = list(root.iterdir())
    except OSError as error:
        raise StagingError(f"Cannot inspect managed backup root {root}: {error}") from error
    matches: list[Path] = []
    for child in children:
        if child.is_symlink():
            continue
        try:
            info = child.stat(follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == identity:
            matches.append(child)
    if len(matches) > 1:
        raise StagingError(f"Checkpoint identity is ambiguous under {root}: {matches}")
    return matches[0] if matches else None


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


def parse_runtime_lock(lock_file: Path) -> tuple[int, int]:
    try:
        payload = json.loads(lock_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StagingError(f"Runtime lock is missing or invalid: {lock_file}: {error}") from error
    pid = payload.get("pid") if isinstance(payload, dict) else None
    started_at = payload.get("startedAt") if isinstance(payload, dict) else None
    if not isinstance(pid, int) or pid <= 0 or not isinstance(started_at, int) or started_at <= 0:
        raise StagingError(f"Runtime lock has invalid pid/startedAt: {lock_file}")
    return pid, started_at


def process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # If the OS refuses inspection, fail closed and treat the PID as live.
        return True


def bundle_processes(app: Path, runner: Runner = run_command) -> list[tuple[int, str]]:
    prefix = str(app.resolve()) + "/Contents/"
    result = runner(["/bin/ps", "-axo", "pid=,command="])
    found: list[tuple[int, str]] = []
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        pid_text, separator, command = line.partition(" ")
        if separator and pid_text.isdigit() and prefix in command:
            found.append((int(pid_text), command))
    return found


def assert_application_stopped(app: Path, lock_file: Path, runner: Runner = run_command) -> None:
    processes = bundle_processes(app, runner)
    if processes or lock_file.exists():
        raise StagingError(
            "Robb Agents reopened before the atomic exchange; transaction aborted. "
            f"Remaining processes={processes}, runtimeLockExists={lock_file.exists()}"
        )


def wait_until_stopped(
    app: Path,
    lock_file: Path,
    *,
    timeout: float,
    runner: Runner = run_command,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not bundle_processes(app, runner) and not lock_file.exists():
            return
        time.sleep(0.25)
    processes = bundle_processes(app, runner)
    raise StagingError(
        "Robb Agents did not stop cleanly; no files were exchanged. "
        f"Remaining processes={[(pid, command) for pid, command in processes]}, "
        f"runtimeLockExists={lock_file.exists()}"
    )


def quit_application(
    app: Path,
    lock_file: Path,
    *,
    timeout: float,
    runner: Runner = run_command,
) -> None:
    live_lock = False
    if lock_file.exists():
        try:
            lock_pid, _ = parse_runtime_lock(lock_file)
            live_lock = process_is_alive(lock_pid)
        except StagingError:
            # Keep the unparsable lock as a blocker, but do not launch an app
            # merely by sending it an Apple Event.
            live_lock = False
    if bundle_processes(app, runner) or live_lock:
        runner(
            ["/usr/bin/osascript", "-e", f'tell application id "{APP_ID}" to quit'],
            check=False,
            timeout=max(5, timeout),
        )
    wait_until_stopped(app, lock_file, timeout=timeout, runner=runner)


def verify_runtime(
    app: Path,
    lock_file: Path,
    *,
    launched_after_ms: int,
    timeout: float,
    runner: Runner = run_command,
) -> dict[str, int | str]:
    expected_executable = str(app.resolve() / "Contents/MacOS/Robb Agents")
    deadline = time.monotonic() + timeout
    last_error = "runtime did not create its production-profile lock"
    while time.monotonic() < deadline:
        try:
            pid, started_at = parse_runtime_lock(lock_file)
            if started_at < launched_after_ms:
                last_error = f"runtime lock is stale ({started_at} < {launched_after_ms})"
            elif not process_is_alive(pid):
                last_error = f"runtime pid {pid} is not alive"
            else:
                command = runner(["/bin/ps", "-p", str(pid), "-o", "command="]).stdout.strip()
                if command == expected_executable or command.startswith(expected_executable + " "):
                    return {"pid": pid, "startedAt": started_at, "command": command}
                last_error = f"runtime pid {pid} is not the installed target: {command!r}"
        except StagingError as error:
            last_error = str(error)
        time.sleep(0.25)
    raise StagingError(f"Installed runtime verification failed: {last_error}")


def launch_and_verify_runtime(
    app: Path,
    profile_root: Path,
    *,
    timeout: float,
    runner: Runner = run_command,
) -> dict[str, int | str]:
    lock_file = profile_root.resolve() / "robb-electron/.server.lock"
    launched_after_ms = int(time.time() * 1000)
    runner(["/usr/bin/open", str(app.resolve())])
    return verify_runtime(
        app,
        lock_file,
        launched_after_ms=launched_after_ms,
        timeout=timeout,
        runner=runner,
    )


def safe_remove_partial(path: Path, target_parent: Path) -> None:
    if not path.exists():
        return
    resolved_parent = path.parent.resolve()
    if resolved_parent != target_parent.resolve() or not path.name.startswith(".partial-robb-staging-"):
        raise StagingError(f"Refusing to clean unexpected staging path: {path}")
    shutil.rmtree(path)
    if path.exists():
        raise StagingError(f"Transaction directory still exists after cleanup: {path}")


def cleanup_partial_best_effort(path: Path, target_parent: Path) -> str | None:
    try:
        safe_remove_partial(path, target_parent)
    except BaseException as error:
        return f"Transaction directory remains at {path}: {error}"
    return None


def rollback_exchange(target: Path, previous: Path, failed: Path, swapper: Swapper) -> None:
    if not previous.exists():
        raise StagingError(f"Immediate rollback bundle is missing: {previous}")
    if failed.exists():
        raise StagingError(f"Refusing to overwrite failed-candidate evidence: {failed}")
    if not target.exists():
        raise StagingError(f"Installed candidate is missing: {target}")
    # The first operation restores the old app atomically. Evidence is moved
    # only afterwards, so an interruption cannot leave the target absent.
    swapper(target, previous)
    try:
        os.replace(previous, failed)
    except OSError as error:
        raise StagingError(
            f"Previous app was restored, but failed-candidate evidence remains at {previous}: {error}"
        ) from error


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
        require_candidate_adhoc: bool = True,
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
            require_adhoc=require_candidate_adhoc,
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
        self,
        candidate_app: Path,
        expected_commit: str,
        artifact_commit: str,
        *,
        require_candidate_adhoc: bool,
    ) -> dict[str, object]:
        preflight = self.preflight(
            candidate_app,
            expected_commit,
            artifact_commit,
            require_candidate_adhoc=require_candidate_adhoc,
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

    def install(self, candidate_app: Path, expected_commit: str) -> dict[str, object]:
        commit = require_exact_commit(expected_commit)
        with exclusive_file_lock(self.transaction_lock_file):
            return self._install_locked(
                candidate_app,
                commit,
                commit,
                require_candidate_adhoc=True,
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
                    require_candidate_adhoc=False,
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
