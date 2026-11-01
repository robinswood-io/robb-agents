"""Shared, fail-closed Gmail pacing and effect journal for Robinswood campaigns."""
from __future__ import annotations

import base64
import fcntl
import json
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from typing import Protocol, TypedDict, cast
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from evergreen_campaign_data_types import (
 JsonObject,
 data_cell,
 data_integer,
 data_json_array,
 data_json_object,
 data_json_object_or_empty,
 data_json_objects,
 data_parse_json_object,
 data_sqlite_row,
 data_sqlite_rows,
 data_text,
)

OPS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
SENDER='thibault@robinswood.io'
ROBB='robb@robinswood.io'
SENDER_STRATEGY='2026-10-04.1'
PROSPECTING={'robinswood-evergreen-france-pme','robinswood-evergreen-france-eti'}
LIMITS={'daily':40,'weekly':200,'hourly':6,'intervalSeconds':600}

class Gateway(Protocol):
 def call(self, path: str) -> JsonObject: ...
 def get(self, mid: str) -> JsonObject: ...
 def search(self, query: str) -> list[JsonObject]: ...

class SenderCounts(TypedDict):
 daily: int
 weekly: int
 hourly: int
 lastSeconds: float | None
ALLOWED={'scotland-executive-conference-october-2026',
 'robinswood-evergreen-france-presse','robinswood-evergreen-france-pme','robinswood-evergreen-france-eti'}
class SenderGuardBlocked(RuntimeError):
 def __init__(self, message: str, write_attempted: bool = False) -> None:
  super().__init__(message)
  self.write_attempted: bool = write_attempted

def utcnow() -> datetime: return datetime.now(UTC)

def _fetch_row(cursor: sqlite3.Cursor) -> sqlite3.Row | None:
 row = cast(object, cursor.fetchone())
 if row is None: return None
 if not isinstance(row, sqlite3.Row): raise TypeError('expected SQLite row')
 return row

def _cell_text(value: object) -> str:
 if not isinstance(value, str): raise TypeError('expected a text SQLite value')
 return value

def _optional_cell_text(value: object) -> str | None:
 if value is None: return None
 if not isinstance(value, str): raise TypeError('expected an optional text SQLite value')
 return value
def database(path: Path) -> sqlite3.Connection:
 db=sqlite3.connect(path);db.row_factory=sqlite3.Row
 _effects = db.execute('CREATE TABLE IF NOT EXISTS effects(operation TEXT PRIMARY KEY,campaign TEXT,created TEXT,state TEXT,raw TEXT,thread TEXT,gmail_id TEXT,checks TEXT)')
 _metadata = db.execute('CREATE TABLE IF NOT EXISTS sender_metadata(id TEXT PRIMARY KEY,payload TEXT)')
 db.commit();return db
def values(msg: EmailMessage[str, str], name: str) -> list[str]:
 return [address.lower() for _, address in getaddresses([msg.get(name, '')])]
def parse_raw(raw: str) -> EmailMessage[str, str]:
 parsed = BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw + '=' * ((-len(raw)) % 4)))
 return parsed
def expected(raw: str) -> tuple[EmailMessage[str, str], str, str]:
 m=parse_raw(raw);op=m.get('X-RBW-Operation','');cid=m.get('X-RBW-Campaign','')
 if cid not in ALLOWED or not op or m.get('Message-ID')!='<'+op+'@robinswood.io>':raise SenderGuardBlocked('unapproved_campaign_or_operation')
 sender=values(m,'From')
 if sender not in [[SENDER],[ROBB]] or len(values(m,'To'))!=1 or m.get('Cc') or m.get('Bcc'):raise SenderGuardBlocked('invalid_sender_or_recipients')
 if sender==[ROBB]:
  if cid not in PROSPECTING or m.get('X-RBW-Sender-Strategy')!=SENDER_STRATEGY:raise SenderGuardBlocked('unapproved_robb_campaign_or_strategy')
  body=m.get_body(preferencelist=('plain',))
  if values(m,'Reply-To')!=[ROBB] or not body or 'Je suis Robb, l’assistant IA de Robinswood.' not in body.get_content():raise SenderGuardBlocked('robb_disclosure_or_reply_identity_missing')
 if any(p.get_content_disposition()=='attachment' for p in m.walk()):raise SenderGuardBlocked('attachments_forbidden')
 return m,op,cid
