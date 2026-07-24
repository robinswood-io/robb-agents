from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def runtime_attributes(*, legacy_id: str | None, backend: str | None, policy_mode: str, decision: str, risk_class: str | None) -> dict[str, Any]:
    """Return stable OpenTelemetry-compatible attributes without requiring an SDK import."""
    return {
        "service.name": "rbw-agents-oss",
        "service.version": "runtime-v2",
        "rbw.agent.id": legacy_id,
        "rbw.agent.execution.backend": backend,
        "rbw.agent.policy.mode": policy_mode,
        "rbw.agent.policy.decision": decision,
        "rbw.agent.risk.class": risk_class,
    }


def append_event(path: Path, event: str, attributes: dict[str, Any], **data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"ts": now_iso(), "event": event, "attributes": attributes, "data": data}
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
