#!/usr/bin/env python3
"""Approved two-sender experiment; company ownership never changes on a retry."""
from __future__ import annotations
import base64, hashlib, json, sqlite3
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import outbound_sender_guard as guard

PRIMARY=guard.SENDER
ROBB=guard.ROBB
VERSION=guard.SENDER_STRATEGY
DISCLOSURE='Je suis Robb, l’assistant IA de Robinswood.'
APPROVED=json.loads("{\"version\":\"2026-10-04.1\",\"authorizationSource\":\"human_robb_sender_pilot_approval_2026-10-04\",\"approvedBy\":\"Thibault\",\"approvedAt\":\"2026-10-04\",\"previousScopeSha256\":\"263e3bc6879eb1936762e96b06eff31329815995b82691326e36fc9b22624270\",\"primaryAccount\":\"thibault@robinswood.io\",\"pressSender\":\"thibault@robinswood.io\",\"prospectingSenders\":[\"thibault@robinswood.io\",\"robb@robinswood.io\"],\"initialLaneDailyMax\":{\"pme\":5,\"eti\":3},\"steadyLaneDailyMax\":{\"pme\":6,\"eti\":4},\"initialProspectingDailyMaxPerSender\":8,\"steadyProspectingDailyMaxPerSender\":10,\"assignment\":\"balanced_immutable_company_with_hashed_ties\",\"existingConversations\":\"preserve_actual_sender_subject_thread\",\"allEffectsConsumeQuota\":true,\"robbDisclosure\":\"Je suis Robb, l’assistant IA de Robinswood.\",\"learning\":\"isolate_sender_strategy_and_copy_version\",\"sharedAccountCapsPreserved\":true}")

def verify_contract(c,digest):
 pilot=c.get('senderPilot')
 if not pilot:return
 assert pilot==APPROVED,'sender_pilot_scope_not_authorized'
 previous={k:v for k,v in c.items() if k not in ['authorization','senderPilot']}
 assert digest(previous)==pilot['previousScopeSha256'],'sender_pilot_prior_scope_changed'
 assert c['authorization']['latestApprovalSource']==pilot['authorizationSource'],'sender_pilot_approval_missing'
 assert c['sharedSender']=={'dailyMax':40,'weeklyMax':200,'hourlyMax':6,'minimumIntervalSeconds':600},'shared_account_caps_changed'

def ensure_schema(db,root):
 if db.execute("SELECT 1 FROM sqlite_master WHERE name='sender_bindings'").fetchone():return
 # SQLite backup includes the committed WAL before this additive migration.
 archive=root.parent/'archive'/root.name
 archive.mkdir(parents=True,exist_ok=True)
 backup=archive/('sender-pilot-schema-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.sqlite3')
 snapshot=sqlite3.connect(backup)
 try:db.backup(snapshot)
 finally:snapshot.close()
 db.execute('CREATE TABLE sender_bindings(account TEXT PRIMARY KEY,sender TEXT NOT NULL,strategy TEXT NOT NULL,lane TEXT NOT NULL,created TEXT NOT NULL)')
 db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',('sender_pilot_schema_backup',str(backup)))
 db.commit()

def touch_identity(row):
 m=guard.parse_raw(row['raw'])
 senders=guard.values(m,'From')
 if len(senders)!=1 or senders[0] not in [PRIMARY,ROBB]:raise RuntimeError('stored_sender_unproven')
 version=m.get('X-RBW-Sender-Strategy') or 'legacy'
 if senders[0]==ROBB and version!=VERSION:raise RuntimeError('stored_robb_strategy_unproven')
 if version not in ['legacy',VERSION]:raise RuntimeError('stored_sender_strategy_unproven')
 return senders[0],version

def daily_usage(db,t):
 day=t.astimezone(ZoneInfo('Europe/Paris')).date()
 counts={s:{'pme':0,'eti':0,'total':0} for s in [PRIMARY,ROBB]}
 for r in db.execute("SELECT * FROM touches WHERE lane IN ('pme','eti')"):
  if datetime.fromisoformat(r['created'].replace('Z','+00:00')).astimezone(ZoneInfo('Europe/Paris')).date()!=day:continue
  sender,_=touch_identity(r)
  counts[sender][r['lane']]+=1;counts[sender]['total']+=1
 return counts

def quota(db,lane,sender,t,cap,c):
 if not c.get('senderPilot') or lane=='presse':return True
 if not isinstance(cap,dict):return False
 phase=cap.get('portfolioRamp',{}).get('phase')
 pilot=c['senderPilot']
 if phase in ['initial_20','steady_30']:
  prefix='initial' if phase=='initial_20' else 'steady'
  lane_max=pilot[prefix+'LaneDailyMax'][lane]
  total_max=pilot[prefix+'ProspectingDailyMaxPerSender']
 else:
  lane_max=max(1,(cap['dailyCap']+1)//2);total_max=3
 usage=daily_usage(db,t)[sender]
 return usage[lane]<lane_max and usage['total']<total_max

def plan(db,row,step,c,t,cap):
 if not c.get('senderPilot'):return PRIMARY,'legacy'
 original=db.execute("SELECT * FROM touches WHERE email=? AND step='initial'",(row['email'],)).fetchone()
 binding=db.execute('SELECT * FROM sender_bindings WHERE account=?',(row['account'],)).fetchone()
 if original:
  sender,version=touch_identity(original)
  if binding and (binding['sender'],binding['strategy'])!=(sender,version):raise RuntimeError('company_sender_binding_changed')
 elif step!='initial':
  import evergreen_queue_continuity as continuity
  historical=continuity.historical_parent(db,row['email']) if continuity.policy() else None
  if not historical or historical['sender']!=PRIMARY:raise RuntimeError('original_conversation_unproven')
  sender,version=PRIMARY,'legacy'
  if binding and (binding['sender'],binding['strategy'])!=(sender,version):return None,None
 elif binding:sender,version=binding['sender'],binding['strategy']
 elif row['lane']=='presse':sender,version=PRIMARY,VERSION
 else:
  assigned={s:db.execute('SELECT count(*) FROM sender_bindings WHERE sender=? AND lane=?',(s,row['lane'])).fetchone()[0] for s in [PRIMARY,ROBB]}
  tie=int(hashlib.sha256((row['account']+'|'+VERSION).encode()).hexdigest(),16)%2
  choices=[PRIMARY,ROBB] if tie==0 else [ROBB,PRIMARY]
  choices.sort(key=lambda s:assigned[s])
  available=[s for s in choices if quota(db,row['lane'],s,t,cap,c)]
  if not available:return None,None
  sender,version=available[0],VERSION
 if row['lane']=='presse' and sender!=PRIMARY:raise RuntimeError('press_sender_must_be_primary')
 return (sender,version) if quota(db,row['lane'],sender,t,cap,c) else (None,None)

def bind(db,row,sender,version,t):
 existing=db.execute('SELECT * FROM sender_bindings WHERE account=?',(row['account'],)).fetchone()
 if existing and (existing['sender'],existing['strategy'])!=(sender,version):raise RuntimeError('immutable_company_sender_conflict')
 db.execute('INSERT OR IGNORE INTO sender_bindings VALUES(?,?,?,?,?)',(row['account'],sender,version,row['lane'],t.isoformat()))
 db.commit()
