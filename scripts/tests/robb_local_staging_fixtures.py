import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable, Generator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import cast
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "robb_local_staging.py"
sys.path.insert(0, str(SCRIPT.parent))
try:
    import robb_local_staging as staging
finally:
    _ = sys.path.pop(0)


_DEFAULT_RETURN_VALUE = cast(object, mock.DEFAULT)


@contextmanager
def patch_staging(name: str, *, return_value: object = _DEFAULT_RETURN_VALUE, side_effect: object = None) -> Generator[mock.Mock]:
    """Inject the same native fault into each module that binds this function."""
    original = cast(object, getattr(staging, name))
    owners = [sys.modules[module] for module in (
        'robb_staging_common', 'robb_staging_bundles', 'robb_staging_checkpoints',
        'robb_staging_publication', 'robb_staging_runtime', 'robb_staging_transaction',
    ) if getattr(sys.modules[module], name, None) is original]
    with ExitStack() as stack:
        patched = cast(mock.Mock, stack.enter_context(mock.patch.object(
            staging, name, return_value=return_value, side_effect=side_effect,
        )))
        for owner in owners:
            _ = cast(object, stack.enter_context(mock.patch.object(owner, name, patched)))
        yield patched


COMMIT = "a" * 40


def completed(stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def fingerprint(app: Path) -> dict[str, str]:
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


def validation_fingerprint(_repo: Path, app: Path, **_kwargs: object) -> dict[str, str]:
    return fingerprint(app)


def completed_command(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
    return completed()


def checkpoint_listing(root: Path, *_args: object, **_kwargs: object) -> dict[str, object]:
    return {"apply": True, "kept": [path.name for path in root.iterdir()
                                    if staging.CHECKPOINT_NAME_RE.fullmatch(path.name)]}


class GitRunner:
    def __init__(self, *, status: str = "", commit: str = COMMIT) -> None:
        self.status: str = status
        self.commit: str = commit

    def __call__(self, args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        if args[1:3] == ["status", "--porcelain"]:
            return completed(self.status)
        if args[1:3] == ["rev-parse", "HEAD"]:
            return completed(self.commit + "\n")
        raise AssertionError(args)


type StageCandidate = Callable[[Path, str], tuple[Path, Path, dict[str, str]]]


class LocalStagingTestCase(unittest.TestCase):
    def make_transaction(self, base: Path) -> tuple[staging.LocalStagingInstaller, Path, Path, Path, StageCandidate]:
        repo = base / "repo"
        repo.mkdir()
        (repo / "scripts").mkdir()
        retention_source = repo / "scripts/staging_retention.py"
        _ = retention_source.write_text("retention fixture\n", encoding="utf-8")
        installed_retention = base / "installed-staging-retention.py"
        _ = installed_retention.write_text("retention fixture\n", encoding="utf-8")
        target_parent = base / "Applications"
        target = target_parent / staging.APP_NAME
        candidate = repo / "candidate" / staging.APP_NAME
        backup_root = base / "backups"
        checkpoint = backup_root / "20260911-old"
        profile = base / "profile"
        for app, value in ((target, "old"), (candidate, "new"), (checkpoint / staging.APP_NAME, "old")):
            app.mkdir(parents=True)
            _ = (app / "marker").write_text(value, encoding="utf-8")
        def swapper(left: Path, right: Path) -> None:
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

        def stage_candidate(source: Path, _commit: str) -> tuple[Path, Path, dict[str, str]]:
            partial = Path(tempfile.mkdtemp(prefix=".partial-robb-staging-test-", dir=target_parent))
            staged = partial / staging.APP_NAME
            _ = shutil.copytree(source, staged)
            return partial, staged, fingerprint(staged)

        return installer, target, candidate, checkpoint, stage_candidate

__all__ = [
    'COMMIT',
    'GitRunner',
    'LocalStagingTestCase',
    'checkpoint_listing',
    'completed',
    'completed_command',
    'fingerprint',
    'patch_staging',
    'staging',
    'validation_fingerprint',
]
