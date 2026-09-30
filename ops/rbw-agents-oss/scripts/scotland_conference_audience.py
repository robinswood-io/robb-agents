#!/usr/bin/env python3
"""Authorized Hunter audience preparation; never sends mail or purchases credits."""
import argparse, concurrent.futures, hashlib, json, re, sys, time
from datetime import datetime, timezone
from pathlib import Path
from urllib import request, parse, error
ROOT=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops/product-campaigns/scotland-executive-conference-october-2026')
CITIES=['Edinburgh','Glasgow','Aberdeen','Dundee','Inverness','Stirling','Perth','Paisley','Livingston','Dunfermline','East Kilbride','Falkirk','Kirkcaldy','Hamilton']
TITLES='CEO,Managing Director,CFO,COO,CTO,CIO,CMO,Chief Executive Officer,Chief Financial Officer,Chief Operating Officer,Chief Technology Officer,Chief Information Officer,Chief Marketing Officer'
def stamp():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def read(p):return json.loads(p.read_text())
def save(p,v):
 p.parent.mkdir(parents=True,exist_ok=True);q=p.with_name('.'+p.name+'.tmp');q.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');q.replace(p)
def key():
 for line in Path('/srv/rbw-agents-oss/compose/.env').read_text().splitlines():
  if line.startswith('HUNTER_API_KEY='):return line.split('=',1)[1].strip().strip('"').strip("'")
 raise RuntimeError('hunter_key_missing')
def call(endpoint,params,post=None):
 params=dict(params,api_key=key());url='https://api.hunter.io/v2/'+endpoint+'?'+parse.urlencode(params)
 try:
  with request.urlopen(request.Request(url,data=json.dumps(post).encode() if post is not None else None,headers={'Content-Type':'application/json','User-Agent':'Robinswood-OSS-Scotland-Conference/1.0'}),timeout=35) as r:return {'ok':True,'http':r.status,'body':json.load(r),'checkedAt':stamp()}
 except error.HTTPError as e:return {'ok':False,'http':e.code,'errorType':'HTTPError','checkedAt':stamp()}
 except Exception as e:return {'ok':False,'http':None,'errorType':type(e).__name__,'checkedAt':stamp()}
def cache(endpoint,params,post=None):
 ident=hashlib.sha256(json.dumps([endpoint,params,post],sort_keys=True).encode()).hexdigest()
 p=ROOT/'hunter-cache'/f'{ident}.json'
 if p.exists():return read(p)
 v=call(endpoint,params,post);save(p,v);return v
def role(raw):
 if re.search(r'former|retired|assistant|associate|deputy|non.executive|\binterim\b',raw,re.I):return None
 for alias,title in [('CEO','Chief Executive Officer'),('CFO','Chief Financial Officer'),('COO','Chief Operating Officer'),('CTO','Chief Technology Officer'),('CIO','Chief Information Officer'),('CMO','Chief Marketing Officer')]:
  if re.search(r'\b'+alias+r'\b|'+title,raw,re.I):return title
 if re.search(r'\bmanaging director\b',raw,re.I):return 'Managing Director'
 return None
