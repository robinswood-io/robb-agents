#!/usr/bin/env python3
"""Fail closed before changing the Robb Agents repository to public visibility.

This is deliberately a narrow complement to dedicated secret scanners. It checks
tracked HEAD content and the history reachable from the candidate public branch
for known legacy private-distribution markers that must never become public.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Check:
    label: str
    pattern: str


LEGACY_PRIVATE_MARKERS = (
    Check("legacy password-manager references", r"op://|Dev_Craft_Agents"),
    Check("legacy private updater endpoint", r"agents\.robinswood\.io"),
    Check("legacy internal service endpoint", r"rbw\.ovh|mycompanyfiles"),
)

SECRET_MARKERS = (
    Check("private key material", r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    Check("AWS access key", r"AKIA[0-9A-Z]{16}"),
    Check("GitHub token", r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    Check("Slack token", r"xox[baprs]-[A-Za-z0-9-]+"),
)

# These locations contain security fixtures that intentionally name forbidden
# values to assert their absence. Production code, build scripts, workflows,
# and documentation remain in scope.
AUDIT_EXCLUDES = (
    ":(exclude)**/__tests__/**",
    ":(exclude)**/tests/**",
    ":(exclude)scripts/robinswood-validate.py",
    ":(exclude)scripts/robinswood-public-preflight.py",
)


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


def tracked_matches(pattern: str) -> bool:
    # `-e` prevents a pattern beginning with dashes (for example a PEM header)
    # from being interpreted as a git-grep option.
    result = run(
        "git",
        "grep",
        "-I",
        "-E",
        "-n",
        "-e",
        pattern,
        "--",
        ".",
        *AUDIT_EXCLUDES,
    )
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr.strip() or "git grep failed")
    return result.returncode == 0


def history_matches(ref: str, pattern: str) -> bool:
    result = run("git", "log", ref, "-G", pattern, "--format=%H", "--", ".", *AUDIT_EXCLUDES)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git log failed")
    return bool(result.stdout.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD", help="candidate branch/ref to audit (default: HEAD)")
    args = parser.parse_args()

    failures: list[str] = []
    for check in (*LEGACY_PRIVATE_MARKERS, *SECRET_MARKERS):
        if tracked_matches(check.pattern):
            failures.append(f"tracked content contains {check.label}")
        if history_matches(args.ref, check.pattern):
            failures.append(f"history reachable from {args.ref} contains {check.label}")

    if failures:
        print("Public-visibility preflight blocked:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        print(
            "Remediate the current tree and reachable history, then rerun this command before changing repository visibility.",
            file=sys.stderr,
        )
        return 1

    print(f"✓ Public-visibility preflight passed for {args.ref}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
