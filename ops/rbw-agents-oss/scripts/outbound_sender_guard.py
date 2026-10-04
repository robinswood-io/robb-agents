#!/usr/bin/env python3
"""Shared, fail-closed Gmail pacing and effect journal for Robinswood campaigns."""
from __future__ import annotations
import base64, fcntl, hashlib, json, sqlite3
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

OPS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
SENDER='thibault@robinswood.io'
ROBB='robb@robinswood.io'
SENDER_STRATEGY='2026-10-04.1'
PROSPECTING={'robinswood-evergreen-france-pme','robinswood-evergreen-france-eti'}
LIMITS={'daily':40,'weekly':200,'hourly':6,'intervalSeconds':600}
ALLOWED={'scotland-executive-conference-october-2026',
 'robinswood-evergreen-france-presse','robinswood-evergreen-france-pme','robinswood-evergreen-france-eti'}
class SenderGuardBlocked(RuntimeError):
 def __init__(self,message,write_attempted=False):
  super().__init__(message);self.write_attempted=write_attempted
def utcnow(): return datetime.now(timezone.utc)
def database(path):
 db=sqlite3.connect(path);db.row_factory=sqlite3.Row
 db.execute('CREATE TABLE IF NOT EXISTS effects(operation TEXT PRIMARY KEY,campaign TEXT,created TEXT,state TEXT,raw TEXT,thread TEXT,gmail_id TEXT,checks TEXT)')
 db.execute('CREATE TABLE IF NOT EXISTS sender_metadata(id TEXT PRIMARY KEY,payload TEXT)')
 db.commit();return db
def values(msg,name):return [a.lower() for _,a in getaddresses([msg.get(name,'')])]
def parse_raw(raw):return BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw+'='*((-len(raw))%4)))
def expected(raw):
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
def plain(payload):
 if payload.get('mimeType')=='text/plain':
  v=payload.get('body',{}).get('data','');return base64.urlsafe_b64decode(v+'='*((-len(v))%4)).decode()
 return ''.join(plain(p) for p in payload.get('parts',[]))
def header(msg,name):
 return next((x['value'] for x in msg.get('payload',{}).get('headers',[]) if x['name'].lower()==name.lower()),'')
def verify(msg,raw,thread=None):
 m,op,cid=expected(raw)
 def addr(n):return [a.lower() for _,a in getaddresses([header(msg,n)])]
 content=m.get_body(preferencelist=('plain',)).get_content().replace('\r\n','\n')
 def attached(p):return bool(p.get('filename')) or any(attached(x) for x in p.get('parts',[]))
 checks={'sent':'SENT' in msg.get('labelIds',[]),'sender':addr('From')==values(m,'From'),
 'recipient':addr('To')==values(m,'To'),'noCcBcc':not header(msg,'Cc') and not header(msg,'Bcc'),
 'subject':header(msg,'Subject')==str(m['Subject']),'bodySignature':plain(msg['payload']).replace('\r\n','\n')==content,
 'operation':header(msg,'X-RBW-Operation')==op,'campaign':header(msg,'X-RBW-Campaign')==cid,
 'messageId':header(msg,'Message-ID')==str(m['Message-ID']),'noAttachments':not attached(msg['payload']),
 'thread':not thread or msg.get('threadId')==thread,
 'replyIdentity':not m.get('Reply-To') or addr('Reply-To')==values(m,'Reply-To'),
 'senderStrategy':not m.get('X-RBW-Sender-Strategy') or header(msg,'X-RBW-Sender-Strategy')==str(m['X-RBW-Sender-Strategy'])}
 return all(checks.values()),checks
def sent_messages(gateway,t,metadata_cache=None):
 monday=t.astimezone(ZoneInfo('Europe/Paris')).replace(hour=0,minute=0,second=0,microsecond=0)
 monday-=timedelta(days=monday.weekday())
 # Every identity shares this authenticated Gmail account; manual sends count too.
 q='in:sent after:'+str(int(monday.timestamp())-3600)
 result=[];token=None
 for _ in range(6):
  params={'q':q,'maxResults':100}
  if token:params['pageToken']=token
  page=gateway.call('/messages?'+urlencode(params))
  for x in page.get('messages',[]):
   cached=metadata_cache.execute('SELECT payload FROM sender_metadata WHERE id=?',(x['id'],)).fetchone() if metadata_cache else None
   if cached:m=json.loads(cached['payload'])
   else:
    m=gateway.call('/messages/'+x['id']+'?format=metadata&metadataHeaders=From&fields=id,internalDate,labelIds,payload(headers)')
    if metadata_cache:
     metadata_cache.execute('INSERT OR REPLACE INTO sender_metadata VALUES(?,?)',(x['id'],json.dumps(m)));metadata_cache.commit()
   if 'SENT' in m.get('labelIds',[]):
    result.append(m)
  token=page.get('nextPageToken')
  if not token:return result
 raise SenderGuardBlocked('sender_history_overflow')
