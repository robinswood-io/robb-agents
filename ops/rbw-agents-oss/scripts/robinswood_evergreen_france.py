#!/usr/bin/env python3
"""Evergreen French press / SME / mid-market campaigns with evidence-based learning."""
from __future__ import annotations
import argparse, base64, fcntl, hashlib, html, ipaddress, json, re, socket, sqlite3, sys, unicodedata
from datetime import datetime, timedelta, timezone
from email import policy as email_policy
from email.parser import BytesParser
from pathlib import Path
from urllib import request, parse
from zoneinfo import ZoneInfo
import scotland_executive_conference_october as transport

WS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS=WS/'campaigns/ops'
ROOT=OPS/'product-campaigns/robinswood-evergreen-france'
POLICY=Path('/srv/rbw-agents-oss/config/robinswood-evergreen-france.json')
LANES=('presse','pme','eti')
IDS={x:'robinswood-evergreen-france-'+x for x in LANES}
ROLE=re.compile(r'présiden|presiden|directeur|directrice|gérant|gerant|chief|ceo|rédact|redact|journalist',re.I)
EMAIL=re.compile(r'[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}',re.I)
EDITORIAL=re.compile(r'^(redaction|rédaction|editorial|editor|newsroom|presse|press|tips|tribune|podcast)@',re.I)
EMPLOYEES={'21':50,'22':100,'31':200,'32':250,'41':500,'42':1000,'51':2000}
def now():return datetime.now(timezone.utc)
def stamp(t):return t.isoformat().replace('+00:00','Z')
def dt(s):return datetime.fromisoformat(s.replace('Z','+00:00'))
def norm(s):return ''.join(c for c in unicodedata.normalize('NFKD',str(s or '').lower()) if not unicodedata.combining(c))
def read(p,default=None):
 try:return json.loads(Path(p).read_text())
 except FileNotFoundError:return {} if default is None else default
def save(p,obj):transport.save(p,obj)
def digest(obj):return transport.digest(obj)
def contract(path=POLICY):
 c=read(path);assert c.get('authorization',{}).get('source')=='human_evergreen_campaign_request_2026-10-02','missing_human_authorization'
 assert c['authorization']['scopeSha256']==digest({k:v for k,v in c.items() if k!='authorization'}),'contract_scope_changed'
 assert c['sender']=='thibault@robinswood.io' and c['timezone']=='Europe/Paris'
 assert c['paidAllowed'] is False and c['crmWriteAllowed'] is False and c['linkedinWriteAllowed'] is False
 assert c['lanes']=={'presse':{'dailyMax':5,'weeklyMax':20},'pme':{'dailyMax':3,'weeklyMax':10},'eti':{'dailyMax':2,'weeklyMax':10}}
 assert c['canaryDailyMax']==1 and c['maxTouchesWithoutReply']==2
 assert c['windows']==[['09:00','12:00'],['14:00','18:00']] and c['minimumIntervalSeconds']==600
 assert c['proofMaxAgeDays']==7 and c['copyVersion']=='2026-10-02.2'
 assert c['autoRecovery']=={'cooldownDays':7,'minimumFreshSmtpContacts':3,'complaintRecoveryAllowed':False,'capAfterRecovery':1}
 return c
def in_window(t,c):
 x=t.astimezone(ZoneInfo(c['timezone']));h=x.strftime('%H:%M')
 return x.weekday()<5 and any(a<=h<b for a,b in c['windows'])
def db_open(root):
 root.mkdir(parents=True,exist_ok=True);db=sqlite3.connect(root/'campaign-state.sqlite3');db.row_factory=sqlite3.Row
 db.executescript("""
 CREATE TABLE IF NOT EXISTS candidates(email TEXT PRIMARY KEY,lane TEXT,account TEXT,payload TEXT,proof TEXT,checked TEXT,reason TEXT);
 CREATE TABLE IF NOT EXISTS touches(operation TEXT PRIMARY KEY,email TEXT,lane TEXT,step TEXT,variant TEXT,copy_version TEXT,created TEXT,state TEXT,raw TEXT,expected TEXT,subject TEXT,gmail_id TEXT,thread TEXT,checks TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS touch_unique ON touches(email,step);
 CREATE TABLE IF NOT EXISTS replies(message_id TEXT PRIMARY KEY,email TEXT,lane TEXT,kind TEXT,observed TEXT,evidence TEXT);
 CREATE TABLE IF NOT EXISTS legacy(email TEXT PRIMARY KEY,campaign TEXT,message_id TEXT,subject TEXT,state TEXT);
 CREATE TABLE IF NOT EXISTS research(siren TEXT PRIMARY KEY,payload TEXT,checked TEXT,reason TEXT);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);
 """);db.commit();return db
def suppressed(root=OPS.parent):
 obj=read(root/'contact-suppression.json');out=set()
 for k in ['records','blockedRecipients','items']:
  for r in obj.get(k,[]):
   if isinstance(r,dict) and r.get('active') is not False and (r.get('active') is True or r.get('status') in ['do_not_contact','blocked','unsubscribe','opt_out','bounced_invalid_email'] or str(r.get('status','')).startswith('cooldown_')):
    out.add(str(r.get('email') or r.get('value','')).lower())
 return out
