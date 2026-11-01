"""Offline preflight tests for the Scotland and Evergreen schedule registrations."""
from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from typing import Self, TypeGuard, final, override
from unittest.mock import AsyncMock, patch

import evergreen_offline_test_guard as offline_guard
import robinswood_evergreen_france as evergreen_campaign
import robinswood_evergreen_register as evergreen_register
import scotland_conference_register as scotland_register
import scotland_executive_conference_october as scotland_campaign
from pydantic import JsonValue, TypeAdapter
from scotland_conference_test_fixtures import CampaignFixture
from temporalio.api.workflowservice.v1 import DescribeScheduleResponse
from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleDescription,
    ScheduleInfo,
    ScheduleSpec,
    ScheduleState,
    ScheduleUpdate,
    ScheduleUpdateInput,
)
from temporalio.common import TypedSearchAttributes
from temporalio.converter import DataConverter

JsonObject = dict[str, JsonValue]
JSON_VALUE_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)

def is_json_object(value: JsonValue) -> TypeGuard[JsonObject]:
    return isinstance(value, dict)

def as_object(value: JsonValue) -> JsonObject:
    if not is_json_object(value):
        raise TypeError('expected_json_object')
    return value

def schema_fingerprint(value: JsonObject) -> str:
    keys = sorted(value)
    canonical = json.dumps(keys, separators=(",", ":")).encode()
    return hashlib.sha256(canonical).hexdigest()[:16]
def write_json(path: Path, data: JsonValue) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _ = path.write_text(json.dumps(data), encoding="utf-8")

@final
class MemoryMutation:
    def __init__(self, batch_id: str, *, root: Path) -> None:
        self.batch_id = batch_id
        self.root = root
        self.backups: dict[str, str] = {}

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None) -> None:
        return None

    def load_json(self, path: Path) -> JsonValue:
        return JSON_VALUE_ADAPTER.validate_json(path.read_text(encoding='utf-8'))

    def write_json(self, path: Path, data: JsonValue) -> None:
        write_json(path, data)

    def backup(self, path: Path) -> Path | None:
        if not path.exists():
            return None
        backup = self.root / 'backups' / path.relative_to(self.root)
        backup.parent.mkdir(parents=True, exist_ok=True)
        _ = shutil.copy2(path, backup)
        self.backups[str(path)] = str(backup)
        return backup

    def write_text(self, path: Path, content: str) -> None:
        _ = path.write_text(content, encoding='utf-8')

class Compiler:
    def __init__(self, root: Path) -> None:
        self.root: Path = root

    def build(self, *, write_fragments: bool) -> dict[str, JsonValue]:
        _ = write_fragments
        return {"ok": True, "counts": {}}

    def validate(self) -> dict[str, JsonValue]:
        return {"ok": True}

class FakeScheduleHandle:
    def __init__(self, *, fail_rollback: bool) -> None:
        self.description: ScheduleDescription = make_schedule_description()
        self.describe_calls: int = 0
        self.update_calls: int = 0
        self.fail_rollback: bool = fail_rollback
    async def describe(self) -> ScheduleDescription:
        self.describe_calls += 1
        if self.describe_calls == 2:
            raise RuntimeError("injected_final_describe_failure")
        return self.description
    async def update(self, callback: object) -> None:
        self.update_calls += 1
        if self.fail_rollback and self.update_calls == 2:
            raise RuntimeError("injected_schedule_rollback_failure")
        if not callable(callback):
            raise TypeError("schedule_update_callback_required")
        updated = callback(ScheduleUpdateInput(description=self.description))
        if not isinstance(updated, ScheduleUpdate):
            raise TypeError("schedule_update_result_required")
        self.description = ScheduleDescription(
            id=self.description.id,
            schedule=updated.schedule,
            info=self.description.info,
            typed_search_attributes=self.description.typed_search_attributes,
            search_attributes=self.description.search_attributes,
            data_converter=self.description.data_converter,
            raw_description=self.description.raw_description,
        )
class EmptyGateway:
    pass
class FakeTemporalClient:
    def __init__(self, handle: FakeScheduleHandle) -> None:
        self.handle: FakeScheduleHandle = handle
    def get_schedule_handle(self, schedule_id: str) -> FakeScheduleHandle:
        if schedule_id != scotland_register.SID:
            raise AssertionError("unexpected_schedule_id")
        return self.handle
