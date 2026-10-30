"""Read-only deployment audit of the historical commercial containment baseline.

This command requires deployed OPS reports and private profiles. Missing inputs
are failures, never skipped checks. It neither dispatches nor mutates CRM data.
Synthetic tests qualify its behavior without asserting that deployment is ready.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path

import flow_structural_commerce as commerce
import flow_structural_reports as reports
import flow_structural_runtime as runtime
import robinswood_flow_core as core
from flow_structural_checks import Report, canonical_contacts_valid, check

__all__ = ["canonical_contacts_valid", "run_tests"]
R = Path(os.environ.get("RBW_OSS_ROOT", str(Path(__file__).resolve().parents[1])))
STAGES: tuple[tuple[str, Callable[[Path], list[Report]]], ...] = (
    ("compilation", runtime.compilation),
    ("deployment", runtime.deployment),
    ("pure_behavior", runtime.pure_checks),
    ("reply_safety", runtime.reply_safety),
    ("crm_plans", runtime.crm_plans),
    ("schedules", runtime.schedules),
    ("post_remediation", commerce.post_remediation),
    ("recovery", commerce.recovery),
    ("lane_diagnostic", commerce.lane_diagnostic),
    ("duplicate_audit", commerce.duplicate_audit),
    ("report_policy", commerce.report_policy),
    ("hdf_containment", commerce.hdf_containment),
    ("attribution", commerce.attribution),
    ("learning", commerce.learning),
    ("accounts", reports.accounts),
    ("task_due", reports.task_due),
    ("queues", reports.queues),
    ("preaudits", reports.preaudits),
    ("approvals", reports.approvals),
    ("crm_integrity", reports.crm_integrity),
    ("retry_dates", reports.retry_dates),
)


def run_tests() -> int:
    checks: list[Report] = []
    for name, function in STAGES:
        try:
            result = function(R)
            checks.extend(result or [check(name, False, "no_checks_returned")])
        except (
            OSError,
            ValueError,
            TypeError,
            RuntimeError,
            KeyError,
            StopIteration,
            ImportError,
        ) as exc:
            checks.append(check(name, False, type(exc).__name__))
    passed = sum(row.get("ok") is True for row in checks)
    ok = bool(checks) and passed == len(checks)
    counts: Report = {
        "checks": len(checks),
        "passed": passed,
        "failed": len(checks) - passed,
        "externalSends": 0,
        "crmMutations": 0,
        "opportunitiesCreated": 0,
    }
    payload: Report = {
        "generatedAt": core.now(),
        "contractVersion": "robinswood-flow-structural-tests-v7-private-baseline",
        "capabilityId": "robinswood-flow-guard-tests",
        "scope": "historical_commercial_containment",
        "ok": ok,
        "status": "passed" if ok else "failed",
        "counts": counts,
        "checks": [row for row in checks],
        "testResults": [row for row in checks],
    }
    core.save(core.OPS / "robinswood-flow-guard-tests-last.json", payload)
    _ = (core.OPS / "robinswood-flow-guard-tests-last.md").write_text(
        f"# Commerce structural tests\n\n- Passed: **{passed}/{len(checks)}**\n"
        + "- Scope: historical commercial containment\n- External sends: **0**\n"
        + "- CRM mutations from tests: **0**\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "ok": ok,
                "status": payload["status"],
                "counts": counts,
                "failed": [row["name"] for row in checks if row.get("ok") is not True],
            },
            ensure_ascii=False,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(run_tests())