def suppress(email,kind,message_id,path=OPS.parent/'contact-suppression.json'):
 with path.with_suffix('.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX);obj=read(path)
  if email not in suppressed(path.parent):
   obj.setdefault('records',[]).append({'email':email,'active':True,'status':'do_not_contact','reason':kind,'sourceGmailMessageId':message_id,'createdAt':stamp(now()),'campaignId':'robinswood-evergreen-france'})
   obj['updatedAt']=stamp(now());save(path,obj)
def append_legacy(db,row):
 email=str(row.get('email') or row.get('recipientEmail','')).lower()
 if email:db.execute('INSERT OR IGNORE INTO legacy VALUES(?,?,?,?,?)',(email,row.get('campaignId','legacy'),row.get('gmailMessageId') or row.get('gmail_id'),row.get('subject'),row.get('status') or row.get('event','prior_contact')))
def import_reserves(db,ops=OPS,cfg=Path('/srv/rbw-agents-oss/config')):
 # Historical contacts and operator holds never become a new cold contact.
 for name in ['robinswood-media-authority-2026-ledger.jsonl','robinswood-pme-hdf-audited-mailer-ledger.jsonl','robinswood-pme-hdf-audited-dispatch-ledger.jsonl','robinswood-flow-email-ledger.jsonl']:
  p=ops/name
  if p.exists():
   for line in p.read_text().splitlines():
    r=json.loads(line)
    if r.get('status') in ['sent','sent_verified','sent_needs_manual_verification','already_sent_after_verified_lookup'] or r.get('event')=='sent':append_legacy(db,r)
 for r in read(ops.parent/'press-campaign-database.json').get('contacts',[]):append_legacy(db,{**r,'status':'operator_legacy_hold'})
 # The old canary lane stays paused; its reserve is requalified from primary sources.
 seeds=read(ops/'robinswood-pme-hdf-full-seed-2026-06-18.json').get('items',[])
 by_name={norm(x.get('companyName')):x for x in seeds}
 for x in read(ops/'robinswood-pme-hdf-email-drafts-prepare-only-latest.json').get('drafts',[]):
  email=str(x.get('recipientEmail','')).lower();seed=by_name.get(norm(x.get('companyName')),{})
  if not EMAIL.fullmatch(email):continue
  c={'email':email,'name':x.get('recipientName',''),'company':x.get('companyName',''),'siren':seed.get('siren'),'domain':email.split('@')[1],
     'sourceUrls':['https://'+email.split('@')[1]+'/','https://'+email.split('@')[1]+'/mentions-legales/','https://'+email.split('@')[1]+'/contact/'],
     'topic':x.get('profileControl',{}).get('contextStrength',{}).get('synthesizedAngle','')}
  lower=EMPLOYEES.get(str(seed.get('tranche_effectif_salarie')),0)
  c['lane']='eti' if str(seed.get('employeeRange','')).startswith(('250','500','1000','2000')) or lower>=250 else 'pme'
  put_candidate(db,c)
 seeds=read(cfg/'oss-media-authority-seeds.json')
 seeds=seeds if isinstance(seeds,list) else seeds.get('items',seeds.get('seeds',[]))
 for x in seeds:
  if not isinstance(x,dict) or x.get('language') not in (None,'fr','fr-FR'):continue
  email=str(x.get('email','')).lower();url=x.get('sourceUrl','')
  if not EMAIL.fullmatch(email) or not url:continue
  domain=email.split('@')[1];primary=url if url.startswith('https://') and (parse.urlparse(url).hostname or '').removeprefix('www.')==domain.removeprefix('www.') else 'https://'+domain+'/'
  put_candidate(db,{'email':email,'name':x.get('contactName',''),'company':x.get('media',''),'lane':'presse','domain':domain,
   'sourceUrls':[primary],'discoverySource':url,'topic':x.get('angle',''),'fitScore':x.get('fitScore',0),'segment':x.get('segment','')})
 for c in read(cfg/'robinswood-evergreen-france-primary-seeds.json').get('contacts',[]):
  if c.get('lane')=='presse' and EMAIL.fullmatch(c.get('email','')) and c.get('domain') and c.get('sourceUrls') and all(owned_domain(u,c['domain']) for u in c['sourceUrls']):put_candidate(db,c)
 for x in read(ops/'robinswood-media-contact-base-2026-enriched.json').get('contacts',[]):
  email=str(x.get('email') or x.get('enrichedEmail') or '').lower()
  if x.get('country')!='FR' or x.get('countryConfidence')=='medium_francophone' or not EMAIL.fullmatch(email):continue
  if x.get('legacyPrStatus') or x.get('suppressionStatus') or str(x.get('outreachStatus','')).startswith('not_eligible'):continue
  domain=email.split('@')[1];url=x.get('sourceUrl') or ''
  put_candidate(db,{'email':email,'name':x.get('contactName',''),'company':x.get('media',''),'lane':'presse','domain':domain,
   'sourceUrls':[url if url.startswith('https://') and (parse.urlparse(url).hostname or '').removeprefix('www.')==domain.removeprefix('www.') else 'https://'+domain+'/'],'discoverySource':url,
   'topic':'IA et décisions des dirigeants PME/ETI','fitScore':x.get('qualityScore',0),'segment':'journalist','emailVerification':x.get('emailVerification',{})})
 db.commit()
def put_candidate(db,c):
 if c['lane'] not in LANES:return
 account=c.get('siren') or c.get('company','').lower() or c['domain']
 existing=db.execute('SELECT payload FROM candidates WHERE email=?',(c['email'],)).fetchone()
 if existing:
  old=json.loads(existing['payload'])
  if old.get('name')!=c.get('name') or old.get('company')!=c.get('company'):return
  repaired=bool(old.get('sourceUrls') and not old['sourceUrls'][0].startswith('https://') and c.get('sourceUrls') and c['sourceUrls'][0].startswith('https://'))
  verification=c.get('emailVerification')
  if repaired or (verification and verification!=old.get('emailVerification')):
   if repaired:old['sourceUrls']=c['sourceUrls'];old['discoverySource']=c.get('discoverySource')
   if verification:old['emailVerification']=verification
   db.execute('UPDATE candidates SET payload=?,checked=NULL,proof=NULL,reason=? WHERE email=?',(json.dumps(old,ensure_ascii=False),'primary_source_or_delivery_evidence_refreshed',c['email']))
 else:db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?,?)',(c['email'],c['lane'],account,json.dumps(c,ensure_ascii=False),None,None,'needs_primary_requalification'))
def safe_url(url):
 u=parse.urlparse(url)
 if u.scheme!='https' or u.username or u.password or u.port not in (None,443):raise ValueError('unsafe_source_url')
 for x in socket.getaddrinfo(u.hostname,443):
  if not ipaddress.ip_address(x[4][0]).is_global:raise ValueError('private_source_address')
 return u
