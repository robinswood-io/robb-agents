"""Capture the failing Linux checks before the full canonical qualification."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from robinswood_quality_ci import bootstrap_rtk, git_value


def main() -> int:
    root = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    temporary = Path(os.environ["RUNNER_TEMP"]).resolve()
    bootstrap_rtk(temporary)
    exclude = Path(git_value(["rev-parse", "--git-path", "info/exclude"], root))
    if not exclude.is_absolute():
        exclude = root / exclude
    with exclude.open("a") as stream:
        stream.write("\n/.quality-rulebook/\n")
    output = temporary / "robb-public-quality"
    output.mkdir(mode=0o700, exist_ok=True)
    environment = dict(os.environ)
    environment["CRAFT_CONFIG_DIR"] = str(temporary / "robb-platform-test-profile")
    commands = {
        "linux-platform-tests": ["bun", "run", "test"],
        "dependencies": ["python3", "scripts/check_workspace_dependencies.py"],
    }
    failed = 0
    for name, command in commands.items():
        result = subprocess.run(
            command, cwd=root, env=environment, capture_output=True, text=True,
            timeout=600, check=False,
        )
        (output / (name + ".log")).write_text(result.stdout + result.stderr)
        print(name, "exit_code", result.returncode, flush=True)
        if result.returncode:
            failed = result.returncode
    return failed


if __name__ == "__main__":
    raise SystemExit(main())
