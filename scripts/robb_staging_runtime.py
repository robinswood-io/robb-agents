from __future__ import annotations

import json
import os
from pathlib import Path
import time

from robb_staging_common import (
    APP_ID,
    StagingError,
    Runner,
    Swapper,
    run_command,
)

def parse_runtime_lock(lock_file: Path) -> tuple[int, int]:
    try:
        payload = json.loads(lock_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StagingError(f"Runtime lock is missing or invalid: {lock_file}: {error}") from error
    pid = payload.get("pid") if isinstance(payload, dict) else None
    started_at = payload.get("startedAt") if isinstance(payload, dict) else None
    if not isinstance(pid, int) or pid <= 0 or not isinstance(started_at, int) or started_at <= 0:
        raise StagingError(f"Runtime lock has invalid pid/startedAt: {lock_file}")
    return pid, started_at

def process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # If the OS refuses inspection, fail closed and treat the PID as live.
        return True

def bundle_processes(app: Path, runner: Runner = run_command) -> list[tuple[int, str]]:
    prefix = str(app.resolve()) + "/Contents/"
    result = runner(["/bin/ps", "-axo", "pid=,command="])
    found: list[tuple[int, str]] = []
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        pid_text, separator, command = line.partition(" ")
        if separator and pid_text.isdigit() and prefix in command:
            found.append((int(pid_text), command))
    return found

def assert_application_stopped(app: Path, lock_file: Path, runner: Runner = run_command) -> None:
    processes = bundle_processes(app, runner)
    if processes or lock_file.exists():
        raise StagingError(
            "Robb Agents reopened before the atomic exchange; transaction aborted. "
            f"Remaining processes={processes}, runtimeLockExists={lock_file.exists()}"
        )

def wait_until_stopped(
    app: Path,
    lock_file: Path,
    *,
    timeout: float,
    runner: Runner = run_command,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not bundle_processes(app, runner) and not lock_file.exists():
            return
        time.sleep(0.25)
    processes = bundle_processes(app, runner)
    raise StagingError(
        "Robb Agents did not stop cleanly; no files were exchanged. "
        f"Remaining processes={[(pid, command) for pid, command in processes]}, "
        f"runtimeLockExists={lock_file.exists()}"
    )

def quit_application(
    app: Path,
    lock_file: Path,
    *,
    timeout: float,
    runner: Runner = run_command,
) -> None:
    live_lock = False
    if lock_file.exists():
        try:
            lock_pid, _ = parse_runtime_lock(lock_file)
            live_lock = process_is_alive(lock_pid)
        except StagingError:
            # Keep the unparsable lock as a blocker, but do not launch an app
            # merely by sending it an Apple Event.
            live_lock = False
    if bundle_processes(app, runner) or live_lock:
        runner(
            ["/usr/bin/osascript", "-e", f'tell application id "{APP_ID}" to quit'],
            check=False,
            timeout=max(5, timeout),
        )
    wait_until_stopped(app, lock_file, timeout=timeout, runner=runner)

def verify_runtime(
    app: Path,
    lock_file: Path,
    *,
    launched_after_ms: int,
    timeout: float,
    runner: Runner = run_command,
) -> dict[str, int | str]:
    expected_executable = str(app.resolve() / "Contents/MacOS/Robb Agents")
    deadline = time.monotonic() + timeout
    last_error = "runtime did not create its production-profile lock"
    while time.monotonic() < deadline:
        try:
            pid, started_at = parse_runtime_lock(lock_file)
            if started_at < launched_after_ms:
                last_error = f"runtime lock is stale ({started_at} < {launched_after_ms})"
            elif not process_is_alive(pid):
                last_error = f"runtime pid {pid} is not alive"
            else:
                command = runner(["/bin/ps", "-p", str(pid), "-o", "command="]).stdout.strip()
                if command == expected_executable or command.startswith(expected_executable + " "):
                    return {"pid": pid, "startedAt": started_at, "command": command}
                last_error = f"runtime pid {pid} is not the installed target: {command!r}"
        except StagingError as error:
            last_error = str(error)
        time.sleep(0.25)
    raise StagingError(f"Installed runtime verification failed: {last_error}")

def launch_and_verify_runtime(
    app: Path,
    profile_root: Path,
    *,
    timeout: float,
    runner: Runner = run_command,
) -> dict[str, int | str]:
    lock_file = profile_root.resolve() / "robb-electron/.server.lock"
    launched_after_ms = int(time.time() * 1000)
    runner(["/usr/bin/open", str(app.resolve())])
    return verify_runtime(
        app,
        lock_file,
        launched_after_ms=launched_after_ms,
        timeout=timeout,
        runner=runner,
    )

def rollback_exchange(target: Path, previous: Path, failed: Path, swapper: Swapper) -> None:
    if not previous.exists():
        raise StagingError(f"Immediate rollback bundle is missing: {previous}")
    if failed.exists():
        raise StagingError(f"Refusing to overwrite failed-candidate evidence: {failed}")
    if not target.exists():
        raise StagingError(f"Installed candidate is missing: {target}")
    # The first operation restores the old app atomically. Evidence is moved
    # only afterwards, so an interruption cannot leave the target absent.
    swapper(target, previous)
    try:
        os.replace(previous, failed)
    except OSError as error:
        raise StagingError(
            f"Previous app was restored, but failed-candidate evidence remains at {previous}: {error}"
        ) from error