def plain(payload: JsonObject) -> str:
 if data_text(payload.get('mimeType')) == 'text/plain':
  body = data_json_object_or_empty(payload.get('body'))
  encoded = data_text(body.get('data'))
  return base64.urlsafe_b64decode(encoded + '=' * ((-len(encoded)) % 4)).decode()
 return ''.join(plain(part) for part in data_json_objects(payload.get('parts')))
def header(msg: JsonObject, name: str) -> str:
 payload = data_json_object_or_empty(msg.get('payload'))
 for entry in data_json_objects(payload.get('headers')):
  if data_text(entry.get('name')).lower() == name.lower(): return data_text(entry.get('value'))
 return ''
def verify(msg: JsonObject, raw: str, thread: str | None = None) -> tuple[bool, JsonObject]:
 m,op,cid=expected(raw)
 def addr(name: str) -> list[str]: return [address.lower() for _, address in getaddresses([header(msg, name)])]
 body = m.get_body(preferencelist=('plain',))
 if body is None: return False, {}
 body_content: object = cast(object, body.get_content())
 if not isinstance(body_content, str): return False, {}
 content = body_content.replace('\r\n', '\n')
 def attached(payload: JsonObject) -> bool:
  return bool(data_text(payload.get('filename'))) or any(attached(part) for part in data_json_objects(payload.get('parts')))
 payload = data_json_object(msg.get('payload'))
 checks: JsonObject = {'sent':'SENT' in data_json_array(msg.get('labelIds')),'sender':addr('From')==values(m,'From'),
 'recipient':addr('To')==values(m,'To'),'noCcBcc':not header(msg,'Cc') and not header(msg,'Bcc'),
 'subject':header(msg,'Subject')==str(m['Subject']),'bodySignature':plain(payload).replace('\r\n','\n')==content,
 'operation':header(msg,'X-RBW-Operation')==op,'campaign':header(msg,'X-RBW-Campaign')==cid,
 'messageId':header(msg,'Message-ID')==str(m['Message-ID']),'noAttachments':not attached(payload),
 'thread':not thread or msg.get('threadId')==thread,
 'replyIdentity':not m.get('Reply-To') or addr('Reply-To')==values(m,'Reply-To'),
 'senderStrategy':not m.get('X-RBW-Sender-Strategy') or header(msg,'X-RBW-Sender-Strategy')==str(m['X-RBW-Sender-Strategy'])}
 return all(checks.values()),checks
def sent_messages(gateway: Gateway, t: datetime, metadata_cache: sqlite3.Connection | None = None) -> list[JsonObject]:
 monday = t.astimezone(ZoneInfo('Europe/Paris')).replace(hour=0, minute=0, second=0, microsecond=0)
 monday -= timedelta(days=monday.weekday())
 query = 'in:sent after:' + str(int(monday.timestamp()) - 3600)
 result: list[JsonObject] = []
 token: str | None = None
 for _ in range(6):
  params = {'q': query, 'maxResults': 100}
  if token: params['pageToken'] = token
  page = gateway.call('/messages?' + urlencode(params))
  for item in data_json_objects(page.get('messages')):
   message_id = data_text(item.get('id'))
   cached_value: object | None = None
   if metadata_cache is not None:
    cached_cursor = metadata_cache.execute('SELECT payload FROM sender_metadata WHERE id=?', (message_id,))
    cached_value = _fetch_row(cached_cursor)
   cached = data_sqlite_row(cached_value)
   if cached is not None:
    message = data_parse_json_object(_cell_text(data_cell(cached, 'payload')))
   else:
    message = gateway.call('/messages/' + message_id + '?format=metadata&metadataHeaders=From&fields=id,internalDate,labelIds,payload,threadId')
    if metadata_cache is not None:
     _cursor = metadata_cache.execute('INSERT OR REPLACE INTO sender_metadata VALUES(?,?)', (message_id, json.dumps(message)))
     metadata_cache.commit()
   if 'SENT' in data_json_array(message.get('labelIds')):
    result.append(message)
  token = data_text(page.get('nextPageToken'))
  if not token: return result
 raise SenderGuardBlocked('sender_history_overflow')
def counts(messages: list[JsonObject], t: datetime) -> SenderCounts:
 local=t.astimezone(ZoneInfo('Europe/Paris'));day=local.date();monday=day-timedelta(days=day.weekday())
 times=[datetime.fromtimestamp(data_integer(m.get('internalDate')) / 1000, UTC) for m in messages]
 return {'daily':sum(x.astimezone(ZoneInfo('Europe/Paris')).date()==day for x in times),
 'weekly':sum(x.astimezone(ZoneInfo('Europe/Paris')).date()>=monday for x in times),
 'hourly':sum(x>t-timedelta(hours=1) for x in times),
 'lastSeconds':(t-max(times)).total_seconds() if times else None}
