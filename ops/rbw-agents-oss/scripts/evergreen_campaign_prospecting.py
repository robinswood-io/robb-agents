from __future__ import annotations

import base64
import binascii
import hashlib
import html
import ipaddress
import json
import logging
import re
import socket
import sqlite3
from collections.abc import Callable
from datetime import datetime, timedelta
from http.client import HTTPMessage
from pathlib import Path
from typing import IO, NotRequired, Protocol, TypedDict, cast, override
from urllib import parse, request
from urllib.parse import ParseResult

import evergreen_campaign_data_types as data_types


class ProofRefreshResult(TypedDict):
 ok: bool
 reason: str
 checkedAt: str
 emailBasis: NotRequired[str]
 sources: NotRequired[list[dict[str, str]]]
 smtpVerified: NotRequired[bool]
 registryUrl: NotRequired[str]
 registrySha256: NotRequired[str]
 category: NotRequired[str]
 lane: NotRequired[str]
 employeeLowerBound: NotRequired[int]
 employeeYear: NotRequired[JsonValue]
 verifiedRole: NotRequired[str | None]
 mandateBasis: NotRequired[str | None]
 mandateSource: NotRequired[str | None]
 budgetConfirmed: NotRequired[bool]

import evergreen_queue_continuity as continuity
import scotland_executive_conference_october as transport
from evergreen_campaign_data import (
 EDITORIAL,
 EMAIL,
 EMPLOYEES,
 OPS,
 ROLE,
 cached_delivery,
 delivery_blocker,
 digest,
 norm,
 owned_domain,
 primary_mandate,
 primary_sirens,
 provider_delivery,
 put_candidate,
 stamp,
)
from evergreen_campaign_data_types import JsonObject, JsonValue

LOGGER = logging.getLogger(__name__)

def _row_text(row: sqlite3.Row, column: str) -> str:
 return data_types.data_text(data_types.data_json_value(data_types.data_cell(row, column)))

def safe_url(url: str) -> ParseResult:
 u=parse.urlparse(url)
 if u.scheme!='https' or u.username or u.password or u.port not in (None,443):raise ValueError('unsafe_source_url')
 for x in socket.getaddrinfo(u.hostname,443):
  if not ipaddress.ip_address(x[4][0]).is_global:raise ValueError('private_source_address')
 return u
class WebResponse(Protocol):
 url: str
 def read(self, amount: int = -1) -> bytes: ...
 def close(self) -> None: ...

class SafeRedirect(request.HTTPRedirectHandler):
 @override
 def redirect_request(self,req:request.Request,fp:IO[bytes],code:int,msg:str,headers:HTTPMessage,newurl:str)->request.Request|None:
  _ = safe_url(newurl);return super().redirect_request(req,fp,code,msg,headers,newurl)
def fetch(url: str) -> tuple[str,str]:
 _ = safe_url(url)
 req=request.Request(url,headers={'User-Agent':'Robinswood-Evidence-Research/1.0 (+https://robinswood.io/)'})
 response=cast(WebResponse,request.build_opener(SafeRedirect()).open(req,timeout=8))
 try:
  final=response.url;_ = safe_url(final);data=response.read(700001)
  if len(data)>700000:raise ValueError('source_too_large')
  return data.decode('utf-8',errors='replace'),final
 finally:response.close()
def published_emails(data: str) -> set[str]:
 return data_types.data_published_emails(data, EMAIL)
def public_page(url: str) -> JsonObject:
 data,final=fetch(url);text=html.unescape(re.sub('<[^>]+>',' ',re.sub(r'<(script|style)\b[^>]*>.*?</\1>',' ',data,flags=re.DOTALL|re.IGNORECASE)))
 text=re.sub(r'\s+',' ',text).strip()
 links: list[str]=[]
 for match in re.finditer(r'href=["\x27]([^"\x27]+)',html.unescape(data)):
  link=cast(object,match.group(1))
  if not isinstance(link,str):continue
  target=parse.urljoin(final,link)
  target=parse.urldefrag(target)[0];path=parse.urlparse(target).path
  relevant=re.search(r'contact|redaction|rédaction|mentions|presse|gouvernance|direction|societe|a-propos|about|company|(?:^|[-/])equipes?(?:[-/]|$)',path,re.IGNORECASE)
  asset=re.search(r'\.(css|js|json|png|jpg|jpeg|svg|woff2?|pdf)$',path,re.IGNORECASE)
  if parse.urlparse(target).hostname==parse.urlparse(final).hostname and relevant and not asset and target not in links:links.append(target)
 blocks: list[str]=[]
 for match in re.finditer(r'<(p|li|h[1-6]|td|div)\b[^>]*>(.*?)</\1>',data,re.IGNORECASE|re.DOTALL):
  body=cast(object,match.group(2))
  if not isinstance(body,str):continue
  block=re.sub(r'\s+',' ',html.unescape(re.sub('<[^>]+>',' ',body))).strip()
  if 0<len(block)<=260:blocks.append(block)
 return data_types.data_coerce_json_object({'url':final,'sha256':hashlib.sha256(data.encode()).hexdigest(),'text':text,'emails':sorted(published_emails(data)),'contactLinks':links[:3],'roleBlocks':blocks,'language':next(iter(re.findall(r'<html[^>]*lang=[\"\x27]([^\"\x27]+)',data,re.IGNORECASE)), '')})
