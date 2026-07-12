from __future__ import annotations

import os
from typing import Any

from .models import AgentSpec, ExecutionBackend, Invocation, PolicyDecision

APPROVAL_KEYS = (
    "approved",
    "approvedForApply",
    "approvedForExternalSend",
    "humanApproved",
    "operatorApproved",
)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "approved", "allow"}


def _approval_present(payload: dict[str, Any]) -> bool:
    approval = payload.get("approval") if isinstance(payload.get("approval"), dict) else {}
    return any(_truthy(payload.get(key)) or _truthy(approval.get(key)) for key in APPROVAL_KEYS)


def _apply_requested(payload: dict[str, Any], argv: list[str] | None, manifest_env: dict[str, str]) -> bool:
    requested = str(payload.get("requested_effect") or payload.get("requestedEffect") or "").lower()
    if requested in {"apply", "mutation", "external_send", "send"}:
        return True
    text = " ".join(argv or []) + " " + " ".join(f"{key}={value}" for key, value in manifest_env.items())
    markers = (" --apply", "_APPLY=1", "ENABLE_MUTATIONS=true", "--send", "--go-live")
    return any(marker.lower() in f" {text}".lower() for marker in markers)


class PolicyEngine:
    """Deterministic preflight policy.

    Structural/runtime violations always fail closed. Business side-effect policy
    stays in shadow mode by default during migration and can later be promoted to
    enforce without changing the activity implementation.
    """

    def __init__(self, mode: str | None = None):
        requested = str(mode or os.getenv("RBW_RUNTIME_V2_POLICY_MODE", "shadow")).strip().lower()
        self.mode = "enforce" if requested == "enforce" else "shadow"

    def evaluate(
        self,
        payload: dict[str, Any],
        entry: dict[str, Any] | None,
        spec: AgentSpec | None,
        *,
        spec_hash: str | None = None,
    ) -> PolicyDecision:
        strict: list[str] = []
        shadow: list[str] = []
        warnings: list[str] = []
        legacy_id = payload.get("legacy_id")

        if not legacy_id:
            strict.append("missing_legacy_id")
        if entry is None:
            strict.append("unknown_automation_id")
        if entry is not None and entry.get("mode") != "script":
            strict.append("unsupported_manifest_mode")
        if spec is None:
            strict.append("catalog_spec_missing")

        backend: ExecutionBackend | None = None
        argv: list[str] | None = None
        manifest_env: dict[str, str] = {}
        timeout: int | None = None
        cwd: str | None = None
        risk_class: str | None = None

        if spec is not None:
            backend = spec.execution.backend
            argv = spec.execution.argv
            manifest_env = dict(spec.execution.env)
            timeout = spec.execution.timeout_seconds
            cwd = spec.execution.cwd
            risk_class = spec.risk_class

            if backend != ExecutionBackend.ARGV:
                strict.append("unsupported_execution_backend")
            elif not argv:
                strict.append("argv_backend_missing_argv")
            elif not argv[0].startswith("/"):
                strict.append("argv_executable_must_be_absolute")
            if any("\x00" in item for item in (argv or [])):
                strict.append("argv_contains_nul")

            if not spec.policy.classified:
                shadow.append("side_effect_policy_unclassified")
            approval_required = (
                spec.policy.requires_human_approval_for_apply
                or spec.policy.requires_human_approval_for_external_send
            )
            if approval_required and _apply_requested(payload, argv, manifest_env) and not _approval_present(payload):
                shadow.append("human_approval_required_for_requested_effect")

        enforced_shadow = list(shadow) if self.mode == "enforce" else []
        reasons = sorted(set(strict + enforced_shadow))
        allowed = not reasons
        return PolicyDecision(
            allowed=allowed,
            decision="allow" if allowed else "block",
            policy_mode=self.mode,
            legacy_id=str(legacy_id) if legacy_id else None,
            backend=backend,
            strict_reasons=sorted(set(strict)),
            shadow_reasons=sorted(set(shadow)),
            warnings=sorted(set(warnings)),
            risk_class=risk_class,
            spec_hash=spec_hash,
            argv=argv,
            env=manifest_env,
            timeout_seconds=timeout,
            cwd=cwd,
        )
