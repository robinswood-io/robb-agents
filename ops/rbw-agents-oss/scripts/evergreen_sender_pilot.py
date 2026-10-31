#!/usr/bin/env python3
"""Approved two-sender experiment; company ownership never changes on a retry."""
from __future__ import annotations

import base64
import hashlib
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from email import policy as email_policy
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from typing import cast
from zoneinfo import ZoneInfo

import evergreen_campaign_data_types as data_types
import outbound_sender_guard as guard
from evergreen_campaign_data_types import JsonObject, JsonValue

PRIMARY: str = guard.SENDER
ROBB: str = guard.ROBB
VERSION: str = guard.SENDER_STRATEGY
DISCLOSURE = 'Je suis Robb, l’assistant IA de Robinswood.'
APPROVED = data_types.data_parse_json_object("{\"version\":\"2026-10-04.1\",\"authorizationSource\":\"human_robb_sender_pilot_approval_2026-10-04\",\"approvedBy\":\"Thibault\",\"approvedAt\":\"2026-10-04\",\"previousScopeSha256\":\"263e3bc6879eb1936762e96b06eff31329815995b82691326e36fc9b22624270\",\"primaryAccount\":\"thibault@robinswood.io\",\"pressSender\":\"thibault@robinswood.io\",\"prospectingSenders\":[\"thibault@robinswood.io\",\"robb@robinswood.io\"],\"initialLaneDailyMax\":{\"pme\":5,\"eti\":3},\"steadyLaneDailyMax\":{\"pme\":6,\"eti\":4},\"initialProspectingDailyMaxPerSender\":8,\"steadyProspectingDailyMaxPerSender\":10,\"assignment\":\"balanced_immutable_company_with_hashed_ties\",\"existingConversations\":\"preserve_actual_sender_subject_thread\",\"allEffectsConsumeQuota\":true,\"robbDisclosure\":\"Je suis Robb, l’assistant IA de Robinswood.\",\"learning\":\"isolate_sender_strategy_and_copy_version\",\"sharedAccountCapsPreserved\":true}")

def _row_text(row: sqlite3.Row, column: str) -> str:
 value: object = data_types.data_cell(row, column)
 if not isinstance(value, str):
  raise TypeError(f'expected text in SQLite column {column}')
 return value

def _rows(db: sqlite3.Connection, query: str, params: tuple[object, ...] = ()) -> list[sqlite3.Row]:
 return data_types.data_sqlite_rows(cast(object, db.execute(query, params).fetchall()))

def _scalar_int(db: sqlite3.Connection, query: str, params: tuple[object, ...] = ()) -> int:
 return data_types.data_sqlite_integer(data_types.data_sqlite_value(db, query, params))

def verify_contract(contract: JsonObject, digest: Callable[[JsonObject], str]) -> None:
 pilot = data_types.data_json_object_or_empty(contract.get('senderPilot'))
 if not pilot:
  return
 assert pilot == APPROVED, 'sender_pilot_scope_not_authorized'
 previous = {key: value for key, value in contract.items() if key not in ['authorization', 'senderPilot']}
 assert digest(previous) == data_types.data_text(pilot.get('previousScopeSha256')), 'sender_pilot_prior_scope_changed'
 authorization = data_types.data_json_object_or_empty(contract.get('authorization'))
 assert authorization.get('latestApprovalSource') == pilot.get('authorizationSource'), 'sender_pilot_approval_missing'
 shared = contract.get('sharedSender')
 if shared != {'dailyMax': 40, 'weeklyMax': 200, 'hourlyMax': 6, 'minimumIntervalSeconds': 600}:
  raise AssertionError('shared_sender_contract_changed')