def refresh_proof(c:JsonObject,t:datetime,fetch_page:Callable[[str],JsonObject]=public_page,get_json:Callable[[str],JsonObject]|None=None,ops:Path=OPS)->ProofRefreshResult:
 lane=data_types.data_text(c.get('lane'));email=data_types.data_text(c.get('email'));domain=data_types.data_text(c.get('domain'));source_urls=[data_types.data_text(value) for value in data_types.data_json_array(c.get('sourceUrls'))]
 if lane!='presse' and transport.GENERIC.match(email):return {'ok':False,'reason':'generic_mailbox_does_not_bind_executive','checkedAt':stamp(t)}
 bad=delivery_blocker(c,t,ops)
 if bad:return {'ok':False,'reason':bad,'checkedAt':stamp(t)}
 pages: list[JsonObject]=[]
 for u in source_urls[:3]:
  if not owned_domain(u,domain):continue
  try:
   page=fetch_page(u)
   if owned_domain(data_types.data_text(page.get('url')),domain):pages.append(page)
  except (OSError, ValueError, TypeError, KeyError, UnicodeError) as error:LOGGER.debug("external source unavailable: %s", error)
 if pages:
  for u in [data_types.data_text(value) for value in data_types.data_json_array(pages[0].get('contactLinks'))][:3]:
   if u in {data_types.data_text(p.get('url')) for p in pages}:continue
   if not owned_domain(u,domain):continue
   try:
    page=fetch_page(u)
    if owned_domain(data_types.data_text(page.get('url')),domain):pages.append(page)
   except (OSError, ValueError, TypeError, KeyError, UnicodeError) as error:LOGGER.debug("external source unavailable: %s", error)
 if not pages:return {'ok':False,'reason':'primary_sources_unavailable','checkedAt':stamp(t)}
 literal=any(email in {x.lower() for x in [data_types.data_text(value) for value in data_types.data_json_array(p.get('emails'))]} and owned_domain(data_types.data_text(p.get('url')),domain) for p in pages)
 if literal:
  try:
   mx=data_types.data_parse_json_object(fetch('https://dns.google/resolve?'+parse.urlencode({'name':domain,'type':'MX'}))[0])
   if not any(data_types.data_integer(a.get('type'))==15 and data_types.data_text(a.get('data')).split()[-1]!='.' for a in data_types.data_json_objects(mx.get('Answer'))):literal=False
  except (OSError, ValueError, TypeError, KeyError, UnicodeError):literal=False
 if not literal and not (cached_delivery(email,t,ops) or provider_delivery(c,t)):return {'ok':False,'reason':'fresh_exact_email_or_valid_non_catchall_proof_missing','checkedAt':stamp(t)}
 text=norm(' '.join(data_types.data_text(p.get('text')) for p in pages));proof:ProofRefreshResult={'checkedAt':stamp(t),'ok':False,'reason':'','emailBasis':'primary_public_exact_email' if literal else 'fresh_valid_non_catchall_cache',
 'sources':[{'url':data_types.data_text(p.get('url')),'sha256':data_types.data_text(p.get('sha256'))} for p in pages], 'smtpVerified':cached_delivery(email,t,ops) or provider_delivery(c,t)}
 if lane=='presse':
  editorial=bool(EDITORIAL.match(email)) or bool(data_types.data_text(c.get('name')) and norm(data_types.data_text(c.get('name'))) in text and ROLE.search(text)) or (c.get('segment')=='podcast' and email.startswith('contact@') and 'podcast' in text)
  fit=data_types.data_number(c.get('fitScore'))>=72 and any(w in text for w in ['entrepris','econom','business','dirigeant','pme','eti','industrie','technolog','innovation','intelligence artificielle'])
  french=any(data_types.data_text(p.get('language')).lower().startswith('fr') for p in pages)
  if not french:french=sum(w in text for w in [' les ',' des ',' pour ',' dans ',' une '])>=4
  proof['ok']=editorial and fit and french
  proof['reason']='qualified_editorial_primary_source' if editorial and fit and french else 'editorial_primary_source_unproven'
 else:
  siren_text=data_types.data_text(c.get('siren'));sirens=[siren_text] if siren_text else primary_sirens(pages)
  if not sirens:
    proof['ok']=False;proof['reason']='siren_missing'
    return proof
  words=[w for w in norm(data_types.data_text(c.get('company'))).split() if len(w)>=3 and w not in ['sas','sarl','societe','societes','sa']]
  rows: list[tuple[JsonObject,str]]=[];registry_failed=False
  for siren in sirens:
   url='https://recherche-entreprises.api.gouv.fr/search?'+parse.urlencode({'q':siren})
   d:JsonObject={}
   try:d=get_json(url) if get_json else data_types.data_parse_json_object(fetch(url)[0])
   except (OSError, ValueError, TypeError, KeyError, UnicodeError) as error:
    registry_failed=True;LOGGER.debug('national registry lookup failed: %s', error);d={}
   row=next((x for x in data_types.data_json_objects(d.get('results')) if data_types.data_text(x.get('siren'))==siren),data_types.data_coerce_json_object({}))
   if row and words and all(w in norm(data_types.data_text(row.get('nom_complet'))) and w in text for w in words) and siren in primary_sirens(pages):rows.append((row,url))
  if len(rows)!=1:return {**proof,'ok':False,'reason':'registry_unavailable' if not rows and registry_failed else 'primary_company_identity_ambiguous_or_unproven'}
  row,url=rows[0];c['siren']=row['siren']
  lower=EMPLOYEES.get(data_types.data_text(row.get('tranche_effectif_salarie')),0)
  name=norm(data_types.data_text(c.get('name'))).split();leaders=data_types.data_json_objects(row.get('dirigeants'))
  role=next((x for x in leaders if name and name[-1] in norm(data_types.data_text(x.get('nom'))).split() and name[0] in norm(data_types.data_text(x.get('prenoms'))).split() and ROLE.search(data_types.data_text(x.get('qualite')))),None)
  if not role:role=primary_mandate(pages,data_types.data_text(c.get('name')))
  matched_domain=data_types.data_text(row.get('siren')) in primary_sirens(pages)
  category=data_types.data_text(row.get('categorie_entreprise'));lane='eti' if category=='ETI' else 'pme'
  individual=name and name[0] in text and name[-1] in text
  seat=data_types.data_json_object_or_empty(row.get('siege'));capacity=bool(individual) and data_types.data_text(row.get('statut_diffusion'))=='O' and category in ['PME','ETI'] and lower>=50 and data_types.data_text(row.get('etat_administratif'))=='A' and not seat.get('code_pays_etranger') and data_types.data_integer(row.get('annee_tranche_effectif_salarie'))>=t.year-3
  proof['ok']=bool(role and matched_domain and capacity)
  proof['reason']='qualified_registry_and_exact_email' if role and matched_domain and capacity else 'company_identity_capacity_or_mandate_unproven'
  proof['registryUrl']=url;proof['registrySha256']=digest(row);proof['category']=category;proof['lane']=lane
  proof['employeeLowerBound']=lower;proof['employeeYear']=row.get('annee_tranche_effectif_salarie')
  proof['verifiedRole']=data_types.data_text(role.get('qualite')) if role else None
  proof['mandateBasis']=data_types.data_text(role.get('basis')) if role else None
  proof['mandateSource']=data_types.data_text(role.get('sourceUrl')) if role else None
  proof['budgetConfirmed']=bool(c.get('budgetConfirmed'))
 return proof
