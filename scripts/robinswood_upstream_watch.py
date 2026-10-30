"""Create a non-mutating review report for Craft Agents upstream changes."""
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
from datetime import UTC, datetime

from json_sources import read_json


def run(*args: str) -> str:
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or " ".join(args))
    return result.stdout.strip()


class WatchArguments(argparse.Namespace):
    baseline: pathlib.Path = pathlib.Path()
    upstream_ref: str = "upstream/main"
    output: pathlib.Path = pathlib.Path()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument("--baseline", type=pathlib.Path, required=True)
    _ = parser.add_argument("--upstream-ref", default="upstream/main")
    _ = parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args(namespace=WatchArguments())

    baseline = read_json(args.baseline)
    if not isinstance(baseline, dict):
        raise TypeError("Upstream baseline must be an object")
    reviewed_sha = baseline.get("reviewedUpstreamSha")
    if not isinstance(reviewed_sha, str):
        raise TypeError("reviewedUpstreamSha must be a string")
    upstream_sha = run("git", "rev-parse", args.upstream_ref)
    commits: list[str] = []
    relation = "unchanged"
    if upstream_sha != reviewed_sha:
        try:
            is_ancestor = subprocess.run(
                ["git", "merge-base", "--is-ancestor", reviewed_sha, upstream_sha], check=False
            ).returncode == 0
            if is_ancestor:
                relation = "ahead"
                commits = run("git", "log", "--format=%h %s", f"{reviewed_sha}..{upstream_sha}", "--max-count=100").splitlines()
            else:
                relation = "history-diverged"
        except RuntimeError:
            relation = "history-unavailable"

    report = [
        "# Craft Agents upstream watch",
        "",
        f"- Generated: {datetime.now(UTC).isoformat()}",
        f"- Reviewed upstream baseline: `{reviewed_sha}`",
        f"- Current upstream ref: `{upstream_sha}`",
        f"- Relation: **{relation}**",
        "- Policy: report-only; no upstream commit is merged, rebased or pushed automatically.",
        "",
        "## Review queue",
    ]
    if commits:
        report.extend(f"- `{commit}`" for commit in commits)
    elif relation == "unchanged":
        report.append("- No upstream change since the reviewed baseline.")
    else:
        report.append("- Review the upstream comparison manually; the stored baseline is not an ancestor of the fetched ref.")
    report.extend(["", "## Review policy", "See `docs/robinswood/upstream-pr-evaluation-2026-07-07.md` before selecting any change."])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    _ = args.output.write_text("\n".join(report) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"::error::{error}", file=sys.stderr)
        raise SystemExit(1)
