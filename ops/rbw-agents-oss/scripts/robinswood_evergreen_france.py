#!/usr/bin/env python3
"""Evergreen French press / SME / mid-market campaigns with evidence-based learning."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import html
import json
import logging
import re
import sqlite3
from collections.abc import Callable, Mapping
from datetime import datetime
from email import policy as email_policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path
from typing import cast, override
from urllib import parse

import evergreen_queue_continuity as continuity
import evergreen_sender_pilot as sender_pilot
import scotland_conference_transport as transport
from evergreen_campaign_data import (
 EDITORIAL,
 EMAIL,
 EMPLOYEES,
 IDS,
 LANES,
 OPS,
 POLICY,
 ROLE,
 ROOT,
 WS,
 CampaignRunResult,
 append_legacy,
 audience_counts,
 business_days,
 cached_delivery,
 campaign_run_result,
 choose_variant,
 contract,
 db_open,
 delivery_blocker,
 digest,
 draft,
 dt,
 import_reserves,
 in_window,
 lane_capacity,
 learning,
 norm,
 now,
 owned_domain,
 portfolio_ramp,
 primary_mandate,
 primary_sirens,
 provider_delivery,
 put_candidate,
 save,
 stamp,
 suppress,
 suppressed,
)

LOGGER = logging.getLogger(__name__)
EMAIL_PATTERN: re.Pattern[str] = EMAIL
__all__ = ['EDITORIAL', 'EMAIL', 'EMPLOYEES', 'IDS', 'LANES', 'OPS', 'ROLE', 'WS', 'Gateway', 'append_legacy', 'audience_counts', 'cached_delivery', 'classify_reply', 'contract', 'db_open', 'delivery_blocker', 'digest', 'discover_company', 'draft', 'fetch', 'import_reserves', 'in_window', 'lane_capacity', 'learning', 'new_reply_text', 'next_item', 'norm', 'owned_domain', 'portfolio_ramp', 'primary_mandate', 'primary_sirens', 'provider_delivery', 'public_page', 'published_emails', 'put_candidate', 'refresh_proof', 'reply_scan', 'research', 'reserve_national', 'run', 'safe_url', 'save', 'stamp', 'transport']
from evergreen_campaign_data_types import (
 JsonObject,
 JsonValue,
 data_cell,
 data_coerce_json_object,
 data_integer,
 data_json_array,
 data_json_object_or_empty,
 data_json_objects,
 data_json_value,
 data_number,
 data_parse_json_object,
 data_sqlite_row,
 data_sqlite_rows,
 data_text,
)
from evergreen_campaign_prospecting import (
 discover_company,
 fetch,
 public_page,
 published_emails,
 refresh_proof,
 research,
 reserve_national,
 safe_url,
)

_PLAIN: Callable[[JsonObject], object] = cast(Callable[[JsonObject], object], transport.plain)
_HEADER: Callable[[JsonObject, str], object] = cast(Callable[[JsonObject, str], object], transport.header)
_ADDRESSES: Callable[[str], object] = cast(Callable[[str], object], transport.addresses)
_BASE_CALL: Callable[[transport.GatewayPort, str, JsonValue | None], JsonObject] = transport.Gateway.call
_BASE_PREPARE: Callable[[transport.GatewayPort, JsonObject, Mapping[str, JsonValue], str, JsonObject | None], object] = cast(Callable[[transport.GatewayPort, JsonObject, Mapping[str, JsonValue], str, JsonObject | None], object], transport.Gateway.prepare)

def _plain(value: JsonValue | None) -> str:
 result: object = _PLAIN(data_json_object_or_empty(value))
 if not isinstance(result, str):
  raise TypeError('transport plain parser returned non-text')
 return result

def _header(message: JsonObject, key: str) -> str:
 result: object = _HEADER(message, key)
 if not isinstance(result, str):
  raise TypeError('transport header parser returned non-text')
 return result

def _addresses(value: str) -> list[str]:
 result: object = _ADDRESSES(value)
 if not isinstance(result, list):
  raise TypeError('transport address parser returned invalid data')
 addresses: list[str] = []
 for item in cast(list[object], result):
  if not isinstance(item, str):
   raise TypeError('transport address parser returned invalid data')
  addresses.append(item)
 return addresses

class Gateway(transport.Gateway):
 @override
 def call(self, path: str, data: JsonValue | None = None) -> JsonObject:
  return data_coerce_json_object(_BASE_CALL(self, path, data))

 @override
 def search(self, query: str) -> list[JsonObject]:
  return data_json_objects(self.call('/messages?' + parse.urlencode({'q': query, 'maxResults': 100})).get('messages'))

 @override
 def get(self, mid: str) -> JsonObject:
  return self.call('/messages/' + mid + '?format=full')

 @override
 def prepare(self:transport.GatewayPort,item:JsonObject,draft:Mapping[str,JsonValue],operation:str,parent:JsonObject|None=None)->tuple[str,str,str]:
  sender=data_text(item.get('_sender'),transport.SENDER)
  version=data_text(item.get('_sender_strategy_version'),'legacy')
  if sender not in [sender_pilot.PRIMARY,sender_pilot.ROBB]:raise RuntimeError('sender_not_authorized')
  if sender==sender_pilot.ROBB and (data_text(item.get('lane'))=='presse' or version!=sender_pilot.VERSION):raise RuntimeError('robb_scope_not_authorized')
  if parent and (_addresses(_header(parent,'From'))!=[sender] or _addresses(_header(parent,'To'))!=[item['email']] or _header(parent,'Subject')!=draft['subject']):
    raise RuntimeError('original_sender_recipient_or_subject_changed')
  if sender==transport.SENDER:
   result: object = _BASE_PREPARE(self, item, draft, operation, parent)
   if not isinstance(result, tuple):
    raise TypeError('transport prepared invalid message data')
   components = cast(tuple[object, ...], result)
   if len(components) != 3:
    raise TypeError('transport prepared invalid message data')
   raw, expected, sig = components
   if not isinstance(raw, str) or not isinstance(expected, str) or not isinstance(sig, str):
    raise TypeError('transport prepared invalid message data')
   m=BytesParser(policy=email_policy.default).parsebytes(base64.urlsafe_b64decode(raw))
  else:
   identity=next((x for x in data_json_objects(self.call('/settings/sendAs').get('sendAs')) if data_text(x.get('sendAsEmail')).lower()==sender),None)
   if not identity or identity.get('verificationStatus')!='accepted' or data_text(identity.get('replyToAddress')).lower()!=sender or not data_text(identity.get('signature')).strip():raise RuntimeError('robb_signature_or_verified_identity_not_ready')
   signature=data_text(identity.get('signature')).strip()
   sig_text=html.unescape(re.sub('<[^>]+>',' ',re.sub(r'<br\s*/?>','\n',signature)))
   expected=data_text(draft.get('body')).strip()+'\n\n'+sig_text.strip()+'\n'
   m=EmailMessage();m['From']=sender;m['To']=data_text(item.get('email'));m['Subject']=data_text(draft.get('subject'))
   m['Message-ID']='<'+operation+'@robinswood.io>';m['X-RBW-Operation']=operation;m['X-RBW-Campaign']=data_text(item.get('campaignId'))
   if parent:m['In-Reply-To']=_header(parent,'Message-ID');m['References']=_header(parent,'Message-ID')
   m.set_content(expected);m.add_alternative('<div>'+html.escape(data_text(draft.get('body'))).replace('\n','<br>')+'</div><br>'+signature,subtype='html')
   sig=hashlib.sha256(signature.encode()).hexdigest()
  m.replace_header('X-RBW-Campaign',data_text(item.get('campaignId')));m['Reply-To']=sender
  m['List-Unsubscribe']='<mailto:'+sender+'?subject=STOP>'
  if version==sender_pilot.VERSION:m['X-RBW-Sender-Strategy']=version
  import outbound_sender_guard as sender_guard
  check_payload: Callable[[str], object] = cast(Callable[[str], object], sender_guard.expected)
  raw=base64.urlsafe_b64encode(m.as_bytes()).decode();_validated=check_payload(raw)
  return raw,expected,sig
def classify_reply(m: JsonObject,lane: str) -> str:
 payload=data_json_object_or_empty(m.get('payload'))
 text=norm(_plain(payload)+'\n'+data_text(m.get('snippet')))
 headers: dict[str, str] = {}
 for item in data_json_objects(payload.get('headers')):
  headers[data_text(item.get('name')).lower()] = data_text(item.get('value'))
 if headers.get('auto-submitted','no').lower()!='no' or any(x in text for x in ['out of office','absence du bureau','reponse automatique','automatic reply']):return 'automatic_reply'
 if any(x in text for x in ['spam','plainte','signaler votre message']):return 'complaint'
 if any(x in text for x in ['unsubscribe','desabonn','ne plus','stop','pas interesse']):return 'opposition'
 if any(x in text for x in ['mailer-daemon','delivery status','undeliver','550 ','adresse introuvable']):return 'bounce'
 if re.search(r'placement payant|tribune payante|publireportage|publi.reportage|advertorial|sponsorise|participation financiere',text):return 'paid_editorial_request'
 # Evidence comes from the new message, never the quoted original invitation.
 if lane=='presse' and re.search(r'\b(interview|article|note d.angle|tribune|podcast)\b',text) and re.search(r'\b(envoy|souhait|interess|prepar|propos|pouvez)\w*',text):return 'editorial_request'
 if lane!='presse' and re.search(r'\b\d+\s*(heure|jour|minute|dossier|facture|devis|euro|€)',text) and re.search(r'\b(flux|process|cout|temps|volume|validation|document|commande|factur|devis)\w*',text):return 'qualified_need'
 if re.search(r'\b(envoy|method|audit|interess|souhait|oui|merci)\w*',text):return 'interest'
 return 'reply_unclassified'
def new_reply_text(m: JsonObject) -> JsonObject:
 # Conservative quote trimming prevents attribution to the sender's own pitch.
 body=_plain(m.get('payload')).replace('\r\n','\n')
 lines: list[str] = []
 for l in body.splitlines():
  if l.lstrip().startswith('>') or re.match(r'^(Le .+ a écrit|On .+ wrote|From:|De :|[-_]{3,})',l):break
  lines.append(l)
 payload=data_json_object_or_empty(m.get('payload'))
 out=dict(m);out['payload']=data_coerce_json_object({'headers':payload.get('headers',[]),'mimeType':'text/plain','body':{'data':base64.urlsafe_b64encode('\n'.join(lines).encode()).decode()}});out['snippet']=''
 return out
def _row_text(row: sqlite3.Row | JsonObject, column: str) -> str:
 value: object = data_cell(row, column) if isinstance(row, sqlite3.Row) else row.get(column)
 if not isinstance(value, str):
  raise TypeError(f'expected text in SQLite column {column}')
 return value

def _row_optional_text(row: sqlite3.Row | JsonObject, column: str) -> str | None:
 value: object = data_cell(row, column) if isinstance(row, sqlite3.Row) else row.get(column)
 if value is not None and not isinstance(value, str):
  raise TypeError(f'expected optional text in SQLite column {column}')
 return value

def _query_rows(db: sqlite3.Connection, query: str, parameters: tuple[object, ...]) -> list[sqlite3.Row]:
 return data_sqlite_rows(cast(object, db.execute(query, parameters).fetchall()))

def reply_scan(db: sqlite3.Connection, gateway: transport.GatewayPort, lane: str, t: datetime) -> int:
 done = 0
 query = "SELECT * FROM touches WHERE lane=? AND state='verified' AND (step='initial' OR (step='followup' AND email IN(SELECT email FROM historical_threads))) ORDER BY created DESC LIMIT 120"
 for row in _query_rows(db, query, (lane,)):
  thread = gateway.call('/threads/' + _row_text(row, 'thread') + '?format=full')
  for message in data_json_objects(thread.get('messages')):
   froms = _addresses(_header(message, 'From'))
   message_id = data_text(message.get('id'))
   if 'SENT' in data_json_array(message.get('labelIds')) or any(sender in froms for sender in (sender_pilot.PRIMARY, sender_pilot.ROBB)) or db.execute('SELECT 1 FROM replies WHERE message_id=?', (message_id,)).fetchone():
    continue
   kind = classify_reply(new_reply_text(message), lane)
   created = _row_text(row, 'created')
   if int(data_text(message.get('internalDate'), '0')) <= dt(created).timestamp() * 1000:
    continue
   recipient = _row_text(row, 'email')
   if froms != [recipient] and kind != 'bounce':
    continue
   sender, _reason = sender_pilot.touch_identity(row)
   if kind not in ['bounce', 'opposition', 'complaint'] and (data_text(message.get('threadId')) != _row_text(row, 'thread') or sender not in _addresses(_header(message, 'To')) + _addresses(_header(message, 'Cc'))):
    continue
   evidence = {'gmailMessageId': message_id, 'threadId': _row_text(row, 'thread'), 'sourceTextSha256': hashlib.sha256(_plain(new_reply_text(message).get('payload')).encode()).hexdigest(), 'verifiedFrom': froms}
   _ = db.execute('INSERT OR IGNORE INTO replies VALUES(?,?,?,?,?,?)', (message_id, recipient, lane, kind, stamp(t), json.dumps(evidence)))
   if kind in ['opposition', 'complaint', 'bounce']:
    suppress(recipient, kind, message_id)
   done += 1

 for reference in gateway.search('in:anywhere (from:mailer-daemon OR from:postmaster) newer_than:14d'):
  reference_id = data_text(reference.get('id'))
  if db.execute('SELECT 1 FROM replies WHERE message_id=?', (reference_id,)).fetchone():
   continue
  message = gateway.get(reference_id)
  content = _plain(message.get('payload')) + ' ' + data_text(message.get('snippet'))
  found = {address.lower() for address in  (match.group() for match in EMAIL_PATTERN.finditer(content))}
  matches = _query_rows(db, "SELECT DISTINCT email FROM touches WHERE lane=? AND state='verified'", (lane,))
  for row in matches:
   target_email = _row_text(row, 'email')
   if target_email not in found:
    continue
   message_id = data_text(message.get('id'))
   evidence = {'gmailMessageId': message_id, 'threadId': message.get('threadId'), 'exactFailedRecipient': target_email}
   _ = db.execute('INSERT OR IGNORE INTO replies VALUES(?,?,?,?,?,?)', (message_id, target_email, lane, 'bounce', stamp(t), json.dumps(evidence)))
   suppress(target_email, 'bounce', message_id)
   done += 1
 db.commit()
 return done

def observe_historical_negative(row: sqlite3.Row | JsonObject, message: JsonObject) -> None:
 if 'SENT' in data_json_array(message.get('labelIds')):
  return
 kind = classify_reply(new_reply_text(message), 'presse')
 if kind not in ['opposition', 'complaint', 'bounce']:
  return
 email = _row_text(row, 'email')
 sender = _addresses(_header(message, 'From'))
 if sender != [email] and (kind != 'bounce' or email.lower() not in _plain(message.get('payload')).lower()):
  return
 # Historical negatives suppress globally without contaminating new-cohort metrics.
 suppress(email, kind, data_text(message.get('id')))

def recover_pending(db: sqlite3.Connection, gateway: transport.GatewayPort) -> None:
 rows = _query_rows(db, "SELECT * FROM touches WHERE state!='verified'", ())
 import outbound_sender_guard as sender_guard
 verify: Callable[[JsonObject, str, str | None], object] = cast(Callable[[JsonObject, str, str | None], object], sender_guard.verify)
 for row in rows:
  operation = _row_text(row, 'operation')
  matches = gateway.search('in:sent rfc822msgid:' + operation + '@robinswood.io')
  if len(matches) != 1:
   raise RuntimeError('unresolved_campaign_effect')
  message = gateway.get(data_text(matches[0].get('id')))
  result: object = verify(message, _row_text(row, 'raw'), _row_optional_text(row, 'thread'))
  if not isinstance(result, tuple):
   raise TypeError('campaign effect verifier returned invalid data')
  values: tuple[object, ...] = cast(tuple[object, ...], result)
  if len(values) != 2:
   raise TypeError('campaign effect verifier returned invalid data')
  valid, checks = values
  if not isinstance(valid, bool) or not valid:
   raise RuntimeError('campaign_effect_verification_failed')
  checks_json = data_json_value(checks)
  _ = db.execute("UPDATE touches SET state='verified',gmail_id=?,thread=?,checks=? WHERE operation=?", (data_text(message.get('id')), data_text(message.get('threadId')), json.dumps(checks_json), operation))
  db.commit()

def _row_exists(db: sqlite3.Connection, query: str, parameters: tuple[object, ...]) -> bool:
 return db.execute(query, parameters).fetchone() is not None

def next_item(db: sqlite3.Connection, lane: str, t: datetime, c: JsonObject) -> tuple[sqlite3.Row, str, JsonObject] | None:
 exclusions = suppressed()
 learn = learning(db, lane, t, c)
 cap = lane_capacity(db, lane, t, c)[1]
 def available(row: sqlite3.Row, step: str) -> bool:
  sender, _version = sender_pilot.plan(db, row, step, c, t, cap)
  return sender is not None

 # Explicit requests take precedence; every reply/followup consumes the same caps.
 requested = _query_rows(db, "SELECT DISTINCT email FROM replies WHERE lane=? AND kind IN ('interest','qualified_need','editorial_request')", (lane,))
 for reply in requested:
  email = _row_text(reply, 'email')
  sent = _row_exists(db, "SELECT 1 FROM touches WHERE email=? AND step='reply'", (email,))
  candidate = data_sqlite_row(cast(object, db.execute('SELECT * FROM candidates WHERE email=?', (email,)).fetchone()))
  if not sent and candidate is not None and email not in exclusions and available(candidate, 'reply'):
   return candidate, 'reply', learn

 policy = continuity.policy()
 candidates = _query_rows(db, "SELECT * FROM candidates WHERE lane=? AND proof IS NOT NULL ORDER BY CASE WHEN email IN(SELECT email FROM touches WHERE step='initial') OR email IN(SELECT email FROM historical_threads WHERE status='eligible') THEN 0 ELSE 1 END,email", (lane,))
 for row in candidates:
  email = _row_text(row, 'email')
  historical = continuity.historical_parent(db, email) if policy else None
  payload = data_parse_json_object(_row_text(row, 'payload'))
  if email in exclusions or delivery_blocker(payload, t) or (historical is None and _row_exists(db, 'SELECT 1 FROM legacy WHERE email=?', (email,))):
   continue
  proof = data_parse_json_object(_row_text(row, 'proof'))
  checked_at = data_text(proof.get('checkedAt'))
  max_age_days = data_number(c.get('proofMaxAgeDays'))
  if proof.get('ok') is not True or not 0 <= (t - dt(checked_at)).total_seconds() < max_age_days * 86400:
   continue
  touches = _query_rows(db, 'SELECT * FROM touches WHERE email=? ORDER BY created', (email,))
  followup_exists = _row_exists(db, "SELECT 1 FROM touches WHERE email=? AND step='followup'", (email,))
  if historical is not None and not followup_exists:
   if _row_exists(db, 'SELECT 1 FROM touches JOIN candidates ON candidates.email=touches.email WHERE candidates.account=?', (_row_text(row, 'account'),)):
    continue
   if available(row, 'followup'):
    return row, 'followup', learn
   continue
  if not touches:
   if _row_exists(db, 'SELECT 1 FROM touches JOIN candidates ON candidates.email=touches.email WHERE candidates.account=?', (_row_text(row, 'account'),)):
    continue
   if available(row, 'initial'):
    return row, 'initial', learn
   continue
  initial = next((touch for touch in touches if _row_text(touch, 'step') == 'initial'), None)
  replied = _row_exists(db, 'SELECT 1 FROM replies WHERE email=?', (email,))
  max_touches = data_integer(c.get('maxTouchesWithoutReply'))
  if initial is not None and not replied and len(touches) < max_touches and business_days(dt(_row_text(initial, 'created')), t) >= 10 and available(row, 'followup'):
   return row, 'followup', learn
 return None

def run(lane:str,apply:bool=False,research_only:bool=False,root:Path=ROOT,c:JsonObject|None=None,gateway:transport.GatewayPort|None=None,t:datetime|None=None,research_batch:int=2,maintain:bool=False)->CampaignRunResult:
 assert lane in LANES;report_id=IDS[lane]+('-maintenance' if maintain else '');c=c or contract();t=t or now();root.mkdir(parents=True,exist_ok=True)
 with (root/'campaign.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX);db=db_open(root)
  try:
   q=continuity.policy()
   queue_authorization=data_json_object_or_empty(q.get('authorization')) if q else {}
   contract_authorization=data_json_object_or_empty(c.get('authorization'))
   if q:assert queue_authorization.get('campaignScopeSha256')==contract_authorization.get('scopeSha256'),'queue_campaign_scope_changed'
   import_reserves(db)
   historical_audit: JsonObject = {}
   if maintain and q:
    gateway=gateway or Gateway()
    historical_audit=continuity.audit_historical(db,gateway,lane,t,suppressed(),business_days,q,observe_historical_negative)
   research_result=data_coerce_json_object(research(db,t,research_batch,lane) if research_batch else {})
   counts=audience_counts(db,lane,t,c)
   status='outside_business_window';sent=0;reply_count=0
   if research_only or maintain:
    if maintain:
     gateway=gateway or Gateway();recover_pending(db,gateway);reply_count=reply_scan(db,gateway,lane,t)
    key='registry_last_day_'+lane;prior=data_sqlite_row(cast(object,db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone()))
    added=0
    coverage=continuity.coverage(db,lane,t,c,counts,q)
    refill_required=coverage.get('refillRequired') if coverage else False
    if not isinstance(refill_required,bool): raise TypeError('queue refill requirement must be boolean')
    refill=continuity.refill_allowed(db,lane,t,refill_required,q) if q else False
    if lane!='presse' and (refill if q else (not prior or prior['value']!=t.date().isoformat())):
     # Record a daily attempt before the free public API request; failures back off.
     _attempt=db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,t.date().isoformat()));db.commit()
     try:added=reserve_national(db,t,lane)
     except (OSError, ValueError, TypeError, KeyError, UnicodeError):research_result['national_registry_unavailable_backoff']=1
    discovered=data_coerce_json_object(discover_company(db,t,lane=lane,retry_hours=data_integer(q.get('discoveryRetryHours'))) if q else discover_company(db,t,lane=lane))
    research_result.update(companyDiscovery=discovered,historicalThreadAudit=historical_audit)
    counts=audience_counts(db,lane,t,c)
    status='maintenance_no_send';counts['nationalCompanyReservesAdded']=added;counts['publicContactsDiscovered']=discovered['addedContacts']
   elif in_window(t,c) and apply:
    gateway=gateway or Gateway();recover_pending(db,gateway);reply_count=reply_scan(db,gateway,lane,t)
    capacity,cap=lane_capacity(db,lane,t,c)
    selection=next_item(db,lane,t,c)
    if selection is None: row=None;step='initial';learn=learning(db,lane,t,c)
    else: row,step,learn=selection
    status='lane_cap_reached' if not capacity else 'awaiting_qualified_contact' if not row else 'prepared'
    if capacity and row:
     item=data_parse_json_object(_row_text(row,'payload'));item['campaignId']=IDS[lane]
     sender,version=sender_pilot.plan(db,row,step,c,t,cap)
     if not sender:raise RuntimeError('sender_capacity_changed')
     item['_sender']=sender;item['_sender_strategy_version']=version
     learn=learning(db,lane,t,c,sender,version) if c.get('senderPilot') else learn
     v=choose_variant(_row_text(row,'email'),learn)
     parent_row=data_sqlite_row(cast(object,db.execute("SELECT * FROM touches WHERE email=? AND step='initial' AND state='verified'",(_row_text(row,'email'),)).fetchone()))
     historical_parent=continuity.historical_parent(db,_row_text(row,'email')) if q and parent_row is None and step!='initial' else None
     if historical_parent:parent_row=historical_parent
     parent=gateway.get(_row_text(parent_row,'message_id' if historical_parent else 'gmail_id')) if parent_row and step!='initial' else None
     if parent:
      if parent_row is None:raise RuntimeError('missing_parent_record')
      import outbound_sender_guard as sender_guard
      verify_parent: Callable[[JsonObject, str, str], object] = cast(Callable[[JsonObject, str, str], object], sender_guard.verify)
      if historical_parent:
       verified=continuity.validate_parent(parent,historical_parent)
       if step=='followup' and not continuity.no_other_relationship(gateway,historical_parent,observe_historical_negative):continuity.hold(db,historical_parent,'historical_reply_or_later_touch_before_send')
      else:
       parent_result: object = verify_parent(parent,_row_text(parent_row,'raw'),_row_text(parent_row,'thread'))
       if not isinstance(parent_result,tuple):raise TypeError('campaign verifier returned invalid data')
       parent_values: tuple[object,...] = cast(tuple[object,...], parent_result)
       if len(parent_values)!=2:raise TypeError('campaign verifier returned invalid data')
       verified_value,checks_value=parent_values
       verified=verified_value;checks=data_coerce_json_object(checks_value)
      if not verified:
       if historical_parent:continuity.hold(db,historical_parent,'original_conversation_effect_changed')
       raise RuntimeError('original_conversation_effect_changed')
     duplicate_contact=step=='initial' and bool(gateway.search('in:sent to:'+_row_text(row,'email')))
     if duplicate_contact:
      append_legacy(db,{'email':_row_text(row,'email'),'status':'prior_contact_found_in_gmail','campaignId':'gmail_history'})
      status='historical_contact_deduplicated'
     if duplicate_contact:
      report=campaign_run_result({'generatedAt':stamp(now()),'capabilityId':report_id,'ok':True,'status':status,'summary':status,'counts':{**counts,'sentNow':0}})
      save(OPS/(report_id+'-last.json'),report);save(root/(lane+('-maintenance' if maintain else '')+'-last.json'),report);return report
     d=draft(item,v,step,_row_text(parent_row,'subject') if parent and parent_row else None)
     op='rbw-eg-'+hashlib.sha256((_row_text(row,'email')+'|'+step+'|'+data_text(c.get('copyVersion'))).encode()).hexdigest()[:32]
     raw,_expected,_sig=gateway.prepare(item,data_coerce_json_object(d),op,parent)
     if c.get('senderPilot'):
      if version is None:raise RuntimeError('sender_version_unavailable')
      sender_pilot.bind(db,row,sender,version,t)
     thread=_row_text(parent_row,'thread') if parent and parent_row else None
     # Shared capacity is checked before reservation so a pacing rejection is a no-op.
     from outbound_sender_guard import SenderGuardBlocked
     _reservation=db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(op,_row_text(row,'email'),lane,step,v,c['copyVersion'],t.isoformat(),'reserved',raw,_expected,d['subject'],op,thread,'{}'))
     db.commit()
     try:
      result=data_coerce_json_object(gateway.send(raw,thread,ops=OPS))
      import outbound_sender_guard as sender_guard
      verify: Callable[[JsonObject, str, str | None], object] = cast(Callable[[JsonObject, str, str | None], object], sender_guard.verify)
      actual=gateway.get(data_text(result.get('id')))
      send_result: object = verify(actual,raw,thread)
      if not isinstance(send_result,tuple):raise TypeError('campaign verifier returned invalid data')
      send_values: tuple[object,...] = cast(tuple[object,...], send_result)
      if len(send_values)!=2:raise TypeError('campaign verifier returned invalid data')
      ok_value,checks_value=send_values
      ok=ok_value;checks=data_coerce_json_object(checks_value)
      if not ok:raise RuntimeError('end_user_effect_unverified')
      _verified=db.execute("UPDATE touches SET state='verified',gmail_id=?,thread=?,checks=? WHERE operation=?",(data_text(actual.get('id')),data_text(actual.get('threadId')),json.dumps(checks),op));db.commit()
      status='sent_verified';sent=1
     except SenderGuardBlocked as e:
      # A proven pre-send cap/interval refusal creates no ambiguous effect.
      if not e.write_attempted:
       _released=db.execute("DELETE FROM touches WHERE operation=? AND state='reserved'",(op,));db.commit();status=str(e)
      else:raise
   else:cap=lane_capacity(db,lane,t,c)[1]
   report=campaign_run_result({'generatedAt':stamp(now()),'contractVersion':'robinswood-evergreen-france-v1','capabilityId':report_id,
    'ok':True,'status':status,'mode':'apply' if apply else 'dry_run','counts':{**counts,'sentNow':sent,'newReplies':reply_count},
    'summary':lane+': '+status+'; sends='+str(sent),'blockingReasons':[] if status not in ['awaiting_qualified_contact'] else ['fresh_primary_qualification_required'],
    'warningReasons':['historical_HDF_bounces_5_of_48_preserved','SENT_is_not_inbox_delivery','recovery_canary_one_per_lane_per_day_preserved'],
    'queueCoverage':continuity.coverage(db,lane,t,c,audience_counts(db,lane,t,c),q),'queuePolicyVersion':q.get('version') if q else None,
    'artifacts':{'state':str(root/'campaign-state.sqlite3'),'contract':str(POLICY)},
    'systemsOfRecord':{'classification':'none','crmWrites':0,'gmailProof':'exact_SENT_message_thread_body_signature'},
    'durability':{'idempotency':'email_step_copy_version_operation','unknownEffect':'pause_and_reconcile_no_retry'},
    'senderSharedCaps':{'daily':40,'weekly':200,'hourly':6,'intervalSeconds':600},'senderPilot':c.get('senderPilot'),'senderPilotDailyUsage':sender_pilot.daily_usage(db,t) if c.get('senderPilot') else None,'authorizationScopeSha256':contract_authorization.get('scopeSha256'),'laneCapacity':lane_capacity(db,lane,t,c)[1]})
   save(OPS/(report_id+'-last.json'),report);save(root/(lane+('-maintenance' if maintain else '')+'-last.json'),report);return report
  except continuity.HistoricalHold as err:
   report=campaign_run_result({'generatedAt':stamp(now()),'capabilityId':report_id,'ok':True,'status':'historical_followup_held','summary':str(err),'counts':{'sentNow':0},'queuePolicyVersion':None})
   save(OPS/(report_id+'-last.json'),report);save(root/(lane+('-maintenance' if maintain else '')+'-last.json'),report);return report
  finally:db.close()

if __name__=='__main__':
 from evergreen_france_cli import main
 raise SystemExit(main(run,LANES,IDS,OPS,stamp,now,save))