def ensure_schema(db: sqlite3.Connection, root: Path) -> None:
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='sender_bindings'").fetchone():
  return
 archive = root.parent / 'archive' / root.name
 archive.mkdir(parents=True, exist_ok=True)
 backup = archive / ('sender-pilot-schema-' + datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite3')
 snapshot = sqlite3.connect(backup)
 try:
  db.backup(snapshot)
 finally:
  snapshot.close()
 _ = db.execute('CREATE TABLE sender_bindings(account TEXT PRIMARY KEY,sender TEXT NOT NULL,strategy TEXT NOT NULL,lane TEXT NOT NULL,created TEXT NOT NULL)')
 _ = db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', ('sender_pilot_schema_backup', str(backup)))
 db.commit()

def touch_identity(row: sqlite3.Row) -> tuple[str, str]:
 raw = _row_text(row, 'raw')
 message = BytesParser(policy=email_policy.default).parsebytes(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
 senders = [address.lower() for _, address in getaddresses([str(message.get('From', ''))]) if address]
 if len(senders) != 1 or senders[0] not in [PRIMARY, ROBB]:
  raise RuntimeError('stored_sender_unproven')
 version = str(message.get('X-RBW-Sender-Strategy') or 'legacy')
 if senders[0] == ROBB and version != VERSION:
  raise RuntimeError('stored_robb_strategy_unproven')
 if version not in ['legacy', VERSION]:
  raise RuntimeError('stored_sender_strategy_unproven')
 return senders[0], version

def daily_usage(db: sqlite3.Connection, t: datetime) -> dict[str, dict[str, int]]:
 day = t.astimezone(ZoneInfo('Europe/Paris')).date()
 counts = {sender: {'pme': 0, 'eti': 0, 'total': 0} for sender in [PRIMARY, ROBB]}
 for row in _rows(db, "SELECT * FROM touches WHERE lane IN ('pme','eti')"):
  created = datetime.fromisoformat(_row_text(row, 'created')).astimezone(ZoneInfo('Europe/Paris')).date()
  if created != day:
   continue
  sender, _version = touch_identity(row)
  lane = _row_text(row, 'lane')
  counts[sender][lane] += 1
  counts[sender]['total'] += 1
 return counts

def quota(db: sqlite3.Connection, lane: str, sender: str, t: datetime, cap: JsonValue, contract: JsonObject) -> bool:
 pilot = data_types.data_json_object_or_empty(contract.get('senderPilot'))
 if not pilot or lane == 'presse':
  return True
 cap_data = data_types.data_json_object(cap) if isinstance(cap, dict) else {}
 ramp = data_types.data_json_object_or_empty(cap_data.get('portfolioRamp'))
 phase = data_types.data_text(ramp.get('phase'))
 if phase in ['initial_20', 'steady_30']:
  prefix = 'initial' if phase == 'initial_20' else 'steady'
  lane_limits = data_types.data_json_object_or_empty(pilot.get(prefix + 'LaneDailyMax'))
  lane_max = data_types.data_integer(lane_limits.get(lane))
  total_max = data_types.data_integer(pilot.get(prefix + 'ProspectingDailyMaxPerSender'))
 else:
  lane_max = max(1, (data_types.data_integer(cap_data.get('dailyCap')) + 1) // 2)
  total_max = 3
 usage = daily_usage(db, t)[sender]
 return usage[lane] < lane_max and usage['total'] < total_max

def plan(db: sqlite3.Connection, row: sqlite3.Row, step: str, contract: JsonObject, t: datetime, cap: JsonValue) -> tuple[str | None, str | None]:
 if not contract.get('senderPilot'):
  return PRIMARY, 'legacy'
 email = _row_text(row, 'email')
 account = _row_text(row, 'account')
 lane = _row_text(row, 'lane')
 original = data_types.data_sqlite_row(cast(object, db.execute("SELECT * FROM touches WHERE email=? AND step='initial'", (email,)).fetchone()))
 binding = data_types.data_sqlite_row(cast(object, db.execute('SELECT * FROM sender_bindings WHERE account=?', (account,)).fetchone()))
 if original is not None:
  sender, version = touch_identity(original)
  if binding is not None and (_row_text(binding, 'sender'), _row_text(binding, 'strategy')) != (sender, version):
   raise RuntimeError('company_sender_binding_changed')
 elif step != 'initial':
  import evergreen_queue_continuity as continuity
  historical = continuity.historical_parent(db, email) if continuity.policy() else None
  if historical is None or _row_text(historical, 'sender') != PRIMARY:
   raise RuntimeError('original_conversation_unproven')
  sender, version = PRIMARY, 'legacy'
  if binding is not None and (_row_text(binding, 'sender'), _row_text(binding, 'strategy')) != (sender, version):
   return None, None
 elif binding is not None:
  sender, version = _row_text(binding, 'sender'), _row_text(binding, 'strategy')
 elif lane == 'presse':
  sender, version = PRIMARY, VERSION
 else:
  assigned = {candidate: _scalar_int(db, 'SELECT count(*) FROM sender_bindings WHERE sender=? AND lane=?', (candidate, lane)) for candidate in [PRIMARY, ROBB]}
  tie = int(hashlib.sha256((account + '|' + VERSION).encode()).hexdigest(), 16) % 2
  choices = [PRIMARY, ROBB] if tie == 0 else [ROBB, PRIMARY]
  choices.sort(key=lambda candidate: assigned[candidate])
  available = [candidate for candidate in choices if quota(db, lane, candidate, t, cap, contract)]
  if not available:
   return None, None
  sender, version = available[0], VERSION
 if lane == 'presse' and sender != PRIMARY:
  raise RuntimeError('press_sender_must_be_primary')
 return (sender, version) if quota(db, lane, sender, t, cap, contract) else (None, None)

def bind(db: sqlite3.Connection, row: sqlite3.Row, sender: str, version: str, t: datetime) -> None:
 account = _row_text(row, 'account')
 lane = _row_text(row, 'lane')
 existing = data_types.data_sqlite_row(cast(object, db.execute('SELECT * FROM sender_bindings WHERE account=?', (account,)).fetchone()))
 if existing is not None and (_row_text(existing, 'sender'), _row_text(existing, 'strategy')) != (sender, version):
  raise RuntimeError('immutable_company_sender_conflict')
 _ = db.execute('INSERT OR IGNORE INTO sender_bindings VALUES(?,?,?,?,?)', (account, sender, version, lane, t.isoformat()))
 db.commit()