def make_schedule_description() -> ScheduleDescription:
    return ScheduleDescription(
        id=scotland_register.SID,
        schedule=Schedule(
            action=ScheduleActionStartWorkflow(workflow="offline-fixture", id="offline-schedule", task_queue="offline"),
            spec=ScheduleSpec(cron_expressions=["0 9 * * 1-5"], time_zone_name="Europe/London"),
            state=ScheduleState(paused=False),
        ),
        info=ScheduleInfo(
            num_actions=0,
            num_actions_missed_catchup_window=0,
            num_actions_skipped_overlap=0,
            running_actions=[],
            recent_actions=[],
            next_action_times=[],
            created_at=datetime(2026, 10, 1, tzinfo=UTC),
            last_updated_at=None,
        ),
        typed_search_attributes=TypedSearchAttributes.empty,
        search_attributes={},
        data_converter=DataConverter.default,
        raw_description=DescribeScheduleResponse(),
    )
def make_empty_campaign_database() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    _ = connection.execute("CREATE TABLE touches (state TEXT, item TEXT, gmail_id TEXT, draft TEXT, operation TEXT, expected TEXT, thread_id TEXT, checks TEXT, step TEXT)")
    _ = connection.execute("CREATE TABLE replies (kind TEXT)")
    return connection
class RegisterPreflightTests(unittest.TestCase):
    @override
    def tearDown(self) -> None:
        offline_guard.assert_no_external_attempts()

    def test_scotland_register_updates_direct_mapping_list_in_tmp_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config"
            write_json(config / "command-manifest.json", {"wave1": []})
            write_json(config / "automation-mapping.json", [])
            write_json(config / "temporal/schedules.json", {"schedules": []})
            write_json(config / "temporal/ready-schedules.json", {"schedules": [], "items": []})
            write_json(config / "registry/side-effects-policy.json", {"capabilities": [], "counts": {}})
            write_json(config / "registry/script-coverage-policy.json", {"acceptedOrphanScripts": [], "counts": {}})
            write_json(config / "system-of-record-policy.json", {"classification": {"explicitOverrides": {}}})

            def mutation(batch_id: str) -> MemoryMutation:
                return MemoryMutation(batch_id, root=root)

            with (
                patch.object(scotland_register, "ROOT", root),
                patch.object(scotland_register, "ConfigMutation", mutation),
                patch.object(scotland_register, "CatalogCompiler", Compiler),
            ):
                result = scotland_register.register()

            mapping_value = JSON_VALUE_ADAPTER.validate_json((config / "automation-mapping.json").read_text(encoding="utf-8"))
            if not isinstance(mapping_value, list):
                self.fail('automation_mapping_must_remain_a_direct_list')
            mapping = [as_object(row) for row in mapping_value]
            self.assertEqual([row["legacy_id"] for row in mapping], [scotland_register.ID])
            self.assertEqual(mapping[0]["cron"], scotland_register.CRON)
            self.assertEqual(mapping[0]["timezone"], "Europe/London")
            self.assertIs(result["ok"], True)

    def test_registration_schemas_match_head_baseline(self) -> None:
        self.assertEqual(schema_fingerprint(scotland_register.entry()), "add7023be6681f49")
        registrations = evergreen_register.entries()
        self.assertTrue(registrations)
        for entry, payload, _, _ in registrations:
            self.assertEqual(schema_fingerprint(entry), "add7023be6681f49")
            self.assertEqual(schema_fingerprint(payload), "c2a70568c525e1de")
    def test_scotland_entry_keeps_schedule_identity_and_cron(self) -> None:
        entry = scotland_register.entry()
        self.assertEqual(entry["legacy_id"], scotland_register.ID)
        self.assertEqual(entry["triggerType"], 'SchedulerTick')
        self.assertEqual(scotland_register.SID, "sched." + scotland_register.ID)

    def test_evergreen_entries_and_calendar_preflight(self) -> None:
        registrations = evergreen_register.entries()
        self.assertEqual(len(registrations), len(evergreen_campaign.LANES) * 2)
        schedule_ids = [registration[0]["legacy_id"] for registration in registrations]
        self.assertEqual(len(schedule_ids), len(set(schedule_ids)))
        self.assertTrue(all(registration[0]["legacy_id"] in schedule_ids for registration in registrations))
        cron = "*/10 9-11,14-17 * * 1-5"
        spec = ScheduleSpec(cron_expressions=[cron], time_zone_name="Europe/Paris")
        self.assertTrue(evergreen_register.calendar_matches(spec, cron))
        self.assertFalse(evergreen_register.calendar_matches(spec, "5,35 * * * *"))
        wrong_zone = ScheduleSpec(cron_expressions=[cron], time_zone_name="UTC")
        self.assertFalse(evergreen_register.calendar_matches(wrong_zone, cron))


    def run_cadence_rollback_case(self, *, fail_rollback: bool) -> tuple[FakeScheduleHandle, JsonObject]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config"
            campaign_root = root / "ops" / "product-campaigns" / scotland_register.ID
            campaign_root.mkdir(parents=True)
            fixture = CampaignFixture()
            fixture.setUp()
            self.addCleanup(fixture.doCleanups)
            fixture.c["activation"] = "active"
            fixture.c["limits"]["weeklyTouches"] = 100
            fixture.c["limits"]["maxRunTouches"] = 1
            fixture.write()
            scotland_campaign.save(campaign_root / "campaign-contract.json", fixture.c)
            scotland_campaign.OPS_REPORT = root / "ops" / "report.json"
            mapping_row: JsonObject = {"legacy_id": scotland_register.ID, "cron": "old", "timezone": "Europe/London"}
            schedule_row: JsonObject = {"schedule_id": scotland_register.SID, "cron": "old", "timezone": "Europe/London"}
            write_json(config / "automation-mapping.json", [mapping_row])
            write_json(config / "temporal/schedules.json", {"schedules": [schedule_row]})
            write_json(config / "temporal/ready-schedules.json", {"schedules": [schedule_row], "items": []})
            capability: JsonObject = {"legacy_id": scotland_register.ID, "guardrails": ["one Gmail effect per run; old"], "updatedAt": "old", "updatedBy": "old"}
            write_json(config / "registry/side-effects-policy.json", {"capabilities": [capability], "counts": {}})
            handle = FakeScheduleHandle(fail_rollback=fail_rollback)
            client = FakeTemporalClient(handle)
            def mutation(batch_id: str) -> MemoryMutation:
                return MemoryMutation(batch_id, root=root)
            def database(_: Path) -> sqlite3.Connection:
                return make_empty_campaign_database()
            with (
                patch.object(scotland_register, "ROOT", root),
                patch.object(scotland_register, "ConfigMutation", mutation),
                patch.object(scotland_register, "CatalogCompiler", Compiler),
                patch.object(scotland_campaign, "database", database),
                patch.object(scotland_campaign, "Gateway", EmptyGateway),
                patch.object(Client, "connect", new=AsyncMock(return_value=client)),
                self.assertRaisesRegex(RuntimeError, "injected_final_describe_failure"),
            ):
                _ = asyncio.run(scotland_register.update_cadence())
            contract_value = JSON_VALUE_ADAPTER.validate_json((campaign_root / "campaign-contract.json").read_text(encoding="utf-8"))
            return handle, as_object(contract_value)
    def test_cadence_failure_restores_native_schedule_and_contract(self) -> None:
        handle, contract = self.run_cadence_rollback_case(fail_rollback=False)
        self.assertEqual(handle.update_calls, 2)
        self.assertEqual(handle.description.schedule.spec.cron_expressions, ["0 9 * * 1-5"])
        self.assertEqual(contract["activation"], "active")
    def test_failed_schedule_rollback_pauses_campaign_contract(self) -> None:
        handle, contract = self.run_cadence_rollback_case(fail_rollback=True)
        self.assertEqual(handle.update_calls, 2)
        self.assertEqual(handle.description.schedule.spec.cron_expressions, [scotland_register.CRON])
        self.assertEqual(contract["activation"], "paused")

def tearDownModule() -> None:
    offline_guard.assert_no_external_attempts()
