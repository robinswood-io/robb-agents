from __future__ import annotations

from enum import Enum
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ExecutionBackend(str, Enum):
    ARGV = "argv"


PROTECTED_MANIFEST_ENV = frozenset({
    "PATH", "HOME", "BUN_INSTALL", "PYTHONPATH", "PYTHONHOME", "LD_PRELOAD",
    "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "IFS",
    "RBW_AUTOMATION_PAYLOAD_JSON", "RBW_EVENT_JSON", "RBW_SESSION_ID", "RBW_LEGACY_ID",
})


class ExecutionSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    backend: ExecutionBackend
    timeout_seconds: int = Field(default=600, ge=1, le=7200)
    argv: list[str]
    cwd: str = "/home/craft/.craft-agent/workspaces/my-workspace-2"
    env: dict[str, str] = Field(default_factory=dict)

    @field_validator("argv")
    @classmethod
    def validate_argv_items(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("argv must not be empty")
        for item in value:
            if not isinstance(item, str) or not item or "\x00" in item:
                raise ValueError("argv contains an empty or invalid item")
            if len(item) > 8192:
                raise ValueError("argv item exceeds 8192 characters")
        return value

    @field_validator("env")
    @classmethod
    def validate_manifest_env(cls, value: dict[str, str]) -> dict[str, str]:
        clean: dict[str, str] = {}
        for key, item in value.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise ValueError(f"invalid environment key: {key!r}")
            if key in PROTECTED_MANIFEST_ENV or key.startswith("RBW_RUNTIME_V2_"):
                raise ValueError(f"protected environment key: {key}")
            if not isinstance(item, str) or "\x00" in item or len(item) > 16384:
                raise ValueError(f"invalid environment value for {key}")
            clean[key] = item
        return clean

    @model_validator(mode="after")
    def validate_backend_contract(self) -> "ExecutionSpec":
        if self.backend != ExecutionBackend.ARGV or not self.argv:
            raise ValueError("runtime v2 requires a non-empty argv backend")
        if not self.argv[0].startswith("/"):
            raise ValueError("argv executable must be absolute")
        return self


class ReportContract(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: str = "observed-v0"
    expects_report: bool = False
    json_path: str | None = None
    markdown_path: str | None = None


class ScheduleInstance(BaseModel):
    model_config = ConfigDict(extra="allow")

    schedule_id: str | None = None
    workflow_id: str | None = None
    task_queue: str | None = None
    cron: str | None = None
    timezone: str = "Europe/Paris"
    enabled: bool = True


class PolicySpec(BaseModel):
    model_config = ConfigDict(extra="allow")

    classified: bool = False
    policy_class: str = "unclassified"
    mutation_mode: str = "unclassified"
    schedule_allowed: bool | None = None
    requires_human_approval_for_apply: bool = False
    requires_human_approval_for_external_send: bool = False
    requires_explicit_review_before_risk_increase: bool = True
    source: str = "manifest-fallback"


class SourceStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    in_manifest: bool
    in_mapping: bool
    in_schedules: bool
    in_ready_schedules: bool
    manifest_section: str


class AgentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["agent-spec-v2"] = "agent-spec-v2"
    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    name: str = Field(min_length=1)
    lane: str = Field(min_length=1)
    owner: str = Field(min_length=1)
    runtime_version: Literal["v2"]
    risk_class: str
    side_effects: list[str] = Field(default_factory=list)
    execution: ExecutionSpec
    contract: ReportContract
    policy: PolicySpec
    schedules: list[ScheduleInstance] = Field(default_factory=list)
    trigger_types: list[str] = Field(default_factory=list)
    task_queues: list[str] = Field(default_factory=list)
    workflow_ids: list[str] = Field(default_factory=list)
    source_status: SourceStatus
    provenance: dict[str, Any] = Field(default_factory=dict)


class Invocation(BaseModel):
    model_config = ConfigDict(extra="allow")

    legacy_id: str = Field(min_length=1)
    event: dict[str, Any] = Field(default_factory=dict)
    approval: dict[str, Any] = Field(default_factory=dict)
    requested_effect: str | None = None


class PolicyDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allowed: bool
    decision: Literal["allow", "block"]
    policy_mode: Literal["shadow", "enforce"]
    legacy_id: str | None = None
    backend: ExecutionBackend | None = None
    strict_reasons: list[str] = Field(default_factory=list)
    shadow_reasons: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    risk_class: str | None = None
    spec_hash: str | None = None
    argv: list[str] | None = None
    env: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: int | None = None
    cwd: str | None = None


class ExecutionResult(BaseModel):
    model_config = ConfigDict(extra="allow")

    ok: bool
    exitCode: int
    timeout: bool = False
    businessFailure: bool = False
    durationSeconds: float
    stdout: str = ""
    stderr: str = ""
    stdoutPreview: str = ""
    stderrPreview: str = ""
    stdoutBytes: int = 0
    stderrBytes: int = 0
    stdoutTruncated: bool = False
    stderrTruncated: bool = False
    jsonStatus: dict[str, Any] = Field(default_factory=dict)
    executionBackend: Literal["argv"] = "argv"


class ReportEnvelope(BaseModel):
    model_config = ConfigDict(extra="allow")

    generatedAt: str
    contractVersion: str = "oss-agent-report-envelope-v2"
    capabilityId: str
    ok: bool
    status: str
    summary: str
    counts: dict[str, Any] = Field(default_factory=dict)
    blockingReasons: list[str] = Field(default_factory=list)
    warningReasons: list[str] = Field(default_factory=list)
    artifacts: dict[str, Any] = Field(default_factory=dict)
    checks: dict[str, Any] = Field(default_factory=dict)