class SafeRedirect(request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  safe_url(newurl);return super().redirect_request(req,fp,code,msg,headers,newurl)
def fetch(url):
 safe_url(url)
 req=request.Request(url,headers={'User-Agent':'Robinswood-Evidence-Research/1.0 (+https://robinswood.io/)'})
 with request.build_opener(SafeRedirect()).open(req,timeout=8) as r:
  safe_url(r.url);data=r.read(700001)
  if len(data)>700000:raise ValueError('source_too_large')
  return data.decode('utf-8',errors='replace'),r.url
def published_emails(data):
 emails={x.lower() for x in EMAIL.findall(html.unescape(data))}
 # Decode only mailbox literals published in the site's public HTML template.
 for token in re.findall(r'data-cfemail=[\"\x27]([0-9a-fA-F]+)',data):
  if len(token)>512:continue
  try:
   value=bytes.fromhex(token);email=bytes(x^value[0] for x in value[1:]).decode('utf-8')
   if EMAIL.fullmatch(email):emails.add(email.lower())
  except (ValueError,IndexError,UnicodeDecodeError):pass
 return emails
def public_page(url):
 data,final=fetch(url);text=html.unescape(re.sub('<[^>]+>',' ',re.sub(r'<(script|style)\b[^>]*>.*?</\1>',' ',data,flags=re.S|re.I)))
 text=re.sub(r'\s+',' ',text).strip()
 links=[]
 for link in re.findall(r'href=["\x27]([^"\x27]+)',html.unescape(data)):
  target=parse.urljoin(final,link)
  target=parse.urldefrag(target)[0];path=parse.urlparse(target).path
  relevant=re.search(r'contact|redaction|rédaction|mentions|presse|gouvernance|direction|societe|a-propos|about|company|(?:^|[-/])equipes?(?:[-/]|$)',path,re.I)
  asset=re.search(r'\.(css|js|json|png|jpg|jpeg|svg|woff2?|pdf)$',path,re.I)
  if parse.urlparse(target).hostname==parse.urlparse(final).hostname and relevant and not asset and target not in links:links.append(target)
 blocks=[]
 for tag,body in re.findall(r'<(p|li|h[1-6]|td|div)\b[^>]*>(.*?)</\1>',data,re.I|re.S):
  block=re.sub(r'\s+',' ',html.unescape(re.sub('<[^>]+>',' ',body))).strip()
  if 0<len(block)<=260:blocks.append(block)
 return {'url':final,'sha256':hashlib.sha256(data.encode()).hexdigest(),'text':text,'emails':published_emails(data),'contactLinks':links[:3],'roleBlocks':blocks,'language':next(iter(re.findall(r'<html[^>]*lang=[\"\x27]([^\"\x27]+)',data,re.I)), '')}
def cached_delivery(email,t,ops=OPS):
 obj=read(ops/'contact-quality-verification-cache.json')
 v=obj.get('items',{}).get(hashlib.sha256(email.encode()).hexdigest(),{})
 q=v.get('verification',{})
 return bool(v.get('updatedAt') and 0<=(t-dt(v['updatedAt'])).total_seconds()<7*86400 and q.get('result') in ['deliverable','valid'] and q.get('smtp_check') is True and q.get('accept_all') is False and q.get('block') is False)
def provider_delivery(c,t):
 v=c.get('emailVerification',{});checked=v.get('checkedAt')
 return bool(checked and 0<=(t-dt(checked)).total_seconds()<7*86400 and v.get('provider')=='hunter' and v.get('statusCode')==200 and v.get('result') in ['deliverable','valid'] and int(v.get('score') or 0)>=95 and v.get('smtpCheck') is True and v.get('acceptAll') is False and v.get('block') is False)
def delivery_blocker(c,t,ops=OPS):
 obj=read(ops/'contact-quality-verification-cache.json')
 cached=obj.get('items',{}).get(hashlib.sha256(c['email'].encode()).hexdigest(),{})
 evidence=[(cached.get('updatedAt'),cached.get('verification',{})),(c.get('emailVerification',{}).get('checkedAt'),c.get('emailVerification',{}))]
 for checked,v in evidence:
  if checked and 0<=(t-dt(checked)).total_seconds()<30*86400 and (v.get('result') in ['risky','undeliverable'] or (v.get('accept_all') is True or v.get('acceptAll') is True)):
   return 'recent_adverse_delivery_evidence'
 return None
def owned_domain(url,domain):
 host=(parse.urlparse(url).hostname or '').lower().removeprefix('www.')
 domain=domain.lower().removeprefix('www.')
 return host==domain or host.endswith('.'+domain)
def primary_mandate(pages,name):
 tokens=norm(name).split()
 if len(tokens)<2:return None
 fullname=r'\s+'.join(re.escape(x) for x in tokens)
 role=r'(?:president(?:e)?|direct(?:eur|rice)(?:\s+general[e]?)?|ceo|chief executive officer|gerant(?:e)?)'
 pattern=re.compile(r'(?:'+fullname+r'\W{0,12}(?:notre\s+|est\s+|le\s+|la\s+)?(?P<after>'+role+r')|(?P<before>'+role+r')\W{0,12}'+fullname+r')')
 for p in pages:
  path=norm(parse.urlparse(p['url']).path)
  if not re.search(r'societe|a-propos|about|company|groupe|equipe|team|gouvernance|direction|mentions',path) or re.search(r'actualit|news|blog|article|archive|histoire',path):continue
  for block in p.get('roleBlocks',[]):
   text=norm(block)
   if re.search(r'\bancien|\bancienne|\bex-|jusqu|etait|historique',text):continue
   match=pattern.search(text)
   if match:return {'qualite':match['after'] or match['before'],'sourceUrl':p['url'],'sourceSha256':p['sha256'],'basis':'primary_company_professional_mandate'}
 return None
def primary_sirens(pages):
 values=[]
 for page in pages:
  for m in re.finditer(r'\b(?:SIREN|SIRET|RCS)\b',page['text'],re.I):
   tail=page['text'][m.end():m.end()+80]
   number=re.search(r'(?<!\d)(\d(?:[\s.]*\d){13}|\d(?:[\s.]*\d){8})(?!\d)',tail)
   if number:
    digits=re.sub(r'\D','',number[1]);siren=digits[:9]
    if siren not in values:values.append(siren)
 return values[:3]
def refresh_proof(c,t,fetch_page=public_page,get_json=None,ops=OPS):
 if c['lane']!='presse' and transport.GENERIC.match(c['email']):return {'ok':False,'reason':'generic_mailbox_does_not_bind_executive','checkedAt':stamp(t)}
 bad=delivery_blocker(c,t,ops)
 if bad:return {'ok':False,'reason':bad,'checkedAt':stamp(t)}
 pages=[]
 for u in c['sourceUrls'][:3]:
  if not owned_domain(u,c['domain']):continue
  try:
   page=fetch_page(u)
   if owned_domain(page['url'],c['domain']):pages.append(page)
  except Exception:pass
 if pages:
  for u in pages[0].get('contactLinks',[])[:3]:
   if u in {p['url'] for p in pages}:continue
   if not owned_domain(u,c['domain']):continue
   try:
    page=fetch_page(u)
    if owned_domain(page['url'],c['domain']):pages.append(page)
   except Exception:pass
 if not pages:return {'ok':False,'reason':'primary_sources_unavailable','checkedAt':stamp(t)}
 email=c['email'];literal=any(email in {x.lower() for x in p['emails']} and owned_domain(p['url'],c['domain']) for p in pages)
 if literal:
  try:
   mx=json.loads(fetch('https://dns.google/resolve?'+parse.urlencode({'name':c['domain'],'type':'MX'}))[0])
   if not any(a.get('type')==15 and a.get('data','').split()[-1]!='.' for a in mx.get('Answer',[])):literal=False
  except Exception:literal=False
 if not literal and not (cached_delivery(email,t,ops) or provider_delivery(c,t)):return {'ok':False,'reason':'fresh_exact_email_or_valid_non_catchall_proof_missing','checkedAt':stamp(t)}
 text=norm(' '.join(p['text'] for p in pages));proof={'checkedAt':stamp(t),'emailBasis':'primary_public_exact_email' if literal else 'fresh_valid_non_catchall_cache',
 'sources':[{'url':p['url'],'sha256':p['sha256']} for p in pages], 'smtpVerified':cached_delivery(email,t,ops) or provider_delivery(c,t)}
 if c['lane']=='presse':
  editorial=bool(EDITORIAL.match(email)) or bool(c.get('name') and norm(c['name']) in text and ROLE.search(text)) or (c.get('segment')=='podcast' and email.startswith('contact@') and 'podcast' in text)
  fit=c.get('fitScore',0)>=72 and any(w in text for w in ['entrepris','econom','business','dirigeant','pme','eti','industrie','technolog','innovation','intelligence artificielle'])
  french=any(p.get('language','').lower().startswith('fr') for p in pages)
  if not french:french=sum(w in text for w in [' les ',' des ',' pour ',' dans ',' une '])>=4
  proof.update(ok=editorial and fit and french,reason='qualified_editorial_primary_source' if editorial and fit and french else 'editorial_role_language_or_business_beat_unproven')
 else:
  sirens=[c['siren']] if c.get('siren') else primary_sirens(pages)
  if not sirens:return {**proof,'ok':False,'reason':'siren_missing'}
  words=[w for w in norm(c.get('company','')).split() if len(w)>=3 and w not in ['sas','sarl','societe','societes','sa']]
  rows=[];registry_failed=False
  for siren in sirens:
   url='https://recherche-entreprises.api.gouv.fr/search?'+parse.urlencode({'q':siren})
   try:d=get_json(url) if get_json else json.loads(fetch(url)[0])
   except Exception:registry_failed=True;continue
   row=next((x for x in d.get('results',[]) if x.get('siren')==siren),{})
   if row and words and all(w in norm(row.get('nom_complet','')) and w in text for w in words) and siren in primary_sirens(pages):rows.append((row,url))
  if len(rows)!=1:return {**proof,'ok':False,'reason':'registry_unavailable' if not rows and registry_failed else 'primary_company_identity_ambiguous_or_unproven'}
  row,url=rows[0];c['siren']=row['siren']
  lower=EMPLOYEES.get(row.get('tranche_effectif_salarie'),0)
  name=norm(c.get('name','')).split();leaders=row.get('dirigeants',[])
  role=next((x for x in leaders if name and name[-1] in norm(x.get('nom','')).split() and name[0] in norm(x.get('prenoms','')).split() and ROLE.search(x.get('qualite',''))),None)
  if not role:role=primary_mandate(pages,c.get('name',''))
  matched_domain=c['siren'] in primary_sirens(pages)
  category=row.get('categorie_entreprise');lane='eti' if category=='ETI' else 'pme'
  individual=name and name[0] in text and name[-1] in text
  capacity=bool(individual) and row.get('statut_diffusion')=='O' and category in ['PME','ETI'] and lower>=50 and row.get('etat_administratif')=='A' and not row.get('siege',{}).get('code_pays_etranger') and int(row.get('annee_tranche_effectif_salarie') or 0)>=t.year-3
  proof.update(ok=bool(role and matched_domain and capacity),reason='qualified_registry_and_exact_email' if role and matched_domain and capacity else 'company_identity_capacity_or_mandate_unproven',
   registryUrl=url,registrySha256=digest(row),category=category,lane=lane,employeeLowerBound=lower,employeeYear=row.get('annee_tranche_effectif_salarie'),
   verifiedRole=role.get('qualite') if role else None,mandateBasis=role.get('basis','current_registry') if role else None,mandateSource=role.get('sourceUrl',url) if role else None,budgetConfirmed=False)
 return proof
def research(db,t,batch=4,lane=None):
 rows=db.execute('SELECT * FROM candidates WHERE (checked IS NULL OR checked<?) AND (? IS NULL OR lane=?) AND email NOT IN (SELECT email FROM legacy) ORDER BY checked IS NOT NULL,checked,email LIMIT ?', (stamp(t-timedelta(days=7)),lane,lane,batch)).fetchall()
 counts={}
 for r in rows:
  c=json.loads(r['payload']);proof=refresh_proof(c,t)
  lane=proof.get('lane',r['lane']);c['lane']=lane
  db.execute('UPDATE candidates SET lane=?,account=?,payload=?,proof=?,checked=?,reason=? WHERE email=?',(lane,c.get('siren') or r['account'],json.dumps(c,ensure_ascii=False),json.dumps(proof,ensure_ascii=False),stamp(t),proof['reason'],r['email']))
  counts[proof['reason']]=counts.get(proof['reason'],0)+1
 db.commit();return counts
def reserve_national(db,t,lane):
 # INSEE/RNE company reserve is separate from qualified contacts, and includes all France.
 key='registry_page_'+lane;old=db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone();page=int(old['value']) if old else 1
 url='https://recherche-entreprises.api.gouv.fr/search?'+parse.urlencode({'categorie_entreprise':'ETI' if lane=='eti' else 'PME','etat_administratif':'A','statut_diffusion':'O','tranche_effectif_salarie':','.join(EMPLOYEES),'per_page':25,'page':page})
 data=json.loads(fetch(url)[0]);added=0
 for r in data.get('results',[]):
  if not str(r.get('nature_juridique','')).startswith(('5','6')) or r.get('statut_diffusion')!='O' or r.get('categorie_entreprise') not in ['PME','ETI'] or not r.get('dirigeants') or EMPLOYEES.get(r.get('tranche_effectif_salarie'),0)<50:continue
  public={k:r.get(k) for k in ['siren','nom_complet','tranche_effectif_salarie','annee_tranche_effectif_salarie','categorie_entreprise','activite_principale','siege']}
  public['leaders']=[{k:x.get(k) for k in ['nom','prenoms','qualite']} for x in r['dirigeants'] if ROLE.search(x.get('qualite',''))]
  if not public['leaders']:continue
  public['sourceUrl']=url;before=db.total_changes
  db.execute('INSERT OR IGNORE INTO research VALUES(?,?,?,?)',(r['siren'],json.dumps(public,ensure_ascii=False),stamp(t),'needs_official_domain_and_exact_contact'))
  added+=db.total_changes-before
 db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,str(page+1 if page<data.get('total_pages',1) else 1)));db.commit();return added
