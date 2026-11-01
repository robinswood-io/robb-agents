from __future__ import annotations

import fcntl
import hashlib
import json
import re
import sqlite3
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import cast
from urllib import parse
from zoneinfo import ZoneInfo

import evergreen_campaign_data_types as data_types

CampaignDraft = data_types.CampaignDraft
CampaignRunResult = data_types.CampaignRunResult
campaign_run_result = data_types.campaign_run_result
dt = data_types.dt
norm = data_types.norm
now = data_types.now
stamp = data_types.stamp
import evergreen_queue_continuity as continuity
import evergreen_sender_pilot as sender_pilot
import scotland_executive_conference_october as transport
from pydantic import JsonValue

WS=Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
OPS=WS/'campaigns/ops'
ROOT=OPS/'product-campaigns/robinswood-evergreen-france'
POLICY=Path('/srv/rbw-agents-oss/config/robinswood-evergreen-france.json')

LANES=('presse','pme','eti')

IDS={x:'robinswood-evergreen-france-'+x for x in LANES}

ROLE: re.Pattern[str] = re.compile(r'présiden|presiden|directeur|directrice|gérant|gerant|chief|ceo|rédact|redact|journalist',re.IGNORECASE)

EMAIL: re.Pattern[str] = re.compile(r'[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}',re.IGNORECASE)

EDITORIAL: re.Pattern[str] = re.compile(r'^(redaction|rédaction|editorial|editor|newsroom|presse|press|tips|tribune|podcast)@',re.IGNORECASE)

EMPLOYEES={'21':50,'22':100,'31':200,'32':250,'41':500,'42':1000,'51':2000}

def read(p: str | Path, default: JsonValue | None = None) -> JsonValue:
 try: return data_types.JSON_ADAPTER.validate_json(Path(p).read_text())
 except FileNotFoundError: return {} if default is None else default

def save(p: str | Path, obj: object) -> None:transport.save(p,data_types.data_coerce_json_object(obj))

def digest(obj: data_types.JsonObject) -> str:return transport.digest(obj)

def contract(path: str | Path = POLICY) -> data_types.JsonObject:
 c = data_types.data_json_object(read(path))
 authorization = data_types.data_json_object(c.get('authorization'))
 assert authorization.get('source') == 'human_evergreen_campaign_request_2026-10-02', 'missing_human_authorization'
 assert authorization.get('scopeSha256') == digest({key: value for key, value in c.items() if key != 'authorization'}), 'contract_scope_changed'
 assert c.get('sender') == 'thibault@robinswood.io' and c.get('timezone') == 'Europe/Paris'
 assert c.get('paidAllowed') is False and c.get('crmWriteAllowed') is False and c.get('linkedinWriteAllowed') is False
 assert c.get('lanes') == {'presse': {'dailyMax': 5, 'weeklyMax': 20}, 'pme': {'dailyMax': 3, 'weeklyMax': 10}, 'eti': {'dailyMax': 2, 'weeklyMax': 10}}
 assert c.get('canaryDailyMax') == 1 and c.get('maxTouchesWithoutReply') == 2
 assert c.get('windows') == [['09:00', '12:00'], ['14:00', '18:00']] and c.get('minimumIntervalSeconds') == 600
 assert c.get('proofMaxAgeDays') == 7 and c.get('copyVersion') == '2026-10-02.2'
 assert c.get('autoRecovery') == {'cooldownDays': 7, 'minimumFreshSmtpContacts': 3, 'complaintRecoveryAllowed': False, 'capAfterRecovery': 1}
 ramp_value = c.get('postScotlandRamp')
 if ramp_value:
  ramp = data_types.data_json_object(ramp_value)
  assert ramp.get('authorizationSource') == 'human_post_scotland_daily_ramp_request_2026-10-04' and ramp.get('approvedBy') == 'Thibault'
  assert ramp.get('scope') == 'combined_french_portfolio_including_replies_and_followups'
  assert ramp.get('predecessorCampaignId') == 'scotland-executive-conference-october-2026'
  assert (ramp.get('dailyMax'), ramp.get('weeklyMax'), ramp.get('steadyDailyMax'), ramp.get('steadyWeeklyMax')) == (20, 100, 30, 150)
  assert ramp.get('laneDailyMax') == {'presse': 4, 'pme': 10, 'eti': 6}
  change_value = ramp.get('allocationChange')
  expected: data_types.JsonObject = {'presse': 6, 'pme': 15, 'eti': 9}
  if change_value:
   change = data_types.data_json_object(change_value)
   assert change.get('source') == 'human_post_scotland_daily30_press10_request_2026-10-04' and change.get('approvedBy') == 'Thibault'
   assert change.get('scope') == 'target_30_total_press_10_prospecting_20'
   assert change.get('previousSteadyLaneDailyMax') == expected
   previous = data_types.data_coerce_json_object({key: value for key, value in c.items() if key not in ['authorization', 'senderPilot']})
   ramp_previous = data_types.data_coerce_json_object({key: value for key, value in ramp.items() if key != 'allocationChange'})
   ramp_previous['steadyLaneDailyMax'] = data_types.data_coerce_json_object(expected)
   previous['postScotlandRamp'] = ramp_previous
   assert digest(previous) == change.get('previousScopeSha256'), 'allocation_prior_scope_changed'
   expected = {'presse': 10, 'pme': 12, 'eti': 8}
  assert ramp.get('steadyLaneDailyMax') == expected
  assert (ramp.get('healthyCompletedBusinessDays'), ramp.get('minimumVerifiedEffectsPerHealthyDay')) == (5, 10)
  for key in ['requireCurrentPredecessorContractExpiry', 'requireNoUnknownEffects', 'preserveRecoveryCanary']:
   assert ramp.get(key) is True
 sender_pilot.verify_contract(c, digest)
 return c

