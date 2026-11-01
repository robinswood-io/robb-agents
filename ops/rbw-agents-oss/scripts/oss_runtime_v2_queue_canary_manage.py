#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import JsonValue, TypeAdapter

ROOT = Path("/srv/rbw-agents-oss")
sys.path.insert(0, str(ROOT / "packages"))
sys.path.insert(0, str(ROOT / "scripts"))

from lib.config_mutation import ConfigMutation, expected_manifest_count, now_iso
from rbw_agent_runtime.catalog import CatalogCompiler

JSON_OBJECT = TypeAdapter(dict[str, JsonValue])
JSON_ROWS = TypeAdapter(list[dict[str, JsonValue]])
INTEGER = TypeAdapter(int)
MANIFEST = ROOT / "config/command-manifest.json"
SIDE_EFFECTS = ROOT / "config/registry/side-effects-policy.json"
PYTHON = str(ROOT / ".venv/bin/python")
SCRIPT = str(ROOT / "scripts/oss_runtime_v2_queue_canary.py")
OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
QUEUES = ("default", "watchdog", "campaigns", "sync", "ao")
SECTION = "runtimeV2QueueCanaries"
PREFIX = "oss-runtime-v2-queue-canary-"


def rows(data: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    return [row for values in data.values() if isinstance(values, list) for row in values if isinstance(row, dict) and row.get("legacy_id")]


def side_effect_rows(data: dict[str, JsonValue]) -> tuple[str, list[dict[str, JsonValue]]]:
    if isinstance(data.get("capabilities"), list):
        return "capabilities", JSON_ROWS.validate_python(data["capabilities"])
    if isinstance(data.get("rows"), list):
        return "rows", JSON_ROWS.validate_python(data["rows"])
    data["capabilities"] = []
    return "capabilities", JSON_ROWS.validate_python(data["capabilities"])


def install() -> dict[str, JsonValue]:
    expected_count = expected_manifest_count(ROOT)
    with ConfigMutation("architecture-v2-five-queue-canary-install") as mut:
        manifest = JSON_OBJECT.validate_python(mut.load_json(MANIFEST, {}))
        side = JSON_OBJECT.validate_python(mut.load_json(SIDE_EFFECTS, {}))
        existing = rows(manifest)
        if len(existing) != expected_count or any(JSON_OBJECT.validate_python(row.get("execution") or {}).get("backend") != "argv" for row in existing):
            raise RuntimeError(f"canary install requires approved {expected_count}-row argv-only manifest")
        if manifest.get(SECTION):
            raise RuntimeError("queue canaries already installed")
        canaries: list[dict[str, JsonValue]] = []
        policy_key, policies = side_effect_rows(side)
        policy_ids = {str(row.get("legacy_id") or row.get("capability_id")) for row in policies}
        for queue in QUEUES:
            legacy_id = PREFIX + queue
            report = str(OPS / f"oss-runtime-v2-queue-canary-{queue}-last.json")
            argv = [PYTHON, SCRIPT, "--queue", queue]
            canaries.append({
                "legacy_id": legacy_id, "name": f"OSS Runtime v2 — {queue} queue canary", "mode": "script",
                "command": " ".join(argv), "execution": {"backend": "argv", "argv": list(argv), "cwd": str(ROOT), "timeout_seconds": 60},
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
        side[policy_key] = list(policies)
        manifest[SECTION] = list(canaries)
        manifest["updatedAt"] = now_iso(); manifest["updatedBy"] = "oss-runtime-v2-queue-canary-install"
        side["updatedAt"] = now_iso(); side["updatedBy"] = "oss-runtime-v2-queue-canary-install"
        mut.write_json(MANIFEST, manifest); mut.write_json(SIDE_EFFECTS, side)
        build = CatalogCompiler(ROOT).build(write_fragments=True); validation = CatalogCompiler(ROOT).validate()
        if not validation.get("ok") or INTEGER.validate_python(JSON_OBJECT.validate_python(validation.get("counts") or {}).get("agents") or 0) != expected_count + len(QUEUES):
            raise RuntimeError(f"canary catalog invalid: {validation}")
        backups = dict(mut.backups)
    return {"ok": True, "status": "installed", "counts": {"base": expected_count, "canaries": len(QUEUES), "manifest": expected_count + len(QUEUES)}, "catalog": build, "validation": validation, "backups": dict(backups)}


def cleanup() -> dict[str, JsonValue]:
    expected_count = expected_manifest_count(ROOT)
    with ConfigMutation("architecture-v2-five-queue-canary-cleanup") as mut:
        manifest = JSON_OBJECT.validate_python(mut.load_json(MANIFEST, {}))
        side = JSON_OBJECT.validate_python(mut.load_json(SIDE_EFFECTS, {}))
        removed = len(JSON_ROWS.validate_python(manifest.get(SECTION) or []))
        _ = manifest.pop(SECTION, None)
        policy_key, policies = side_effect_rows(side)
        before = len(policies)
        policies = [row for row in policies if not str(row.get("legacy_id") or row.get("capability_id") or "").startswith(PREFIX)]
        side[policy_key] = list(policies)
        manifest["updatedAt"] = now_iso(); manifest["updatedBy"] = "oss-runtime-v2-queue-canary-cleanup"
        side["updatedAt"] = now_iso(); side["updatedBy"] = "oss-runtime-v2-queue-canary-cleanup"
        mut.write_json(MANIFEST, manifest); mut.write_json(SIDE_EFFECTS, side)
        build = CatalogCompiler(ROOT).build(write_fragments=True); validation = CatalogCompiler(ROOT).validate()
        counts = JSON_OBJECT.validate_python(validation.get("counts") or {})
        if not validation.get("ok") or INTEGER.validate_python(counts.get("agents") or 0) != expected_count or INTEGER.validate_python(counts.get("argv") or 0) != expected_count or INTEGER.validate_python(counts.get("legacyShell") or 0) != 0:
            raise RuntimeError(f"final catalog invalid after canary cleanup: {validation}")
        backups = dict(mut.backups)
    return {"ok": True, "status": "cleaned", "counts": {"removedManifestCanaries": removed, "removedPolicyRows": before - len(policies), "manifest": expected_count}, "catalog": build, "validation": validation, "backups": dict(backups)}


class Arguments(argparse.Namespace):
    action: str = ""

def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("action", choices=("install", "cleanup"))
    args = parser.parse_args(namespace=Arguments())
    result = install() if args.action == "install" else cleanup()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
