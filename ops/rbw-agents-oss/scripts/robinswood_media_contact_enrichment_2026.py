#!/usr/bin/env python3
from __future__ import annotations
import argparse, csv, json, os, re, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
import requests

ROOT=Path('/srv/rbw-agents-oss')
WS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS=WS/'campaigns/ops'
BASE=OPS/'robinswood-media-contact-base-2026.json'
STATE=OPS/'robinswood-media-contact-enrichment-2026-state.json'
ENRICHED=OPS/'robinswood-media-contact-base-2026-enriched.json'
QUEUE=OPS/'robinswood-media-contact-enrichment-2026-review-queue.json'
QUEUE_CSV=OPS/'robinswood-media-contact-enrichment-2026-review-queue.csv'
REPORT=OPS/'robinswood-media-contact-enrichment-2026-last.json'
REPORT_MD=OPS/'robinswood-media-contact-enrichment-2026-last.md'
LEDGER=OPS/'robinswood-media-contact-enrichment-2026-ledger.jsonl'
ENV=ROOT/'compose/.env'
UA='Robinswood-OSS-Media-Contact-Enrichment/1.0 prepare-only no-outbound'
EMAIL_RE=re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
EXCLUDED_DOMAINS={'wikipedia.org','wikimedia.org','facebook.com','twitter.com','x.com','linkedin.com','instagram.com','youtube.com','google.com','bnf.fr','data.bnf.fr','viaf.org','worldcat.org','babelio.com','imdb.com'}
WEBMAIL={'gmail.com','hotmail.com','outlook.com','yahoo.com','icloud.com','orange.fr','free.fr','wanadoo.fr','proton.me','protonmail.com'}