def in_window(t: datetime, c: data_types.JsonObject) -> bool:
 zone = ZoneInfo(data_types.data_text(c.get('timezone')))
 local = t.astimezone(zone)
 clock = local.strftime('%H:%M')
 windows = data_types.data_json_array(c.get('windows'))
 if local.weekday() >= 5: return False
 for window in windows:
  if not isinstance(window, list) or len(window) != 2: continue
  start, end = window
  if isinstance(start, str) and isinstance(end, str) and start <= clock < end: return True
 return False

def db_open(root: Path) -> sqlite3.Connection:
 root.mkdir(parents=True,exist_ok=True);db=sqlite3.connect(root/'campaign-state.sqlite3');db.row_factory=sqlite3.Row
 _ = db.executescript("""
 CREATE TABLE IF NOT EXISTS candidates(email TEXT PRIMARY KEY,lane TEXT,account TEXT,payload TEXT,proof TEXT,checked TEXT,reason TEXT);
 CREATE TABLE IF NOT EXISTS touches(operation TEXT PRIMARY KEY,email TEXT,lane TEXT,step TEXT,variant TEXT,copy_version TEXT,created TEXT,state TEXT,raw TEXT,expected TEXT,subject TEXT,gmail_id TEXT,thread TEXT,checks TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS touch_unique ON touches(email,step);
 CREATE TABLE IF NOT EXISTS replies(message_id TEXT PRIMARY KEY,email TEXT,lane TEXT,kind TEXT,observed TEXT,evidence TEXT);
 CREATE TABLE IF NOT EXISTS legacy(email TEXT PRIMARY KEY,campaign TEXT,message_id TEXT,subject TEXT,state TEXT);
 CREATE TABLE IF NOT EXISTS research(siren TEXT PRIMARY KEY,payload TEXT,checked TEXT,reason TEXT);
 CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);
 """);db.commit();sender_pilot.ensure_schema(db,root);continuity.ensure_schema(db,root);return db

def suppressed(root: Path = OPS.parent) -> set[str]:
 obj = data_types.data_json_object(read(root / 'contact-suppression.json'))
 out: set[str] = set()
 for key in ['records', 'blockedRecipients', 'items']:
  for value in data_types.data_json_array(obj.get(key)):
   if not isinstance(value, dict): continue
   record = data_types.data_json_object(value)
   active = record.get('active')
   if active is not False and (active is True or record.get('status') in ['do_not_contact', 'unsubscribed', 'complaint', 'bounced', 'legal_hold']):
    email = data_types.data_text(record.get('email') or record.get('value')).lower()
    out.add(email)
 return out

def suppress(email: str, kind: str, message_id: str, path: Path | None = None) -> None:
 path = path or OPS.parent / 'contact-suppression.json'
 with path.with_suffix('.lock').open('a') as lock:
  fcntl.flock(lock, fcntl.LOCK_EX)
  obj = data_types.data_json_object(read(path))
  if email not in suppressed(path.parent):
   records = data_types.data_json_array(obj.get('records'))
   records.append(data_types.data_coerce_json_object({'email': email, 'active': True, 'status': 'do_not_contact', 'reason': kind, 'source': 'evergreen-reply', 'messageId': message_id, 'observedAt': data_types.stamp(data_types.now())}))
   obj['records'] = records
   obj['updatedAt'] = data_types.stamp(data_types.now())
   save(path, obj)

def append_legacy(db: sqlite3.Connection, row: data_types.JsonObject) -> None:
 email = data_types.data_text(row.get('email') or row.get('recipientEmail')).lower()
 if email:
  _ = db.execute(
   'INSERT OR IGNORE INTO legacy VALUES(?,?,?,?,?)',
   (email, data_types.data_text(row.get('campaignId'), 'legacy'), data_types.data_text(row.get('message_id') or row.get('gmailMessageId') or row.get('gmail_id')), data_types.data_text(row.get('subject')), data_types.data_text(row.get('status'), 'legacy')),
  )