def capacity(messages: list[JsonObject], t: datetime) -> SenderCounts:
 c=counts(messages,t)
 for key in ('daily', 'weekly', 'hourly'):
  if data_integer(c.get(key)) >= LIMITS[key]: raise SenderGuardBlocked('shared_sender_' + key + '_cap')
 last_seconds = c['lastSeconds']
 if last_seconds is not None and last_seconds < LIMITS['intervalSeconds']: raise SenderGuardBlocked('shared_sender_interval')
 return c
def reconcile(db: sqlite3.Connection, gateway: Gateway) -> None:
 rows = db.execute("SELECT * FROM effects WHERE state!='verified'").fetchall()
 for row in data_sqlite_rows(rows):
  raw = _cell_text(data_cell(row, 'raw'))
  operation = expected(raw)[1]
  matches = gateway.search('in:sent rfc822msgid:' + operation + '@robinswood.io')
  if len(matches) != 1: raise SenderGuardBlocked('unresolved_gmail_effect:' + operation)
  message_id = data_text(matches[0].get('id'))
  message = gateway.get(message_id)
  valid, checks = verify(message, raw, _optional_cell_text(data_cell(row, 'thread')))
  if not valid: raise SenderGuardBlocked('unverified_gmail_effect:' + operation)
  _cursor = db.execute("UPDATE effects SET state='verified',gmail_id=?,checks=? WHERE operation=?", (message_id, json.dumps(checks), operation))
def shared_send(gateway: Gateway, raw: str, thread_id: str | None, send_once: Callable[[], JsonObject], ops: Path = OPS, t: datetime | None = None) -> JsonObject:
 """No write retry. Global lock covers Gmail reads, durable reservation and effect."""
 ops.mkdir(parents=True,exist_ok=True);_message,op,cid=expected(raw)
 with (ops/'outbound-sender-guard.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  db=database(ops/'outbound-sender-guard.sqlite3')
  try:
   try:reconcile(db,gateway)
   except SenderGuardBlocked:raise
   except Exception as exc:raise SenderGuardBlocked('shared_sender_preflight_read_failed:'+type(exc).__name__) from exc
   prior_cursor = db.execute('SELECT * FROM effects WHERE operation=?',(op,))
   prior_value = _fetch_row(prior_cursor)
   prior = data_sqlite_row(prior_value)
   if prior is not None:
    prior_raw = _cell_text(data_cell(prior, 'raw'))
    prior_thread = _optional_cell_text(data_cell(prior, 'thread')) or None
    if prior_raw != raw or prior_thread != thread_id: raise SenderGuardBlocked('operation_payload_changed')
    gmail_id = _cell_text(data_cell(prior, 'gmail_id'))
    return {'id':gmail_id,'threadId':gateway.get(gmail_id).get('threadId'),'deduplicated':True}
   moment=t or utcnow()
   local=moment.astimezone(ZoneInfo('Europe/London' if cid.startswith('scotland-') else 'Europe/Paris'))
   clock=local.strftime('%H:%M')
   if local.weekday()>=5 or not ('09:00'<=clock<'12:00' or '14:00'<=clock<'18:00'):raise SenderGuardBlocked('shared_sender_window_closed')
   try: _capacity = capacity(sent_messages(gateway,moment,metadata_cache=db),moment)
   except SenderGuardBlocked:raise
   except Exception as exc:raise SenderGuardBlocked('shared_sender_preflight_read_failed:'+type(exc).__name__) from exc
   _reservation = db.execute('INSERT INTO effects VALUES(?,?,?,?,?,?,?,?)',(op,cid,moment.isoformat(),'reserved',raw,thread_id,None,None));db.commit()
   result=send_once()
   _acknowledgement = db.execute("UPDATE effects SET state='acknowledged',gmail_id=? WHERE operation=?",(data_text(result.get('id')),op));db.commit()
   actual=gateway.get(data_text(result.get('id')));ok,checks=verify(actual,raw,thread_id)
   if not ok:raise SenderGuardBlocked('post_send_verification_failed:'+op,write_attempted=True)
   _verification = db.execute("UPDATE effects SET state='verified',checks=? WHERE operation=?",(json.dumps(checks),op));db.commit()
   return result
  finally:db.close()