def now(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def norm(x): return str(x or '').strip()
def norm_email(x): return norm(x).lower()
def read(p:Path, default:Any):
    try: return json.loads(p.read_text(encoding='utf-8'))
    except Exception: return default
def write(p:Path, data:Any):
    p.parent.mkdir(parents=True,exist_ok=True)
    tmp=p.with_name(f'.{p.name}.tmp-{os.getpid()}')
    tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    os.replace(tmp,p)
def append_jsonl(p:Path,row:dict[str,Any]):
    p.parent.mkdir(parents=True,exist_ok=True)
    with p.open('a',encoding='utf-8') as f: f.write(json.dumps(row,ensure_ascii=False)+'\n')
def domain_from_url(url:str)->str:
    try:
        d=urlparse(url).netloc.lower().split(':')[0]
        if d.startswith('www.'): d=d[4:]
        return d
    except Exception: return ''
def email_domain(email:str)->str: return norm_email(email).split('@')[-1] if '@' in norm_email(email) else ''
def domain_allowed(d:str)->bool:
    d=(d or '').lower()
    if not d or d in WEBMAIL: return False
    return not any(d==x or d.endswith('.'+x) for x in EXCLUDED_DOMAINS)
def split_name(name:str)->tuple[str|None,str|None]:
    s=re.sub(r'\([^)]*\)',' ',name or '')
    s=re.sub(r'\s+',' ',s).strip()
    parts=[p for p in s.split(' ') if p and not p.startswith('Q')]
    if len(parts)<2: return None,None
    return parts[0], parts[-1]
def hunter_key()->str|None:
    if os.getenv('HUNTER_API_KEY'): return os.getenv('HUNTER_API_KEY')
    if ENV.exists():
        for line in ENV.read_text(encoding='utf-8',errors='ignore').splitlines():
            if line.startswith('HUNTER_API_KEY='):
                return line.split('=',1)[1].strip().strip('"').strip("'")
    return None
def hunter(path:str, params:dict[str,Any], timeout:int=7)->dict[str,Any]:
    try:
        r=requests.get('https://api.hunter.io/v2/'+path, params=params, headers={'User-Agent':UA}, timeout=timeout)
        try: body=r.json()
        except Exception: body={'raw':r.text[:500]}
        return {'ok':r.status_code<400,'statusCode':r.status_code,'body':body}
    except Exception as e:
        return {'ok':False,'statusCode':None,'body':{'error':type(e).__name__,'message':str(e)[:300]}}
def verify_email(key,email): return hunter('email-verifier',{'email':email,'api_key':key},timeout=7)
def email_finder(key,domain,first,last): return hunter('email-finder',{'domain':domain,'first_name':first,'last_name':last,'api_key':key},timeout=8)
def wiki_enrich(title:str)->dict[str,Any]:
    try:
        r=requests.get('https://fr.wikipedia.org/w/api.php', params={'action':'query','format':'json','prop':'extracts|extlinks','titles':title,'explaintext':'1','exintro':'1','ellimit':'20'}, headers={'User-Agent':UA}, timeout=8)
        r.raise_for_status(); data=r.json(); pages=(data.get('query') or {}).get('pages') or {}
        page=next(iter(pages.values())) if pages else {}
        extract=norm(page.get('extract'))[:1200]
        links=[]
        for x in page.get('extlinks') or []:
            u=x.get('*') or x.get('url') or ''
            d=domain_from_url(u)
            if d and domain_allowed(d): links.append({'url':u,'domain':d})
        # de-dupe by domain, keep first
        seen=set(); out=[]
        for l in links:
            if l['domain'] not in seen:
                seen.add(l['domain']); out.append(l)
        return {'ok':True,'extract':extract,'externalLinks':out[:8]}
    except Exception as e:
        return {'ok':False,'error':str(e)[:300],'extract':'','externalLinks':[]}
def eligible_for_processing(r:dict[str,Any])->bool:
    if r.get('outreachStatus') in {'not_eligible_legacy_pr_hold','not_eligible_suppressed','not_eligible_bounced','not_eligible_weak_generic'}: return False
    if r.get('recordType')=='email_contact' and r.get('email'):
        checked=(r.get('emailVerification') or {}).get('checkedAt')
        if checked:
            try: return (datetime.now(timezone.utc)-datetime.fromisoformat(checked.replace('Z','+00:00'))).total_seconds()>=7*86400
            except ValueError: return False
        return True
    if r.get('enrichmentStatus') in {'verified_email_found_review_required','email_verified_review_required','profile_context_enriched','no_public_email_found_yet'}: return False
    return True
def row_outcome(row:dict[str,Any], key:str|None, hunter_left:int)->tuple[dict[str,Any],int,dict[str,Any]]:
    ts=now(); work=dict(row); event={'id':row.get('id'),'recordType':row.get('recordType'),'contactName':row.get('contactName'),'startedAt':ts,'hunterCalls':0,'status':'processed'}
    work['enrichedAt']=ts; work['outreachEligible']=False  # fail-closed: enrichment never makes a row directly sendable
    if row.get('recordType')=='email_contact' and row.get('email'):
        if key and hunter_left>0:
            ver=verify_email(key,row['email']); event['hunterCalls']+=1; hunter_left-=1
            data=((ver.get('body') or {}).get('data') or {}) if isinstance(ver,dict) else {}
            result=str(data.get('result') or data.get('status') or '').lower(); score=data.get('score')
            work['emailVerification']={'provider':'hunter','result':result,'score':score,'statusCode':ver.get('statusCode'),'checkedAt':ts,'smtpCheck':data.get('smtp_check'),'acceptAll':data.get('accept_all'),'block':data.get('block'),'mxRecords':data.get('mx_records')}
            if result in {'deliverable','valid'} and isinstance(score,int) and score>=95 and data.get('smtp_check') is True and data.get('accept_all') is False and data.get('block') is False:
                work['enrichmentStatus']='email_verified_review_required'; work['nextStep']='manual_media_fit_review_before_any_outreach'
            else:
                work['enrichmentStatus']='email_not_verified_review_or_replace'; work['nextStep']='manual_review_or_find_replacement_email'
        else:
            work['enrichmentStatus']='email_present_not_verified_budget_or_key_missing'; work['nextStep']='verify_email_before_any_outreach'
        event['enrichmentStatus']=work['enrichmentStatus']; return work,hunter_left,event
    # profile rows: enrich public context, try official domains if available + Hunter finder budget
    title=row.get('contactName') or ''
    wiki=wiki_enrich(title)
    work['profileEnrichment']={'provider':'fr.wikipedia.org','ok':wiki.get('ok'), 'extract':wiki.get('extract'), 'externalLinks':wiki.get('externalLinks'), 'checkedAt':ts}
    first,last=split_name(title)
    found=None
    if key and first and last and hunter_left>0:
        for link in wiki.get('externalLinks') or []:
            d=link.get('domain')
            if not domain_allowed(d): continue
            res=email_finder(key,d,first,last); event['hunterCalls']+=1; hunter_left-=1
            data=((res.get('body') or {}).get('data') or {}) if isinstance(res,dict) else {}
            email=norm_email(data.get('email'))
            score=data.get('score') or data.get('confidence')
            if EMAIL_RE.match(email) and email_domain(email)==d and (score is None or int(score or 0)>=55):
                found={'email':email,'domain':d,'provider':'hunter_email_finder','score':score,'sourceUrl':link.get('url'),'statusCode':res.get('statusCode')}
                break
            if hunter_left<=0: break
    if found:
        work['enrichedEmail']=found['email']; work['emailStatus']='public_candidate_to_verify'; work['enrichmentStatus']='candidate_email_found_review_required'; work['nextStep']='verify_email_and_manual_media_fit_review_before_any_outreach'; work['enrichmentEvidence']=found
    elif wiki.get('externalLinks'):
        work['enrichmentStatus']='profile_context_enriched'; work['nextStep']='review_external_links_or_run_later_hunter_budget'
    else:
        work['enrichmentStatus']='no_public_email_found_yet'; work['nextStep']='manual_source_research_or_later_enrichment'
    event['enrichmentStatus']=work['enrichmentStatus']; return work,hunter_left,event

def main()->int:
    ap=argparse.ArgumentParser()
    ap.add_argument('--batch-size',type=int,default=25)
    ap.add_argument('--max-hunter-calls',type=int,default=8)
    ap.add_argument('--reset',action='store_true')
    args=ap.parse_args()
    base=read(BASE,{})
    contacts=base.get('contacts') or []
    if ENRICHED.exists() and not args.reset:
        current=read(ENRICHED,{})
        contacts=current.get('contacts') or contacts
    state={} if args.reset else read(STATE,{})
    start=int(state.get('nextIndex') or 0)
    key=hunter_key(); hunter_left=max(0,args.max_hunter_calls)
    processed=[]; events=[]; idx=start; scanned=0
    n=len(contacts)
    while scanned<n and len(processed)<args.batch_size:
        i=idx % n; row=contacts[i]; scanned+=1; idx=i+1
        if not eligible_for_processing(row): continue
        new,hunter_left,event=row_outcome(row,key,hunter_left)
        contacts[i]=new; processed.append(new); events.append(event); append_jsonl(LEDGER, {**event,'timestamp':now()})
        if hunter_left<=0 and len(processed)>=max(5,args.batch_size//3): break
    # review queue: enriched candidates only, still no direct outbound
    review=[r for r in contacts if r.get('enrichmentStatus') in {'candidate_email_found_review_required','email_verified_review_required','email_not_verified_review_or_replace','profile_context_enriched'}]
    meta={**(base.get('meta') or {}),'enrichedAt':now(),'enrichmentContract':'media-contact-enrichment-v1-prepare-only-no-outbound','outboundPolicy':'No automatic send; enrichment never sets direct outbound eligibility.'}
    write(ENRICHED, {'meta':meta,'contacts':contacts})
    write(QUEUE, {'generatedAt':now(),'contract':'media-contact-enrichment-review-queue-v1','outboundAllowed':False,'items':review})
    with QUEUE_CSV.open('w',newline='',encoding='utf-8') as f:
        fields=['id','recordType','contactName','email','enrichedEmail','media','country','sourceUrl','enrichmentStatus','nextStep','qualityScore','outreachStatus']
        w=csv.DictWriter(f,fieldnames=fields); w.writeheader()
        for r in review:
            w.writerow({k:r.get(k,'') for k in fields})
    done=sum(1 for r in contacts if r.get('enrichmentStatus'))
    remaining=sum(1 for r in contacts if eligible_for_processing(r))
    report={'generatedAt':now(),'capabilityId':'robinswood-media-contact-enrichment-2026','ok':True,'status':'processed' if processed else 'no_eligible_batch','mode':'prepare-only','summary':f'media contact enrichment: processed={len(processed)} enrichedTotal={done} remaining={remaining} hunterCallsUsed={args.max_hunter_calls-hunter_left}','counts':{'baseContacts':len(contacts),'processedThisRun':len(processed),'enrichedTotal':done,'remainingEligible':remaining,'reviewQueueItems':len(review),'hunterCallsUsed':args.max_hunter_calls-hunter_left,'hunterKeyPresent':bool(key)},'state':{'nextIndex':idx % n if n else 0},'artifacts':{'enrichedJson':str(ENRICHED),'reviewQueueJson':str(QUEUE),'reviewQueueCsv':str(QUEUE_CSV),'stateJson':str(STATE),'ledgerJsonl':str(LEDGER),'reportJson':str(REPORT),'reportMd':str(REPORT_MD)},'events':events[:20],'guardrails':['prepare_only','no_outbound_message','enrichment_never_sets_direct_send_eligibility','legacy_suppressed_bounced_rows_skipped']}
    write(STATE, {'updatedAt':now(),'nextIndex':idx % n if n else 0,'lastRun':report['counts']})
    write(REPORT, report)
    REPORT_MD.write_text('\n'.join(['# Robinswood Media Contact Enrichment 2026','',f"- Generated: {report['generatedAt']}",f"- Status: {report['status']}",f"- Summary: {report['summary']}",'- Outbound allowed: **false**','', '## Counts']+[f"- {k}: {v}" for k,v in report['counts'].items()]+['','## Artifacts']+[f"- {k}: {v}" for k,v in report['artifacts'].items()])+'\n',encoding='utf-8')
    print(json.dumps({'ok':True,'status':report['status'],'summary':report['summary'],'reportJson':str(REPORT)},ensure_ascii=False))
    return 0
if __name__=='__main__': raise SystemExit(main())