def import_reserves(db: sqlite3.Connection, ops: Path = OPS, cfg: Path | None = None) -> None:
 cfg = cfg or Path('/srv/rbw-agents-oss/config')
 for name in ['robinswood-media-authority-2026-ledger.jsonl', 'robinswood-pme-hdf-audited-mailer-ledger.jsonl', 'robinswood-pme-hdf-audited-dispatch-ledger.jsonl', 'robinswood-flow-email-ledger.jsonl']:
  path = ops / name
  if path.exists():
   for line in path.read_text().splitlines():
    row = data_types.data_parse_json_object(line)
    if row.get('status') in []:
     append_legacy(db, row)
 for row in data_types.data_json_objects(data_types.data_json_object(read(ops.parent / 'press-campaign-database.json')).get('contacts')):
  append_legacy(db, data_types.data_coerce_json_object({**row, 'status': 'operator_hold'}))
 seeds = data_types.data_json_objects(data_types.data_json_object(read(ops / 'robinswood-pme-hdf-full-seed-2026-06-18.json')).get('items'))
 by_name = {data_types.norm(row.get('companyName')): row for row in seeds}
 drafts = data_types.data_json_objects(data_types.data_json_object(read(ops / 'robinswood-pme-hdf-email-drafts-prepare-only-latest.json')).get('drafts'))
 for draft in drafts:
  email = data_types.data_text(draft.get('recipientEmail')).lower()
  seed = by_name.get(data_types.norm(draft.get('companyName')), {})
  if not EMAIL.fullmatch(email): continue
  profile = data_types.data_json_object_or_empty(draft.get('profileControl'))
  context = data_types.data_json_object_or_empty(profile.get('contextStrength'))
  candidate = data_types.data_coerce_json_object({
   'email': email, 'name': draft.get('recipientName', ''), 'company': draft.get('companyName', ''), 'siren': seed.get('siren'),
   'domain': email.split('@')[1], 'lane': 'pme', 'sourceUrls': ['https://' + email.split('@')[1] + '/', 'https://' + email.split('@')[1] + '/mentions-legales/', 'https://www.pappers.fr/'],
   'discoverySource': 'audited_hdf_reserve', 'topic': context.get('synthesizedAngle', ''),
  })
  lower = EMPLOYEES.get(str(seed.get('tranche_effectif_salarie')), 0)
  candidate['lane'] = 'eti' if str(seed.get('employeeRange', '')).startswith(('250', '500', '1000', '2000')) or lower >= 250 else 'pme'
  put_candidate(db, candidate)
 seed_value = read(cfg / 'oss-media-authority-seeds.json')
 if isinstance(seed_value, list):
  media_seeds = data_types.data_json_objects(seed_value)
 else:
  media_seed_object = data_types.data_json_object(seed_value)
  media_seeds = data_types.data_json_objects(media_seed_object.get('items') or media_seed_object.get('seeds'))
 for item in media_seeds:
  if item.get('language') not in (None, 'fr', 'fr-FR'): continue
  email = data_types.data_text(item.get('email')).lower()
  url = data_types.data_text(item.get('sourceUrl'))
  if not EMAIL.fullmatch(email) or not url: continue
  domain = email.split('@')[1]
  primary = url if url.startswith('https://') and (parse.urlparse(url).hostname or '').removeprefix('www.') == domain.removeprefix('www.') else 'https://' + domain + '/'
  put_candidate(db, data_types.data_coerce_json_object({
   'email': email, 'name': item.get('contactName', ''), 'company': item.get('media', ''), 'lane': 'presse', 'domain': domain,
   'sourceUrls': [primary], 'discoverySource': url, 'topic': item.get('angle', ''), 'fitScore': item.get('fitScore', 0), 'segment': 'journalist',
  }))
 for contact in data_types.data_json_objects(data_types.data_json_object(read(cfg / 'robinswood-evergreen-france-primary-seeds.json')).get('contacts')):
  if contact.get('lane') == 'presse' and EMAIL.fullmatch(data_types.data_text(contact.get('email'))) and contact.get('domain') and contact.get('sourceUrls') and not contact.get('legacyPrStatus'):
   put_candidate(db, contact)
 for item in data_types.data_json_objects(data_types.data_json_object(read(ops / 'robinswood-media-contact-base-2026-enriched.json')).get('contacts')):
  email = data_types.data_text(item.get('email') or item.get('enrichedEmail')).lower()
  if item.get('country') != 'FR' or item.get('countryConfidence') == 'medium_francophone' or not EMAIL.fullmatch(email): continue
  if item.get('legacyPrStatus') or item.get('suppressionStatus') or data_types.data_text(item.get('outreachStatus')).startswith('not_eligible'): continue
  domain = email.split('@')[1]
  url = data_types.data_text(item.get('sourceUrl'))
  source_url = url if url.startswith('https://') and (parse.urlparse(url).hostname or '').removeprefix('www.') == domain.removeprefix('www.') else 'https://' + domain + '/'
  put_candidate(db, data_types.data_coerce_json_object({
   'email': email, 'name': item.get('contactName', ''), 'company': item.get('media', ''), 'lane': 'presse', 'domain': domain,
   'sourceUrls': [source_url], 'discoverySource': item.get('sourceUrl', ''), 'topic': 'IA et décisions des dirigeants PME/ETI',
   'fitScore': item.get('qualityScore', 0), 'segment': 'journalist', 'emailVerification': item.get('emailVerification'),
  }))
 db.commit()