def business_days(a,b):
 d=a.astimezone(ZoneInfo('Europe/Paris')).date();end=b.astimezone(ZoneInfo('Europe/Paris')).date();n=0
 while d<end:
  d+=timedelta(days=1);n+=d.weekday()<5
 return n
def learning(db,lane,t,c):
 out={}
 for v in ['A','B']:
  matured={r['email'] for r in db.execute("SELECT * FROM touches WHERE lane=? AND step='initial' AND state='verified' AND variant=? AND copy_version=?",(lane,v,c['copyVersion'])) if business_days(dt(r['created']),t)>=5}
  successes={r['email'] for r in db.execute("SELECT * FROM replies WHERE lane=? AND kind=?",(lane,'editorial_request' if lane=='presse' else 'qualified_need'))}&matured
  out[v]={'matured':len(matured),'qualified':len(successes),'posterior':(1+len(successes))/(2+len(matured))}
 enough=all(x['matured']>=8 for x in out.values()) and sum(x['qualified'] for x in out.values())>=3
 winner=max(out,key=lambda v:out[v]['posterior']) if enough and abs(out['A']['posterior']-out['B']['posterior'])>=.1 else None
 return {'copyVersion':c['copyVersion'],'variants':out,'winner':winner,'explorationFloor':.25,'technicalSendsRewarded':False,'bookingsInferred':False}