def company(seed):
 d=seed['domain'];result=cache('companies/find',{'domain':d})
 c=result.get('body',{}).get('data',{});geo=c.get('geo') or {};metrics=c.get('metrics') or {}
 minimum=metrics.get('employeesCount') or 0
 if minimum<=35:
  band=str(metrics.get('employees',''));match=re.match(r'(\d+)',band.replace(',',''));minimum=int(match.group(1)) if match else 0
 if minimum<=35 or geo.get('countryCode')!='GB' or not (geo.get('stateCode')=='GB-SCT' or geo.get('state')=='Scotland' or geo.get('city') in CITIES):return {'domain':d,'blocked':'headcount_or_scottish_hq_unproven','company':c}
 ctype=c.get('companyType',c.get('company_type'))
 if ctype not in ['privately held','public company']:return {'domain':d,'blocked':'corporate_type_unproven','company':c}
 result=cache('domain-search',{'domain':d,'type':'personal','job_titles':TITLES,'limit':10})
 out=[]
 for p in result.get('body',{}).get('data',{}).get('emails',[]):
  raw=p.get('position_raw') or p.get('position') or '';r=role(raw)
  email=p.get('value','').lower()
  if not r or p.get('source_type') not in ['found','generated'] or not p.get('first_name') or not p.get('last_name') or not email.endswith('@'+d):continue
  if re.match(r'^(info|hello|contact|sales|support|admin|office|team|enquiries|privacy|press|jobs)@',email):continue
  out.append({'id':'scotland-'+hashlib.sha256(email.encode()).hexdigest()[:20],'email':email,'firstName':p['first_name'],'contactName':p['first_name']+' '+p['last_name'],'role':r,'roleReported':raw,'company':c.get('name') or seed.get('organization'),'domain':d,'employeeMinimum':minimum,'employeeReported':str(metrics.get('employees')),'city':geo.get('city'),'scottishHeadquarters':True,'corporateType':'public_company' if ctype=='public company' else 'private_company','evidenceProvider':'Hunter company enrichment and domain search','providerCompanyCheckedAt':result.get('checkedAt'),'employeeEvidenceUrl':'https://hunter.io/api-documentation/v2#company-enrichment','locationEvidenceUrl':'https://'+d,'legalEvidenceUrl':'https://'+d,'roleEvidenceUrl':'https://'+d,'roleCheckedAt':None,'addressSourceType':p.get('source_type'),'sourceRecords':p.get('sources',[]),'providerRoleCheckedAt':result.get('checkedAt'),'companyDescription':c.get('description'),'relevance':'business operations and dependable service delivery','qualification':'provider_candidate_requires_current_public_role_and_legal_evidence'})
 return {'domain':d,'company':c,'candidates':out}
def run(target=300):
 c=read(ROOT/'campaign-contract.json')
 if not c.get('providerTransfer',{}).get('hunterAuthorized'):raise RuntimeError('hunter_not_authorized')
 if target>c['providerTransfer']['maxContacts']:raise RuntimeError('authorized_limit_exceeded')
 state=read(ROOT/'audience-preparation.json') if (ROOT/'audience-preparation.json').exists() else {'items':[],'companies':{},'verifications':{},'generatedAt':stamp()}
 seeds=[]
 base=read(ROOT/'hunter-discovery-page-0.json')['filters'];base['headcount']=['51-200','201-500','501-1000','1001-5000','5001-10000','10001+']
 for offset in range(0,500,100):
  base['offset']=offset;r=cache('discover',{},base)
  if not r['ok']:break
  seeds.extend(r['body'].get('data',[]))
 # Prefer midmarket rather than banking/energy giants while keeping all sectors.
 for index in range(0,len(seeds),4):
  if len(state['items'])>=target:break
  quotas=call('account',{}).get('body',{}).get('data',{}).get('requests',{})
  if quotas.get('searches',{}).get('remaining',0)<20 or quotas.get('verifications',{}).get('remaining',0)<10:
   state['stopReason']='existing_credit_reserve_reached';break
  batch=[s for s in seeds[index:index+4] if s['domain'] not in state['companies']]
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
   for v in pool.map(company,batch):
    state['companies'][v['domain']]=v
    for p in v.get('candidates',[]):
     if p['email'] in state['verifications']:continue
     proof=cache('email-verifier',{'email':p['email']});data=proof.get('body',{}).get('data',{})
     state['verifications'][p['email']]={'checkedAt':proof['checkedAt'],'result':data.get('result'),'status':data.get('status'),'score':data.get('score'),'acceptAll':data.get('accept_all'),'provider':'hunter'}
     if proof['ok'] and data.get('result')=='deliverable' and data.get('status')=='valid' and data.get('score',0)>=90 and data.get('accept_all') is False:
      state['items'].append(p)
     if len(state['verifications'])>=500 or len(state['items'])>=target:break
  state['updatedAt']=stamp();state['counts']={'verifiedAddresses':len(state['items']),'companiesExamined':len(state['companies']),'distinctCandidateCompanies':len({x['domain'] for x in state['items']}),'verificationRequests':len(state['verifications'])}
  save(ROOT/'audience-preparation.json',state)
  print(json.dumps(state['counts']),flush=True);time.sleep(.3)
  if len(state['verifications'])>=500:state['stopReason']='authorized_verification_bound_reached';break
 state['updatedAt']=stamp();save(ROOT/'audience-preparation.json',state)
 return state['counts']

