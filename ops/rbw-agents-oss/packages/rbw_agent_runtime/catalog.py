from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import (
    AgentSpec,
    ExecutionBackend,
    ExecutionSpec,
    PolicySpec,
    ReportContract,
    ScheduleInstance,
    SourceStatus,
)

ROOT = Path(os.getenv("RBW_OSS_ROOT", "/srv/rbw-agents-oss"))
CONFIG = ROOT / "config"
AGENTS_V2 = CONFIG / "agents-v2"
GENERATED = AGENTS_V2 / "generated"
CATALOG_PATH = AGENTS_V2 / "catalog-v2.json"
LOCK_PATH = AGENTS_V2 / "catalog-v2.lock.json"
CARDS_PATH = AGENTS_V2 / "agent-cards-v2.json"
SCHEMA_PATH = AGENTS_V2 / "agent-spec.schema.json"
BASELINE_PATH = AGENTS_V2 / "baseline.json"
MANIFEST_PATH = CONFIG / "command-manifest.json"
MAPPING_PATH = CONFIG / "automation-mapping.json"
SCHEDULES_PATH = CONFIG / "temporal" / "schedules.json"
READY_PATH = CONFIG / "temporal" / "ready-schedules.json"
SIDE_EFFECTS_PATH = CONFIG / "registry" / "side-effects-policy.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))
    tmp.replace(path)