def put_candidate(db: sqlite3.Connection, c: data_types.JsonObject) -> None:
 lane = data_types.data_text(c.get('lane'))
 if lane not in LANES: return
 account = data_types.data_text(c.get('siren')) or data_types.data_text(c.get('company')).lower() or data_types.data_text(c.get('domain'))
 email = data_types.data_text(c.get('email'))
 existing = data_types.data_sqlite_row(cast(object, db.execute('SELECT payload FROM candidates WHERE email=?', (email,)).fetchone()))
 if existing:
  raw_payload = data_types.data_cell(existing, 'payload')
  old = data_types.data_parse_json_object(str(raw_payload))
  if old.get('name') != c.get('name') or old.get('company') != c.get('company'): return
  old_urls = data_types.data_json_array(old.get('sourceUrls'))
  old_url = data_types.data_text(old_urls[0]) if old_urls else ''
  new_urls = data_types.data_json_array(c.get('sourceUrls'))
  repaired = bool(old_urls and not old_url.startswith('https://') and new_urls and data_types.data_text(new_urls[0]).startswith('https://'))
  verification = c.get('emailVerification')
  if repaired or (verification and verification != old.get('emailVerification')):
   if repaired:
    old['sourceUrls'] = new_urls
    old['discoverySource'] = c.get('discoverySource')
   if verification: old['emailVerification'] = verification
   _ = db.execute('UPDATE candidates SET payload=?,checked=NULL,proof=NULL,reason=? WHERE email=?', (json.dumps(old, ensure_ascii=False), 'candidate_repaired_or_reverified', email))
 else:
  _ = db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?,?)', (email, lane, account, json.dumps(c, ensure_ascii=False), None, None, None))

def cached_delivery(email: str, t: datetime, ops: Path = OPS) -> bool:
 obj = data_types.data_json_object(read(ops / 'contact-quality-verification-cache.json'))
 items = data_types.data_json_object_or_empty(obj.get('items'))
 verification_record = data_types.data_json_object_or_empty(items.get(hashlib.sha256(email.encode()).hexdigest()))
 verification = data_types.data_json_object_or_empty(verification_record.get('verification'))
 updated = verification_record.get('updatedAt')
 return bool(updated and 0 <= (t - data_types.dt(data_types.data_text(updated))).total_seconds() < 7 * 86400 and verification.get('result') in ['deliverable', 'valid'] and verification.get('smtp_check') is True and verification.get('accept_all') is False and verification.get('block') is False)

def provider_delivery(c: data_types.JsonObject, t: datetime) -> bool:
 verification = data_types.data_json_object_or_empty(c.get('emailVerification'))
 checked = verification.get('checkedAt')
 return bool(checked and 0 <= (t - data_types.dt(data_types.data_text(checked))).total_seconds() < 7 * 86400 and verification.get('provider') == 'hunter' and verification.get('statusCode') == 200 and verification.get('result') in ['deliverable', 'valid'] and data_types.data_integer(verification.get('score')) >= 95 and verification.get('smtpCheck') is True and verification.get('acceptAll') is False and verification.get('block') is False)

def delivery_blocker(c: data_types.JsonObject, t: datetime, ops: Path = OPS) -> str | None:
 obj = data_types.data_json_object(read(ops / 'contact-quality-verification-cache.json'))
 items = data_types.data_json_object_or_empty(obj.get('items'))
 cached = data_types.data_json_object_or_empty(items.get(hashlib.sha256(data_types.data_text(c.get('email')).encode()).hexdigest()))
 cached_verification = data_types.data_json_object_or_empty(cached.get('verification'))
 candidate_verification = data_types.data_json_object_or_empty(c.get('emailVerification'))
 evidence = [(cached.get('updatedAt'), cached_verification), (candidate_verification.get('checkedAt'), candidate_verification)]
 for checked, verification in evidence:
  if checked and 0 <= (t - data_types.dt(data_types.data_text(checked))).total_seconds() < 30 * 86400 and (verification.get('result') in ['risky', 'undeliverable'] or verification.get('accept_all') is True or verification.get('acceptAll') is True):
   return 'recent_adverse_delivery_evidence'
 return None

def owned_domain(url: str, domain: str) -> bool:
 host=(parse.urlparse(url).hostname or '').lower().removeprefix('www.')
 domain=domain.lower().removeprefix('www.')
 return host==domain or host.endswith('.'+domain)

def primary_mandate(pages: list[data_types.JsonObject], name: str) -> data_types.JsonObject | None:
 tokens = data_types.norm(name).split()
 if len(tokens) < 2: return None
 fullname = r'\s+'.join(re.escape(token) for token in tokens)
 role = r'(?:president(?:e)?|direct(?:eur|rice)(?:\s+general[e]?)?|ceo|chief executive officer|gerant(?:e)?)'
 pattern = re.compile(r'(?:' + fullname + r'\W{0,12}(?:notre\s+|est\s+|le\s+|la\s+)?(?P<after>' + role + r')|(?P<before>' + role + r')\W{0,12}' + fullname + r')', re.IGNORECASE)
 for raw_page in pages:
  url = data_types.data_text(raw_page.get('url'))
  path = data_types.norm(parse.urlparse(url).path)
  blocks = data_types.data_json_array(raw_page.get('roleBlocks'))
  if not re.search(r'societe|a-propos|about|company|groupe|equipe|team|gouvernance|direction|mentions', path) or re.search(r'blog|actualites|communique', path): continue
  for raw_block in blocks:
   if not isinstance(raw_block, str): continue
   text = data_types.norm(raw_block)
   if re.search(r'\bancien|\bancienne|\bex-|jusqu|etait|historique', text): continue
   match = pattern.search(text)
   if match:
    return data_types.data_coerce_json_object({'qualite': match['after'] or match['before'], 'sourceUrl': url, 'sourceSha256': data_types.data_text(raw_page.get('sha256')), 'basis': 'primary_company_professional_mandate'})
 return None