def research(db: sqlite3.Connection, t: datetime, batch: int = 4, lane: str | None = None) -> dict[str, int]:
 policy = continuity.policy()
 failed_retry = data_types.data_integer(policy.get('failedProofRetryHours')) if policy else 168
 rows = data_types.data_sqlite_rows(cast(object, db.execute(
  "SELECT * FROM candidates WHERE (checked IS NULL OR checked<? OR (? AND COALESCE(json_extract(proof,'$.ok'),0)=0 AND checked<?)) AND (? IS NULL OR lane=?) ORDER BY checked LIMIT ?",
  (stamp(t-timedelta(days=7)), bool(policy), stamp(t-timedelta(hours=failed_retry)), lane, lane, batch),
 ).fetchall()))
 counts: dict[str, int] = {}
 for row in rows:
  candidate = data_types.data_parse_json_object(_row_text(row, 'payload'))
  proof = refresh_proof(candidate, t)
  candidate_lane = data_types.data_text(proof.get('lane')) or _row_text(row, 'lane')
  candidate['lane'] = candidate_lane
  reason = data_types.data_text(proof.get('reason'))
  _ = db.execute(
   'UPDATE candidates SET lane=?,account=?,payload=?,proof=?,checked=?,reason=? WHERE email=?',
   (candidate_lane, data_types.data_text(candidate.get('siren')) or None, json.dumps(candidate, ensure_ascii=False), json.dumps(proof, ensure_ascii=False), stamp(t), reason, _row_text(row, 'email')),
  )
  counts[reason] = counts.get(reason, 0) + 1
 db.commit()
 return counts

