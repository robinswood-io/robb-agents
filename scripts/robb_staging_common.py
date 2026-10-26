from __future__ import annotations

from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import math
import os
from pathlib import Path
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