def primary_sirens(pages: list[data_types.JsonObject]) -> list[str]:
 values: list[str] = []
 for page in pages:
  text = data_types.data_text(page.get('text'))
  for match in re.finditer(r'\b(?:SIREN|SIRET|RCS)\b', text, re.IGNORECASE):
   tail = text[match.end():match.end() + 80]
   number = re.search(r'(?<!\d)(\d(?:[\s.]*\d){13}|\d(?:[\s.]*\d){8})(?!\d)', tail)
   if number:
    digits = re.sub(r'\D', '', number[1])
    siren = digits[:9]
    if siren not in values: values.append(siren)
 return values[:3]

def business_days(a: datetime, b: datetime) -> int:
 return data_types.business_days(a, b)

def learning(db: sqlite3.Connection, lane: str, t: datetime, c: data_types.JsonObject, sender: str | None = None, strategy: str | None = None) -> data_types.JsonObject:
 out: dict[str, JsonValue] = {}
 for variant in ['A', 'B']:
  rows: list[sqlite3.Row] = data_types.data_sqlite_rows(cast(object, db.execute("SELECT * FROM touches WHERE lane=? AND step='initial' AND state='verified' AND variant=? AND copy_version=?", (lane, variant, c.get('copyVersion'))).fetchall()))
  if sender is not None:
   matched: list[sqlite3.Row] = []
   for row in rows:
    try:
     identity = sender_pilot.touch_identity(row)
    except (KeyError, RuntimeError, TypeError, ValueError):
     continue
    if identity == (sender, strategy): matched.append(row)
   rows = matched
  matured = {str(data_types.data_cell(row, 'email')) for row in rows if business_days(data_types.dt(str(data_types.data_cell(row, 'created'))), t) >= 5}
  reply_kind = 'editorial_request' if lane == 'presse' else 'qualified_need'
  successes = {str(data_types.data_cell(row, 'email')) for row in data_types.data_sqlite_rows(cast(object, db.execute('SELECT * FROM replies WHERE lane=? AND kind=?', (lane, reply_kind)).fetchall()))}
  out[variant] = data_types.data_coerce_json_object({'matured': len(matured), 'qualified': len(successes & matured), 'posterior': (1 + len(successes & matured)) / (2 + len(matured))})
 enough = all(data_types.data_integer(data_types.data_json_object(value).get('matured')) >= 8 for value in out.values()) and sum(data_types.data_integer(data_types.data_json_object(value).get('qualified')) for value in out.values()) >= 3
 a = data_types.data_json_object(out['A'])
 b = data_types.data_json_object(out['B'])
 winner = max(out, key=lambda value: data_types.data_number(data_types.data_json_object(out[value]).get('posterior'))) if enough and abs(data_types.data_number(a.get('posterior')) - data_types.data_number(b.get('posterior'))) > 0.15 else None
 result = data_types.data_coerce_json_object({'copyVersion': c.get('copyVersion'), 'variants': out, 'winner': winner, 'explorationFloor': 0.25, 'technicalSendsReward': False, 'bookingsInferred': False})
 if c.get('senderPilot') and sender is None:
  result['winner'] = None
  result['cohorts'] = data_types.data_coerce_json_object({sender_id: learning(db, lane, t, c, sender_id, sender_pilot.VERSION) for sender_id in [sender_pilot.PRIMARY, sender_pilot.ROBB]})
 return result

def choose_variant(email: str, learn: data_types.JsonObject) -> str:
 bucket = int(hashlib.sha256(email.encode()).hexdigest(), 16) % 4
 winner = learn.get('winner')
 return winner if isinstance(winner, str) and bucket != 0 else ('A' if bucket % 2 == 0 else 'B')

