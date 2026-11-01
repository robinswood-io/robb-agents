"""Typed command-line entry point for the offline-safe Evergreen France runner."""
import argparse
import json
import sqlite3
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from typing import Protocol, cast

from evergreen_campaign_data_types import (
 CampaignRunResult,
 JsonObject,
 data_coerce_json_object,
)


class CampaignRunner(Protocol):
 def __call__(self, lane: str, apply: bool = False, research_only: bool = False, *, research_batch: int, maintain: bool) -> CampaignRunResult: ...


def main(run: CampaignRunner, lanes: Sequence[str], ids: dict[str, str], ops: Path, stamp: Callable[[datetime], str], now: Callable[[], datetime], save: Callable[[str | Path, JsonObject], None]) -> int:
 parser = argparse.ArgumentParser()
 _lane_action = parser.add_argument('--lane', choices=lanes, required=True)
 _apply_action = parser.add_argument('--apply', action='store_true')
 _research_action = parser.add_argument('--research-only', action='store_true')
 _batch_action = parser.add_argument('--research-batch', type=int, default=2)
 _maintain_action = parser.add_argument('--maintain', action='store_true')
 args = parser.parse_args()
 lane_value: object = cast(object, args.lane)
 apply_value: object = cast(object, args.apply)
 research_value: object = cast(object, args.research_only)
 batch_value: object = cast(object, args.research_batch)
 maintain_value: object = cast(object, args.maintain)
 if not isinstance(lane_value, str) or lane_value not in lanes:
  raise ValueError('unsupported campaign lane')
 if not isinstance(apply_value, bool) or not isinstance(research_value, bool) or not isinstance(maintain_value, bool):
  raise TypeError('invalid boolean command-line option')
 if not isinstance(batch_value, int) or isinstance(batch_value, bool):
  raise TypeError('invalid research batch size')
 lane = lane_value
 apply = apply_value
 research_only = research_value
 research_batch = batch_value
 maintain = maintain_value
 try:
  report = run(lane, apply, research_only, research_batch=max(0, min(research_batch, 6)), maintain=maintain)
  print(json.dumps({key: report[key] for key in ['ok', 'status', 'counts', 'summary']}, ensure_ascii=False))
  return 0
 except (OSError, ValueError, TypeError, KeyError, UnicodeError, sqlite3.Error) as error:
  report = data_coerce_json_object({'generatedAt': stamp(now()), 'capabilityId': ids[lane] + ('-maintenance' if maintain else ''), 'ok': False, 'status': 'error', 'summary': str(error), 'counts': {}})
  save(ops / (ids[lane] + ('-maintenance' if maintain else '') + '-last.json'), report)
  print(json.dumps(report))
  return 2
