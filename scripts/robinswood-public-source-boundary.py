#!/usr/bin/env python3
"""Reject known automatic model-routing implementations in the public tree.

This source boundary supplements review and manual-selection integration tests.
Historical provider/cost metadata and transport routing are intentionally allowed.
"""
from __future__ import annotations

import fnmatch
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_PATHS = (
    "packages/shared/src/config/routing-policy*",
    "packages/shared/src/config/routing-outcome*",
    "packages/shared/src/config/routing-shadow*",
    "packages/server-core/src/sessions/routing-runtime*",
    "packages/server-core/src/sessions/routing-fallback*",
    "packages/pi-agent-server/src/compaction-model-policy*",
    "packages/pi-agent-server/src/query-llm-model-policy*",
    "packages/pi-agent-server/src/pick-mini-model*",
    "packages/server-core/src/tasks/task-node-routing*",
    "packages/server-core/src/missions/mission-routing-ground-truth*",
    "apps/electron/src/renderer/pages/settings/routing-policy-editor*",
    "docs/robinswood/routing-policy*.json",
    "docs/robinswood/templates/client-workspace/routing-policy*.json",
    "ops/rbw-agents-oss/scripts/provider_routing_guard.py",
    "ops/rbw-agents-oss/config/agents-v2/generated/observability/provider-routing-guard.json",
)
FORBIDDEN_RUNTIME_SYMBOLS = re.compile(
    r"\b(?:resolveRoutingPolicy|simulateRoutingPolicy|classifyLocalRoutingRequirements|"
    r"decideAgentCostControl|RoutingOutcomeStore|buildRoutingShadowReport|"
    r"selectCompactionUtilityModel|applyRoutingFallback|"
    r"getSummarizationModel|getDefaultSummarizationModel)\b|provider[_-]routing[_-]guard"
)
RUNTIME_ROOTS = {"apps", "packages", "ops"}
SOURCE_EXTENSIONS = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".json"}


def violations(root: Path, paths: list[str]) -> list[str]:
    failures: list[str] = []
    for relative in sorted(set(paths)):
        path = root / relative
        if not path.is_file():
            continue  # A tracked file deleted by the candidate is absent.
        if any(fnmatch.fnmatchcase(relative, pattern) for pattern in FORBIDDEN_PATHS):
            failures.append(f"{relative}: automatic-routing implementation path")
            continue
        parts = Path(relative).parts
        if not parts or parts[0] not in RUNTIME_ROOTS or path.suffix not in SOURCE_EXTENSIONS:
            continue
        if any(part in {"tests", "__tests__"} for part in parts) or ".test." in path.name:
            continue  # Compatibility fixtures may name retired settings.
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            failures.append(f"{relative}: cannot inspect source ({type(exc).__name__})")
            continue
        match = FORBIDDEN_RUNTIME_SYMBOLS.search(text)
        if match:
            failures.append(f"{relative}: forbidden executable reference {match.group(0)}")
    return failures


def main() -> int:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        print("Public source boundary: unable to inventory candidate source", file=sys.stderr)
        return 1
    failures = violations(ROOT, [path for path in result.stdout.split("\0") if path])
    if failures:
        print("Public source boundary blocked:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print("Public source boundary passed: no known automatic model-routing implementation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