def choose_variant(email,learn):
 bucket=int(hashlib.sha256(email.encode()).hexdigest(),16)%4
 return learn['winner'] if learn['winner'] and bucket!=0 else ('A' if bucket%2==0 else 'B')
def draft(c,v,step='initial',subject=None):
 name=c.get('name','').split(' ')[0] if c.get('name') and len(c['name'].split())>=2 else ''
 greeting='Bonjour'+(' '+name.title() if name and c['lane']!='presse' else '')+','
 if c['lane']=='presse':
  title='Angle PME/ETI : décider où l’IA mérite un investissement' if v=='A' else 'IA en entreprise : ce qui permet de passer à un usage maîtrisé'
  main=("Je vous propose un angle concret pour votre rédaction : comment un dirigeant distingue un cas d’usage utile d’une démonstration séduisante, puis décide d’investir ou d’arrêter." if v=='A' else
    "Je vous propose un angle terrain pour votre rédaction : qui possède les données, comment les équipes adoptent l’outil et comment mesurer un flux avant et après sa transformation.")
  text=greeting+'\n\n'+main+'\n\nChez Robinswood, nous travaillons sur les flux métier, les outils IA et l’adoption. Exemple de périmètre réalisé : pour Cerfrance Picardie Nord de Seine, conception, développement et maintenance d’une application de gestion des lettres de mission.\n\nSouhaitez-vous une note d’angle courte avec les questions à poser aux dirigeants ? Aucun placement payant ni exclusivité proposés.'
 else:
  # Imported historical angles may be English or unproven; outgoing copy stays French.
  topic='les validations, les documents et le passage entre équipes'
  title=c['company']+' : quel flux mérite d’être simplifié ?' if v=='A' else c['company']+' : un usage IA que vos équipes maîtrisent'
  main=("Un sujet possible chez "+c['company']+" : "+topic+". Où se situent le temps perdu et les reprises ? C’est une hypothèse à vérifier avec vous, sans supposer un gain déjà obtenu." if v=='A' else
    "Un sujet possible chez "+c['company']+" : "+topic+". Quelle étape améliorer en gardant la maîtrise des données, des décisions et de l’outil ?")
  text=greeting+'\n\n'+main+'\n\nRobinswood accompagne les PME et ETI de l’étude du flux à la mise en œuvre. Notre audit stratégique IA (5 000 € HT, dix jours) établit une situation de départ et permet de décider : arrêt, outil, accompagnement ou combinaison.\n\nQuel flux vous coûte aujourd’hui le plus de temps, et dans quel ordre de grandeur ? Une réponse de deux lignes suffit.'
 if step=='followup':text=greeting+'\n\nJe reviens une seule fois sur ma proposition ci-dessous. '+('Une note d’angle sur les décisions IA des PME/ETI serait-elle utile à votre rédaction ?' if c['lane']=='presse' else 'Le sujet est-il pertinent pour votre entreprise, ou faut-il le laisser de côté ?')
 if step=='reply':
  text=greeting+'\n\nMerci pour votre retour. '+('Voici notre angle : partir d’un flux réel, établir le coût total, puis décider de poursuivre ou d’arrêter. Nous pouvons documenter la méthode et le périmètre de nos missions ; aucun gain chiffré n’est annoncé sans mesure. Pour quel format et quelle échéance préparez-vous ce sujet ?' if c['lane']=='presse' else
    'Notre démarche commence par un flux précis, une situation de départ et un coût total. L’audit stratégique IA est proposé à 5 000 € HT sur dix jours ; sa conclusion peut recommander l’arrêt, un outil ou un accompagnement. Quel flux, quel volume et quelle échéance souhaiteriez-vous examiner ?')
 text+='\n\nVotre adresse professionnelle provient de sources publiques en lien avec votre activité. Source : '+c['sourceUrls'][0]+'\nInformations et droits sur vos données : https://robinswood.io/confidentialite — contact : thibault@robinswood.io. Pour ne plus recevoir de message, répondez simplement « STOP » ; l’opposition est gratuite et prise en compte automatiquement.'
 return {'subject':subject or title,'body':text}