def reserve_national(db: sqlite3.Connection, t: datetime, lane: str) -> int:
 # INSEE/RNE company reserve is separate from qualified contacts, and includes all France.
 key = 'registry_page_' + lane
 old = data_types.data_sqlite_row(cast(object, db.execute('SELECT value FROM metadata WHERE key=?', (key,)).fetchone()))
 page = int(_row_text(old, 'value')) if old else 1
 url = 'https://recherche-entreprises.api.gouv.fr/search?' + parse.urlencode({'categorie_entreprise': 'ETI' if lane == 'eti' else 'PME', 'etat_administratif': 'A', 'statut_diffusion': 'O', 'tranche_effectif_salarie': '21,22,31,32,41,42,51', 'per_page': 25, 'page': page})
 data = data_types.data_parse_json_object(fetch(url)[0])
 added = 0
 for company in data_types.data_json_objects(data.get('results')):
  legal_form = data_types.data_text(company.get('nature_juridique'))
  category = data_types.data_text(company.get('categorie_entreprise'))
  if not legal_form.startswith(('5', '6')) or data_types.data_text(company.get('statut_diffusion')) != 'O' or category != ('ETI' if lane == 'eti' else 'PME'):
   continue
  public: JsonObject = {key: company.get(key) for key in ['siren', 'nom_complet', 'tranche_effectif_salarie', 'annee_tranche_effectif_salarie', 'categorie_entreprise', 'nature_juridique', 'statut_diffusion']}
  public['leaders'] = [{key: leader.get(key) for key in ['nom', 'prenoms', 'qualite']} for leader in data_types.data_json_objects(company.get('dirigeants')) if ROLE.search(data_types.data_text(leader.get('qualite')))]
  if not data_types.data_json_array(public.get('leaders')):
   continue
  public['sourceUrl'] = url
  before = db.total_changes
  _ = db.execute('INSERT OR IGNORE INTO research VALUES(?,?,?,?)', (data_types.data_text(company.get('siren')), json.dumps(public, ensure_ascii=False), stamp(t), 'needs_official_domain'))
  added += db.total_changes - before
 total_pages = data_types.data_integer(data.get('total_pages')) or 1
 _ = db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (key, str(page + 1 if page < total_pages else 1)))
 db.commit()
 return added