def draft(c: data_types.JsonObject, v: str, step: str = 'initial', subject: str | None = None) -> data_types.CampaignDraft:
 name = data_types.data_text(c.get('name')).split(' ')[0] if data_types.data_text(c.get('name')) and len(data_types.data_text(c.get('name')).split()) >= 2 else ''
 lane = data_types.data_text(c.get('lane'))
 greeting = 'Bonjour' + (' ' + name.title() if name and lane != 'presse' else '') + ','
 if lane == 'presse':
  title = 'Angle PME/ETI : décider où l’IA mérite un investissement' if v == 'A' else 'IA en entreprise : ce qui permet aux équipes de décider'
  main = ("Je vous propose un angle concret pour votre rédaction : comment un dirigeant distingue un cas d’usage utile d’une expérimentation sans suite, à partir de décisions, de données et de résultats mesurables." if v == 'A' else "Je vous propose un angle terrain pour votre rédaction : qui possède les données, comment les équipes adoptent l’IA et quels contrôles évitent qu’un prototype ne devienne un risque opérationnel.")
  text = greeting + '\n\n' + main + '\n\nChez Robinswood, nous travaillons sur les flux métier, les outils IA et l’adoption responsable.'
 else:
  topic = 'les validations, les documents et le passage entre équipes'
  company = data_types.data_text(c.get('company'))
  title = company + ' : quel flux mérite d’être simplifié ?' if v == 'A' else company + ' : un usage IA que vos équipes pourraient cadrer'
  main = ("Un sujet possible chez " + company + " : " + topic + ". Où se situent le temps perdu et les reprises ? C’est souvent là que l’IA peut aider." if v == 'A' else "Un sujet possible chez " + company + " : " + topic + ". Quelle étape améliorer en gardant la maîtrise des données et la validation humaine ?")
  text = greeting + '\n\n' + main + '\n\nRobinswood accompagne les PME et ETI de l’étude du flux à la mise en œuvre. Notre approche commence par un périmètre vérifiable.'
 if step == 'followup': text = greeting + '\n\nJe reviens une seule fois sur ma proposition ci-dessous. ' + ('Une note d’approche est disponible si le sujet vous intéresse.' if lane != 'presse' else 'Souhaitez-vous recevoir une courte note de cadrage ?') + '\n\n' + text
 if step == 'reply': text = greeting + '\n\nMerci pour votre retour. ' + ('Voici notre angle : partir d’un flux réel, établir le coût total et mesurer les effets avant d’automatiser.' if lane != 'presse' else 'Notre démarche commence par un flux précis, une situation de départ et un coût total. L’audit stratégique IA aide à prioriser les usages.')
 if c.get('_sender') == sender_pilot.ROBB: text = text.replace(greeting + '\n\n', greeting + '\n\n' + sender_pilot.DISCLOSURE + '\n\n', 1)
 text += '\n\nVotre adresse professionnelle provient de sources publiques en lien avec votre activité. Source : ' + data_types.data_text(c.get('discoverySource')) + '. Si ce sujet n’est pas pertinent, un simple retour suffit.'
 text += '\n\nInformations et droits sur vos données : https://robinswood.io/confidentialite — contact : thibault@robinswood.io. Pour ne plus recevoir de message, répondez simplement « STOP » ; l’opposition est gratuite et prise en compte automatiquement.'
 return {'subject': subject or title, 'body': text}