def discover_company(db,t,fetch_page=public_page):
 r=db.execute("SELECT * FROM research WHERE reason='needs_official_domain_and_exact_contact' OR (checked<datetime('now','-7 days') AND reason IN ('official_domain_or_public_executive_email_not_found','public_discovery_unavailable_backoff')) ORDER BY checked,siren LIMIT 1").fetchone()
 if not r:return {'checked':0,'addedContacts':0}
 item=json.loads(r['payload']);query=item['nom_complet']+' '+r['siren']+' site officiel'
 added=0;reason='official_domain_or_public_executive_email_not_found'
 try:
  data,_=fetch('https://www.bing.com/search?'+parse.urlencode({'q':query}))
  urls=[]
  for raw in re.findall(r'href=["\'](https://[^"\']+)',html.unescape(data)):
   initial=parse.urlparse(raw)
   if initial.hostname and initial.hostname.endswith('bing.com') and initial.path.startswith('/ck/a'):
    encoded=parse.parse_qs(initial.query).get('u',[''])[0]
    if encoded.startswith('a1'):
     try:raw=base64.urlsafe_b64decode(encoded[2:]+'='*((-len(encoded[2:]))%4)).decode()
     except Exception:continue
   host=(parse.urlparse(raw).hostname or '').lower()
   if any(host==x or host.endswith('.'+x) for x in ['bing.com','microsoft.com','google.com','linkedin.com','facebook.com','pappers.fr','societe.com','annuaire-entreprises.data.gouv.fr','verif.com','pagesjaunes.fr']):continue
   origin='https://'+host+'/'
   if origin not in urls:urls.append(origin)
  for origin in urls[:5]:
   pages=[]
   for suffix in ['', 'mentions-legales/', 'contact/']:
    try:pages.append(fetch_page(origin+suffix))
    except Exception:pass
   text=norm(' '.join(p['text'] for p in pages))
   # A search engine only discovers a URL. The official SIREN proves identity.
   if r['siren'] not in primary_sirens(pages):continue
   domain=(parse.urlparse(origin).hostname or '').removeprefix('www.')
   for leader in item['leaders']:
    last=norm(leader.get('nom','')).replace(' ','');first=norm(leader.get('prenoms','')).split()
    if not last or not first:continue
    for email in {x.lower() for p in pages for x in p['emails']}:
     local,host=email.split('@')
     if host.removeprefix('www.')!=domain or last not in norm(local).replace('.','').replace('-',''):continue
     # The address must be public; this never constructs or guesses an address.
     c={'email':email,'name':leader['prenoms']+' '+leader['nom'],'company':item['nom_complet'],'siren':r['siren'],'domain':domain,
      'lane':'eti' if item['categorie_entreprise']=='ETI' else 'pme','sourceUrls':[p['url'] for p in pages],
      'topic':'les validations, les documents et le passage entre équipes'}
     before=db.total_changes;put_candidate(db,c);added+=db.total_changes-before
   if added:reason='public_exact_contacts_discovered';break
 except Exception:reason='public_discovery_unavailable_backoff'
 db.execute('UPDATE research SET checked=?,reason=? WHERE siren=?',(stamp(t),reason,r['siren']));db.commit()
 return {'checked':1,'addedContacts':added,'reason':reason}

class Gateway(transport.Gateway):
 def prepare(self,item,draft,operation,parent=None):
  raw,expected,sig=super().prepare(item,draft,operation,parent);m=BytesParser(policy=email_policy.default).parsebytes(base64.urlsafe_b64decode(raw))
  m.replace_header('X-RBW-Campaign',item['campaignId']);m['Reply-To']=transport.SENDER
  m['List-Unsubscribe']='<mailto:thibault@robinswood.io?subject=STOP>'
  return base64.urlsafe_b64encode(m.as_bytes()).decode(),expected,sig
def classify_reply(m,lane):
 text=norm(transport.plain(m.get('payload',{}))+'\n'+m.get('snippet',''));headers={h['name'].lower():h['value'] for h in m.get('payload',{}).get('headers',[])}
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
def new_reply_text(m):
 # Conservative quote trimming prevents attribution to the sender's own pitch.
 body=transport.plain(m.get('payload',{})).replace('\r\n','\n')
 lines=[]
 for l in body.splitlines():
  if l.lstrip().startswith('>') or re.match(r'^(Le .+ a écrit|On .+ wrote|From:|De :|[-_]{3,})',l):break
  lines.append(l)
 out=dict(m);out['payload']={'headers':m.get('payload',{}).get('headers',[]),'mimeType':'text/plain','body':{'data':base64.urlsafe_b64encode('\n'.join(lines).encode()).decode()}};out['snippet']=''
 return out
def reply_scan(db,gateway,lane,t):
 done=0
 for r in db.execute("SELECT * FROM touches WHERE lane=? AND state='verified' AND step='initial' ORDER BY created DESC LIMIT 120",(lane,)).fetchall():
  thread=gateway.call('/threads/'+r['thread']+'?format=full')
  for m in thread.get('messages',[]):
   froms=transport.addresses(transport.header(m,'From'))
   if transport.SENDER in froms or db.execute('SELECT 1 FROM replies WHERE message_id=?',(m['id'],)).fetchone():continue
   # Only a reply from the exact recipient or a delivery failure may act on that contact.
   kind=classify_reply(new_reply_text(m),lane)
   if froms!=[r['email']] and kind!='bounce':continue
   evidence={'gmailMessageId':m['id'],'threadId':r['thread'],'sourceTextSha256':hashlib.sha256(transport.plain(new_reply_text(m)['payload']).encode()).hexdigest(),'verifiedFrom':froms}
   db.execute('INSERT OR IGNORE INTO replies VALUES(?,?,?,?,?,?)',(m['id'],r['email'],lane,kind,stamp(t),json.dumps(evidence)))
   if kind in ['opposition','complaint','bounce']:suppress(r['email'],kind,m['id'])
   done+=1

 for ref in gateway.search('in:anywhere (from:mailer-daemon OR from:postmaster) newer_than:14d'):
  if db.execute('SELECT 1 FROM replies WHERE message_id=?',(ref['id'],)).fetchone():continue
  m=gateway.get(ref['id']);content=transport.plain(m.get('payload',{}))+' '+m.get('snippet','')
  found={x.lower() for x in EMAIL.findall(content)}
  matches=db.execute("SELECT DISTINCT email FROM touches WHERE lane=? AND state='verified'",(lane,)).fetchall()
  for target in matches:
   if target['email'] not in found:continue
   evidence={'gmailMessageId':m['id'],'threadId':m.get('threadId'),'exactFailedRecipient':target['email']}
   db.execute('INSERT OR IGNORE INTO replies VALUES(?,?,?,?,?,?)',(m['id'],target['email'],lane,'bounce',stamp(t),json.dumps(evidence)))
   suppress(target['email'],'bounce',m['id']);done+=1
 db.commit();return done
def recover_pending(db,gateway):
 for r in db.execute("SELECT * FROM touches WHERE state!='verified'").fetchall():
  matches=gateway.search('in:sent rfc822msgid:'+r['operation']+'@robinswood.io')
  if len(matches)!=1:raise RuntimeError('unresolved_campaign_effect')
  from outbound_sender_guard import verify
  m=gateway.get(matches[0]['id']);ok,checks=verify(m,r['raw'],r['thread'])
  if not ok:raise RuntimeError('campaign_effect_verification_failed')
  db.execute("UPDATE touches SET state='verified',gmail_id=?,thread=?,checks=? WHERE operation=?",(m['id'],m['threadId'],json.dumps(checks),r['operation']));db.commit()
