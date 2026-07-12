#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

SUDO = "/usr/bin/sudo"
SYSTEMCTL = "/usr/bin/systemctl"
UNIT = "rbw-drive-audio-transcription.service"
START_ARGV = [SUDO, "-n", SYSTEMCTL, "start", UNIT]
SHOW_ARGV = [SYSTEMCTL, "show", UNIT, "--property=ActiveState,SubState,MainPID", "--no-pager"]


def run(argv: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, text=True, capture_output=True, timeout=timeout, shell=False, check=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="Start and inspect the durable Drive audio transcription service without a shell.")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        missing = [path for path in (SUDO, SYSTEMCTL) if not Path(path).is_file()]
        payload = {"ok": not missing, "status": "passed" if not missing else "failed", "unit": UNIT, "startArgv": START_ARGV, "showArgv": SHOW_ARGV, "missingExecutables": missing, "shell": False}
        print(json.dumps(payload, ensure_ascii=False))
        raise SystemExit(0 if not missing else 1)
    started = time.monotonic()
    try:
        start = run(START_ARGV, 45)
    except subprocess.TimeoutExpired as exc:
        print(json.dumps({"ok": False, "status": "timeout", "unit": UNIT, "stage": "start", "timeout": True, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(124)
    show = run(SHOW_ARGV, 15) if start.returncode == 0 else None
    payload = {
        "ok": start.returncode == 0 and show is not None and show.returncode == 0,
        "status": "started" if start.returncode == 0 and show is not None and show.returncode == 0 else "failed",
        "unit": UNIT,
        "startExitCode": start.returncode,
        "showExitCode": show.returncode if show is not None else None,
        "serviceState": (show.stdout or "").strip() if show is not None else "",
        "stderr": ((start.stderr or "") + (show.stderr or "" if show is not None else ""))[-1600:],
        "durationSeconds": round(time.monotonic() - started, 3),
        "shell": False,
    }
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(0 if payload["ok"] else int(start.returncode or (show.returncode if show is not None else 1) or 1))


if __name__ == "__main__":
    main()