def portfolio_ramp(db: sqlite3.Connection, t: datetime, c: data_types.JsonObject, predecessor_root: Path | None = None) -> data_types.JsonObject:
 ramp_value = c.get('postScotlandRamp')
 info = data_types.data_coerce_json_object({'phase': 'predecessor_active', 'dailyCap': None, 'weeklyCap': None, 'reason': 'no_post_scotland_authorization'})
 if not ramp_value: return info
 effects = data_types.data_sqlite_rows(cast(object, db.execute('SELECT * FROM touches').fetchall()))
 if any(data_types.data_text(data_types.data_json_value(data_types.data_cell(effect, 'state'))) != 'verified' for effect in effects):
  info.update(phase='blocked', reason='portfolio_unknown_gmail_effect')
  return info
 ramp = data_types.data_json_object(ramp_value)
 predecessor_id = data_types.data_text(ramp.get('predecessorCampaignId'))
 predecessor_root = predecessor_root or OPS / 'product-campaigns' / predecessor_id
 try:
  contract_value = read(predecessor_root / 'campaign-contract.json')
  predecessor = data_types.data_json_object(contract_value)
  transport.verify_contract(predecessor)
  limits = data_types.data_json_object(predecessor.get('limits'))
  end = data_types.data_text(limits.get('lastOutboundDate'))
  predecessor_zone = ZoneInfo(data_types.data_text(limits.get('timezone')))
  local = t.astimezone(predecessor_zone)
  authorization = data_types.data_json_object(predecessor.get('authorization'))
  info.update(predecessorCampaignId=predecessor.get('campaignId'), predecessorLastOutboundDate=end, predecessorScopeSha256=authorization.get('scopeSha256'), reason='awaiting_authorized_predecessor_expiry')
  if local.date().isoformat() <= end: return info
  with closing(sqlite3.connect('file:' + str(predecessor_root / 'campaign-state.sqlite3') + '?mode=ro', uri=True)) as prior:
   unknown = data_types.data_sqlite_integer(data_types.data_sqlite_value(prior, "SELECT count(*) FROM touches WHERE state IS NULL OR state!='sent_verified'"))
   adverse_predecessor = data_types.data_sqlite_integer(data_types.data_sqlite_value(prior, "SELECT count(*) FROM replies WHERE kind IN ('bounce','complaint','delivery_failure','opt_out')"))
   info.update(predecessorUnknownEffects=unknown, predecessorAdverseSignals=adverse_predecessor)
   if unknown or adverse_predecessor:
    info['reason'] = 'predecessor_unknown_effect' if unknown else 'predecessor_adverse_signal_requires_review'
    return info
 except (AssertionError, OSError, ValueError, KeyError, sqlite3.Error, TypeError) as error:
  info['reason'] = 'predecessor_completion_unproven:' + type(error).__name__
  return info
 campaign_zone = ZoneInfo(data_types.data_text(c.get('timezone')))
 day = t.astimezone(campaign_zone).date()
 monday = day - timedelta(days=day.weekday())
 daily_used = sum(data_types.dt(data_types.data_text(data_types.data_json_value(data_types.data_cell(effect, 'created')))).astimezone(campaign_zone).date() == day for effect in effects)
 weekly_used = sum(monday <= data_types.dt(data_types.data_text(data_types.data_json_value(data_types.data_cell(effect, 'created')))).astimezone(campaign_zone).date() <= day for effect in effects)
 days: dict[date, int] = {}
 for effect in effects:
  created = data_types.dt(data_types.data_text(data_types.data_json_value(data_types.data_cell(effect, 'created'))))
  local_day = created.astimezone(campaign_zone).date()
  if created.astimezone(predecessor_zone).date().isoformat() > end and local_day < day and local_day.weekday() < 5:
   days[local_day] = days.get(local_day, 0) + 1
 healthy = sorted(value.isoformat() for value, count in days.items() if count >= data_types.data_integer(ramp.get('minimumVerifiedEffectsPerHealthyDay')))
 adverse = data_types.data_sqlite_integer(data_types.data_sqlite_value(db, "SELECT count(*) FROM replies WHERE kind IN ('bounce','complaint')"))
 steady = len(healthy) >= data_types.data_integer(ramp.get('healthyCompletedBusinessDays')) and not adverse
 healthy_json: JsonValue = data_types.data_json_value(healthy)
 info.update(phase='steady_30' if steady else 'initial_20', reason='verified_predecessor_expiry', dailyCap=data_types.data_integer(ramp.get('steadyDailyMax' if steady else 'dailyMax')), weeklyCap=data_types.data_integer(ramp.get('steadyWeeklyMax' if steady else 'weeklyMax')), laneDailyMax=data_types.data_json_object_or_empty(ramp.get('steadyLaneDailyMax' if steady else 'laneDailyMax')), dailyUsed=daily_used, weeklyUsed=weekly_used, healthyCompletedDays=healthy_json, adverseSignalsPreserved=adverse, countsRepliesAndFollowups=True)
 return info

