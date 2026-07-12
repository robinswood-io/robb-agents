#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path("/srv/rbw-agents-oss")
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "scripts"))

from lib.config_mutation import ConfigMutation, now_iso
from rbw_agent_runtime.catalog import CatalogCompiler

MANIFEST = ROOT / "config/command-manifest.json"
SIDE_EFFECTS = ROOT / "config/registry/side-effects-policy.json"
PYTHON = str(ROOT / ".venv/bin/python")
SCRIPT = str(ROOT / "scripts/oss_runtime_v2_queue_canary.py")
OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
QUEUES = ("default", "watchdog", "campaigns", "sync", "ao")
SECTION = "runtimeV2QueueCanaries"
PREFIX = "oss-runtime-v2-queue-canary-"


def rows(data: dict) -> list[dict]:
    return [row for values in data.values() if isinstance(values, list) for row in values if isinstance(row, dict) and row.get("legacy_id")]


def side_effect_rows(data: dict) -> tuple[str, list[dict]]:
    if isinstance(data.get("capabilities"), list):
        return "capabilities", data["capabilities"]
    if isinstance(data.get("rows"), list):
        return "rows", data["rows"]
    data["capabilities"] = []
    return "capabilities", data["capabilities"]


def install() -> dict:
    with ConfigMutation("architecture-v2-five-queue-canary-install") as mut:
        manifest = mut.load_json(MANIFEST, {})
        side = mut.load_json(SIDE_EFFECTS, {})
        existing = rows(manifest)
        if len(existing) != 193 or any((row.get("execution") or {}).get("backend") != "argv" for row in existing):
            raise RuntimeError("canary install requires final 193-row argv-only manifest")
        if manifest.get(SECTION):
            raise RuntimeError("queue canaries already installed")
        manifest[SECTION] = []
        policy_key, policies = side_effect_rows(side)
        policy_ids = {str(row.get("legacy_id") or row.get("capability_id")) for row in policies if isinstance(row, dict)}
        for queue in QUEUES:
            legacy_id = PREFIX + queue
            report = str(OPS / f"oss-runtime-v2-queue-canary-{queue}-last.json")
            argv = [PYTHON, SCRIPT, "--queue", queue]
            manifest[SECTION].append({
                "legacy_id": legacy_id, "name": f"OSS Runtime v2 — {queue} queue canary", "mode": "script",
                "command": " ".join(argv), "execution": {"backend": "argv", "argv": argv, "cwd": str(ROOT), "timeout_seconds": 60},
                "runtimeVersion": "v2", "timeout_seconds": 60, "cutover_ready": True, "triggerType": "ManualDirectOnly",
                "task_queue": queue, "riskClass": "low_observability", "sideEffects": ["filesystem-write:test-report"],
                "expectsReport": True, "reportJsonPath": report, "runtimeReportJsonPath": str(OPS / "runtime-v2" / f"{legacy_id}-last.json"),
                "contractVersion": "runtime-v2-queue-canary-v1",
            })
            if legacy_id not in policy_ids:
                policies.append({
                    "legacy_id": legacy_id, "classified": True, "policyClass": "runtime_v2_queue_canary",
                    "mutationMode": "observability_report_only", "scheduleAllowed": False,
                    "requiresHumanApprovalForApply": False, "requiresHumanApprovalForExternalSend": False,
                    "requiresExplicitReviewBeforeRiskIncrease": True, "updatedAt": now_iso(), "updatedBy": "oss-runtime-v2-queue-canary-manage",
                })
        side[policy_key] = policies
        manifest["updatedAt"] = now_iso(); manifest["updatedBy"] = "oss-runtime-v2-queue-canary-install"
        side["updatedAt"] = now_iso(); side["updatedBy"] = "oss-runtime-v2-queue-canary-install"
        mut.write_json(MANIFEST, manifest); mut.write_json(SIDE_EFFECTS, side)
        build = CatalogCompiler(ROOT).build(write_fragments=True); validation = CatalogCompiler(ROOT).validate()
        if not validation.get("ok") or int((validation.get("counts") or {}).get("agents") or 0) != 198:
            raise RuntimeError(f"canary catalog invalid: {validation}")
        backups = dict(mut.backups)
    return {"ok": True, "status": "installed", "counts": {"base": 193, "canaries": 5, "manifest": 198}, "catalog": build, "validation": validation, "backups": backups}


def cleanup() -> dict:
    with ConfigMutation("architecture-v2-five-queue-canary-cleanup") as mut:
        manifest = mut.load_json(MANIFEST, {})
        side = mut.load_json(SIDE_EFFECTS, {})
        removed = len(manifest.get(SECTION, [])) if isinstance(manifest.get(SECTION), list) else 0
        manifest.pop(SECTION, None)
        policy_key, policies = side_effect_rows(side)
        before = len(policies)
        policies = [row for row in policies if not str(row.get("legacy_id") or row.get("capability_id") or "").startswith(PREFIX)]
        side[policy_key] = policies
        manifest["updatedAt"] = now_iso(); manifest["updatedBy"] = "oss-runtime-v2-queue-canary-cleanup"
        side["updatedAt"] = now_iso(); side["updatedBy"] = "oss-runtime-v2-queue-canary-cleanup"
        mut.write_json(MANIFEST, manifest); mut.write_json(SIDE_EFFECTS, side)
        build = CatalogCompiler(ROOT).build(write_fragments=True); validation = CatalogCompiler(ROOT).validate()
        counts = validation.get("counts") or {}
        if not validation.get("ok") or int(counts.get("agents") or 0) != 193 or int(counts.get("argv") or 0) != 193 or int(counts.get("legacyShell") or 0) != 0:
            raise RuntimeError(f"final catalog invalid after canary cleanup: {validation}")
        backups = dict(mut.backups)
    return {"ok": True, "status": "cleaned", "counts": {"removedManifestCanaries": removed, "removedPolicyRows": before - len(policies), "manifest": 193}, "catalog": build, "validation": validation, "backups": backups}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("install", "cleanup"))
    args = parser.parse_args()
    result = install() if args.action == "install" else cleanup()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