def verify_cached(target=300):
 c=read(ROOT/'campaign-contract.json')
 if not c.get('providerTransfer',{}).get('hunterAuthorized'):raise RuntimeError('hunter_not_authorized')
 if target>c['providerTransfer']['maxContacts']:raise RuntimeError('authorized_limit_exceeded')
 state=read(ROOT/'audience-preparation.json')
 existing={p['email'] for p in state['items']}
 for pth in sorted((ROOT/'hunter-cache').glob('*.json')):
  res=read(pth);data=res.get('body',{}).get('data',{})
  if not isinstance(data,dict) or not isinstance(data.get('emails'),list):continue
  domain=data.get('domain');record=state['companies'].get(domain,{})
  if record.get('blocked') or not record.get('company'):continue
  comp=record['company'];metrics=comp.get('metrics') or {};geo=comp.get('geo') or {}
  minimum=metrics.get('employeesCount') or 0
  if minimum<=35:continue
  for person in data['emails']:
   raw=person.get('position_raw') or person.get('position') or '';title=role(raw);email=person.get('value','').lower()
   if not title or not person.get('first_name') or not person.get('last_name') or email in existing or not email.endswith('@'+domain):continue
   sources=person.get('sources') or []
   if not sources:continue
   proof=cache('email-verifier',{'email':email});v=proof.get('body',{}).get('data',{})
   state['verifications'][email]={'checkedAt':proof['checkedAt'],'result':v.get('result'),'status':v.get('status'),'score':v.get('score'),'acceptAll':v.get('accept_all'),'provider':'hunter'}
   if proof['ok'] and v.get('result')=='deliverable' and v.get('status')=='valid' and v.get('score',0)>=90 and v.get('accept_all') is False:
    item={'id':'scotland-'+hashlib.sha256(email.encode()).hexdigest()[:20],'email':email,'firstName':person['first_name'],'contactName':person['first_name']+' '+person['last_name'],'role':title,'roleReported':raw,'company':comp.get('name'),'domain':domain,'employeeMinimum':minimum,'employeeReported':str(metrics.get('employees')),'city':geo.get('city'),'scottishHeadquarters':True,'corporateType':'provider_corporate_unconfirmed','employeeEvidenceUrl':'https://hunter.io/api-documentation/v2#company-enrichment','locationEvidenceUrl':'https://'+domain,'legalEvidenceUrl':'https://'+domain,'roleEvidenceUrl':'https://'+domain,'roleCheckedAt':None,'sourceRecords':sources,'addressSourceType':person.get('source_type'),'providerRoleCheckedAt':res['checkedAt'],'companyDescription':comp.get('description'),'relevance':'business operations and dependable service delivery','qualification':'provider_candidate_requires_current_public_role_and_legal_evidence'}
    state['items'].append(item);existing.add(email)
   state['updatedAt']=stamp();state['counts']={'verifiedAddresses':len(state['items']),'companiesExamined':len(state['companies']),'distinctCandidateCompanies':len({x['domain'] for x in state['items']}),'verificationRequests':len(state['verifications'])}
   save(ROOT/'audience-preparation.json',state)
   if len(state['items'])>=target or len(state['verifications'])>=500:return state['counts']
 state['stopReason']='cached_executive_candidates_exhausted';save(ROOT/'audience-preparation.json',state);return state['counts']


def cache_public_navigation(domain):
 p=ROOT/'public-evidence-cache'/(hashlib.sha256((domain+'-navigation').encode()).hexdigest()+'.json')
 if p.exists():return read(p).get('paths',[])
 paths=[]
 for suffix in ['/','/sitemap.xml','/sitemap_index.xml']:
  try:
   with request.urlopen(request.Request('https://'+domain+suffix,headers={'User-Agent':'Robinswood-Conference-Business-Research/1.0'}),timeout=8) as r:
    if parse.urlparse(r.url).hostname not in [domain,'www.'+domain]:continue
    raw=r.read(1200000).decode('utf-8','replace')
   links=re.findall(r'(?:href=["\x27]([^"\x27]+)|<loc>([^<]+)</loc>)',raw,re.I)
   for pair in links:
    link=pair[0] or pair[1];parsed=parse.urlparse(parse.urljoin('https://'+domain+'/',link))
    if parsed.hostname not in [domain,'www.'+domain] or parsed.query or parsed.fragment:continue
    path=parsed.path
    if re.search(r'leadership|executive|management|board|directors|team|about|who-we-are|company|people',path,re.I) and not path.endswith(('.pdf','.jpg','.png','.xml')):paths.append(path)
  except Exception:continue
 paths=list(dict.fromkeys(paths))
 paths.sort(key=lambda p:(0 if re.search('leadership|executive|board|management',p,re.I) else 1,len(p)))
 save(p,{'checkedAt':stamp(),'paths':paths[:17]})
 return paths[:17]

