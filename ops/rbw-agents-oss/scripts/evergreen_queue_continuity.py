"""Bounded refill and original-thread-only historical press followups."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol, cast
from zoneinfo import ZoneInfo

import evergreen_campaign_data_types as data_types
import scotland_conference_transport as transport
from evergreen_campaign_data_types import JsonObject

APPROVED = data_types.data_parse_json_object("{\"version\":\"2026-10-04.queue.1\",\"authorization\":{\"source\":\"human_queue_continuity_and_historical_followup_request_2026-10-04\",\"approvedBy\":\"Thibault\",\"request\":\"contrôle que la queue avance bien et qu’elle ne tombera jamais à 0, ne serait-ce que parce qu’elle doit relancer d’anciens contacts\",\"campaignScopeSha256\":\"9a54b413638f3d5e9810d18854af73378fb22e1c4c7e7e2883af24a2d2c7cf3d\"},\"readyBusinessDays\":3,\"minimumCompanyResearchReserve\":100,\"registryMinimumIntervalSeconds\":3600,\"registryMaximumCallsPerDayPerLane\":8,\"failedProofRetryHours\":24,\"discoveryRetryHours\":24,\"validProofMaxAgeDays\":7,\"historicalAuditBatch\":2,\"historicalFollowupCampaigns\":[\"robinswood-media-authority-2026\"],\"preserveOperatorHolds\":true,\"preserveHistoricalHdfPause\":true,\"historicalFollowupMaximum\":1,\"followupBusinessDays\":10,\"unknownEffectBlocks\":true,\"replyStopsFollowup\":true,\"allExistingCapsPreserved\":true,\"paidAllowed\":false}")

class GatewayPort(Protocol):
 def call(self, path: str) -> JsonObject: ...
 def search(self, query: str) -> list[JsonObject]: ...
 def get(self, mid: str) -> JsonObject: ...

class HistoricalHold(RuntimeError):
 """A historical contact cannot be safely used for followup."""

def _text(row: JsonObject | sqlite3.Row, key: str) -> str:
 if isinstance(row, sqlite3.Row):
  value: object = data_types.data_cell(row, key)
  if not isinstance(value, str):
   raise TypeError(f'expected text in SQLite column {key}')
  return value
 return data_types.data_text(row.get(key))

def _rows(db: sqlite3.Connection, query: str, params: tuple[object, ...] = ()) -> list[sqlite3.Row]:
 return data_types.data_sqlite_rows(cast(object, db.execute(query, params).fetchall()))

def _header(message: JsonObject, name: str) -> str:
 parser: Callable[[JsonObject, str], object] = cast(Callable[[JsonObject, str], object], transport.header)
 result = parser(message, name)
 if not isinstance(result, str):
  raise TypeError('transport returned invalid header value')
 return result

def _addresses(value: str) -> list[str]:
 parser: Callable[[str], object] = cast(Callable[[str], object], transport.addresses)
 result = parser(value)
 if not isinstance(result, list):
  raise TypeError('transport returned invalid address list')
 addresses: list[str] = []
 for item in cast(list[object], result):
  if not isinstance(item, str):
   raise TypeError('transport returned invalid address')
  addresses.append(item)
 return addresses


def policy(path: Path | None = None) -> JsonObject | None:
 policy_path = path or Path('/srv/rbw-agents-oss/config/robinswood-evergreen-queue.json')
 try:
  config = data_types.data_parse_json_object(policy_path.read_text())
 except FileNotFoundError:
  return None
 assert config == APPROVED, 'queue_policy_not_authorized'
 return config

def dt(value: str) -> datetime:
 return datetime.fromisoformat(value)

def ensure_schema(db: sqlite3.Connection, root: Path) -> None:
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='historical_threads'").fetchone():
  return
 archive = root.parent / 'archive' / root.name
 archive.mkdir(parents=True, exist_ok=True)
 backup = archive / ('historical-queue-schema-' + datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite3')
 snapshot = sqlite3.connect(backup)
 try:
  db.backup(snapshot)
 finally:
  snapshot.close()
 _ = db.execute('CREATE TABLE historical_threads(email TEXT PRIMARY KEY,message_id TEXT,thread TEXT,sender TEXT,subject TEXT,sent_at TEXT,effect_hash TEXT,checked TEXT,status TEXT,reason TEXT)')
 _ = db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', ('historical_queue_schema_backup', str(backup)))
 db.commit()

def canonical_effect(message: JsonObject) -> str:
 payload = {key: message.get(key) for key in ['id', 'threadId', 'internalDate', 'payload']}
 return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def validate_parent(message: JsonObject, row: JsonObject | sqlite3.Row) -> bool:
 return (
  'SENT' in data_types.data_json_array(message.get('labelIds'))
  and data_types.data_text(message.get('id')) == _text(row, 'message_id')
  and data_types.data_text(message.get('threadId')) == _text(row, 'thread')
  and _addresses(_header(message, 'From')) == [_text(row, 'sender')]
  and _addresses(_header(message, 'To')) == [_text(row, 'email')]
  and _header(message, 'Subject') == _text(row, 'subject')
  and canonical_effect(message) == _text(row, 'effect_hash')
 )

def historical_parent(db: sqlite3.Connection, email: str) -> sqlite3.Row | None:
 return data_types.data_sqlite_row(cast(object, db.execute("SELECT * FROM historical_threads WHERE email=? AND status='eligible'", (email,)).fetchone()))

def hold(db: sqlite3.Connection, row: JsonObject | sqlite3.Row, reason: str) -> None:
 _ = db.execute("UPDATE historical_threads SET status='held',reason=? WHERE email=?", (reason, _text(row, 'email')))
 db.commit()
 raise HistoricalHold(reason)

def no_other_relationship(gateway: GatewayPort, row: JsonObject | sqlite3.Row, observer: Callable[[JsonObject | sqlite3.Row, JsonObject], None] | None = None) -> bool:
 thread = gateway.call('/threads/' + _text(row, 'thread') + '?format=full')
 others = [message for message in data_types.data_json_objects(thread.get('messages')) if data_types.data_text(message.get('id')) != _text(row, 'message_id')]
 date = (dt(_text(row, 'sent_at')) - timedelta(days=1)).date().isoformat()
 cutoff = int(dt(_text(row, 'sent_at')).timestamp() * 1000)
 for query in ['from:' + _text(row, 'email') + ' -in:sent after:' + date, 'in:sent to:' + _text(row, 'email') + ' after:' + date]:
  for reference in gateway.search(query):
   reference_id = data_types.data_text(reference.get('id'))
   if reference_id == _text(row, 'message_id') or reference_id in {data_types.data_text(message.get('id')) for message in others}:
    continue
   message = gateway.get(reference_id)
   if data_types.data_integer(message.get('internalDate')) >= cutoff:
    others.append(message)
 if observer is not None:
  for message in others:
   observer(row, message)
 return not others

def audit_historical(db: sqlite3.Connection, gateway: GatewayPort, lane: str, t: datetime, exclusions: set[str], business_days_fn: Callable[[datetime, datetime], int], cfg: JsonObject, observer: Callable[[JsonObject | sqlite3.Row, JsonObject], None] | None = None) -> JsonObject:
 if lane != 'presse':
  return {'checked': 0, 'eligible': 0, 'held': 0}
 retry_before = data_types.stamp(t - timedelta(hours=data_types.data_integer(cfg.get('failedProofRetryHours'))))
 rows = _rows(db, "SELECT l.* FROM legacy l JOIN candidates c ON c.email=l.email LEFT JOIN historical_threads h ON h.email=l.email WHERE l.state='sent' AND l.campaign='robinswood-media-authority-2026' AND (h.email IS NULL OR (h.status='held' AND h.reason LIKE 'historical_read_unavailable_%' AND h.checked<?)) ORDER BY l.rowid LIMIT ?", (retry_before, data_types.data_integer(cfg.get('historicalAuditBatch'))))
 checked = eligible = held_count = 0
 for legacy in rows:
  checked += 1
  email = _text(legacy, 'email')
  result: JsonObject = {'email': email, 'message_id': _text(legacy, 'message_id'), 'thread': None, 'sender': None, 'subject': _text(legacy, 'subject'), 'sent_at': None, 'effect_hash': None, 'checked': data_types.stamp(t), 'status': 'held', 'reason': 'not_audited'}
  try:
   if email in exclusions:
    result['reason'] = 'suppressed'
   else:
    message = gateway.get(_text(legacy, 'message_id'))
    result.update(thread=data_types.data_text(message.get('threadId')), sender=transport.SENDER, subject=_header(message, 'Subject'), sent_at=data_types.data_text(message.get('internalDate')))
    result['sent_at'] = datetime.fromtimestamp(data_types.data_integer(message.get('internalDate')) / 1000, UTC).isoformat()
    result['effect_hash'] = canonical_effect(message)
    if not validate_parent(message, result) or _header(message, 'Cc') or _header(message, 'Bcc') or not transport.plain(data_types.data_json_object_or_empty(message.get('payload'))).strip():
     result['reason'] = 'original_effect_or_reply_not_proven'
    elif business_days_fn(dt(_text(result, 'sent_at')), t) < data_types.data_integer(cfg.get('followupBusinessDays')):
     result['reason'] = 'followup_not_due'
    elif not no_other_relationship(gateway, result, observer):
     result['reason'] = 'historical_reply_or_later_touch'
    else:
     result.update(status='eligible', reason='original_effect_verified_pending_fresh_qualification')
  except (OSError, ValueError, TypeError, KeyError, RuntimeError) as exc:
   result['reason'] = 'historical_read_unavailable_' + type(exc).__name__
  _ = db.execute('INSERT INTO historical_threads VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET message_id=excluded.message_id,thread=excluded.thread,sender=excluded.sender,subject=excluded.subject,sent_at=excluded.sent_at,effect_hash=excluded.effect_hash,checked=excluded.checked,status=excluded.status,reason=excluded.reason', tuple(result[key] for key in ['email', 'message_id', 'thread', 'sender', 'subject', 'sent_at', 'effect_hash', 'checked', 'status', 'reason']))
  eligible += result['status'] == 'eligible'
  held_count += result['status'] != 'eligible'
 db.commit()
 return {'checked': checked, 'eligible': eligible, 'held': held_count}

def refill_allowed(db: sqlite3.Connection, lane: str, t: datetime, required: bool, cfg: JsonObject | None) -> bool:
 if cfg is None or lane == 'presse':
  return False
 key = 'queue_registry_' + lane
 previous = data_types.data_sqlite_row(cast(object, db.execute('SELECT value FROM metadata WHERE key=?', (key,)).fetchone()))
 state = data_types.data_parse_json_object(_text(previous, 'value')) if previous is not None else {}
 day = t.astimezone(ZoneInfo('Europe/Paris')).date().isoformat()
 used = data_types.data_integer(state.get('used')) if state.get('day') == day else 0
 if used >= data_types.data_integer(cfg.get('registryMaximumCallsPerDayPerLane')):
  return False
 last = data_types.data_text(state.get('last'))
 if last and (t - dt(last)).total_seconds() < data_types.data_integer(cfg.get('registryMinimumIntervalSeconds')):
  return False
 if not required:
  return False
 _ = db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (key, json.dumps({'day': day, 'used': used + 1, 'last': t.isoformat()})))
 db.commit()
 return True

def coverage(db: sqlite3.Connection, lane: str, t: datetime, contract: JsonObject, audience: JsonObject, cfg: JsonObject | None) -> JsonObject | None:
 if cfg is None:
  return None
 ramp = data_types.data_json_object_or_empty(contract.get('postScotlandRamp'))
 target = ramp.get('steadyLaneDailyMax', contract.get('lanes'))
 if not isinstance(target, dict):
  raise TypeError('expected daily lane targets')
 lane_target = target.get(lane)
 daily = data_types.data_integer(lane_target.get('dailyMax')) if isinstance(lane_target, dict) else data_types.data_integer(lane_target)
 initial = data_types.data_integer(audience.get('readyForInitial'))
 due = future = held = 0
 for row in _rows(db, "SELECT c.email,c.proof,t.created FROM candidates c JOIN touches t ON c.email=t.email WHERE t.step='initial' AND t.state='verified' AND t.lane=?", (lane,)):
  days = data_types.business_days(dt(_text(row, 'created')), t)
  if days >= data_types.data_integer(cfg.get('followupBusinessDays')):
   due += 1
  else:
   future += 1
 for row in _rows(db, 'SELECT h.email,h.status,c.proof FROM historical_threads h JOIN candidates c ON c.email=h.email WHERE c.lane=?', (lane,)):
  proof = data_types.data_parse_json_object(_text(row, 'proof')) if data_types.data_cell(row, 'proof') is not None else {}
  fresh = proof.get('ok') is True and bool(data_types.data_text(proof.get('checkedAt'))) and 0 <= (t - dt(data_types.data_text(proof.get('checkedAt')))).total_seconds() < data_types.data_number(contract.get('proofMaxAgeDays')) * 86400
  if _text(row, 'status') == 'eligible' and fresh:
   due += 1
  else:
   held += 1
 pending_raw = data_types.data_sqlite_value(db, "SELECT count(*) FROM research WHERE json_extract(payload,'$.categorie_entreprise')=? AND (checked IS NULL OR checked<?)", ('PME', data_types.stamp(t - timedelta(days=7))))
 pending = data_types.data_sqlite_integer(pending_raw)
 ready = initial + due
 target_count = daily * data_types.data_integer(cfg.get('readyBusinessDays'))
 return {'readyInitials': initial, 'followupsDueBeforeFreshChecks': due, 'followupsScheduledLater': future, 'historicalHeld': held, 'targetReady': target_count, 'researchReserve': pending, 'refillRequired': ready < target_count or pending < data_types.data_integer(cfg.get('minimumCompanyResearchReserve'))}
