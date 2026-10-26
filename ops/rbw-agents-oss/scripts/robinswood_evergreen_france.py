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
import evergreen_sender_pilot as sender_pilot
from email.message import EmailMessage
import evergreen_queue_continuity as continuity
from evergreen_campaign_data import (
    WS,
    OPS,
    ROOT,
    POLICY,
    LANES,
    IDS,
    ROLE,
    EMAIL,
    EDITORIAL,
    EMPLOYEES,
    now,
    stamp,
    dt,
    norm,
    read,
    save,
    digest,
    contract,
    in_window,
    db_open,
    suppressed,
    suppress,
    append_legacy,
    import_reserves,
    put_candidate,
    cached_delivery,
    provider_delivery,
    delivery_blocker,
    owned_domain,
    primary_mandate,
    primary_sirens,
    business_days,
    learning,
    choose_variant,
    draft,
    portfolio_ramp,
    lane_capacity,
    audience_counts,
)

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
 q=continuity.policy()
 rows=db.execute("SELECT * FROM candidates WHERE (checked IS NULL OR checked<? OR (? AND COALESCE(json_extract(proof,'$.ok'),0)!=1 AND checked<?)) AND (? IS NULL OR lane=?) AND (email NOT IN(SELECT email FROM legacy) OR (? AND email IN(SELECT email FROM historical_threads WHERE status='eligible'))) ORDER BY checked IS NOT NULL,checked,email LIMIT ?", (stamp(t-timedelta(days=7)),bool(q),stamp(t-timedelta(hours=q['failedProofRetryHours'] if q else 168)),lane,lane,bool(q),batch)).fetchall()
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