def next_item(db,lane,t,c):
 exclusions=suppressed();learn=learning(db,lane,t,c)
 # Explicit requests take precedence; every reply/followup consumes the same caps.
 for r in db.execute("SELECT DISTINCT email FROM replies WHERE lane=? AND kind IN ('interest','qualified_need','editorial_request')",(lane,)):
  sent=db.execute("SELECT 1 FROM touches WHERE email=? AND step='reply'",(r['email'],)).fetchone()
  row=db.execute('SELECT * FROM candidates WHERE email=?',(r['email'],)).fetchone()
  if not sent and row and r['email'] not in exclusions:return row,'reply',learn
 rows=db.execute('SELECT * FROM candidates WHERE lane=? AND proof IS NOT NULL ORDER BY email',(lane,)).fetchall()
 for r in rows:
  if r['email'] in exclusions or delivery_blocker(json.loads(r['payload']),t) or db.execute('SELECT 1 FROM legacy WHERE email=?',(r['email'],)).fetchone():continue
  proof=json.loads(r['proof'])
  if not proof.get('ok') or not 0<=(t-dt(proof['checkedAt'])).total_seconds()<c['proofMaxAgeDays']*86400:continue
  touches=db.execute('SELECT * FROM touches WHERE email=? ORDER BY created',(r['email'],)).fetchall()
  if not touches:
   if db.execute('SELECT 1 FROM touches JOIN candidates ON candidates.email=touches.email WHERE candidates.account=?',(r['account'],)).fetchone():continue
   return r,'initial',learn
  initial=next((x for x in touches if x['step']=='initial'),None)
  replied=db.execute('SELECT 1 FROM replies WHERE email=?',(r['email'],)).fetchone()
  if initial and not replied and len(touches)<c['maxTouchesWithoutReply'] and business_days(dt(initial['created']),t)>=10:return r,'followup',learn
 return None,None,learn
def lane_capacity(db,lane,t,c):
 effects=db.execute("SELECT * FROM touches WHERE lane=?",(lane,)).fetchall();local=t.astimezone(ZoneInfo('Europe/Paris'));day=local.date();monday=day-timedelta(days=day.weekday())
 learn=learning(db,lane,t,c);matured=sum(x['matured'] for x in learn['variants'].values());qualified=sum(x['qualified'] for x in learn['variants'].values())
 adverse=db.execute("SELECT count(*) n FROM replies WHERE lane=? AND kind IN ('bounce','complaint')",(lane,)).fetchone()['n']
 bounce=db.execute("SELECT max(observed) observed FROM replies WHERE lane=? AND kind='bounce'",(lane,)).fetchone()['observed']
 if db.execute("SELECT 1 FROM replies WHERE lane=? AND kind='complaint'",(lane,)).fetchone():return False,'complaint_pause'
 if bounce:
  key='recovery_epoch_'+lane;epoch=db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone()
  recovered=bool(epoch and json.loads(epoch['value'])['afterBounce']==bounce)
  if not recovered:
   eligible=[]
   if (t-dt(bounce)).total_seconds()>=c['autoRecovery']['cooldownDays']*86400:
    for row in db.execute('SELECT * FROM candidates WHERE lane=? AND proof IS NOT NULL AND email NOT IN(SELECT email FROM touches) AND email NOT IN(SELECT email FROM legacy)',(lane,)):
     proof=json.loads(row['proof'])
     if proof.get('ok') and proof.get('smtpVerified') is True and dt(proof['checkedAt'])>dt(bounce) and 0<=(t-dt(proof['checkedAt'])).total_seconds()<7*86400 and row['email'] not in suppressed() and not delivery_blocker(json.loads(row['payload']),t):
      eligible.append(row['email'])
   if len(eligible)<c['autoRecovery']['minimumFreshSmtpContacts']:return False,'new_cohort_bounce_pause_awaiting_independent_smtp_proofs'
   db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,json.dumps({'activatedAt':stamp(t),'afterBounce':bounce,'freshContactHashes':[digest(e) for e in eligible],'historicalMetricsPreserved':True})));db.commit()
   recovered=True
  if recovered:
   # Keep the new recovery canary at one/day; allow only independently verified SMTP contacts.
   for row in db.execute('SELECT email,proof FROM candidates WHERE lane=? AND proof IS NOT NULL',(lane,)):
    proof=json.loads(row['proof'])
    if proof.get('smtpVerified') is not True and proof.get('ok'):
     proof['ok']=False;proof['reason']='recovery_requires_independent_smtp_proof'
     db.execute('UPDATE candidates SET proof=?,reason=? WHERE email=?',(json.dumps(proof),proof['reason'],row['email']))
   db.commit()
 daily=c['lanes'][lane]['dailyMax'] if matured>=10 and qualified>=1 and not adverse else c['canaryDailyMax']
 nday=sum(dt(x['created']).astimezone(ZoneInfo('Europe/Paris')).date()==day for x in effects)
 nweek=sum(dt(x['created']).astimezone(ZoneInfo('Europe/Paris')).date()>=monday for x in effects)
 return nday<daily and nweek<c['lanes'][lane]['weeklyMax'],{'dailyCap':daily,'dailyUsed':nday,'weeklyCap':c['lanes'][lane]['weeklyMax'],'weeklyUsed':nweek,'historicalMetricsReset':False}
def audience_counts(db,lane,t,c):
 rows=db.execute('SELECT * FROM candidates WHERE lane=?',(lane,)).fetchall()
 legacy={r['email'] for r in db.execute('SELECT email FROM legacy')}
 blocked=suppressed();qualified=[]
 for r in rows:
  if r['email'] in legacy or r['email'] in blocked or not r['proof']:continue
  proof=json.loads(r['proof'])
  if proof.get('ok') is True and proof.get('checkedAt') and 0<=(t-dt(proof['checkedAt'])).total_seconds()<c['proofMaxAgeDays']*86400:qualified.append(r)
 contacted={r['email'] for r in db.execute('SELECT email FROM touches')}
 touched_accounts={r['account'] for r in db.execute('SELECT c.account FROM candidates c JOIN touches t ON c.email=t.email')}
 return {'reserve':len(rows),'qualified':len(qualified),'readyForInitial':sum(r['email'] not in contacted and r['account'] not in touched_accounts for r in qualified),
  'historicalContactsExcluded':len(legacy),'laneHistoricalReserveExcluded':sum(r['email'] in legacy for r in rows)}
