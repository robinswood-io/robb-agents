#!/usr/bin/env python3
"""Bounded refill and original-thread-only historical press followups."""
from __future__ import annotations
import hashlib,json,sqlite3
from datetime import datetime,timedelta,timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import scotland_executive_conference_october as transport

APPROVED=json.loads("{\"version\":\"2026-10-04.queue.1\",\"authorization\":{\"source\":\"human_queue_continuity_and_historical_followup_request_2026-10-04\",\"approvedBy\":\"Thibault\",\"request\":\"contrôle que la queue avance bien et qu’elle ne tombera jamais à 0, ne serait-ce que parce qu’elle doit relancer d’anciens contacts\",\"campaignScopeSha256\":\"9a54b413638f3d5e9810d18854af73378fb22e1c4c7e7e2883af24a2d2c7cf3d\"},\"readyBusinessDays\":3,\"minimumCompanyResearchReserve\":100,\"registryMinimumIntervalSeconds\":3600,\"registryMaximumCallsPerDayPerLane\":8,\"failedProofRetryHours\":24,\"discoveryRetryHours\":24,\"validProofMaxAgeDays\":7,\"historicalAuditBatch\":2,\"historicalFollowupCampaigns\":[\"robinswood-media-authority-2026\"],\"preserveOperatorHolds\":true,\"preserveHistoricalHdfPause\":true,\"historicalFollowupMaximum\":1,\"followupBusinessDays\":10,\"unknownEffectBlocks\":true,\"replyStopsFollowup\":true,\"allExistingCapsPreserved\":true,\"paidAllowed\":false}")
def policy(path=Path('/srv/rbw-agents-oss/config/robinswood-evergreen-queue.json')):
 try:c=json.loads(path.read_text())
 except FileNotFoundError:return None
 assert c==APPROVED,'queue_policy_not_authorized'
 return c
def dt(s):return datetime.fromisoformat(s.replace('Z','+00:00'))
def ensure_schema(db,root):
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='historical_threads'").fetchone():return
 archive=root.parent/'archive'/root.name;archive.mkdir(parents=True,exist_ok=True)
 backup=archive/('historical-queue-schema-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.sqlite3')
 copy=sqlite3.connect(backup)
 try:db.backup(copy)
 finally:copy.close()
 db.execute('CREATE TABLE historical_threads(email TEXT PRIMARY KEY,message_id TEXT,thread TEXT,sender TEXT,subject TEXT,sent_at TEXT,effect_hash TEXT,checked TEXT,status TEXT,reason TEXT)')
 db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',('historical_queue_schema_backup',str(backup)))
 db.commit()