def counts(messages,t):
 local=t.astimezone(ZoneInfo('Europe/Paris'));day=local.date();monday=day-timedelta(days=day.weekday())
 times=[datetime.fromtimestamp(int(m['internalDate'])/1000,timezone.utc) for m in messages]
 return {'daily':sum(x.astimezone(ZoneInfo('Europe/Paris')).date()==day for x in times),
 'weekly':sum(x.astimezone(ZoneInfo('Europe/Paris')).date()>=monday for x in times),
 'hourly':sum(x>t-timedelta(hours=1) for x in times),
 'lastSeconds':(t-max(times)).total_seconds() if times else None}
def capacity(messages,t):
 c=counts(messages,t)
 for k in ['daily','weekly','hourly']:
  if c[k]>=LIMITS[k]:raise SenderGuardBlocked('shared_sender_'+k+'_cap')
 if c['lastSeconds'] is not None and c['lastSeconds']<LIMITS['intervalSeconds']:raise SenderGuardBlocked('shared_sender_interval')
 return c
def reconcile(db,gateway):
 for r in db.execute("SELECT * FROM effects WHERE state!='verified'").fetchall():
  _,op,_=expected(r['raw'])
  matches=gateway.search('in:sent rfc822msgid:'+op+'@robinswood.io')
  if len(matches)!=1:raise SenderGuardBlocked('unresolved_gmail_effect:'+op)
  m=gateway.get(matches[0]['id']);ok,checks=verify(m,r['raw'],r['thread'])
  if not ok:raise SenderGuardBlocked('unverified_gmail_effect:'+op)
  db.execute("UPDATE effects SET state='verified',gmail_id=?,checks=? WHERE operation=?",(m['id'],json.dumps(checks),op));db.commit()
def shared_send(gateway,raw,thread_id,send_once,ops=OPS,t=None):
 """No write retry. Global lock covers Gmail reads, durable reservation and effect."""
 ops.mkdir(parents=True,exist_ok=True);m,op,cid=expected(raw)
 with (ops/'outbound-sender-guard.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  db=database(ops/'outbound-sender-guard.sqlite3')
  try:
   try:reconcile(db,gateway)
   except SenderGuardBlocked:raise
   except Exception as exc:raise SenderGuardBlocked('shared_sender_preflight_read_failed:'+type(exc).__name__) from exc
   prior=db.execute('SELECT * FROM effects WHERE operation=?',(op,)).fetchone()
   if prior:
    if prior['raw']!=raw or (prior['thread'] or None)!=(thread_id or None):raise SenderGuardBlocked('operation_payload_changed')
    return {'id':prior['gmail_id'],'threadId':gateway.get(prior['gmail_id'])['threadId'],'deduplicated':True}
   moment=t or utcnow()
   local=moment.astimezone(ZoneInfo('Europe/London' if cid.startswith('scotland-') else 'Europe/Paris'))
   clock=local.strftime('%H:%M')
   if local.weekday()>=5 or not ('09:00'<=clock<'12:00' or '14:00'<=clock<'18:00'):raise SenderGuardBlocked('shared_sender_window_closed')
   try:capacity(sent_messages(gateway,moment,metadata_cache=db),moment)
   except SenderGuardBlocked:raise
   except Exception as exc:raise SenderGuardBlocked('shared_sender_preflight_read_failed:'+type(exc).__name__) from exc
   db.execute('INSERT INTO effects VALUES(?,?,?,?,?,?,?,?)',(op,cid,moment.isoformat(),'reserved',raw,thread_id,None,None));db.commit()
   result=send_once()
   db.execute("UPDATE effects SET state='acknowledged',gmail_id=? WHERE operation=?",(result['id'],op));db.commit()
   actual=gateway.get(result['id']);ok,checks=verify(actual,raw,thread_id)
   if not ok:raise SenderGuardBlocked('post_send_verification_failed:'+op,write_attempted=True)
   db.execute("UPDATE effects SET state='verified',checks=? WHERE operation=?",(json.dumps(checks),op));db.commit()
   return result
  finally:db.close()