def run(lane,apply=False,research_only=False,root=ROOT,c=None,gateway=None,t=None,research_batch=2,maintain=False):
 assert lane in LANES;report_id=IDS[lane]+('-maintenance' if maintain else '');c=c or contract();t=t or now();root.mkdir(parents=True,exist_ok=True)
 with (root/'campaign.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX);db=db_open(root)
  try:
   import_reserves(db);research_result=research(db,t,research_batch,lane) if research_batch else {}
   counts=audience_counts(db,lane,t,c)
   status='outside_business_window';sent=0;reply_count=0
   if research_only or maintain:
    if maintain:
     gateway=gateway or Gateway();recover_pending(db,gateway);reply_count=reply_scan(db,gateway,lane,t)
    key='registry_last_day_'+lane;prior=db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone()
    added=0
    if lane!='presse' and (not prior or prior['value']!=t.date().isoformat()):
     # Record a daily attempt before the free public API request; failures back off.
     db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,t.date().isoformat()));db.commit()
     try:added=reserve_national(db,t,lane)
     except Exception:research_result['national_registry_unavailable_backoff']=1
    discovered=discover_company(db,t) if lane!='presse' else {'checked':0,'addedContacts':0}
    status='maintenance_no_send';counts['nationalCompanyReservesAdded']=added;counts['publicContactsDiscovered']=discovered['addedContacts']
   elif in_window(t,c) and apply:
    gateway=gateway or Gateway();recover_pending(db,gateway);reply_count=reply_scan(db,gateway,lane,t)
    capacity,cap=lane_capacity(db,lane,t,c);row,step,learn=next_item(db,lane,t,c)
    status='lane_cap_reached' if not capacity else 'awaiting_qualified_contact' if not row else 'prepared'
    if capacity and row:
     item=json.loads(row['payload']);item['campaignId']=IDS[lane];v=choose_variant(row['email'],learn)
     parent_row=db.execute("SELECT * FROM touches WHERE email=? AND step='initial' AND state='verified'",(row['email'],)).fetchone()
     parent=gateway.get(parent_row['gmail_id']) if parent_row and step!='initial' else None
     if step=='initial' and gateway.search('in:sent to:'+row['email']):
      append_legacy(db,{'email':row['email'],'status':'prior_contact_found_in_gmail','campaignId':'gmail_history'});db.commit()
      status='historical_contact_deduplicated'
      row=None
     if row is None:
      report={'generatedAt':stamp(now()),'capabilityId':report_id,'ok':True,'status':status,'summary':status,'counts':{**counts,'sentNow':0},'blockingReasons':[],'artifacts':{'state':str(root/'campaign-state.sqlite3')}}
      save(OPS/(report_id+'-last.json'),report);save(root/(lane+('-maintenance' if maintain else '')+'-last.json'),report);return report
     d=draft(item,v,step,parent_row['subject'] if parent else None)
     op='rbw-eg-'+hashlib.sha256((row['email']+'|'+step+'|'+c['copyVersion']).encode()).hexdigest()[:32]
     raw,expected,sig=gateway.prepare(item,d,op,parent)
     thread=parent_row['thread'] if parent else None
     # Shared capacity is checked before reservation so a pacing rejection is a no-op.
     from outbound_sender_guard import SenderGuardBlocked
     db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(op,row['email'],lane,step,v,c['copyVersion'],stamp(now()),'reserved',raw,expected,d['subject'],None,thread,None));db.commit()
     try:
      result=gateway.send(raw,thread)
      from outbound_sender_guard import verify
      actual=gateway.get(result['id']);ok,checks=verify(actual,raw,thread)
      if not ok:raise RuntimeError('end_user_effect_unverified')
      db.execute("UPDATE touches SET state='verified',gmail_id=?,thread=?,checks=? WHERE operation=?",(actual['id'],actual['threadId'],json.dumps(checks),op));db.commit()
      status='sent_verified';sent=1
     except SenderGuardBlocked as e:
      # A proven pre-send cap/interval refusal creates no ambiguous effect.
      if not e.write_attempted:
       db.execute("DELETE FROM touches WHERE operation=? AND state='reserved'",(op,));db.commit();status=str(e)
      else:raise
   else:cap=lane_capacity(db,lane,t,c)[1]
   report={'generatedAt':stamp(now()),'contractVersion':'robinswood-evergreen-france-v1','capabilityId':report_id,
    'ok':True,'status':status,'mode':'apply' if apply else 'dry_run','counts':{**counts,'sentNow':sent,'newReplies':reply_count},
    'summary':lane+': '+status+'; sends='+str(sent),'blockingReasons':[] if status not in ['awaiting_qualified_contact'] else ['fresh_primary_qualification_required'],
    'warningReasons':['historical_HDF_bounces_5_of_48_preserved','SENT_is_not_inbox_delivery','new_cohort_canary_one_per_lane_per_day'],
    'research':research_result,'learning':learning(db,lane,t,c),'yearRound':True,'endDate':None,
    'artifacts':{'state':str(root/'campaign-state.sqlite3'),'contract':str(POLICY)},
    'systemsOfRecord':{'classification':'none','crmWrites':0,'gmailProof':'exact_SENT_message_thread_body_signature'},
    'durability':{'idempotency':'email_step_copy_version_operation','unknownEffect':'pause_and_reconcile_no_retry'},
    'senderSharedCaps':{'daily':40,'weekly':200,'hourly':6,'intervalSeconds':600},'laneCapacity':lane_capacity(db,lane,t,c)[1]}
   save(OPS/(report_id+'-last.json'),report);save(root/(lane+('-maintenance' if maintain else '')+'-last.json'),report);return report
  finally:db.close()
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--lane',choices=LANES,required=True);ap.add_argument('--apply',action='store_true');ap.add_argument('--research-only',action='store_true');ap.add_argument('--maintain',action='store_true');ap.add_argument('--research-batch',type=int,default=2);args=ap.parse_args()
 try:
  r=run(args.lane,args.apply,args.research_only,research_batch=max(0,min(args.research_batch,6)),maintain=args.maintain)
  print(json.dumps({k:r[k] for k in ['ok','status','counts','summary']},ensure_ascii=False));return 0
 except Exception as e:
  r={'generatedAt':stamp(now()),'capabilityId':IDS[args.lane]+('-maintenance' if args.maintain else ''),'ok':False,'status':'blocked_fail_closed','summary':str(e)[:220],'blockingReasons':[type(e).__name__+':'+str(e)[:220]],'counts':{'sentNow':0},'artifacts':{'state':str(ROOT/'campaign-state.sqlite3')}}
  save(OPS/(IDS[args.lane]+('-maintenance' if args.maintain else '')+'-last.json'),r);print(json.dumps(r));return 2
if __name__=='__main__':raise SystemExit(main())
