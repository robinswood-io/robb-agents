"""Typed SQLite reads and pacing for the bounded conference campaign."""
from __future__ import annotations

import sqlite3
from collections.abc import Iterable, Iterator, Mapping
from datetime import datetime, timedelta
from pathlib import Path
from typing import cast, override

from pydantic import JsonValue, TypeAdapter
from scotland_executive_conference_eligibility import dt
from scotland_executive_conference_types import CampaignLimits
from typing_extensions import TypedDict

JSON_OBJECT_ADAPTER: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])

class CampaignPacing(TypedDict):
    hourlyTouchesUsed: int
    waitSeconds: int
    blockingReasons: list[str]

class StateRow(Mapping[str, str]):
    def __init__(self, value: object) -> None:
        if not isinstance(value, sqlite3.Row):
            raise TypeError('invalid_campaign_state_row')
        self._row: sqlite3.Row = value

    def optional_text(self, key: str) -> str | None:
        value = cast(object, self._row[key])
        if value is None or isinstance(value, str):
            return value
        raise TypeError('invalid_campaign_state_value')

    @override
    def __getitem__(self, key: str) -> str:
        value = self.optional_text(key)
        if value is None:
            raise TypeError('missing_campaign_state_value')
        return value

    @override
    def __iter__(self) -> Iterator[str]:
        return iter(self._row.keys())

    @override
    def __len__(self) -> int:
        return len(self._row)


def state_rows(cursor: sqlite3.Cursor) -> list[StateRow]:
    return [StateRow(row) for row in cast(Iterable[object], cursor)]


def state_first(cursor: sqlite3.Cursor) -> StateRow | None:
    row = cast(object, cursor.fetchone())
    return None if row is None else StateRow(row)


def state_count(cursor: sqlite3.Cursor) -> int:
    row = cast(object, cursor.fetchone())
    if not isinstance(row, sqlite3.Row):
        raise TypeError('missing_campaign_count_row')
    value = cast(object, row[0])
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    raise TypeError('invalid_campaign_count')


def database(root: str | Path) -> sqlite3.Connection:
    db = sqlite3.connect(Path(root) / 'campaign-state.sqlite3')
    db.row_factory = sqlite3.Row
    _schema_cursor = db.executescript("""
      CREATE TABLE IF NOT EXISTS touches(item TEXT, step TEXT, variant TEXT, created TEXT,
        state TEXT, operation TEXT UNIQUE, expected TEXT, draft TEXT, signature TEXT,
        gmail_id TEXT, thread_id TEXT, checks TEXT, PRIMARY KEY(item,step));
      CREATE TABLE IF NOT EXISTS replies(gmail_id TEXT PRIMARY KEY,item TEXT,kind TEXT,observed TEXT,evidence TEXT);
    """)
    return db

def pacing(db: sqlite3.Connection, limits: CampaignLimits, t: datetime) -> CampaignPacing:
    # Every durable reservation consumes capacity, including unresolved sends.
    stamps: list[datetime] = []
    for row in state_rows(db.execute('SELECT created,checks FROM touches')):
        created = row['created']
        checks = row.optional_text('checks')
        parsed = JSON_OBJECT_ADAPTER.validate_json(checks or '{}')
        verified_value = parsed.get('gmailSentAt', created)
        verified_at = verified_value if isinstance(verified_value, str) else created
        stamps.append(max(dt(created), dt(verified_at)))
    hourly = sum(stamp_value > t - timedelta(hours=1) for stamp_value in stamps)
    interval_value = limits.get('minimumSendIntervalSeconds', 0)
    interval = interval_value
    remaining = max(0, int((max(stamps) + timedelta(seconds=interval) - t).total_seconds())) if stamps else 0
    reasons: list[str] = []
    hourly_limit = limits.get('hourlyTouches')
    if isinstance(hourly_limit, int) and hourly >= hourly_limit:
        reasons.append('rolling_hourly_touch_cap_reached')
    if interval and remaining > 0:
        reasons.append('minimum_send_interval_not_elapsed')
    return {'hourlyTouchesUsed': hourly, 'waitSeconds': remaining, 'blockingReasons': reasons}


def read_object(path: str | Path) -> dict[str, JsonValue]:
    return JSON_OBJECT_ADAPTER.validate_json(Path(path).read_bytes())


def suppressed(path: str | Path) -> set[str]:
    obj = read_object(path)
    out: set[str] = set()
    for collection_name in ('blockedRecipients', 'records'):
        entries = obj.get(collection_name, [])
        if not isinstance(entries, list):
            raise TypeError('invalid_suppression_collection')
        for entry in entries:
            if not isinstance(entry, dict):
                raise TypeError('invalid_suppression_entry')
            status = entry.get('status')
            active = entry.get('active') is True
            blocked = isinstance(status, str) and (status in {
                'do_not_contact', 'blocked', 'unsubscribe', 'opt_out', 'bounced_invalid_email'
            } or status.startswith('cooldown_'))
            if active or blocked:
                address_value = entry.get('email') or entry.get('value') or ''
                if isinstance(address_value, str):
                    out.add(address_value.lower())
    return out
