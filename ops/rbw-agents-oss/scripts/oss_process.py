#!/usr/bin/env python3
from __future__ import annotations

import os
import signal
import subprocess
from typing import Any, Sequence


def run(
    args: Sequence[str] | str,
    *,
    timeout: float | None = None,
    check: bool = False,
    capture_output: bool = False,
    text: bool | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    stdout: Any = None,
    stderr: Any = None,
    **kwargs: Any,
) -> subprocess.CompletedProcess:
    """subprocess.run-compatible wrapper that kills the whole process group on timeout.

    Python's subprocess.run(timeout=...) kills only the direct child process. Many OSS
    wrappers execute `bash -lc ...`, which can leave grandchildren running after a
    timeout. This wrapper starts a new session and terminates the process group.
    """
    if capture_output:
        stdout = subprocess.PIPE
        stderr = subprocess.PIPE
    if text is None:
        text = bool(kwargs.pop('universal_newlines', False))
    else:
        kwargs.pop('universal_newlines', None)

    proc = subprocess.Popen(
        args,
        cwd=cwd,
        env=env,
        stdout=stdout,
        stderr=stderr,
        text=text,
        start_new_session=True,
        **kwargs,
    )
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            out, err = proc.communicate(timeout=10)
        except Exception:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                pass
            out, err = proc.communicate()
        code = 124

    completed = subprocess.CompletedProcess(args=args, returncode=code, stdout=out, stderr=err)
    # Marking timeout for callers that inspect custom attrs while staying compatible
    # with CompletedProcess users.
    setattr(completed, 'timed_out', timed_out)
    if check and code != 0:
        raise subprocess.CalledProcessError(code, args, output=out, stderr=err)
    return completed