def canonical_hash(payload: Any) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def flatten_manifest(data: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(data, dict):
        return rows
    for section, values in data.items():
        if not isinstance(values, list):
            continue
        for value in values:
            if not isinstance(value, dict) or not value.get("legacy_id"):
                continue
            row = dict(value)
            row.setdefault("manifestSection", section)
            rows.append(row)
    return rows


def flatten_mapping(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        return [row for values in data.values() if isinstance(values, list) for row in values if isinstance(row, dict)]
    return []


def schedule_legacy_id(row: dict[str, Any]) -> str | None:
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    value = row.get("legacy_id") or payload.get("legacy_id") or row.get("capability_id")
    return str(value) if value else None


def derive_lane(capability_id: str, row: dict[str, Any]) -> str:
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


def policy_rows(data: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(data, dict):
        return {}
    rows = data.get("capabilities") or data.get("rows") or []
    return {
        str(row.get("legacy_id") or row.get("capability_id")): row
        for row in rows
        if isinstance(row, dict) and (row.get("legacy_id") or row.get("capability_id"))
    }


def ready_identities(data: Any) -> set[str]:
    out: set[str] = set()
    if not isinstance(data, dict):
        return out
    for section in ("schedules", "items"):
        for row in data.get(section, []) if isinstance(data.get(section), list) else []:
            if not isinstance(row, dict):
                continue
            for key in ("legacy_id", "capability_id", "schedule_id"):
                value = row.get(key)
                if value:
                    out.add(str(value))
                    if key == "schedule_id" and str(value).startswith("sched."):
                        out.add(str(value)[6:])
    return out


def structured_argv_from_row(row: dict[str, Any]) -> list[str] | None:
    execution = row.get("execution") if isinstance(row.get("execution"), dict) else {}
    argv = execution.get("argv")
    if isinstance(argv, list) and argv and all(isinstance(item, str) and item for item in argv):
        return list(argv)
    return None


def execution_from_row(row: dict[str, Any]) -> ExecutionSpec:
    timeout = int(row.get("timeout_seconds") or 600)
    execution = row.get("execution") if isinstance(row.get("execution"), dict) else {}
    argv = structured_argv_from_row(row)
    if argv:
        raw_env = execution.get("env") if isinstance(execution.get("env"), dict) else {}
        return ExecutionSpec(
            backend=ExecutionBackend.ARGV,
            argv=argv,
            timeout_seconds=timeout,
            cwd=str(execution.get("cwd") or "/home/craft/.craft-agent/workspaces/my-workspace-2"),
            env={str(key): str(value) for key, value in raw_env.items()},
        )
    raise ValueError(f"manifest row {row.get('legacy_id')} is missing execution.backend=argv")


def policy_from_row(row: dict[str, Any], classified: dict[str, Any] | None) -> PolicySpec:
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
        schedule_allowed=classified.get("scheduleAllowed"),
        requires_human_approval_for_apply=bool(classified.get("requiresHumanApprovalForApply")),
        requires_human_approval_for_external_send=bool(classified.get("requiresHumanApprovalForExternalSend")),
        requires_explicit_review_before_risk_increase=bool(classified.get("requiresExplicitReviewBeforeRiskIncrease", True)),
        source=str(SIDE_EFFECTS_PATH),
    )


class CatalogCompiler:
    def __init__(self, root: Path = ROOT):
        self.root = root
        self.config = root / "config"
        self.agents_v2 = self.config / "agents-v2"
        self.manifest_path = self.config / "command-manifest.json"
        self.mapping_path = self.config / "automation-mapping.json"
        self.schedules_path = self.config / "temporal" / "schedules.json"
        self.ready_path = self.config / "temporal" / "ready-schedules.json"
        self.side_effects_path = self.config / "registry" / "side-effects-policy.json"

    def build_specs(self) -> list[AgentSpec]:
        manifest = read_json(self.manifest_path, {})
        mapping = flatten_mapping(read_json(self.mapping_path, []))
        schedules_data = read_json(self.schedules_path, {})
        ready = read_json(self.ready_path, {})
        side_effects = policy_rows(read_json(self.side_effects_path, {}))
        rows = flatten_manifest(manifest)
        duplicate_ids = [value for value, count in Counter(str(row.get("legacy_id")) for row in rows).items() if count > 1]
        if duplicate_ids:
            raise ValueError(f"duplicate manifest ids: {sorted(duplicate_ids)}")
        mapping_by_id = {str(row.get("legacy_id")): row for row in mapping if row.get("legacy_id")}
        schedule_rows = schedules_data.get("schedules", []) if isinstance(schedules_data, dict) else []
        schedules_by_id: dict[str, list[dict[str, Any]]] = {}
        for schedule in schedule_rows if isinstance(schedule_rows, list) else []:
            if not isinstance(schedule, dict):
                continue
            legacy_id = schedule_legacy_id(schedule)
            if legacy_id:
                schedules_by_id.setdefault(legacy_id, []).append(schedule)
        ready_ids = ready_identities(ready)

        specs: list[AgentSpec] = []
        for row in sorted(rows, key=lambda item: str(item.get("legacy_id"))):
            legacy_id = str(row["legacy_id"])
            mapped = mapping_by_id.get(legacy_id, {})
            schedule_instances: list[ScheduleInstance] = []
            for schedule in schedules_by_id.get(legacy_id, []):
                schedule_instances.append(ScheduleInstance(
                    schedule_id=schedule.get("schedule_id"),
                    workflow_id=schedule.get("workflow_id"),
                    task_queue=schedule.get("task_queue") or mapped.get("task_queue"),
                    cron=schedule.get("cron"),
                    timezone=str(schedule.get("timezone") or "Europe/Paris"),
                    enabled=bool(schedule.get("enabled", True)),
                ))
            execution = execution_from_row(row)
            runtime_version = "v2"
            trigger_types = sorted({str(value) for value in (row.get("triggerType"), mapped.get("triggerType")) if value})
            task_queues = sorted({str(value) for value in ([row.get("task_queue"), mapped.get("task_queue")] + [s.task_queue for s in schedule_instances]) if value})
            workflow_ids = sorted({str(value) for value in ([row.get("workflow_id"), mapped.get("workflow_id")] + [s.workflow_id for s in schedule_instances]) if value})
            lane = derive_lane(legacy_id, row)
            spec = AgentSpec(
                id=legacy_id,
                name=str(row.get("name") or legacy_id),
                lane=lane,
                owner=str(row.get("owner") or ("ops" if lane in {"observability", "general"} else lane)),
                runtime_version=runtime_version,
                risk_class=str(row.get("riskClass") or "unclassified"),
                side_effects=[str(value) for value in row.get("sideEffects", []) if value],
                execution=execution,
                contract=ReportContract(
                    version=str(row.get("contractVersion") or "observed-v0"),
                    expects_report=bool(row.get("expectsReport")),
                    json_path=row.get("reportJsonPath"),
                    markdown_path=row.get("reportMdPath"),
                ),
                policy=policy_from_row(row, side_effects.get(legacy_id)),
                schedules=schedule_instances,
                trigger_types=trigger_types,
                task_queues=task_queues,
                workflow_ids=workflow_ids,
                source_status=SourceStatus(
                    in_manifest=True,
                    in_mapping=legacy_id in mapping_by_id,
                    in_schedules=legacy_id in schedules_by_id,
                    in_ready_schedules=legacy_id in ready_ids,
                    manifest_section=str(row.get("manifestSection") or "unknown"),
                ),
                provenance={
                    "manifest": str(self.manifest_path),
                    "mapping": str(self.mapping_path),
                    "schedules": str(self.schedules_path),
                    "sideEffectsPolicy": str(self.side_effects_path),
                    "manifestUpdatedAt": manifest.get("updatedAt") if isinstance(manifest, dict) else None,
                },
            )
            specs.append(spec)
        return specs

    def build(self, *, write_fragments: bool = True) -> dict[str, Any]:
        generated_at = now_iso()
        specs = self.build_specs()
        spec_payloads = [spec.model_dump(mode="json") for spec in specs]
        spec_hashes = {spec.id: canonical_hash(payload) for spec, payload in zip(specs, spec_payloads)}
        backend_counts = Counter(spec.execution.backend.value for spec in specs)
        lane_counts = Counter(spec.lane for spec in specs)
        policy_gaps = [spec.id for spec in specs if not spec.policy.classified]
        catalog = {
            "schemaVersion": "agent-catalog-v2",
            "generatedAt": generated_at,
            "sourceManifest": str(self.manifest_path),
            "counts": {
                "agents": len(specs),
                "cards": len(specs),
                "argv": backend_counts.get("argv", 0),
                "legacyShell": 0,
                "policyGaps": len(policy_gaps),
                "lanes": dict(sorted(lane_counts.items())),
            },
            "agents": spec_payloads,
        }
        cards = {
            "schemaVersion": "rbw-agent-cards-v2",
            "generatedAt": generated_at,
            "counts": {"cards": len(specs), "traceable": sum(1 for spec in specs if spec.contract.json_path)},
            "cards": [
                {
                    "agentId": spec.id,
                    "name": spec.name,
                    "description": f"RBW OSS {spec.lane} capability executed through Temporal/runtime v2.",
                    "protocolProfile": "rbw-agent-card-v2",
                    "transport": {
                        "type": "temporal-wrapper",
                        "workflowIds": spec.workflow_ids,
                        "taskQueues": spec.task_queues,
                        "scheduled": bool(spec.schedules),
                    },
                    "skills": sorted(set([spec.lane, f"risk:{spec.risk_class}"] + [f"effect:{value}" for value in spec.side_effects])),
                    "execution": {
                        "backend": spec.execution.backend.value,
                        "timeoutSeconds": spec.execution.timeout_seconds,
                    },
                    "contracts": spec.contract.model_dump(mode="json"),
                    "security": {
                        "scope": "internal-only",
                        "policyClass": spec.policy.policy_class,
                        "mutationMode": spec.policy.mutation_mode,
                        "approvalForApply": spec.policy.requires_human_approval_for_apply,
                        "approvalForExternalSend": spec.policy.requires_human_approval_for_external_send,
                    },
                    "observability": {
                        "traceable": bool(spec.contract.json_path),
                        "reportJsonPath": spec.contract.json_path,
                    },
                    "specHash": spec_hashes[spec.id],
                }
                for spec in specs
            ],
        }
        lock = {
            "schemaVersion": "agent-catalog-lock-v2",
            "generatedAt": generated_at,
            "catalogHash": canonical_hash(catalog),
            "manifestHash": canonical_hash(read_json(self.manifest_path, {})),
            "specHashes": spec_hashes,
            "expectedFragments": [f"generated/{spec.lane}/{safe_fragment_name(spec.id)}.json" for spec in specs],
        }
        atomic_write_json(self.agents_v2 / "agent-spec.schema.json", AgentSpec.model_json_schema())
        atomic_write_json(self.agents_v2 / "catalog-v2.json", catalog)
        atomic_write_json(self.agents_v2 / "agent-cards-v2.json", cards)
        atomic_write_json(self.agents_v2 / "catalog-v2.lock.json", lock)
        if write_fragments:
            for spec, payload in zip(specs, spec_payloads):
                atomic_write_json(self.agents_v2 / "generated" / spec.lane / f"{safe_fragment_name(spec.id)}.json", payload)
        return {
            "ok": not policy_gaps,
            "status": "processed" if not policy_gaps else "degraded",
            "generatedAt": generated_at,
            "summary": f"agent_catalog_v2: agents={len(specs)} cards={len(specs)} argv={backend_counts.get('argv', 0)} legacy=0 policyGaps={len(policy_gaps)}",
            "counts": catalog["counts"],
            "policyGaps": policy_gaps,
            "artifacts": {
                "catalog": str(self.agents_v2 / "catalog-v2.json"),
                "cards": str(self.agents_v2 / "agent-cards-v2.json"),
                "lock": str(self.agents_v2 / "catalog-v2.lock.json"),
                "schema": str(self.agents_v2 / "agent-spec.schema.json"),
                "fragments": str(self.agents_v2 / "generated"),
            },
        }

    def validate(self) -> dict[str, Any]:
        errors: list[str] = []
        catalog = read_json(self.agents_v2 / "catalog-v2.json", {})
        cards = read_json(self.agents_v2 / "agent-cards-v2.json", {})
        lock = read_json(self.agents_v2 / "catalog-v2.lock.json", {})
        manifest_rows = flatten_manifest(read_json(self.manifest_path, {}))
        agents = catalog.get("agents", []) if isinstance(catalog, dict) else []
        parsed: list[AgentSpec] = []
        for raw in agents if isinstance(agents, list) else []:
            try:
                parsed.append(AgentSpec.model_validate(raw))
            except Exception as exc:
                errors.append(f"invalid_spec:{str(exc)[:300]}")
        ids = [spec.id for spec in parsed]
        duplicates = [value for value, count in Counter(ids).items() if count > 1]
        if duplicates:
            errors.append(f"duplicate_ids:{','.join(sorted(duplicates))}")
        if len(parsed) != len(manifest_rows):
            errors.append(f"catalog_manifest_count_mismatch:{len(parsed)}!={len(manifest_rows)}")
        card_rows = cards.get("cards", []) if isinstance(cards, dict) else []
        if len(card_rows) != len(parsed):
            errors.append(f"card_count_mismatch:{len(card_rows)}!={len(parsed)}")
        expected_hashes = lock.get("specHashes", {}) if isinstance(lock, dict) else {}
        for spec in parsed:
            actual = canonical_hash(spec.model_dump(mode="json"))
            if expected_hashes.get(spec.id) != actual:
                errors.append(f"spec_hash_mismatch:{spec.id}")
            fragment = self.agents_v2 / "generated" / spec.lane / f"{safe_fragment_name(spec.id)}.json"
            if not fragment.exists():
                errors.append(f"missing_fragment:{spec.id}")
        policy_gaps = [spec.id for spec in parsed if not spec.policy.classified]
        if policy_gaps:
            errors.extend(f"policy_gap:{value}" for value in policy_gaps)
        non_argv = [spec.id for spec in parsed if spec.execution.backend != ExecutionBackend.ARGV]
        if non_argv:
            errors.extend(f"argv_only_runtime_violation:{value}" for value in non_argv)
        return {
            "ok": not errors,
            "status": "passed" if not errors else "failed",
            "counts": {
                "manifest": len(manifest_rows),
                "agents": len(parsed),
                "cards": len(card_rows),
                "errors": len(errors),
                "argv": sum(1 for spec in parsed if spec.execution.backend == ExecutionBackend.ARGV),
                "legacyShell": 0,
            },
            "errors": errors[:200],
        }


class CatalogRepository:
    def __init__(self, root: Path = ROOT):
        self.root = root
        self.manifest_path = root / "config" / "command-manifest.json"
        self.catalog_path = root / "config" / "agents-v2" / "catalog-v2.json"
        self.lock_path = root / "config" / "agents-v2" / "catalog-v2.lock.json"
        self._manifest_mtime: int | None = None
        self._catalog_mtime: int | None = None
        self._manifest_entries: dict[str, dict[str, Any]] = {}
        self._specs: dict[str, AgentSpec] = {}
        self._hashes: dict[str, str] = {}

    @staticmethod
    def _mtime(path: Path) -> int:
        try:
            return path.stat().st_mtime_ns
        except Exception:
            return -1

    def manifest_entries(self) -> dict[str, dict[str, Any]]:
        mtime = self._mtime(self.manifest_path)
        if mtime != self._manifest_mtime:
            rows = flatten_manifest(read_json(self.manifest_path, {}))
            entries: dict[str, dict[str, Any]] = {}
            for row in rows:
                legacy_id = str(row["legacy_id"])
                if legacy_id in entries:
                    raise ValueError(f"duplicate manifest id: {legacy_id}")
                entries[legacy_id] = row
            self._manifest_entries = entries
            self._manifest_mtime = mtime
        return self._manifest_entries

    def specs(self) -> dict[str, AgentSpec]:
        mtime = self._mtime(self.catalog_path)
        if mtime != self._catalog_mtime:
            data = read_json(self.catalog_path, {})
            rows = data.get("agents", []) if isinstance(data, dict) else []
            specs = [AgentSpec.model_validate(row) for row in rows if isinstance(row, dict)]
            self._specs = {spec.id: spec for spec in specs}
            lock = read_json(self.lock_path, {})
            self._hashes = dict(lock.get("specHashes", {})) if isinstance(lock, dict) else {}
            self._catalog_mtime = mtime
        return self._specs

    def spec(self, legacy_id: str | None) -> AgentSpec | None:
        if not legacy_id:
            return None
        return self.specs().get(str(legacy_id))

    def spec_hash(self, legacy_id: str | None) -> str | None:
        self.specs()
        return self._hashes.get(str(legacy_id)) if legacy_id else None

    def cache_state(self) -> dict[str, Any]:
        return {
            "manifestMtimeNs": self._manifest_mtime,
            "catalogMtimeNs": self._catalog_mtime,
            "manifestEntries": len(self._manifest_entries),
            "specs": len(self._specs),
        }
