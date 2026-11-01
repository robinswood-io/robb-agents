from __future__ import annotations

import html
import re
import sqlite3
import unicodedata
from datetime import UTC, datetime, timedelta
from typing import NotRequired, Required, TypedDict, TypeGuard, cast
from zoneinfo import ZoneInfo

from pydantic import JsonValue, TypeAdapter

JSON_ADAPTER = TypeAdapter(JsonValue)
JsonObject = dict[str, JsonValue]

class CampaignDraft(TypedDict):
 subject: str
 body: str

class CampaignCounts(TypedDict, total=False, extra_items=JsonValue):
 sentNow: Required[int]

class CampaignRunResult(TypedDict, total=False, extra_items=JsonValue):
 status: Required[str]
 counts: NotRequired[CampaignCounts]

__all__ = [
 'CampaignCounts',
 'CampaignDraft',
 'CampaignRunResult',
 'JsonObject',
 'JsonValue',
 'business_days',
 'campaign_run_result',
 'data_cell',
 'data_coerce_json_object',
 'data_integer',
 'data_json_array',
 'data_json_object',
 'data_json_object_or_empty',
 'data_json_objects',
 'data_number',
 'data_parse_json_object',
 'data_published_emails',
 'data_sqlite_row',
 'data_sqlite_rows',
 'data_sqlite_value',
 'data_text',
 'dt',
 'norm',
 'now',
 'stamp',
]

def data_published_emails(data: str, pattern: re.Pattern[str]) -> set[str]:
 emails = {match.group().lower() for match in pattern.finditer(html.unescape(data))}
 for match in re.finditer(r'data-cfemail=["\x27]([0-9a-fA-F]+)', data):
  token = cast(object, match.group(1))
  if not isinstance(token, str) or len(token) > 512: continue
  try:
   value = bytes.fromhex(token)
   email = bytes(byte ^ value[0] for byte in value[1:]).decode('utf-8')
   if pattern.fullmatch(email): emails.add(email.lower())
  except (IndexError, UnicodeDecodeError, ValueError): continue
 return emails

def _is_json_object(value: JsonValue) -> TypeGuard[JsonObject]:
 return isinstance(value,dict)

def data_json_object(value: JsonValue) -> JsonObject:
 if _is_json_object(value): return value
 raise TypeError("expected a JSON object")

def data_parse_json_object(raw: str) -> JsonObject:
 return data_json_object(JSON_ADAPTER.validate_json(raw))

def data_json_array(value: JsonValue | None) -> list[JsonValue]:
 if value is None: return []
 if isinstance(value, list): return value
 raise TypeError("expected a JSON array")

def data_json_object_or_empty(value: JsonValue | None) -> JsonObject:
 if value is None: return {}
 return data_json_object(value)

def data_json_objects(value: JsonValue | None) -> list[JsonObject]:
 return [data_json_object(item) for item in data_json_array(value)]

def data_sqlite_row(value: object) -> sqlite3.Row | None:
 if value is None: return None
 if isinstance(value, sqlite3.Row): return value
 raise TypeError("expected a SQLite row")

def data_sqlite_rows(value: object) -> list[sqlite3.Row]:
 if not isinstance(value, list): raise TypeError("expected SQLite rows")
 rows: list[sqlite3.Row] = []
 for item in cast(list[object], value):
  if not isinstance(item, sqlite3.Row): raise TypeError("expected a SQLite row")
  rows.append(item)
 return rows

def data_cell(row: sqlite3.Row, column: str) -> object:
 return cast(object, row[column])

def data_sqlite_integer(value: object | None) -> int:
 if value is None: return 0
 if isinstance(value, bool | int | float | str): return int(value)
 raise TypeError("expected a SQLite integer")

def data_coerce_json_object(value: object) -> JsonObject:
 return data_json_object(JSON_ADAPTER.validate_python(value))

def _is_campaign_run_result(value: JsonObject) -> TypeGuard[CampaignRunResult]:
 if not isinstance(value.get('status'), str): return False
 counts = value.get('counts')
 if counts is None: return True
 if not isinstance(counts, dict): return False
 sent = counts.get('sentNow')
 return isinstance(sent, int) and not isinstance(sent, bool)

def campaign_run_result(value: object) -> CampaignRunResult:
 report = data_coerce_json_object(value)
 report['status'] = data_text(report.get('status'))
 raw_counts = report.get('counts')
 if raw_counts is not None:
  counts = data_json_object(raw_counts)
  sent = counts.get('sentNow')
  if sent is None: raise TypeError('campaign counts lack sentNow')
  counts['sentNow'] = data_integer(sent)
  report['counts'] = counts
 if not _is_campaign_run_result(report): raise TypeError('campaign run result is invalid')
 return report

def data_json_value(value: object) -> JsonValue:
 return JSON_ADAPTER.validate_python(value)

def data_text(value: JsonValue | None, default: str = "") -> str:
 if value is None: return default
 if isinstance(value, str): return value
 raise TypeError("expected a JSON string")

def data_integer(value: JsonValue | None, default: int = 0) -> int:
 if value is None: return default
 if isinstance(value, (str, int, float, bool)): return int(value)
 raise TypeError("expected an integer-compatible JSON value")

def data_number(value: JsonValue | None, default: float = 0.0) -> float:
 if value is None: return default
 if isinstance(value, (str, int, float, bool)): return float(value)
 raise TypeError("expected a numeric JSON value")


def data_sqlite_value(connection: sqlite3.Connection, query: str, parameters: tuple[object, ...] = ()) -> object | None:
 raw: object = cast(object, connection.execute(query, parameters).fetchone())
 if raw is None: return None
 if isinstance(raw, sqlite3.Row): value: object = cast(object, raw[0])
 elif isinstance(raw, tuple) and raw: value = cast(object, raw[0])
 else: raise TypeError("expected a SQLite result row")
 if value is None or isinstance(value, str | bytes | int | float): return value
 raise TypeError("expected a SQLite scalar")

def now() -> datetime:
 return datetime.now(UTC)

def stamp(value: datetime) -> str:
 return value.isoformat().replace('+00:00', 'Z')

def dt(value: str) -> datetime:
 return datetime.fromisoformat(value)

def norm(value: object) -> str:
 return ''.join(character for character in unicodedata.normalize('NFKD', str(value or '').lower()) if not unicodedata.combining(character))


def business_days(start: datetime, end: datetime) -> int:
 start_day = start.astimezone(ZoneInfo('Europe/Paris')).date()
 end_day = end.astimezone(ZoneInfo('Europe/Paris')).date()
 count = 0
 while start_day < end_day:
  start_day += timedelta(days=1)
  count += start_day.weekday() < 5
 return count
