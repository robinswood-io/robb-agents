from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
from pathlib import Path
from typing import cast

REPO_ROOT = Path(__file__).resolve().parents[5]
BIN_DIR = REPO_ROOT / "apps" / "electron" / "resources" / "bin"
SCRIPTS_DIR = REPO_ROOT / "apps" / "electron" / "resources" / "scripts"


def resolve_platform_key() -> str:
    sys_name = platform.system().lower()
    machine = platform.machine().lower()

    if machine in ("x86_64", "amd64"):
        arch = "x64"
    elif machine in ("arm64", "aarch64"):
        arch = "arm64"
    else:
        arch = machine

    if sys_name.startswith("darwin"):
        os_key = "darwin"
    elif sys_name.startswith("linux"):
        os_key = "linux"
    elif sys_name.startswith("windows"):
        os_key = "win32"
    else:
        os_key = os.name

    return f"{os_key}-{arch}"


def resolve_uv_binary() -> Path:
    platform_key = resolve_platform_key()
    uv_name = "uv.exe" if os.name == "nt" else "uv"
    bundled = BIN_DIR / platform_key / uv_name
    if bundled.exists():
        return bundled

    fallback = shutil.which("uv")
    if fallback:
        return Path(fallback)

    raise FileNotFoundError(f"No bundled uv at {bundled} and no uv on PATH")


def resolve_wrapper(tool_name: str) -> Path:
    wrapper = BIN_DIR / (f"{tool_name}.cmd" if os.name == "nt" else tool_name)
    if not wrapper.exists():
        raise FileNotFoundError(f"{tool_name} wrapper not found: {wrapper}")
    return wrapper


def build_env() -> dict[str, str]:
    uv = resolve_uv_binary()
    env = dict(os.environ)
    env["CRAFT_UV"] = str(uv)
    env["CRAFT_SCRIPTS"] = str(SCRIPTS_DIR)
    env["PATH"] = os.pathsep.join([
        str(BIN_DIR),
        str(uv.parent),
        env.get("PATH", ""),
    ])
    return env


def run_tool(tool_name: str, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    if env is None:
        env = build_env()
    wrapper = resolve_wrapper(tool_name)
    return subprocess.run(
        [str(wrapper), *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def parse_json_object(text: str) -> dict[str, object]:
    """Decode a JSON object into values safe for strict test assertions."""
    decoded: object = cast(object, json.loads(text))
    return require_json_object(decoded)

def parse_json_array(text: str) -> list[object]:
    """Decode a JSON array into values safe for strict test assertions."""
    decoded: object = cast(object, json.loads(text))
    if not isinstance(decoded, list):
        raise TypeError("Expected a JSON array")
    return [_normalize_json_value(item) for item in cast(list[object], decoded)]

def require_json_object(value: object) -> dict[str, object]:
    """Validate and normalize an already decoded JSON object."""
    if not isinstance(value, dict):
        raise TypeError("Expected a JSON object")
    result: dict[str, object] = {}
    for key, item in cast(dict[object, object], value).items():
        if not isinstance(key, str):
            raise TypeError("Expected JSON object keys to be strings")
        result[key] = _normalize_json_value(item)
    return result

def require_json_array(value: object) -> list[object]:
    """Validate and normalize an already decoded JSON array."""
    if not isinstance(value, list):
        raise TypeError("Expected a JSON array")
    return [_normalize_json_value(item) for item in cast(list[object], value)]

def _normalize_json_value(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_normalize_json_value(item) for item in cast(list[object], value)]
    if isinstance(value, dict):
        result: dict[str, object] = {}
        for key, item in cast(dict[object, object], value).items():
            if not isinstance(key, str):
                raise TypeError("Expected JSON object keys to be strings")
            result[key] = _normalize_json_value(item)
        return result
    raise TypeError("Decoded JSON contains an unsupported value")