def discover_company(db,t,fetch_page=public_page,lane=None,retry_hours=168):
 r=db.execute("SELECT * FROM research WHERE (? IS NULL OR json_extract(payload,'$.categorie_entreprise')=?) AND (reason='needs_official_domain_and_exact_contact' OR (checked<? AND reason IN ('official_domain_or_public_executive_email_not_found','public_discovery_unavailable_backoff'))) ORDER BY checked,siren LIMIT 1",(lane,'PME' if lane=='pme' else 'ETI',stamp(t-timedelta(hours=retry_hours)))).fetchone()
 if not r:return {'checked':0,'addedContacts':0}
 item=json.loads(r['payload']);query=item['nom_complet']+' '+r['siren']+' site officiel'
 added=0;reason='official_domain_or_public_executive_email_not_found'
 try:
  q=continuity.policy()
  if q:
   origin=parse.urlparse(item.get('sourceUrl',''))
   allowed={'categorie_entreprise','etat_administratif','statut_diffusion','tranche_effectif_salarie','per_page','page'}
   if origin.scheme!='https' or origin.hostname!='recherche-entreprises.api.gouv.fr' or origin.path!='/search' or not set(parse.parse_qs(origin.query))<=allowed:raise ValueError('public_registry_origin_unproven')
   # Build search terms only from freshly fetched public registry data.
   public=next(x for x in json.loads(fetch(item['sourceUrl'])[0]).get('results',[]) if x.get('siren')==r['siren'] and x.get('statut_diffusion')=='O')
   query='"'+public['nom_complet']+'" site officiel'
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
   for link in list(dict.fromkeys(x for page in pages for x in page.get('contactLinks',[])))[:3]:
    if len(pages)>=6:break
    try:pages.append(fetch_page(link))
    except Exception:pass
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
  sender=item.get('_sender',transport.SENDER);version=item.get('_sender_strategy_version','legacy')
  if sender not in [sender_pilot.PRIMARY,sender_pilot.ROBB]:raise RuntimeError('sender_not_authorized')
  if sender==sender_pilot.ROBB and (item['lane']=='presse' or version!=sender_pilot.VERSION):raise RuntimeError('robb_scope_not_authorized')
  if parent:
   if transport.addresses(transport.header(parent,'From'))!=[sender] or transport.addresses(transport.header(parent,'To'))!=[item['email']] or transport.header(parent,'Subject')!=draft['subject']:
    raise RuntimeError('original_sender_recipient_or_subject_changed')
  if sender==transport.SENDER:
   raw,expected,sig=super().prepare(item,draft,operation,parent)
   m=BytesParser(policy=email_policy.default).parsebytes(base64.urlsafe_b64decode(raw))
  else:
   identity=next((x for x in self.call('/settings/sendAs')['sendAs'] if x['sendAsEmail'].lower()==sender),None)
   if not identity or identity.get('verificationStatus')!='accepted' or identity.get('replyToAddress','').lower()!=sender or not identity.get('signature','').strip():raise RuntimeError('robb_signature_or_verified_identity_not_ready')
   signature=identity['signature'].strip()
   sig_text=html.unescape(re.sub('<[^>]+>',' ',re.sub(r'<br\s*/?>','\n',signature)))
   expected=draft['body'].strip()+'\n\n'+sig_text.strip()+'\n'
   m=EmailMessage();m['From']=sender;m['To']=item['email'];m['Subject']=draft['subject']
   m['Message-ID']='<'+operation+'@robinswood.io>';m['X-RBW-Operation']=operation;m['X-RBW-Campaign']=item['campaignId']
   if parent:m['In-Reply-To']=transport.header(parent,'Message-ID');m['References']=transport.header(parent,'Message-ID')
   m.set_content(expected);m.add_alternative('<div>'+html.escape(draft['body']).replace('\n','<br>')+'</div><br>'+signature,subtype='html')
   sig=hashlib.sha256(signature.encode()).hexdigest()
  m.replace_header('X-RBW-Campaign',item['campaignId']);m['Reply-To']=sender
  m['List-Unsubscribe']='<mailto:'+sender+'?subject=STOP>'
  if version==sender_pilot.VERSION:m['X-RBW-Sender-Strategy']=version
  from outbound_sender_guard import expected as check_payload
  raw=base64.urlsafe_b64encode(m.as_bytes()).decode();check_payload(raw)
  return raw,expected,sig
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
 for r in db.execute("SELECT * FROM touches WHERE lane=? AND state='verified' AND (step='initial' OR (step='followup' AND email IN(SELECT email FROM historical_threads))) ORDER BY created DESC LIMIT 120",(lane,)).fetchall():
  thread=gateway.call('/threads/'+r['thread']+'?format=full')
  for m in thread.get('messages',[]):
   froms=transport.addresses(transport.header(m,'From'))
   if 'SENT' in m.get('labelIds',[]) or any(s in froms for s in [sender_pilot.PRIMARY,sender_pilot.ROBB]) or db.execute('SELECT 1 FROM replies WHERE message_id=?',(m['id'],)).fetchone():continue
   # Only a reply from the exact recipient or a delivery failure may act on that contact.
   kind=classify_reply(new_reply_text(m),lane)
   if int(m.get('internalDate',0))<=dt(r['created']).timestamp()*1000:continue
   if froms!=[r['email']] and kind!='bounce':continue
   sender,_=sender_pilot.touch_identity(r)
   if kind not in ['bounce','opposition','complaint'] and (m.get('threadId')!=r['thread'] or sender not in transport.addresses(transport.header(m,'To'))+transport.addresses(transport.header(m,'Cc'))):continue
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
def observe_historical_negative(row,message):
 if 'SENT' in message.get('labelIds',[]):return
 kind=classify_reply(new_reply_text(message),'presse')
 if kind not in ['opposition','complaint','bounce']:return
 sender=transport.addresses(transport.header(message,'From'))
 if sender!=[row['email']] and (kind!='bounce' or row['email'].lower() not in transport.plain(message.get('payload',{})).lower()):return
 # Historical negatives suppress globally without contaminating new-cohort metrics.
 suppress(row['email'],kind,message['id'])
def recover_pending(db,gateway):
 for r in db.execute("SELECT * FROM touches WHERE state!='verified'").fetchall():
  matches=gateway.search('in:sent rfc822msgid:'+r['operation']+'@robinswood.io')
  if len(matches)!=1:raise RuntimeError('unresolved_campaign_effect')
  from outbound_sender_guard import verify
  m=gateway.get(matches[0]['id']);ok,checks=verify(m,r['raw'],r['thread'])
  if not ok:raise RuntimeError('campaign_effect_verification_failed')
  db.execute("UPDATE touches SET state='verified',gmail_id=?,thread=?,checks=? WHERE operation=?",(m['id'],m['threadId'],json.dumps(checks),r['operation']));db.commit()