def lane_capacity(db: sqlite3.Connection, lane: str, t: datetime, c: data_types.JsonObject) -> tuple[bool, str | data_types.JsonObject]:
 effects = data_types.data_sqlite_rows(cast(object, db.execute('SELECT * FROM touches WHERE lane=?', (lane,)).fetchall()))
 day = t.astimezone(ZoneInfo('Europe/Paris')).date()
 monday = day - timedelta(days=day.weekday())
 learn = learning(db, lane, t, c)
 variants = data_types.data_json_object(learn.get('variants'))
 statistics = [data_types.data_json_object(value) for value in variants.values()]
 matured = sum(data_types.data_integer(item.get('matured')) for item in statistics)
 qualified = sum(data_types.data_integer(item.get('qualified')) for item in statistics)
 adverse = data_types.data_sqlite_integer(data_types.data_sqlite_value(db, "SELECT count(*) FROM replies WHERE lane=? AND kind IN ('bounce','complaint')", (lane,)))
 bounce_value = data_types.data_sqlite_value(db, "SELECT max(observed) FROM replies WHERE lane=? AND kind='bounce'", (lane,))
 bounce = str(bounce_value) if bounce_value is not None else None
 complaint = data_types.data_sqlite_value(db, "SELECT 1 FROM replies WHERE lane=? AND kind='complaint'", (lane,))
 if complaint is not None:
  return False, 'complaint_pause'
 if bounce:
  key = 'recovery_epoch_' + lane
  epoch_value = data_types.data_sqlite_value(db, 'SELECT value FROM metadata WHERE key=?', (key,))
  epoch = data_types.data_parse_json_object(str(epoch_value)) if epoch_value is not None else {}
  recovered = epoch.get('afterBounce') == bounce
  if not recovered:
   auto_recovery = data_types.data_json_object(c.get('autoRecovery'))
   eligible: list[str] = []
   cooldown = data_types.data_number(auto_recovery.get('cooldownDays'))
   if (t - data_types.dt(bounce)).total_seconds() >= cooldown * 86400:
    query = "SELECT * FROM candidates WHERE lane=? AND proof IS NOT NULL AND email NOT IN(SELECT email FROM legacy)"
    candidate_rows = data_types.data_sqlite_rows(cast(object, db.execute(query, (lane,)).fetchall()))
    for row in candidate_rows:
     proof = data_types.data_parse_json_object(str(data_types.data_cell(row, 'proof')))
     checked_at = data_types.data_text(proof.get('checkedAt'))
     if proof.get('ok') and proof.get('smtpVerified') is True and data_types.dt(checked_at) > data_types.dt(bounce) and 0 <= (t - data_types.dt(checked_at)).total_seconds() < 7 * 86400:
      eligible.append(str(data_types.data_cell(row, 'email')))
   if len(eligible) < data_types.data_integer(auto_recovery.get('minimumFreshSmtpContacts')):
    return False, 'new_cohort_bounce_pause_awaiting_independent_smtp_proofs'
   _ = db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (key, json.dumps({'activatedAt': data_types.stamp(t), 'afterBounce': bounce})))
   recovered = True
  if recovered:
   query = 'SELECT email,proof FROM candidates WHERE lane=? AND proof IS NOT NULL'
   recovery_rows = data_types.data_sqlite_rows(cast(object, db.execute(query, (lane,)).fetchall()))
   for row in recovery_rows:
    proof = data_types.data_parse_json_object(str(data_types.data_cell(row, 'proof')))
    if proof.get('smtpVerified') is not True and proof.get('ok'):
     proof['ok'] = False
     proof['reason'] = 'recovery_requires_independent_smtp_proof'
     _ = db.execute('UPDATE candidates SET proof=?,reason=? WHERE email=?', (json.dumps(proof), proof['reason'], str(data_types.data_cell(row, 'email'))))
   db.commit()
 ramp = portfolio_ramp(db, t, c)
 if data_types.data_text(ramp.get('phase')) == 'blocked':
  return False, data_types.data_text(ramp.get('reason'))
 active = data_types.data_text(ramp.get('phase')) in ('initial_20', 'steady_30')
 lane_caps = data_types.data_json_object(data_types.data_json_object(c.get('lanes')).get(lane))
 ramp_caps = data_types.data_json_object(ramp.get('laneDailyMax')) if active else {}
 daily_cap = data_types.data_integer(ramp_caps.get(lane))
 daily = daily_cap if active and not adverse else data_types.data_integer(lane_caps.get('dailyMax')) if matured >= 10 and qualified >= 1 and not adverse else data_types.data_integer(c.get('canaryDailyMax'))
 weekly = daily_cap * 5 if active else data_types.data_integer(lane_caps.get('weeklyMax'))
 created_dates = [data_types.dt(data_types.data_text(data_types.data_json_value(data_types.data_cell(effect, 'created')))).astimezone(ZoneInfo('Europe/Paris')).date() for effect in effects]
 nday = sum(created == day for created in created_dates)
 nweek = sum(created >= monday for created in created_dates)
 portfolio_ok = not active or (data_types.data_integer(ramp.get('dailyUsed')) < data_types.data_integer(ramp.get('dailyCap')) and data_types.data_integer(ramp.get('weeklyUsed')) < data_types.data_integer(ramp.get('weeklyCap')))
 info = data_types.data_coerce_json_object({'dailyCap': daily, 'dailyUsed': nday, 'weeklyCap': weekly, 'weeklyUsed': nweek, 'historicalMetricsReset': False, 'portfolioRamp': ramp})
 return nday < daily and nweek < weekly and portfolio_ok, info

def audience_counts(db: sqlite3.Connection, lane: str, t: datetime, c: data_types.JsonObject) -> data_types.JsonObject:
 rows = data_types.data_sqlite_rows(cast(object, db.execute('SELECT * FROM candidates WHERE lane=?', (lane,)).fetchall()))
 legacy_rows = data_types.data_sqlite_rows(cast(object, db.execute('SELECT email FROM legacy').fetchall()))
 legacy = {str(data_types.data_cell(row, 'email')) for row in legacy_rows}
 blocked = suppressed()
 qualified: list[sqlite3.Row] = []
 for row in rows:
  email = str(data_types.data_cell(row, 'email'))
  proof_value = data_types.data_cell(row, 'proof')
  if email in legacy or email in blocked or not proof_value:
   continue
  proof = data_types.data_parse_json_object(str(proof_value))
  checked_at = data_types.data_text(proof.get('checkedAt'))
  proof_age = (t - data_types.dt(checked_at)).total_seconds() if checked_at else -1
  if proof.get('ok') is True and 0 <= proof_age < data_types.data_number(c.get('proofMaxAgeDays')) * 86400:
   qualified.append(row)
 touch_rows = data_types.data_sqlite_rows(cast(object, db.execute('SELECT email FROM touches').fetchall()))
 contacted = {str(data_types.data_cell(row, 'email')) for row in touch_rows}
 account_rows = data_types.data_sqlite_rows(cast(object, db.execute('SELECT c.account FROM candidates c JOIN touches t ON c.email=t.email').fetchall()))
 touched_accounts = {str(data_types.data_cell(row, 'account')) for row in account_rows}
 return data_types.data_coerce_json_object({
  'reserve': len(rows),
  'qualified': len(qualified),
  'readyForInitial': sum(str(data_types.data_cell(row, 'email')) not in contacted and str(data_types.data_cell(row, 'account')) not in touched_accounts for row in qualified),
  'historicalContactsExcluded': len(legacy),
  'laneHistoricalReserveExcluded': sum(str(data_types.data_cell(row, 'email')) in legacy for row in rows),
 })
