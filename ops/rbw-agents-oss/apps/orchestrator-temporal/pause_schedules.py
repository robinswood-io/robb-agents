from __future__ import annotations
import asyncio, json, argparse
from pathlib import Path
from temporalio.client import Client

async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', default='/srv/rbw-agents-oss/config/temporal/schedules.json')
    parser.add_argument('--unpause', action='store_true')
    args = parser.parse_args()

    data = json.loads(Path(args.manifest).read_text())
    schedules = data.get('schedules', [])
    client = await Client.connect('127.0.0.1:57233')
    changed = 0
    for item in schedules:
        sid = item['schedule_id']
        handle = client.get_schedule_handle(sid)
        try:
            if args.unpause:
                await handle.unpause(note='Cutover enabled by Craft Agent')
            else:
                await handle.pause(note='Paused during migration / shadow mode')
            changed += 1
        except Exception:
            pass
    print(json.dumps({'total': len(schedules), 'changed': changed, 'mode': 'unpause' if args.unpause else 'pause'}, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
