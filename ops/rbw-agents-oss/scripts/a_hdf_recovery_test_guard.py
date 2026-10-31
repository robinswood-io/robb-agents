from __future__ import annotations

import socket
import subprocess
from contextlib import ExitStack
from unittest.mock import patch

_EXTERNAL_ATTEMPTS: list[str] = []
_OFFLINE_GUARD = ExitStack()


def _blocked_attempt(name: str):
    def fail(*_args: object, **_kwargs: object) -> None:
        _EXTERNAL_ATTEMPTS.append(name)
        raise RuntimeError(f"offline_test_blocked:{name}")

    return fail


for target, attribute, label in (
    (socket.socket, "connect", "socket.connect"),
    (socket, "create_connection", "socket.create_connection"),
    (subprocess, "Popen", "subprocess.Popen"),
):
    _ = _OFFLINE_GUARD.enter_context(
        patch.object(target, attribute, side_effect=_blocked_attempt(label))
    )


def assert_no_external_attempts() -> None:
    _OFFLINE_GUARD.close()
    if _EXTERNAL_ATTEMPTS:
        raise AssertionError(f"unexpected_external_attempts:{_EXTERNAL_ATTEMPTS}")
