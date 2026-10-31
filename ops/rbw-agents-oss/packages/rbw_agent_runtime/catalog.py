from __future__ import annotations

import hashlib
import json
import os
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from pydantic import JsonValue, ValidationError

from .catalog_data import (
    derive_lane,
    execution_from_row,
    policy_from_row,
    policy_rows,
    ready_identities,
    safe_fragment_name,
    schedule_legacy_id,
)
from .json_support import (
    JSON_VALUE_ADAPTER,
    _is_json_array,
    _is_json_object,
    _json_array_or_raise,
    _optional_string,
    _to_json_object,
    _to_json_value,
)
from .models import (
    AgentSpec,
    ExecutionBackend,
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
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def read_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        return JSON_VALUE_ADAPTER.validate_json(path.read_bytes())
    except (OSError, UnicodeError, ValidationError):
        return default


def atomic_write_json(path: Path, payload: JsonValue) -> None:
    _ = path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    _ = tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _ = JSON_VALUE_ADAPTER.validate_json(tmp.read_bytes())
    _ = tmp.replace(path)


def canonical_hash(payload: JsonValue) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def flatten_manifest(data: JsonValue) -> list[dict[str, JsonValue]]:
    rows: list[dict[str, JsonValue]] = []
    if not _is_json_object(data):
        return rows
    for section, values in data.items():
        if not _is_json_array(values):
            continue
        for value in values:
            if not _is_json_object(value) or not value.get("legacy_id"):
                continue
            row = dict(value)
            _ = row.setdefault("manifestSection", section)
            rows.append(row)
    return rows


def flatten_mapping(data: JsonValue) -> list[dict[str, JsonValue]]:
    if _is_json_array(data):
        return [row for row in data if _is_json_object(row)]
    if _is_json_object(data):
        return [row for values in data.values() if _is_json_array(values) for row in values if _is_json_object(row)]
    return []


class CatalogCompiler:
    def __init__(self, root: Path = ROOT):
        self.root: Path = root
        self.config: Path = root / "config"
        self.agents_v2: Path = self.config / "agents-v2"
        self.manifest_path: Path = self.config / "command-manifest.json"
        self.mapping_path: Path = self.config / "automation-mapping.json"
        self.schedules_path: Path = self.config / "temporal" / "schedules.json"
        self.ready_path: Path = self.config / "temporal" / "ready-schedules.json"
        self.side_effects_path: Path = self.config / "registry" / "side-effects-policy.json"

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
        schedule_rows_value = schedules_data.get("schedules", []) if _is_json_object(schedules_data) else []
        schedule_rows = schedule_rows_value if _is_json_array(schedule_rows_value) else []
        schedules_by_id: dict[str, list[dict[str, JsonValue]]] = {}
        for schedule in schedule_rows:
            if not _is_json_object(schedule):
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
                    schedule_id=_optional_string(schedule.get("schedule_id")),
                    workflow_id=_optional_string(schedule.get("workflow_id")),
                    task_queue=_optional_string(schedule.get("task_queue") or mapped.get("task_queue")),
                    cron=_optional_string(schedule.get("cron")),
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
                side_effects=[str(value) for value in _json_array_or_raise(row.get("sideEffects", [])) if value],
                execution=execution,
                contract=ReportContract(
                    version=str(row.get("contractVersion") or "observed-v0"),
                    expects_report=bool(row.get("expectsReport")),
                    json_path=_optional_string(row.get("reportJsonPath")),
                    markdown_path=_optional_string(row.get("reportMdPath")),
                ),
                policy=policy_from_row(side_effects.get(legacy_id)),
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

    def build(self, *, write_fragments: bool = True) -> dict[str, JsonValue]:
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
            "catalogHash": canonical_hash(_to_json_value(json.dumps(catalog))),
            "manifestHash": canonical_hash(read_json(self.manifest_path, {})),
            "specHashes": spec_hashes,
            "expectedFragments": [f"generated/{spec.lane}/{safe_fragment_name(spec.id)}.json" for spec in specs],
        }
        atomic_write_json(self.agents_v2 / "agent-spec.schema.json", _to_json_value(json.dumps(AgentSpec.model_json_schema())))
        typed_catalog = _to_json_value(json.dumps(catalog))
        typed_cards = _to_json_value(json.dumps(cards))
        typed_lock = _to_json_value(json.dumps(lock))
        atomic_write_json(self.agents_v2 / "catalog-v2.json", typed_catalog)
        atomic_write_json(self.agents_v2 / "agent-cards-v2.json", typed_cards)
        atomic_write_json(self.agents_v2 / "catalog-v2.lock.json", typed_lock)
        if write_fragments:
            for spec, payload in zip(specs, spec_payloads):
                atomic_write_json(self.agents_v2 / "generated" / spec.lane / f"{safe_fragment_name(spec.id)}.json", payload)
        return _to_json_object(json.dumps({
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
        }))

    def validate(self) -> dict[str, JsonValue]:
        errors: list[str] = []
        catalog = read_json(self.agents_v2 / "catalog-v2.json", {})
        cards = read_json(self.agents_v2 / "agent-cards-v2.json", {})
        lock = read_json(self.agents_v2 / "catalog-v2.lock.json", {})
        manifest_rows = flatten_manifest(read_json(self.manifest_path, {}))
        agents_value = catalog.get("agents", []) if _is_json_object(catalog) else []
        agents = _json_array_or_raise(agents_value)
        parsed: list[AgentSpec] = []
        for raw in agents:
            try:
                parsed.append(AgentSpec.model_validate(raw))
            except ValidationError as exc:
                errors.append(f"invalid_spec:{str(exc)[:300]}")
        ids = [spec.id for spec in parsed]
        duplicates = [value for value, count in Counter(ids).items() if count > 1]
        if duplicates:
            errors.append(f"duplicate_ids:{','.join(sorted(duplicates))}")
        if len(parsed) != len(manifest_rows):
            errors.append(f"catalog_manifest_count_mismatch:{len(parsed)}!={len(manifest_rows)}")
        card_rows_value = cards.get("cards", []) if _is_json_object(cards) else []
        card_rows = _json_array_or_raise(card_rows_value)
        if len(card_rows) != len(parsed):
            errors.append(f"card_count_mismatch:{len(card_rows)}!={len(parsed)}")
        hashes_value = lock.get("specHashes", {}) if _is_json_object(lock) else {}
        expected_hashes = hashes_value if _is_json_object(hashes_value) else {}
        for spec in parsed:
            actual = canonical_hash(_to_json_value(spec.model_dump_json()))
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
        return _to_json_object(json.dumps({
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
        }))


