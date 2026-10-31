"""Fail closed on network and child-process activity in Evergreen tests."""
from __future__ import annotations

import os
import socket
import subprocess
from collections.abc import Callable
from contextlib import AbstractContextManager, ExitStack
from typing import NoReturn, TypeGuard
from unittest.mock import patch

EXTERNAL_ATTEMPTS: list[str] = []

def _blocked(operation: str) -> Callable[..., NoReturn]:
    def reject(*arguments: object, **options: object) -> NoReturn:
        _ = arguments, options
        EXTERNAL_ATTEMPTS.append(operation)
        raise RuntimeError("offline Evergreen tests prohibit network and process execution")
    return reject

def assert_no_external_attempts() -> None:
    if EXTERNAL_ATTEMPTS:
        counts = {operation: EXTERNAL_ATTEMPTS.count(operation) for operation in sorted(set(EXTERNAL_ATTEMPTS))}
        raise AssertionError(f"offline guard blocked external attempts: {counts}")
    print("offline external attempts: 0")


def _is_context_manager(value: object) -> TypeGuard[AbstractContextManager[object]]:
    return callable(getattr(value, "__enter__", None)) and callable(getattr(value, "__exit__", None))


def _patch(stack: ExitStack, target: object, name: str) -> None:
    patcher: object = patch.object(target, name, side_effect=_blocked(name))
    if not _is_context_manager(patcher):
        raise TypeError(f"offline test guard could not patch {name}")
    _ = stack.enter_context(patcher)


_GUARDS = ExitStack()
for _target, _name in (
    (socket.socket, "connect"),
    (socket.socket, "connect_ex"),
    (socket, "create_connection"),
    (socket, "getaddrinfo"),
    (subprocess, "Popen"),
    (subprocess, "run"),
    (subprocess, "call"),
    (subprocess, "check_call"),
    (subprocess, "check_output"),
    (os, "system"),
    (os, "popen"),
):
    _patch(_GUARDS, _target, _name)
