"""Internal schedule report shapes; no runtime orchestration."""
from typing import TypedDict

from pydantic import JsonValue


class AdminPolicy(TypedDict):
    path: str
    adminTaskQueue: str
    watchdogQueueWrappers: set[str]
    duplicateProtectedWrappers: set[str]
    loaded: bool

class ExpectedSchedule(TypedDict):
    enabled: bool
    paused: bool
    cron: str | None
    timezone: JsonValue
    taskQueue: str
    policyTaskQueue: str
    taskQueueSource: str

class LiveSchedule(TypedDict):
    exists: bool
    paused: bool | None
    cronExpressions: list[str]
    taskQueue: str | None

class ScheduleFreshness(TypedDict):
    legacyId: JsonValue
    lastRunAt: str | None
    ageHours: float | None
    maxExpectedAgeHours: float | None
    stale: bool
    reasons: list[str]
    firstRunGraceActive: bool
    manifestAgeHours: float | None

class DriftRow(TypedDict):
    schedule_id: str
    workflow_id: JsonValue
    migrationStatus: str | None
    includedInChecks: bool
    expected: ExpectedSchedule
    live: LiveSchedule
    driftReasons: list[str]
    queuePolicyReasons: list[str]
    freshness: ScheduleFreshness

class BurstSample(TypedDict):
    schedule_id: JsonValue
    legacy_id: JsonValue
    task_queue: JsonValue

class BurstWarning(TypedDict):
    slot: str
    count: int
    watchdogCount: int
    sample: list[BurstSample]
    severity: str
