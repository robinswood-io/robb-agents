"""Run the private canonical controller against the exact trusted release checkout."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import subprocess
import tarfile
import urllib.request
from pathlib import Path

RTK_URL = (
    "https://github.com/rtk-ai/rtk/releases/download/v1.1.0/"
    "rtk-oss-x86_64-unknown-linux-musl.tar.gz"
)
RTK_SHA256 = "4dec94a64035e08189ae82fd5408fe4ae9ae27a665fc07e3e3ec3c4c2d8e8a3e"


def require_commit(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("Expected an immutable Git commit")
    return value


def bootstrap_rtk(temporary: Path) -> None:
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("This release quality job requires Linux x86_64")
    directory = temporary / "robb-quality-rtk"
    directory.mkdir(mode=0o700, exist_ok=True)
    archive = directory / "rtk.tar.gz"
    with urllib.request.urlopen(RTK_URL, timeout=60) as response:
        archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != RTK_SHA256:
        raise ValueError("RTK archive integrity failure")
    with tarfile.open(archive) as bundle:
        candidates = [entry for entry in bundle.getmembers() if entry.name in {"rtk", "./rtk"}]
        if len(candidates) != 1 or not candidates[0].isfile():
            raise ValueError("Unexpected RTK archive")
        source = bundle.extractfile(candidates[0])
        if source is None:
            raise ValueError("RTK binary missing")
        binary = directory / "rtk"
        binary.write_bytes(source.read())
        binary.chmod(0o700)
    os.environ["PATH"] = str(directory) + os.pathsep + os.environ["PATH"]


def execute(argv: list[str], root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["rtk", *argv], cwd=root, capture_output=True, text=True,
        timeout=2400, check=False,
    )


def git_value(args: list[str], root: Path) -> str:
    result = execute(["git", *args], root)
    if result.returncode:
        raise ValueError("Git verification failed")
    return result.stdout.strip()


def main() -> int:
    root = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    temporary = Path(os.environ["RUNNER_TEMP"]).resolve()
    expected = require_commit(os.environ["ROBB_EXPECTED_SOURCE_COMMIT"])
    controller_commit = require_commit(os.environ["ROBB_RULEBOOK_COMMIT"])
    controller = root / ".quality-rulebook"
    bootstrap_rtk(temporary)
    if git_value(["rev-parse", "HEAD"], root) != expected:
        raise ValueError("Release source commit differs from preflight")
    if git_value(["rev-parse", "HEAD"], controller) != controller_commit:
        raise ValueError("Private controller commit differs from pinned revision")
    exclude = Path(git_value(["rev-parse", "--git-path", "info/exclude"], root))
    if not exclude.is_absolute():
        exclude = root / exclude
    exclude.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude.read_text() if exclude.exists() else ""
    if "/.quality-rulebook/" not in existing.splitlines():
        exclude.write_text(existing + "\n/.quality-rulebook/\n")
    os.environ["CRAFT_CONFIG_DIR"] = str(temporary / "robb-quality-test-profile")
    validation = execute(["bun", "run", "validate:versions"], root)
    (temporary / "robb-release-validation.log").write_text(validation.stdout + validation.stderr)
    if validation.returncode:
        print("Release source/installer validation failed; publication remains blocked.")
        print((validation.stdout + validation.stderr)[-4000:])
        return validation.returncode
    gate = controller / "scripts/bmad/quality_gate.py"
    result = execute(["python3", str(gate), "run", str(root)], root)
    # Private rule contents and the full report stay out of public build logs/artifacts.
    report_text = (root / "bmad/quality-evidence.json").read_text()
    (temporary / "robb-canonical-quality.json").write_text(report_text)
    report: object = json.loads(report_text)
    if not isinstance(report, dict):
        raise TypeError("Canonical controller returned an invalid report")
    checks = report.get("checks")
    summary = []
    if isinstance(checks, list):
        for check in checks:
            if isinstance(check, dict):
                summary.append({"name": check.get("name"), "exit_code": check.get("exit_code")})
    public = temporary / "robb-public-quality"
    public.mkdir(mode=0o700, exist_ok=True)
    if isinstance(checks, list):
        for check in checks:
            if isinstance(check, dict) and check.get("name") == "tests":
                diagnostic = check.get("summary")
                if isinstance(diagnostic, str):
                    (public / "tests-summary.txt").write_text(diagnostic)
                    if check.get("exit_code") != 0:
                        print("Synthetic test failure:\n" + diagnostic)
    workers = root / "bmad/quality-logs/typescript-workers.jsonl"
    if workers.is_file() and not workers.is_symlink():
        (public / "typescript-workers.jsonl").write_bytes(workers.read_bytes())
    print(json.dumps({"state": report.get("state"), "checks": summary}))
    if result.returncode:
        print("Canonical quality run failed; publication remains blocked.")
        return result.returncode
    if report.get("state") != "PASS":
        raise ValueError("Canonical controller did not return PASS")
    verified = execute(["python3", str(gate), "verify", str(root)], root)
    if verified.returncode:
        print("Canonical quality verify failed; publication remains blocked.")
        return verified.returncode
    if git_value(["rev-parse", "HEAD"], root) != expected:
        raise ValueError("Release commit changed during checks")
    print(json.dumps({"state": "PASS", "source_commit": expected,
                      "controller_commit": controller_commit}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
