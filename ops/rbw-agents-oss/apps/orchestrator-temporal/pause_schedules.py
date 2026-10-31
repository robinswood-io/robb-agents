from __future__ import annotations

import argparse
import asyncio
import json
import logging
from pathlib import Path

from pydantic import JsonValue, TypeAdapter
from temporalio.client import Client
from temporalio.service import RPCError

JSON_VALUE_ADAPTER = TypeAdapter(JsonValue)
LOGGER = logging.getLogger(__name__)


def schedule_ids(raw_json: str) -> list[str]:
    data = JSON_VALUE_ADAPTER.validate_json(raw_json)
    if not isinstance(data, dict):
        raise TypeError("schedule manifest must be a JSON object")
    schedules = data.get("schedules", [])
    if not isinstance(schedules, list):
        raise TypeError("schedule manifest field 'schedules' must be an array")
    identifiers: list[str] = []
    for item in schedules:
        if not isinstance(item, dict):
            raise TypeError("schedule entries must be JSON objects")
        schedule_id = item.get("schedule_id")
        if not isinstance(schedule_id, str):
            raise TypeError("schedule entries require a string schedule_id")
        identifiers.append(schedule_id)
    return identifiers


class ScheduleArguments(argparse.Namespace):
    def __init__(self) -> None:
        super().__init__()
        self.manifest: str = "/srv/rbw-agents-oss/config/temporal/schedules.json"
        self.unpause: bool = False


async def main() -> None:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument(
        "--manifest", default="/srv/rbw-agents-oss/config/temporal/schedules.json"
    )
    _ = parser.add_argument("--unpause", action="store_true")
    args = parser.parse_args(namespace=ScheduleArguments())

    identifiers = schedule_ids(Path(args.manifest).read_text())
    client = await Client.connect("127.0.0.1:57233")
    changed = 0
    for schedule_id in identifiers:
        handle = client.get_schedule_handle(schedule_id)
        try:
            if args.unpause:
                _ = await handle.unpause(note="Cutover enabled by Craft Agent")
            else:
                _ = await handle.pause(note="Paused during migration / shadow mode")
            changed += 1
        except RPCError:
            LOGGER.exception("failed to update temporal schedule %s", schedule_id)
    print(
        json.dumps(
            {
                "total": len(identifiers),
                "changed": changed,
                "mode": "unpause" if args.unpause else "pause",
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