def discover_company(db: sqlite3.Connection, t: datetime, fetch_page: Callable[[str], JsonObject] = public_page, lane: str | None = None, retry_hours: int = 168) -> JsonObject:
 row = data_types.data_sqlite_row(cast(object, db.execute(
  "SELECT * FROM research WHERE (? IS NULL OR json_extract(payload,'$.categorie_entreprise')=?) AND (checked IS NULL OR checked<?) ORDER BY checked LIMIT 1",
  (lane, 'PME' if lane == 'pme' else 'ETI', stamp(t-timedelta(hours=retry_hours))),
 ).fetchone()))
 if row is None:
  return {'checked': 0, 'addedContacts': 0}
 siren = _row_text(row, 'siren')
 item = data_types.data_parse_json_object(_row_text(row, 'payload'))
 name = data_types.data_text(item.get('nom_complet'))
 query = name + ' ' + siren + ' site officiel'
 added = 0
 reason = 'official_domain_or_public_executive_email_not_found'
 try:
  policy = continuity.policy()
  if policy:
   source_url = data_types.data_text(item.get('sourceUrl'))
   origin = parse.urlparse(source_url)
   allowed = {'categorie_entreprise', 'etat_administratif', 'statut_diffusion', 'tranche_effectif_salarie', 'per_page', 'page'}
   if origin.scheme != 'https' or origin.hostname != 'recherche-entreprises.api.gouv.fr' or origin.path != '/search' or not set(parse.parse_qs(origin.query)) <= allowed:
    raise ValueError('public_registry_origin_unproven')
   public_data = data_types.data_parse_json_object(fetch(source_url)[0])
   public_company = next(company for company in data_types.data_json_objects(public_data.get('results')) if data_types.data_text(company.get('siren')) == siren)
   query = '"' + data_types.data_text(public_company.get('nom_complet')) + '" site officiel'
  search_data, _ = fetch('https://www.bing.com/search?' + parse.urlencode({'q': query}))
  urls: list[str] = []
  for match in re.finditer(r'href=["\x27](https://[^"\x27]+)', html.unescape(search_data)):
   raw = cast(object, match.group(1))
   if not isinstance(raw, str):
    continue
   initial = parse.urlparse(raw)
   if initial.hostname and initial.hostname.endswith('bing.com') and initial.path.startswith('/ck/a'):
    encoded = parse.parse_qs(initial.query).get('u', [''])[0]
    if encoded.startswith('a1'):
     try:
      raw = base64.urlsafe_b64decode(encoded[2:] + '=' * (-len(encoded[2:]) % 4)).decode()
     except (ValueError, UnicodeError, binascii.Error) as error:
      LOGGER.debug('search result URL could not be decoded: %s', error)
   host = (parse.urlparse(raw).hostname or '').lower()
   if any(host == excluded or host.endswith('.' + excluded) for excluded in ['bing.com', 'microsoft.com', 'google.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'youtube.com', 'wikipedia.org']):
    continue
   origin_url = 'https://' + host + '/'
   if origin_url not in urls:
    urls.append(origin_url)
  for origin_url in urls[:5]:
   pages: list[JsonObject] = []
   for suffix in ['', 'mentions-legales/', 'contact/']:
    try:
     pages.append(fetch_page(origin_url + suffix))
    except (OSError, ValueError, TypeError, KeyError, UnicodeError) as error:
     LOGGER.debug('external source unavailable: %s', error)
   if siren not in primary_sirens(pages):
    continue
   domain = (parse.urlparse(origin_url).hostname or '').removeprefix('www.')
   links = list(dict.fromkeys(data_types.data_text(link) for page in pages for link in data_types.data_json_array(page.get('contactLinks'))))[:3]
   for link in links:
    if len(pages) >= 6:
     break
    try:
     pages.append(fetch_page(link))
    except (OSError, ValueError, TypeError, KeyError, UnicodeError) as error:
     LOGGER.debug('external source unavailable: %s', error)
   for leader in data_types.data_json_objects(item.get('leaders')):
    last = norm(data_types.data_text(leader.get('nom'))).replace(' ', '')
    first = norm(data_types.data_text(leader.get('prenoms'))).split()
    if not last or not first:
     continue
    emails = {data_types.data_text(value).lower() for page in pages for value in data_types.data_json_array(page.get('emails'))}
    for email in emails:
     local, separator, host = email.partition('@')
     if not separator or host.removeprefix('www.') != domain or last not in norm(local).replace('.', '').replace('-', ''):
      continue
     contact: JsonObject = data_types.data_coerce_json_object({
      'email': email, 'name': data_types.data_text(leader.get('prenoms')) + ' ' + data_types.data_text(leader.get('nom')),
      'company': name, 'siren': siren, 'domain': domain,
      'lane': 'eti' if data_types.data_text(item.get('categorie_entreprise')) == 'ETI' else 'pme',
      'sourceUrls': [data_types.data_text(page.get('url')) for page in pages],
      'topic': 'les validations, les documents et le passage entre équipes',
     })
     before = db.total_changes
     put_candidate(db, contact)
     added += db.total_changes - before
   if added:
    reason = 'public_exact_contacts_discovered'
    break
 except (OSError, ValueError, TypeError, KeyError, UnicodeError, binascii.Error):
  reason = 'public_discovery_unavailable_backoff'
 _ = db.execute('UPDATE research SET checked=?,reason=? WHERE siren=?', (stamp(t), reason, siren))
 db.commit()
 return {'checked': 1, 'addedContacts': added, 'reason': reason}
