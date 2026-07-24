#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_OPS = Path("/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops")
ALLOWED_QUEUES = {"default", "watchdog", "campaigns", "sync", "ao"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))
    tmp.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", required=True, choices=sorted(ALLOWED_QUEUES))
    parser.add_argument("--ops", default=str(DEFAULT_OPS))
    args = parser.parse_args()
    backend = os.getenv("RBW_RUNTIME_V2_BACKEND")
    spec_hash = os.getenv("RBW_RUNTIME_V2_SPEC_HASH")
    policy_mode = os.getenv("RBW_RUNTIME_V2_POLICY_MODE")
    ok = backend == "argv" and bool(spec_hash) and policy_mode in {"shadow", "enforce"}
    generated = now_iso()
    path = Path(args.ops) / f"oss-runtime-v2-queue-canary-{args.queue}-last.json"
    report = {
        "generatedAt": generated,
        "contractVersion": "oss-agent-report-envelope-v2",
        "capabilityId": f"oss-runtime-v2-queue-canary-{args.queue}",
        "ok": ok,
        "status": "passed" if ok else "failed",
        "summary": f"runtime_v2_queue_canary: queue={args.queue} backend={backend} specHashPresent={bool(spec_hash)}",
        "counts": {"checks": 3, "passed": int(backend == 'argv') + int(bool(spec_hash)) + int(policy_mode in {'shadow', 'enforce'}), "failed": int(not ok)},
        "blockingReasons": [] if ok else ["runtime_v2_environment_missing"],
        "warningReasons": [],
        "artifacts": {"reportJson": str(path)},
        "checks": {"queue": args.queue, "executionBackend": backend, "specHashPresent": bool(spec_hash), "policyMode": policy_mode, "shell": False},
        "data": {},
        "updatedBy": "oss-runtime-v2-queue-canary",
    }
    atomic_json(path, report)
    print(json.dumps({"ok": ok, "status": report["status"], "queue": args.queue, "executionBackend": backend, "reportJson": str(path)}, ensure_ascii=False))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
