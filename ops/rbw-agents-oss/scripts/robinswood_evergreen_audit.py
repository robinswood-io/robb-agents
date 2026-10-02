#!/usr/bin/env python3
"""Read-only Gmail legacy reconciliation; no external sends or OAuth-secret output."""
import argparse,json,sys
from datetime import datetime,timezone
from pathlib import Path
import scotland_executive_conference_october as transport
ROOT=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
OUT=ROOT/'product-campaigns/robinswood-evergreen-france/legacy-gmail-audit.json'
def run(limit=15):
 result=transport.read(OUT) if OUT.exists() else {'checked':{},'startedAt':datetime.now(timezone.utc).isoformat(),'newExternalSends':0}
 rows=[]
 for name in ['robinswood-media-authority-2026-ledger.jsonl','robinswood-pme-hdf-audited-mailer-ledger.jsonl']:
  for line in (ROOT/name).read_text().splitlines():
   r=json.loads(line);mid=r.get('gmailMessageId')
   if mid and (r.get('event')=='sent' or r.get('status') in ['sent','sent_verified','sent_needs_manual_verification']):
    rows.append({'messageId':mid,'email':r.get('email') or r.get('recipientEmail'),'subject':r.get('subject'),'thread':r.get('threadId') or r.get('gmailThreadId'),'campaign':r.get('campaignId'),'sentAt':r.get('sentAt') or r.get('generatedAt')})
 gateway=transport.Gateway()
 for row in [r for r in rows if r['messageId'] not in result['checked']][:limit]:
  try:
   m=gateway.get(row['messageId']);checks={'SENT':'SENT' in m.get('labelIds',[]),'recipient':transport.addresses(transport.header(m,'To'))==[row['email'].lower()],
    'sender':transport.addresses(transport.header(m,'From'))==[transport.SENDER],'subject':transport.header(m,'Subject')==row['subject'],'thread':not row['thread'] or m.get('threadId')==row['thread'],
    'timestamp':abs(int(m['internalDate'])/1000-transport.dt(row['sentAt']).timestamp())<600}
   result['checked'][row['messageId']]={'campaign':row['campaign'],'expectedRecipientSha256':transport.digest(row['email'].lower()),'checks':checks,'ok':all(checks.values()),
    'actualThreadId':m.get('threadId'),'actualInternalDate':m['internalDate'],'bodySha256':transport.digest(transport.plain(m['payload'])),'bodyVerification':'historical_body_not_in_ledger_no_exact_body_claim'}
  except Exception as exc:result['checked'][row['messageId']]={'campaign':row['campaign'],'ok':False,'error':type(exc).__name__,'replayForbidden':True}
  result['updatedAt']=datetime.now(timezone.utc).isoformat();transport.save(OUT,result)
 total=len({r['messageId'] for r in rows});checked=len(result['checked']);verified=sum(x.get('ok') is True for x in result['checked'].values())
 result.update(totalUniqueHistoricalMessages=total,completed=checked==total,verified=verified,unverified=checked-verified,
  historicalHDF={'sent':48,'hardBounces':5,'rate':5/48,'reset':False},legacySenderSecurityDisposition='quarantined_legacy_lane; new signed contract uses durable reservation, explicit signature and exact Gmail read-back')
 transport.save(OUT,result);return {k:result[k] for k in ['totalUniqueHistoricalMessages','completed','verified','unverified','newExternalSends']}
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--limit',type=int,default=15);args=ap.parse_args();print(json.dumps(run(min(max(args.limit,1),30))))
