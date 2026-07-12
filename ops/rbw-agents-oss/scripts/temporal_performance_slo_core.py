#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import os
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean
from typing import Any

ROOT = Path("/srv/rbw-agents-oss")
OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
RUN_LOG = ROOT / "logs" / "workflow-runs.jsonl"
OUT_JSON = OPS / "temporal-performance-slo-last.json"
OUT_MD = OPS / "temporal-performance-slo-last.md"
ACTION_QUEUE = OPS / "temporal-performance-slo-action-queue.json"
ARCHITECTURE_V2_BASELINE = ROOT / "config" / "agents-v2" / "baseline.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_ts(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def tail_jsonl(path: Path, limit: int = 12000) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: deque[str] = deque(maxlen=limit)
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if line.strip():
                rows.append(line)
    out: list[dict[str, Any]] = []
    for raw in rows:
        try:
            value = json.loads(raw)
        except Exception:
            continue
        if isinstance(value, dict):
            out.append(value)
    return out


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil((pct / 100.0) * len(ordered)) - 1))
    return round(float(ordered[index]), 3)


def main() -> None:
    horizon_hours = float(os.getenv("TEMPORAL_PERFORMANCE_SLO_HORIZON_HOURS", "2"))
    horizon_cutoff = datetime.now(timezone.utc) - timedelta(hours=horizon_hours)
    cutover_at = parse_ts(os.getenv("TEMPORAL_PERFORMANCE_SLO_CUTOVER_AT"))
    if cutover_at is None and ARCHITECTURE_V2_BASELINE.exists():
        try:
            baseline = json.loads(ARCHITECTURE_V2_BASELINE.read_text(encoding="utf-8"))
            cutover_at = parse_ts(baseline.get("generatedAt"))
        except Exception:
            cutover_at = None
    cutoff = max(horizon_cutoff, cutover_at) if cutover_at is not None else horizon_cutoff
    pre_cutover_runs_excluded = 0
    rows = []
    for row in tail_jsonl(RUN_LOG):
        ts = parse_ts(row.get("completedAt") or row.get("ts"))
        if ts is not None and cutover_at is not None and horizon_cutoff <= ts < cutover_at:
            pre_cutover_runs_excluded += 1
        if ts is None or ts < cutoff:
            continue
        result = row.get("result") if isinstance(row.get("result"), dict) else {}
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        legacy_id = row.get("legacyId") or payload.get("legacy_id")
        if not legacy_id:
            continue
        rows.append((str(legacy_id), ts, result, row))

    grouped: dict[str, list[tuple[datetime, dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    for legacy_id, ts, result, row in rows:
        grouped[legacy_id].append((ts, result, row))

    profiles: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    for legacy_id, values in sorted(grouped.items()):
        durations = [float(result.get("durationSeconds") or row.get("durationSeconds") or 0) for _ts, result, row in values]
        business_failures = sum(1 for _ts, result, _row in values if result.get("businessFailure"))
        timeouts = sum(1 for _ts, result, _row in values if result.get("timeout"))
        technical_failures = sum(
            1
            for _ts, result, _row in values
            if not result.get("businessFailure")
            and (
                result.get("timeout")
                or result.get("errorType")
                or (result.get("ok") is False and int(result.get("exitCode") or 0) != 0)
            )
        )
        profile = {
            "legacyId": legacy_id,
            "runs": len(values),
            "technicalFailures": technical_failures,
            "businessFailures": business_failures,
            "timeouts": timeouts,
            "avgSeconds": round(mean(durations), 3) if durations else 0.0,
            "p95Seconds": percentile(durations, 95),
            "maxSeconds": round(max(durations), 3) if durations else 0.0,
            "lastRunAt": max(ts for ts, _result, _row in values).isoformat().replace("+00:00", "Z"),
        }
        profiles.append(profile)
        if timeouts >= 2 or technical_failures >= 3:
            reasons = []
            if timeouts >= 2:
                reasons.append("repeated_activity_timeouts")
            if technical_failures >= 3:
                reasons.append("repeated_technical_failures")
            actions.append({
                "id": f"temporal-performance-slo:{legacy_id}",
                "dedupeKey": f"temporal-performance-slo:{legacy_id}",
                "originAutomation": "temporal-performance-slo-guard",
                "owner": "oss-performance-governor",
                "actionType": "investigate_wrapper_runtime_regression",
                "priority": "high" if timeouts else "medium",
                "severity": "high" if timeouts else "medium",
                "actionableNow": True,
                "target": legacy_id,
                "reasons": reasons,
                "metrics": profile,
                "doneCondition": "Two consecutive technical-success runs with no timeout and no worker starvation evidence.",
            })

    generated_at = now_iso()
    status = "watch" if actions else "processed"
    report = {
        "generatedAt": generated_at,
        "contractVersion": "temporal-performance-slo-guard-v2",
        "capabilityId": "temporal-performance-slo-guard",
        "ok": True,
        "status": status,
        "summary": f"temporal_performance_slo_v2: horizonHours={horizon_hours:g} runs={len(rows)} wrappers={len(profiles)} technicalActions={len(actions)}",
        "counts": {
            "horizonHours": horizon_hours,
            "runs": len(rows),
            "wrappers": len(profiles),
            "technicalFailures": sum(int(profile["technicalFailures"]) for profile in profiles),
            "businessFailuresExcluded": sum(int(profile["businessFailures"]) for profile in profiles),
            "timeouts": sum(int(profile["timeouts"]) for profile in profiles),
            "actions": len(actions),
            "watchActions": len(actions),
            "preCutoverRunsExcluded": pre_cutover_runs_excluded,
        },
        "blockingReasons": [],
        "warningReasons": ["technical_slo_actions_present"] if actions else [],
        "actions": actions,
        "artifacts": {
            "businessReportJson": str(OUT_JSON),
            "businessReportMd": str(OUT_MD),
            "actionQueue": str(ACTION_QUEUE),
            "sourceLog": str(RUN_LOG),
        },
        "checks": {
            "sourceLogExists": RUN_LOG.exists(),
            "horizonCutoff": horizon_cutoff.isoformat().replace("+00:00", "Z"),
            "effectiveCutoff": cutoff.isoformat().replace("+00:00", "Z"),
            "cutoverBoundary": cutover_at.isoformat().replace("+00:00", "Z") if cutover_at else None,
            "cutoverBoundarySource": str(ARCHITECTURE_V2_BASELINE) if cutover_at else None,
            "preCutoverRunsExcludedFromActiveActions": pre_cutover_runs_excluded,
            "technicalFailureSemantics": "timeouts/errors/non-business nonzero exits only",
            "businessFailuresExcludedFromTemporalSlo": True,
        },
        "data": {"profiles": profiles},
        "updatedBy": "temporal-performance-slo-core-v2",
    }
    OPS.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    ACTION_QUEUE.write_text(json.dumps({"generatedAt": generated_at, "items": actions, "recoveredItems": [], "counts": {"items": len(actions), "recoveredItems": 0}}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OUT_MD.write_text(
        "# Temporal Performance SLO v2\n\n"
        f"- status: {status}\n"
        f"- horizon: {horizon_hours:g}h\n"
        f"- runs / wrappers: {len(rows)} / {len(profiles)}\n"
        f"- technical actions: {len(actions)}\n"
        f"- business failures excluded: {report['counts']['businessFailuresExcluded']}\n",
        encoding="utf-8",
    )
    print(json.dumps({"ok": True, "status": status, "summary": report["summary"], "counts": report["counts"], "reportJson": str(OUT_JSON)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
