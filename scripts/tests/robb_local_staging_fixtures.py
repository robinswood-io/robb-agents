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


SCRIPT = Path(__file__).parents[1] / "robb-local-staging.py"
SPEC = importlib.util.spec_from_file_location("robb_local_staging", SCRIPT)
staging = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(staging)


COMMIT = "a" * 40


def completed(stdout="", stderr="", returncode=0):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def fingerprint(app: Path):
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


class GitRunner:
    def __init__(self, *, status="", commit=COMMIT):
        self.status = status
        self.commit = commit

    def __call__(self, args, **_kwargs):
        if args[1:3] == ["status", "--porcelain"]:
            return completed(self.status)
        if args[1:3] == ["rev-parse", "HEAD"]:
            return completed(self.commit + "\n")
        raise AssertionError(args)


class LocalStagingTestCase(unittest.TestCase):
    def make_transaction(self, base: Path):
        repo = base / "repo"
        repo.mkdir()
        (repo / "scripts").mkdir()
        retention_source = repo / "scripts/staging-retention.py"
        retention_source.write_text("retention fixture\n", encoding="utf-8")
        installed_retention = base / "installed-staging-retention.py"
        installed_retention.write_text("retention fixture\n", encoding="utf-8")
        target_parent = base / "Applications"
        target = target_parent / staging.APP_NAME
        candidate = repo / "candidate" / staging.APP_NAME
        backup_root = base / "backups"
        checkpoint = backup_root / "20260911-old"
        profile = base / "profile"
        for app, value in ((target, "old"), (candidate, "new"), (checkpoint / staging.APP_NAME, "old")):
            app.mkdir(parents=True)
            (app / "marker").write_text(value, encoding="utf-8")
        def swapper(left, right):
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

        def stage_candidate(source, commit):
            partial = Path(tempfile.mkdtemp(prefix=".partial-robb-staging-test-", dir=target_parent))
            staged = partial / staging.APP_NAME
            shutil.copytree(source, staged)
            return partial, staged, fingerprint(staged)

        return installer, target, candidate, checkpoint, stage_candidate