def next_item(db,lane,t,c):
 exclusions=suppressed();learn=learning(db,lane,t,c);cap=lane_capacity(db,lane,t,c)[1]
 def available(row,step):
  return sender_pilot.plan(db,row,step,c,t,cap)[0] is not None
 # Explicit requests take precedence; every reply/followup consumes the same caps.
 for r in db.execute("SELECT DISTINCT email FROM replies WHERE lane=? AND kind IN ('interest','qualified_need','editorial_request')",(lane,)):
  sent=db.execute("SELECT 1 FROM touches WHERE email=? AND step='reply'",(r['email'],)).fetchone()
  row=db.execute('SELECT * FROM candidates WHERE email=?',(r['email'],)).fetchone()
  if not sent and row and r['email'] not in exclusions and available(row,'reply'):return row,'reply',learn
 q=continuity.policy()
 rows=db.execute("SELECT * FROM candidates WHERE lane=? AND proof IS NOT NULL ORDER BY CASE WHEN email IN(SELECT email FROM touches WHERE step='initial') OR email IN(SELECT email FROM historical_threads WHERE status='eligible') THEN 0 ELSE 1 END,email",(lane,)).fetchall()
 for r in rows:
  historical=continuity.historical_parent(db,r['email']) if q else None
  if r['email'] in exclusions or delivery_blocker(json.loads(r['payload']),t) or (not historical and db.execute('SELECT 1 FROM legacy WHERE email=?',(r['email'],)).fetchone()):continue
  proof=json.loads(r['proof'])
  if not proof.get('ok') or not 0<=(t-dt(proof['checkedAt'])).total_seconds()<c['proofMaxAgeDays']*86400:continue
  touches=db.execute('SELECT * FROM touches WHERE email=? ORDER BY created',(r['email'],)).fetchall()
  if historical and not db.execute("SELECT 1 FROM touches WHERE email=? AND step='followup'",(r['email'],)).fetchone():
   if db.execute('SELECT 1 FROM touches JOIN candidates ON candidates.email=touches.email WHERE candidates.account=?',(r['account'],)).fetchone():continue
   if available(r,'followup'):return r,'followup',learn
   continue
  if not touches:
   if db.execute('SELECT 1 FROM touches JOIN candidates ON candidates.email=touches.email WHERE candidates.account=?',(r['account'],)).fetchone():continue
   if available(r,'initial'):return r,'initial',learn
   continue
  initial=next((x for x in touches if x['step']=='initial'),None)
  replied=db.execute('SELECT 1 FROM replies WHERE email=?',(r['email'],)).fetchone()
  if initial and not replied and len(touches)<c['maxTouchesWithoutReply'] and business_days(dt(initial['created']),t)>=10 and available(r,'followup'):return r,'followup',learn
 return None,None,learn

