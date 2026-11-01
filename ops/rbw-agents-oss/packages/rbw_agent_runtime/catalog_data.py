from __future__ import annotations

import os
import re
from pathlib import Path

from pydantic import JsonValue

from .json_support import (
    _integer,
    _is_json_array,
    _is_json_object,
    _is_string_array,
    _optional_bool,
)
from .models import ExecutionBackend, ExecutionSpec, PolicySpec

SIDE_EFFECTS_PATH = Path(os.getenv("RBW_OSS_ROOT", "/srv/rbw-agents-oss")) / "config" / "registry" / "side-effects-policy.json"

def schedule_legacy_id(row: dict[str, JsonValue]) -> str | None:
    payload_value = row.get("payload")
    payload = payload_value if _is_json_object(payload_value) else {}
    value = row.get("legacy_id") or payload.get("legacy_id") or row.get("capability_id")
    return str(value) if value else None


def derive_lane(capability_id: str, row: dict[str, JsonValue]) -> str:
    text = " ".join(str(x or "") for x in [capability_id, row.get("name"), row.get("category"), row.get("task_queue")]).lower()
    if capability_id.startswith("agent-task"):
        return "agent_tasks"
    if any(token in text for token in ("inqom", "gocardless", "finance", "fiscal", "accounting")):
        return "finance_inqom"
    if any(token in text for token in ("sellsy", "rubypayeur", "revenue", "cash", "pipeline", "recouvrement")):
        return "revenue_ops"
    if any(token in text for token in ("ao", "tender", "appel")):
        return "ao"
    if any(token in text for token in ("campaign", "campagne", "hdf", "abm", "prospect", "outbound", "marketing")):
        return "campaigns"
    if any(token in text for token in ("client-incident", "support", "incident")):
        return "support"
    if any(token in text for token in ("blog", "podcast", "linkedin", "seo", "content", "media")):
        return "content"
    if any(token in text for token in ("temporal", "watchdog", "guard", "drift", "health", "server", "ovh", "langfuse", "oss-")):
        return "observability"
    return "general"


def safe_fragment_name(value: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-") or "agent"


def policy_rows(data: JsonValue) -> dict[str, dict[str, JsonValue]]:
    if not _is_json_object(data):
        return {}
    rows = data.get("capabilities") or data.get("rows") or []
    if not _is_json_array(rows):
        return {}
    return {
        str(row.get("legacy_id") or row.get("capability_id")): row
        for row in rows
        if _is_json_object(row) and (row.get("legacy_id") or row.get("capability_id"))
    }


def ready_identities(data: JsonValue) -> set[str]:
    out: set[str] = set()
    if not _is_json_object(data):
        return out
    for section in ("schedules", "items"):
        section_value = data.get(section, [])
        section_rows = section_value if _is_json_array(section_value) else []
        for row in section_rows:
            if not _is_json_object(row):
                continue
            for key in ("legacy_id", "capability_id", "schedule_id"):
                value = row.get(key)
                if value:
                    out.add(str(value))
                    if key == "schedule_id" and str(value).startswith("sched."):
                        out.add(str(value)[6:])
    return out


def structured_argv_from_row(row: dict[str, JsonValue]) -> list[str] | None:
    execution_value = row.get("execution")
    execution = execution_value if _is_json_object(execution_value) else {}
    argv = execution.get("argv")
    if _is_string_array(argv) and argv and all(argv):
        return list(argv)
    return None


def execution_from_row(row: dict[str, JsonValue]) -> ExecutionSpec:
    timeout = _integer(row.get("timeout_seconds") or 600)
    execution_value = row.get("execution")
    execution = execution_value if _is_json_object(execution_value) else {}
    argv = structured_argv_from_row(row)
    if argv:
        raw_env_value = execution.get("env")
        raw_env = raw_env_value if _is_json_object(raw_env_value) else {}
        return ExecutionSpec(
            backend=ExecutionBackend.ARGV,
            argv=argv,
            timeout_seconds=timeout,
            cwd=str(execution.get("cwd") or "/home/craft/.craft-agent/workspaces/my-workspace-2"),
            env={str(key): str(value) for key, value in raw_env.items()},
        )
    raise ValueError(f"manifest row {row.get('legacy_id')} is missing execution.backend=argv")


def policy_from_row(classified: dict[str, JsonValue] | None) -> PolicySpec:
    if not classified:
        return PolicySpec(
            classified=False,
            policy_class="unclassified",
            mutation_mode="unclassified",
            schedule_allowed=None,
            requires_explicit_review_before_risk_increase=True,
            source="manifest-fallback",
        )
    return PolicySpec(
        classified=True,
        policy_class=str(classified.get("policyClass") or "classified"),
        mutation_mode=str(classified.get("mutationMode") or "classified"),
        schedule_allowed=_optional_bool(classified.get("scheduleAllowed")),
        requires_human_approval_for_apply=bool(classified.get("requiresHumanApprovalForApply")),
        requires_human_approval_for_external_send=bool(classified.get("requiresHumanApprovalForExternalSend")),
        requires_explicit_review_before_risk_increase=bool(classified.get("requiresExplicitReviewBeforeRiskIncrease", True)),
        source=str(SIDE_EFFECTS_PATH),
    )
