from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path

from pydantic import JsonValue, ValidationError

from .json_support import JSON_VALUE_ADAPTER, _is_json_object
from .models import ExecutionResult, PolicyDecision


def _tail(value: str, limit: int = 2000) -> str:
    return value if len(value) <= limit else value[-limit:]


def _extract_json_status(stdout: str) -> dict[str, JsonValue]:
    text = (stdout or "").strip()
    if not text:
        return {}
    candidates = [text]
    candidates.extend(line.strip() for line in text.splitlines()[::-1] if line.strip().startswith("{") )
    for raw in candidates[:10]:
        try:
            parsed = JSON_VALUE_ADAPTER.validate_json(raw)
        except ValidationError:
            continue
        if _is_json_object(parsed):
            return parsed
    return {}


def execute_argv(
    decision: PolicyDecision | dict[str, JsonValue],
    *,
    extra_env: dict[str, JsonValue] | None = None,
) -> dict[str, JsonValue]:
    if isinstance(decision, dict):
        decision = PolicyDecision.model_validate(decision)
    if not decision.allowed:
        raise ValueError("cannot execute a blocked policy decision")
    if decision.backend is None or decision.backend.value != "argv" or not decision.argv:
        raise ValueError("execute_argv requires an allowed argv decision")

    env = os.environ.copy()
    env["HOME"] = env.get("HOME", "/home/ubuntu")
    env["BUN_INSTALL"] = env.get("BUN_INSTALL", "/home/ubuntu/.bun")
    env["PATH"] = "/srv/rbw-agents-oss/.venv/bin:" + env.get("BUN_INSTALL", "/home/ubuntu/.bun") + "/bin:" + env.get("PATH", "")
    env["RBW_RUNTIME_V2_BACKEND"] = "argv"
    env["RBW_RUNTIME_V2_SPEC_HASH"] = decision.spec_hash or ""
    env["RBW_RUNTIME_V2_POLICY_MODE"] = decision.policy_mode
    if decision.env:
        env.update(decision.env)
    if extra_env:
        env.update({str(key): str(value) for key, value in extra_env.items() if value is not None})

    cwd = str(decision.cwd or "/home/craft/.craft-agent/workspaces/my-workspace-2")
    if not Path(cwd).is_dir():
        raise FileNotFoundError(f"execution cwd does not exist: {cwd}")

    started = time.monotonic()
    proc = subprocess.Popen(
        list(decision.argv),
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=int(decision.timeout_seconds or 600))
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            stdout, stderr = proc.communicate(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                timed_out = True
            stdout, stderr = proc.communicate()

    stdout = stdout or ""
    stderr = stderr or ""
    json_status = _extract_json_status(stdout)
    business_failure = json_status.get("ok") is False
    exit_code = 124 if timed_out else int(proc.returncode or 0)
    if business_failure and exit_code == 0:
        exit_code = 1
    result = ExecutionResult(
        ok=(not timed_out) and exit_code == 0 and not business_failure,
        exitCode=exit_code,
        timeout=timed_out,
        businessFailure=business_failure,
        durationSeconds=round(time.monotonic() - started, 3),
        stdout=_tail(stdout),
        stderr=_tail(stderr),
        stdoutPreview=_tail(stdout, 1200),
        stderrPreview=_tail(stderr, 1600),
        stdoutBytes=len(stdout.encode("utf-8", errors="ignore")),
        stderrBytes=len(stderr.encode("utf-8", errors="ignore")),
        stdoutTruncated=len(stdout) > 2000,
        stderrTruncated=len(stderr) > 2000,
        jsonStatus=json_status if business_failure else {},
        executionBackend="argv",
    )
    return result.model_dump(mode="json")