def public_company_pages(domain):
 if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+\.[a-z]{2,}',domain):return []
 out=[]
 paths=['/','/about-us/','/about/','/our-team/','/team/','/leadership/','/management/']
 # Follow the company's own navigation to actual leadership pages.
 homepage=cache_public_navigation(domain)
 for path in homepage:
  if path not in paths:paths.append(path)
 for path in paths[:24]:
  p=ROOT/'public-evidence-cache'/(hashlib.sha256((domain+path).encode()).hexdigest()+'.json')
  if p.exists():v=read(p)
  else:
   url='https://'+domain+path
   try:
    with request.urlopen(request.Request(url,headers={'User-Agent':'Robinswood-Conference-Business-Research/1.0'}),timeout=10) as r:
     if parse.urlparse(r.url).hostname not in [domain,'www.'+domain]:continue
     content=r.read(1200000).decode('utf-8','replace')
     content=re.sub(r'<(?:script|style)\b[^>]*>.*?</(?:script|style)>',' ',content,flags=re.S|re.I)
     import html
     text=html.unescape(re.sub('<[^>]+>',' ',content));text=re.sub(r'\s+',' ',text)
     v={'url':r.url,'checkedAt':stamp(),'text':text}
   except Exception as e:v={'url':url,'checkedAt':stamp(),'errorType':type(e).__name__}
   save(p,v)
  if v.get('text'):out.append(v)
 return out
def qualify_cached():
 state=read(ROOT/'audience-preparation.json');domains=sorted({x['domain'] for x in state['items']})
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  pages=dict(zip(domains,pool.map(public_company_pages,domains)))
 for item in state['items']:
  item['qualification']='current_public_role_or_corporate_evidence_missing'
  legal=None;role_page=None
  for page in pages.get(item['domain'],[]):
   text=page['text']
   if re.search(r'\b(?:'+re.escape(item['company'])+r')\s+(?:group\s+)?(?:limited|ltd|plc)\b|company (?:registration )?(?:number|no\.)\s*(?:SC[0-9]{6}|[0-9]{8})|registered in scotland no[:. ]*SC[0-9]{6}',text,re.I):legal=page
   pos=text.lower().find(item['contactName'].lower())
   if pos>=0:
    excerpt=text[max(0,pos-180):pos+len(item['contactName'])+250]
    if not re.search(r'former|retired|previous|resigned',excerpt,re.I):
     canonical=item['role'].lower()
     aliases={'Chief Executive Officer':'CEO|chief executive','Managing Director':'managing director','Chief Financial Officer':'CFO|chief financial','Chief Operating Officer':'COO|chief operating','Chief Technology Officer':'CTO|chief technology|chief technical','Chief Information Officer':'CIO|chief information','Chief Marketing Officer':'CMO|chief marketing'}
     if re.search(r'\b(?:'+aliases.get(item['role'],re.escape(canonical))+r')\b',excerpt,re.I):role_page=page;item['roleEvidenceExcerpt']=excerpt[:400]
  if legal and role_page:
   item['corporateType']='limited_company';item['legalEvidenceUrl']=legal['url'];item['roleEvidenceUrl']=role_page['url'];item['roleCheckedAt']=role_page['checkedAt']
   item['qualification']='qualified_public_role_and_provider_company_evidence'
   if item.get('addressSourceType')=='generated' and not any(item['email'].lower() in p['text'].lower() for p in pages.get(item['domain'],[])):
    item['qualification']='address_binding_requires_primary_confirmation';item['roleCheckedAt']=None
  item['publicEvidenceCheckedAt']=stamp()
 state['counts']['publicRoleQualifiedContacts']=sum(x['qualification']=='qualified_public_role_and_provider_company_evidence' for x in state['items'])
 state['counts']['publicRoleQualifiedCompanies']=len({x['domain'] for x in state['items'] if x['qualification']=='qualified_public_role_and_provider_company_evidence'})
 state['updatedAt']=stamp();save(ROOT/'audience-preparation.json',state);return state['counts']

if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--target',type=int,default=300);ap.add_argument('--cached-only',action='store_true');ap.add_argument('--qualify-public',action='store_true');args=ap.parse_args();print(json.dumps(qualify_cached() if args.qualify_public else verify_cached(args.target) if args.cached_only else run(args.target)))