def run(lane,apply=False,research_only=False,root=ROOT,c=None,gateway=None,t=None,research_batch=2,maintain=False):
 assert lane in LANES;report_id=IDS[lane]+('-maintenance' if maintain else '');c=c or contract();t=t or now();root.mkdir(parents=True,exist_ok=True)
 with (root/'campaign.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX);db=db_open(root)
  try:
   q=continuity.policy()
   if q:assert q['authorization']['campaignScopeSha256']==c['authorization']['scopeSha256'],'queue_campaign_scope_changed'
   import_reserves(db)
   historical_audit={}
   if maintain and q:
    gateway=gateway or Gateway()
    historical_audit=continuity.audit_historical(db,gateway,lane,t,suppressed(),business_days,q,observe_historical_negative)
   research_result=research(db,t,research_batch,lane) if research_batch else {}
   counts=audience_counts(db,lane,t,c)
   status='outside_business_window';sent=0;reply_count=0
   if research_only or maintain:
    if maintain:
     gateway=gateway or Gateway();recover_pending(db,gateway);reply_count=reply_scan(db,gateway,lane,t)
    key='registry_last_day_'+lane;prior=db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone()
    added=0
    coverage=continuity.coverage(db,lane,t,c,counts,q)
    refill=continuity.refill_allowed(db,lane,t,coverage['refillRequired'],q) if q else False
    if lane!='presse' and (refill if q else (not prior or prior['value']!=t.date().isoformat())):
     # Record a daily attempt before the free public API request; failures back off.
     db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,t.date().isoformat()));db.commit()
     try:added=reserve_national(db,t,lane)
     except Exception:research_result['national_registry_unavailable_backoff']=1
    discovered=(discover_company(db,t,lane=lane,retry_hours=q['discoveryRetryHours']) if q else discover_company(db,t)) if lane!='presse' else {'checked':0,'addedContacts':0}
    research_result.update(companyDiscovery=discovered,historicalThreadAudit=historical_audit)
    counts=audience_counts(db,lane,t,c)
    status='maintenance_no_send';counts['nationalCompanyReservesAdded']=added;counts['publicContactsDiscovered']=discovered['addedContacts']
   elif in_window(t,c) and apply:
    gateway=gateway or Gateway();recover_pending(db,gateway);reply_count=reply_scan(db,gateway,lane,t)
    capacity,cap=lane_capacity(db,lane,t,c);row,step,learn=next_item(db,lane,t,c)
    status='lane_cap_reached' if not capacity else 'awaiting_qualified_contact' if not row else 'prepared'
    if capacity and row:
     item=json.loads(row['payload']);item['campaignId']=IDS[lane]
     sender,version=sender_pilot.plan(db,row,step,c,t,cap)
     if not sender:raise RuntimeError('sender_capacity_changed')
     item['_sender']=sender;item['_sender_strategy_version']=version
     learn=learning(db,lane,t,c,sender,version) if c.get('senderPilot') else learn
     v=choose_variant(row['email'],learn)
     parent_row=db.execute("SELECT * FROM touches WHERE email=? AND step='initial' AND state='verified'",(row['email'],)).fetchone()
     historical_parent=continuity.historical_parent(db,row['email']) if q and parent_row is None and step!='initial' else None
     if historical_parent:parent_row={'gmail_id':historical_parent['message_id'],'subject':historical_parent['subject'],'thread':historical_parent['thread']}
     parent=gateway.get(parent_row['gmail_id']) if parent_row and step!='initial' else None
     if parent:
      from outbound_sender_guard import verify as verify_parent
      if historical_parent:
       verified=continuity.validate_parent(parent,historical_parent)
       if step=='followup' and not continuity.no_other_relationship(gateway,historical_parent,observe_historical_negative):continuity.hold(db,historical_parent,'historical_reply_or_later_touch_before_send')
      else:verified,checks=verify_parent(parent,parent_row['raw'],parent_row['thread'])
      if not verified:
       if historical_parent:continuity.hold(db,historical_parent,'original_conversation_effect_changed')
       raise RuntimeError('original_conversation_effect_changed')
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
     if c.get('senderPilot'):sender_pilot.bind(db,row,sender,version,t)
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
    'warningReasons':['historical_HDF_bounces_5_of_48_preserved','SENT_is_not_inbox_delivery','recovery_canary_one_per_lane_per_day_preserved'],
    'queueCoverage':continuity.coverage(db,lane,t,c,audience_counts(db,lane,t,c),q),'queuePolicyVersion':q['version'] if q else None,'research':research_result,'learning':learning(db,lane,t,c),'yearRound':True,'endDate':None,
    'artifacts':{'state':str(root/'campaign-state.sqlite3'),'contract':str(POLICY)},
    'systemsOfRecord':{'classification':'none','crmWrites':0,'gmailProof':'exact_SENT_message_thread_body_signature'},
    'durability':{'idempotency':'email_step_copy_version_operation','unknownEffect':'pause_and_reconcile_no_retry'},
    'senderSharedCaps':{'daily':40,'weekly':200,'hourly':6,'intervalSeconds':600},'senderPilot':c.get('senderPilot'),'senderPilotDailyUsage':sender_pilot.daily_usage(db,t) if c.get('senderPilot') else None,'authorizationScopeSha256':c['authorization']['scopeSha256'],'laneCapacity':lane_capacity(db,lane,t,c)[1]}
   save(OPS/(report_id+'-last.json'),report);save(root/(lane+('-maintenance' if maintain else '')+'-last.json'),report);return report
  except continuity.HistoricalHold as err:
   report={'generatedAt':stamp(now()),'capabilityId':report_id,'ok':True,'status':'historical_followup_held','summary':str(err),'counts':{**counts,'sentNow':0},'blockingReasons':[str(err)],'queuePolicyVersion':q['version'],'queueCoverage':continuity.coverage(db,lane,t,c,audience_counts(db,lane,t,c),q),'authorizationScopeSha256':c['authorization']['scopeSha256']}
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
