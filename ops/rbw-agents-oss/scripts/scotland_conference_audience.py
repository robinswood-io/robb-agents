"""Authorized Hunter audience preparation; never sends mail or purchases credits."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from http.client import HTTPException, HTTPResponse
from pathlib import Path
from typing import cast
from urllib import error, parse, request

from scotland_audience_types import (
 OBJECT,
 PAGE,
 STATE,
 STRINGS,
 AudienceState,
 CompanyResult,
 JsonObject,
 audience_counts,
 field,
 number,
 obj,
 objects,
 optional_text,
 text,
)
from scotland_public_evidence import (
 AUDIENCE_ADAPTER,
 AudienceItem,
 PublicPage,
 fresh_public_evidence,
 own_public_url,
 public_html,
 qualified_review,
 qualify_item,
)

__all__ = ["fresh_public_evidence", "own_public_url", "public_html", "qualified_review", "qualify_item"]

ROOT=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops/product-campaigns/scotland-executive-conference-october-2026')
CITIES=['Edinburgh','Glasgow','Aberdeen','Dundee','Inverness','Stirling','Perth','Paisley','Livingston','Dunfermline','East Kilbride','Falkirk','Kirkcaldy','Hamilton']
TITLES='CEO,Managing Director,CFO,COO,CTO,CIO,CMO,Chief Executive Officer,Chief Financial Officer,Chief Operating Officer,Chief Technology Officer,Chief Information Officer,Chief Marketing Officer'
def stamp() -> str:return datetime.now(UTC).isoformat().replace('+00:00','Z')
def read(p: Path) -> JsonObject:return OBJECT.validate_json(p.read_text())
def state_read() -> AudienceState:return STATE.validate_python(read(ROOT/'audience-preparation.json'))
def save(p: Path,v: object) -> None:
 p.parent.mkdir(parents=True,exist_ok=True);q=p.with_name('.'+p.name+'.'+str(os.getpid())+'.tmp');_=q.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');_=q.replace(p)
def key() -> str:
 for line in Path('/srv/rbw-agents-oss/compose/.env').read_text().splitlines():
  if line.startswith('HUNTER_API_KEY='):return line.split('=',1)[1].strip().strip('"').strip("'")
 raise RuntimeError('hunter_key_missing')
def call(endpoint: str,params: JsonObject,post: JsonObject | None=None) -> JsonObject:
 params=dict(params,api_key=key());url='https://api.hunter.io/v2/'+endpoint+'?'+parse.urlencode(params)
 try:
  with cast(HTTPResponse, request.urlopen(request.Request(url,data=json.dumps(post).encode() if post is not None else None,headers={'Content-Type':'application/json','User-Agent':'Robinswood-OSS-Scotland-Conference/1.0'}),timeout=35)) as r:return {'ok':True,'http':r.status,'body':OBJECT.validate_json(r.read()),'checkedAt':stamp()}
 except error.HTTPError as e:return {'ok':False,'http':e.code,'errorType':'HTTPError','checkedAt':stamp()}
 except (OSError, ValueError, HTTPException) as e:return {'ok':False,'http':None,'errorType':type(e).__name__,'checkedAt':stamp()}
def cache(endpoint: str,params: JsonObject,post: JsonObject | None=None) -> JsonObject:
 ident=hashlib.sha256(json.dumps([endpoint,params,post],sort_keys=True).encode()).hexdigest()
 p=ROOT/'hunter-cache'/f'{ident}.json'
 if p.exists():return read(p)
 v=call(endpoint,params,post);save(p,v);return v
def role(raw: str) -> str | None:
 if re.search(r'former|retired|assistant|associate|deputy|non.executive|\binterim\b',raw,re.IGNORECASE):return None
 for alias,title in [('CEO','Chief Executive Officer'),('CFO','Chief Financial Officer'),('COO','Chief Operating Officer'),('CTO','Chief Technology Officer'),('CIO','Chief Information Officer'),('CMO','Chief Marketing Officer')]:
  if re.search(r'\b'+alias+r'\b|'+title,raw,re.IGNORECASE):return title
 if re.search(r'\bmanaging director\b',raw,re.IGNORECASE):return 'Managing Director'
 return None
def company(seed: JsonObject) -> CompanyResult:
 d=text(seed['domain']);result=cache('companies/find',{'domain':d})
 c=field(field(result,'body'),'data');geo=obj(c.get('geo') or {});metrics=obj(c.get('metrics') or {})
 minimum=number(metrics.get('employeesCount') or 0)
 if minimum<=35:
  band=str(metrics.get('employees',''))
  match=re.match(r'(\d+)',band.replace(',',''))
  minimum=int(match.group(1)) if match else 0
 if minimum<=35 or geo.get('countryCode')!='GB' or not (geo.get('stateCode')=='GB-SCT' or geo.get('state')=='Scotland' or geo.get('city') in CITIES):return {'domain':d,'blocked':'headcount_or_scottish_hq_unproven','company':c}
 ctype=c.get('companyType',c.get('company_type'))
 if ctype not in ['privately held','public company']:return {'domain':d,'blocked':'corporate_type_unproven','company':c}
 result=cache('domain-search',{'domain':d,'type':'personal','job_titles':TITLES,'limit':10})
 out: list[AudienceItem]=[]
 for p in objects(field(field(result,'body'),'data').get('emails',[])):
  raw=text(p.get('position_raw') or p.get('position') or '');r=role(raw)
  email=text(p.get('value','')).lower()
  if not r or p.get('source_type') not in ['found','generated'] or not p.get('first_name') or not p.get('last_name') or not email.endswith('@'+d):continue
  if re.match(r'^(info|hello|contact|sales|support|admin|office|team|enquiries|privacy|press|jobs)@',email):continue
  out.append(AUDIENCE_ADAPTER.validate_python({'id':'scotland-'+hashlib.sha256(email.encode()).hexdigest()[:20],'email':email,'firstName':p['first_name'],'contactName':text(p['first_name'])+' '+text(p['last_name']),'role':r,'roleReported':raw,'company':c.get('name') or seed.get('organization'),'domain':d,'employeeMinimum':minimum,'employeeReported':str(metrics.get('employees')),'city':geo.get('city'),'scottishHeadquarters':True,'corporateType':'public_company' if ctype=='public company' else 'private_company','evidenceProvider':'Hunter company enrichment and domain search','providerCompanyCheckedAt':result.get('checkedAt'),'employeeEvidenceUrl':'https://hunter.io/api-documentation/v2#company-enrichment','locationEvidenceUrl':'https://'+d,'legalEvidenceUrl':'https://'+d,'roleEvidenceUrl':'https://'+d,'roleCheckedAt':None,'addressSourceType':p.get('source_type'),'sourceRecords':p.get('sources',[]),'providerRoleCheckedAt':result.get('checkedAt'),'companyDescription':c.get('description'),'relevance':'business operations and dependable service delivery','qualification':'provider_candidate_requires_current_public_role_and_legal_evidence'}))
 return {'domain':d,'company':c,'candidates':out}
def run(target: int=300) -> dict[str, int]:
 c=read(ROOT/'campaign-contract.json')
 if not field(c,'providerTransfer').get('hunterAuthorized'):raise RuntimeError('hunter_not_authorized')
 if target>number(field(c,'providerTransfer')['maxContacts']):raise RuntimeError('authorized_limit_exceeded')
 state: AudienceState=state_read() if (ROOT/'audience-preparation.json').exists() else {'items':[],'companies':{},'verifications':{},'generatedAt':stamp()}
 state['counts']=audience_counts(state)
 if len(state['items'])>=target or len(state.get('verifications',{}))>=500:return state['counts']
 seeds: list[JsonObject]=[]
 base=field(read(ROOT/'hunter-discovery-page-0.json'),'filters');base['headcount']=['51-200','201-500','501-1000','1001-5000','5001-10000','10001+']
 for offset in range(0,500,100):
  base['offset']=offset;r=cache('discover',{},base)
  if not r['ok']:break
  seeds.extend(objects(field(r,'body').get('data',[])))
 # Prefer midmarket rather than banking/energy giants while keeping all sectors.
 for index in range(0,len(seeds),4):
  if len(state['items'])>=target:break
  quotas=field(field(field(call('account',{}),'body'),'data'),'requests')
  if number(field(quotas,'searches').get('remaining',0))<20 or number(field(quotas,'verifications').get('remaining',0))<10:
   state['stopReason']='existing_credit_reserve_reached';break
  batch=[s for s in seeds[index:index+4] if s['domain'] not in state.setdefault('companies',{})]
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
   for v in pool.map(company,batch):
    if len(state['items'])>=target or len(state.get('verifications',{}))>=500:break
    state.setdefault('companies',{})[v['domain']]=v
    for p in v.get('candidates',[]):
     if p['email'] in state.setdefault('verifications',{}):continue
     proof=cache('email-verifier',{'email':p['email']});data=field(field(proof,'body'),'data')
     state.setdefault('verifications',{})[p['email']]={'checkedAt':proof['checkedAt'],'result':data.get('result'),'status':data.get('status'),'score':data.get('score'),'acceptAll':data.get('accept_all'),'provider':'hunter'}
     if proof['ok'] and data.get('result')=='deliverable' and data.get('status')=='valid' and number(data.get('score',0))>=90 and data.get('accept_all') is False:
      state['items'].append(p)
     if len(state.setdefault('verifications',{}))>=500 or len(state['items'])>=target:break
  state['updatedAt']=stamp();state['counts']=audience_counts(state)
  save(ROOT/'audience-preparation.json',state)
  print(json.dumps(state['counts']),flush=True);time.sleep(.3)
  if len(state.setdefault('verifications',{}))>=500:state['stopReason']='authorized_verification_bound_reached';break
 state['updatedAt']=stamp();save(ROOT/'audience-preparation.json',state)
 return state.get('counts',{})

def verify_cached(target: int=300) -> dict[str, int]:
 c=read(ROOT/'campaign-contract.json')
 if not field(c,'providerTransfer').get('hunterAuthorized'):raise RuntimeError('hunter_not_authorized')
 if target>number(field(c,'providerTransfer')['maxContacts']):raise RuntimeError('authorized_limit_exceeded')
 state=state_read()
 state['counts']=audience_counts(state)
 if len(state['items'])>=target or len(state.get('verifications',{}))>=500:return state['counts']
 existing={p['email'] for p in state['items']}
 for pth in sorted((ROOT/'hunter-cache').glob('*.json')):
  res=read(pth);data=field(res,'body').get('data',{})
  if not isinstance(data,dict) or not isinstance(data.get('emails'),list):continue
  domain=text(data.get('domain'));record=state.setdefault('companies',{}).get(domain)
  if record is None or record.get('blocked') or not record.get('company'):continue
  comp=record['company'];metrics=obj(comp.get('metrics') or {});geo=obj(comp.get('geo') or {})
  minimum=number(metrics.get('employeesCount') or 0)
  if minimum<=35:continue
  for person in objects(data['emails']):
   raw=text(person.get('position_raw') or person.get('position') or '');title=role(raw);email=text(person.get('value','')).lower()
   if not title or not person.get('first_name') or not person.get('last_name') or email in existing or not email.endswith('@'+domain):continue
   sources=person.get('sources') or []
   if not sources:continue
   proof=cache('email-verifier',{'email':email});v=field(field(proof,'body'),'data')
   state.setdefault('verifications',{})[email]={'checkedAt':proof['checkedAt'],'result':v.get('result'),'status':v.get('status'),'score':v.get('score'),'acceptAll':v.get('accept_all'),'provider':'hunter'}
   if proof['ok'] and v.get('result')=='deliverable' and v.get('status')=='valid' and number(v.get('score',0))>=90 and v.get('accept_all') is False:
    item={'id':'scotland-'+hashlib.sha256(email.encode()).hexdigest()[:20],'email':email,'firstName':person['first_name'],'contactName':text(person['first_name'])+' '+text(person['last_name']),'role':title,'roleReported':raw,'company':comp.get('name'),'domain':domain,'employeeMinimum':minimum,'employeeReported':str(metrics.get('employees')),'city':geo.get('city'),'scottishHeadquarters':True,'corporateType':'provider_corporate_unconfirmed','employeeEvidenceUrl':'https://hunter.io/api-documentation/v2#company-enrichment','locationEvidenceUrl':'https://'+domain,'legalEvidenceUrl':'https://'+domain,'roleEvidenceUrl':'https://'+domain,'roleCheckedAt':None,'sourceRecords':sources,'addressSourceType':person.get('source_type'),'providerRoleCheckedAt':res['checkedAt'],'companyDescription':comp.get('description'),'relevance':'business operations and dependable service delivery','qualification':'provider_candidate_requires_current_public_role_and_legal_evidence'}
    state['items'].append(AUDIENCE_ADAPTER.validate_python(item));existing.add(email)
   state['updatedAt']=stamp();state['counts']=audience_counts(state)
   save(ROOT/'audience-preparation.json',state)
   if len(state['items'])>=target or len(state.setdefault('verifications',{}))>=500:return state.get('counts',{})
 state['stopReason']='cached_executive_candidates_exhausted';save(ROOT/'audience-preparation.json',state);return state.get('counts',{})



QUALIFIED='qualified_public_role_and_provider_company_evidence'
def cache_public_navigation(domain: str) -> list[str]:
 p=ROOT/'public-evidence-cache'/(hashlib.sha256((domain+'-navigation-v2').encode()).hexdigest()+'.json')
 if p.exists() and fresh_public_evidence(optional_text(read(p).get('checkedAt'))):return STRINGS.validate_python(read(p).get('paths',[]))
 paths: list[str]=[]
 for suffix in ['/','/sitemap.xml','/sitemap_index.xml']:
  try:
   url='https://'+domain+suffix
   with cast(HTTPResponse, request.urlopen(request.Request(url,headers={'User-Agent':'Robinswood-Conference-Business-Research/1.0'}),timeout=8)) as r:
    if not own_public_url(r.url,domain):continue
    raw=r.read(1200000).decode('utf-8','replace')
   links=re.finditer(r'(?:href=["\x27]([^"\x27]+)|<loc>([^<]+)</loc>)',raw,re.IGNORECASE)
   for pair in links:
    parsed=parse.urlparse(parse.urljoin(url,pair.group(1) or pair.group(2)))
    if not own_public_url(parsed.geturl(),domain) or parsed.query or parsed.fragment:continue
    path=parsed.path
    if re.search(r'leadership|executive|management|board|directors|team|about|who-we-are|company|people|privacy|legal|terms|slavery',path,re.IGNORECASE) and not path.lower().endswith(('.pdf','.jpg','.png','.xml')):paths.append(path)
  except (OSError, ValueError, HTTPException):continue
 paths=list(dict.fromkeys(paths))
 paths.sort(key=lambda p:(0 if re.search('leadership|executive|board|management',p,re.IGNORECASE) else 1 if re.search('privacy|legal|terms|slavery',p,re.IGNORECASE) else 2,len(p)))
 save(p,{'checkedAt':stamp(),'paths':paths[:25]})
 return paths[:25]

def public_company_pages(domain: str,extra_paths: Sequence[str]=()) -> list[PublicPage]:
 if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+\.[a-z]{2,}',domain):return []
 out: list[PublicPage]=[];paths=list(dict.fromkeys(['/']+list(extra_paths)+cache_public_navigation(domain)+['/about-us/','/about/','/our-team/','/team/','/leadership/','/management/','/privacy-policy/','/legal/','/terms-and-conditions/']))
 for path in paths[:36]:
  url='https://'+domain+path
  if not own_public_url(url,domain) or not path.startswith('/') or path.startswith('//'):continue
  p=ROOT/'public-evidence-cache'/(hashlib.sha256((domain+path).encode()).hexdigest()+'.json')
  old: JsonObject=read(p) if p.exists() else {}
  if old.get('parserVersion')==2 and fresh_public_evidence(optional_text(old.get('checkedAt'))):v=old
  else:
   try:
    with cast(HTTPResponse, request.urlopen(request.Request(url,headers={'User-Agent':'Robinswood-Conference-Business-Research/1.0'}),timeout=10)) as r:
     if not own_public_url(r.url,domain):continue
     text,emails=public_html(r.read(1200000).decode('utf-8','replace'))
     v: JsonObject=obj({'url':r.url,'checkedAt':stamp(),'text':text,'emails':emails,'parserVersion':2})
   except (OSError, ValueError, HTTPException) as e:
    # An inaccessible site must not invent a new verification date.
    v=dict(old) if old.get('text') else {'url':url,'checkedAt':stamp()}
    v.update(parserVersion=2,fetchErrorType=type(e).__name__,fetchAttemptedAt=stamp())
   save(p,v)
  if v.get('text') and fresh_public_evidence(optional_text(v.get('checkedAt'))):out.append(PAGE.validate_python(v))
 return out



def cached_address_types() -> dict[str, str]:
 types: dict[str, str]={}
 for path in (ROOT/'hunter-cache').glob('*.json'):
  data=field(read(path),'body').get('data',{})
  if not isinstance(data,dict):continue
  for person in objects(data.get('emails',[])):
   kind=person.get('source_type');email=text(person.get('value','')).lower()
   if kind in ['found','generated'] and types.get(email)!='generated':types[email]=text(kind)
 return types

def qualify_cached(selected_domains: Sequence[str] | None=None) -> dict[str, int]:
 import fcntl
 state=state_read()
 domains=sorted({x['domain'] for x in state['items'] if not selected_domains or x['domain'] in selected_domains})
 paths: dict[str, list[str]]={d:[] for d in domains}
 for item in state['items']:
  if item['domain'] not in paths:continue
  for url in [item.get('roleEvidenceUrl',''),item.get('legalEvidenceUrl','')]:
   if own_public_url(url,item['domain']):
    parsed=parse.urlparse(url or '')
    if not parsed.query and not parsed.fragment:paths[item['domain']].append(parsed.path or '/')
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  futures={d:pool.submit(public_company_pages,d,paths[d]) for d in domains}
  pages={d:f.result() for d,f in futures.items()}
 types=cached_address_types()
 patches={x['id']:qualify_item(x if x.get('addressSourceType') else x|{'addressSourceType':types.get(x['email'])},pages[x['domain']]) for x in state['items'] if x['domain'] in pages}
 # Serialize evidence commits, reread concurrent updates, and never change approved identities.
 with (ROOT/'audience-evidence.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  latest=state_read()
  for i,item in enumerate(latest['items']):
   candidate=patches.get(item['id'])
   if not candidate or any(candidate.get(k)!=item.get(k) for k in ['id','email','domain','contactName']):continue
   snapshot=next(x for x in state['items'] if x['id']==item['id'])
   if item!=snapshot:continue
   latest['items'][i]=candidate
  latest.setdefault('counts',{})['publicRoleQualifiedContacts']=sum(x.get('qualification')==QUALIFIED for x in latest['items'])
  latest.setdefault('counts',{})['publicRoleQualifiedCompanies']=len({x['domain'] for x in latest['items'] if x.get('qualification')==QUALIFIED})
  latest['updatedAt']=stamp();save(ROOT/'audience-preparation.json',latest)
 return latest.get('counts',{})

class AudienceArguments(argparse.Namespace):
 target: int = 300
 cached_only: bool = False
 qualify_public: bool = False
 domain: list[str] | None = None

if __name__=='__main__':
 ap=argparse.ArgumentParser();_=ap.add_argument('--target',type=int,default=300);_=ap.add_argument('--cached-only',action='store_true');_=ap.add_argument('--qualify-public',action='store_true');_=ap.add_argument('--domain',action='append');args=ap.parse_args(namespace=AudienceArguments());print(json.dumps(qualify_cached(args.domain) if args.qualify_public else verify_cached(args.target) if args.cached_only else run(args.target)))