def canonical_effect(message):
 return hashlib.sha256(json.dumps({k:message.get(k) for k in ['id','threadId','internalDate','payload']},ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def validate_parent(message,row):
 return ('SENT' in message.get('labelIds',[]) and message.get('id')==row['message_id'] and message.get('threadId')==row['thread'] and transport.addresses(transport.header(message,'From'))==[row['sender']] and transport.addresses(transport.header(message,'To'))==[row['email']] and transport.header(message,'Subject')==row['subject'] and canonical_effect(message)==row['effect_hash'])
def historical_parent(db,email):
 return db.execute("SELECT * FROM historical_threads WHERE email=? AND status='eligible'",(email,)).fetchone()
class HistoricalHold(RuntimeError):pass
def hold(db,row,reason):
 db.execute("UPDATE historical_threads SET status='held',reason=? WHERE email=?",(reason,row['email']));db.commit()
 raise HistoricalHold(reason)
def no_other_relationship(gateway,row,observer=None):
 thread=gateway.call('/threads/'+row['thread']+'?format=full')
 others=[m for m in thread.get('messages',[]) if m['id']!=row['message_id']]
 for ref in gateway.search('from:'+row['email']+' -in:sent after:'+dt(row['sent_at']).date().isoformat()):
  if ref['id'] not in {m['id'] for m in others}:others.append(gateway.get(ref['id']))
 if observer:
  for m in others:observer(row,m)
 return not others
def audit_historical(db,gateway,lane,t,exclusions,business_days,cfg,observer=None):
 if not cfg or lane!='presse':return {'checked':0,'eligible':0,'held':0}
 rows=db.execute("SELECT l.* FROM legacy l JOIN candidates c ON c.email=l.email LEFT JOIN historical_threads h ON h.email=l.email WHERE c.lane=? AND l.state='sent' AND l.campaign='robinswood-media-authority-2026' AND (h.email IS NULL OR (h.checked<? AND (h.reason LIKE 'historical_read_unavailable_%' OR h.reason='followup_not_due'))) ORDER BY h.checked,l.email LIMIT ?",(lane,(t-timedelta(hours=cfg['failedProofRetryHours'])).isoformat(),cfg['historicalAuditBatch'])).fetchall()
 checked=eligible=held=0
 for r in rows:
  checked+=1;result={'email':r['email'],'message_id':r['message_id'],'thread':None,'sender':None,'subject':r['subject'],'sent_at':None,'effect_hash':None,'checked':t.isoformat(),'status':'held','reason':'historical_effect_unproven'}
  try:
   if r['email'] in exclusions:result['reason']='suppressed'
   else:
    m=gateway.get(r['message_id'])
    result.update(thread=m['threadId'],sender=transport.SENDER,subject=transport.header(m,'Subject'),sent_at=datetime.fromtimestamp(int(m['internalDate'])/1000,timezone.utc).isoformat(),effect_hash=canonical_effect(m))
    if not validate_parent(m,result) or transport.header(m,'Cc') or transport.header(m,'Bcc') or not transport.header(m,'Message-ID') or not transport.plain(m.get('payload',{})).strip():result['reason']='historical_sender_recipient_or_body_unproven'
    elif business_days(dt(result['sent_at']),t)<cfg['followupBusinessDays']:result['reason']='followup_not_due'
    elif not no_other_relationship(gateway,result,observer):result['reason']='historical_reply_or_later_touch'
    else:result.update(status='eligible',reason='original_effect_verified_pending_fresh_qualification')
  except Exception as ex:result['reason']='historical_read_unavailable_'+type(ex).__name__
  db.execute('INSERT INTO historical_threads VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET message_id=excluded.message_id,thread=excluded.thread,sender=excluded.sender,subject=excluded.subject,sent_at=excluded.sent_at,effect_hash=excluded.effect_hash,checked=excluded.checked,status=excluded.status,reason=excluded.reason',tuple(result[k] for k in ['email','message_id','thread','sender','subject','sent_at','effect_hash','checked','status','reason']))
  eligible+=result['status']=='eligible';held+=result['status']!='eligible'
 db.commit();return {'checked':checked,'eligible':eligible,'held':held}
def refill_allowed(db,lane,t,required,cfg):
 if not cfg or lane=='presse':return False
 key='queue_registry_'+lane
 old=db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone()
 state=json.loads(old['value']) if old else {}
 day=t.astimezone(ZoneInfo('Europe/Paris')).date().isoformat()
 used=state.get('used',0) if state.get('day')==day else 0
 if used>=cfg['registryMaximumCallsPerDayPerLane']:return False
 if state.get('last') and (t-dt(state['last'])).total_seconds()<cfg['registryMinimumIntervalSeconds']:return False
 if not required:return False
 # Reserve a bounded attempt before the external read. Errors share the backoff.
 db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,json.dumps({'day':day,'used':used+1,'last':t.isoformat()})));db.commit();return True
def coverage(db,lane,t,c,audience,cfg):
 if not cfg:return None
 target=c.get('postScotlandRamp',{}).get('steadyLaneDailyMax',c['lanes'])
 daily=target[lane] if isinstance(target[lane],int) else target[lane]['dailyMax']
 initial=audience['readyForInitial'];due=future=held=0
 for row in db.execute("SELECT c.email,c.proof,t.created FROM candidates c JOIN touches t ON c.email=t.email WHERE c.lane=? AND t.step='initial' AND t.state='verified' AND c.email NOT IN(SELECT email FROM replies) AND c.email NOT IN(SELECT email FROM touches WHERE step='followup')",(lane,)):
  days=transport.business_days(dt(row['created']),t)
  if days>=cfg['followupBusinessDays']:due+=1
  else:future+=1
 for row in db.execute('SELECT h.email,h.status,c.proof FROM historical_threads h JOIN candidates c ON c.email=h.email WHERE c.lane=? AND h.email NOT IN(SELECT email FROM touches WHERE step=\'followup\')',(lane,)):
  p=json.loads(row['proof']) if row['proof'] else {}
  if row['status']=='eligible' and p.get('ok') and p.get('checkedAt') and 0<=(t-dt(p['checkedAt'])).total_seconds()<c['proofMaxAgeDays']*86400:due+=1
  else:held+=1
 pending=db.execute("SELECT count(*) FROM research WHERE json_extract(payload,'$.categorie_entreprise')=? AND (reason='needs_official_domain_and_exact_contact' OR checked<?)",('PME' if lane=='pme' else 'ETI', (t-timedelta(hours=cfg['discoveryRetryHours'])).isoformat().replace('+00:00','Z'))).fetchone()[0] if lane!='presse' else 0
 ready=initial+due;target_count=daily*cfg['readyBusinessDays']
 return {'readyInitials':initial,'followupsDueBeforeFreshChecks':due,'followupsScheduledLater':future,'historicalHeldOrNeedsProof':held,'readyPotentialBeforeGmailAndQuotaChecks':ready,'targetQualifiedReserve':target_count,'readySupplyBelowTarget':ready<target_count,'companyResearchPending':pending,'refillRequired':ready<target_count or pending<cfg['minimumCompanyResearchReserve'],'nextAction':'audit_qualify_or_refill' if ready<target_count else 'maintain_fresh_proofs','qualifiedSupplyCanBeZero':True,'contactsOrRepliesRepeatedToFillQueue':False}