class CatalogRepository:
    def __init__(self, root: Path = ROOT):
        self.root: Path = root
        self.manifest_path: Path = root / "config" / "command-manifest.json"
        self.catalog_path: Path = root / "config" / "agents-v2" / "catalog-v2.json"
        self.lock_path: Path = root / "config" / "agents-v2" / "catalog-v2.lock.json"
        self._manifest_mtime: int | None = None
        self._catalog_mtime: int | None = None
        self._manifest_entries: dict[str, dict[str, JsonValue]] = {}
        self._specs: dict[str, AgentSpec] = {}
        self._hashes: dict[str, str] = {}

    @staticmethod
    def _mtime(path: Path) -> int:
        try:
            return path.stat().st_mtime_ns
        except OSError:
            return -1

    def manifest_entries(self) -> dict[str, dict[str, JsonValue]]:
        mtime = self._mtime(self.manifest_path)
        if mtime != self._manifest_mtime:
            rows = flatten_manifest(read_json(self.manifest_path, {}))
            entries: dict[str, dict[str, JsonValue]] = {}
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
            rows_value = data.get("agents", []) if _is_json_object(data) else []
            rows = _json_array_or_raise(rows_value)
            specs = [AgentSpec.model_validate(row) for row in rows if _is_json_object(row)]
            self._specs = {spec.id: spec for spec in specs}
            lock = read_json(self.lock_path, {})
            hashes_value = lock.get("specHashes", {}) if _is_json_object(lock) else {}
            if not _is_json_object(hashes_value):
                raise ValueError("catalog lock specHashes must be an object")
            self._hashes = {key: str(value) for key, value in hashes_value.items()}
            self._catalog_mtime = mtime
        return self._specs

    def spec(self, legacy_id: str | None) -> AgentSpec | None:
        if not legacy_id:
            return None
        return self.specs().get(str(legacy_id))

    def spec_hash(self, legacy_id: str | None) -> str | None:
        _ = self.specs()
        return self._hashes.get(str(legacy_id)) if legacy_id else None

    def cache_state(self) -> dict[str, JsonValue]:
        state = _to_json_value(json.dumps({
            "manifestMtimeNs": self._manifest_mtime,
            "catalogMtimeNs": self._catalog_mtime,
            "manifestEntries": len(self._manifest_entries),
            "specs": len(self._specs),
        }))
        if not _is_json_object(state):
            raise TypeError("cache state must serialize as an object")
        return state
