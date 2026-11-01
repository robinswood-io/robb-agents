"""Offline safety/integration tests. No live credentials, networks, or contacts."""
import base64
import copy
import json
import sqlite3
import tempfile
import unittest
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import final, override
from unittest.mock import patch

import evergreen_campaign_prospecting as prospecting
import evergreen_offline_test_guard as _offline_test_guard
import outbound_sender_guard as guard
import robinswood_evergreen_france as engine
from evergreen_campaign_data_types import (
 CampaignRunResult,
 JsonObject,
 data_coerce_json_object,
 data_json_array,
 data_json_value,
 data_sqlite_integer,
 data_sqlite_value,
)
from evergreen_campaign_test_fixtures import (
 EndGateway,
 FakeGateway,
 T,
 add_test_attachment,
 add_test_cc,
 body_of,
 change_test_campaign,
 change_test_sender,
 headers_of,
 message,
 object_path,
 patch_engine,
 payload_of,
 raw,
 sent_now,
)
from robinswood_evergreen_france_ramp_cases import PostScotlandRampTests
from robinswood_media_contact_enrichment_types import EnrichedCandidate
from scotland_executive_conference_state import state_first

__all__ = ['AudienceReportingTests', 'EndGateway', 'EndToEndTests', 'EngineTests', 'FakeGateway', 'GuardTests', 'PostScotlandRampTests', 'PrimaryIdentityRegressionTests', 'ProfessionalMandateTests', 'PublishedMailboxTests', 'T', 'message', 'raw']

def no_reserves(_db: sqlite3.Connection) -> None:
 return None

@final
class FetchRecorder:
 url: str = ''
 def __call__(self, url: str) -> tuple[str, str]:
  self.url = url
  return '{"results":[],"total_pages":1}', 'https://registry.invalid'





@final
class GuardTests(unittest.TestCase):
 @override
 def __init__(self, methodName: str = 'runTest') -> None:
  super().__init__(methodName)
  self.tmp: tempfile.TemporaryDirectory[str] = tempfile.TemporaryDirectory()
  self.root: Path = Path(self.tmp.name)
  self.g: FakeGateway = FakeGateway()
 @override
 def tearDown(self) -> None:self.tmp.cleanup()
 def send(self,data: str | None=None,thread: str | None=None,t: datetime=T) -> JsonObject:
  data=data or raw();self.g.time=t;return guard.shared_send(self.g,data,thread,lambda:self.g.post(data,thread),ops=self.root,t=t)
 def test_exact_effect_and_idempotence(self) -> None:
  a=self.send();b=self.send();self.assertEqual(a['id'],b['id']);self.assertEqual(self.g.posts,1)
  with closing(guard.database(self.root/'outbound-sender-guard.sqlite3')) as db:
   self.assertEqual(db.execute("SELECT state FROM effects").fetchone()['state'],'verified')
 def test_payload_change_is_rejected(self) -> None:
  _ = self.send()
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'payload_changed'):_ = self.send(raw(subject='Mutated'))
  self.assertEqual(self.g.posts,1)
 def test_ambiguous_success_reconciles_without_second_post(self) -> None:
  self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):_ = self.send()
  self.g.fail_after_post=False
  result=self.send();self.assertTrue(result['deduplicated']);self.assertEqual(self.g.posts,1)
 def test_unknown_never_blindly_retries(self) -> None:
  self.g.fail_before_post=True
  with self.assertRaises(TimeoutError):_ = self.send()
  self.g.fail_before_post=False
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'unresolved'):_ = self.send()
  self.assertEqual(self.g.posts,1)
 def test_lunch_weekend_and_end_exclusive(self) -> None:
  for t in [T.replace(hour=10),T.replace(hour=16),T+timedelta(days=5)]:
   with self.subTest(t=t), self.assertRaisesRegex(guard.SenderGuardBlocked,'window'):
    _ = self.send(t=t)
  self.assertEqual(self.g.posts,0)
 def test_scotland_timezone_is_preserved(self) -> None:
  data=raw();m=guard.parse_raw(data);m.replace_header('X-RBW-Campaign','scotland-executive-conference-october-2026');data=base64.urlsafe_b64encode(m.as_bytes()).decode()
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'window'):_ = guard.shared_send(self.g,data,None,lambda:self.g.post(data),ops=self.root,t=T.replace(hour=7))
  _ = guard.shared_send(self.g,data,None,lambda:self.g.post(data),ops=self.root,t=T)
 def test_global_daily_cap_counts_all_sent_campaigns(self) -> None:
  for i in range(40):self.g.messages[str(i)]=message(raw('old-'+str(i)),str(i),t=T-timedelta(hours=1,seconds=i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'daily'):_ = self.send()
  self.assertEqual(self.g.posts,0)
 def test_interval_and_rolling_hour(self) -> None:
  _ = self.send()
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'interval'):_ = self.send(raw('second'),t=T+timedelta(seconds=599))
  _ = self.send(raw('second'),t=T+timedelta(seconds=600));self.assertEqual(self.g.posts,2)
  self.assertEqual(guard.counts(list(self.g.messages.values()),T+timedelta(seconds=3600))['hourly'],1)
 def test_weekly_and_hourly_caps(self) -> None:
  messages=[message(raw('old-'+str(i)),str(i),t=T+timedelta(seconds=601+i)) for i in range(6)]
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'hourly'):_ = guard.capacity(messages,T+timedelta(seconds=2000))
  messages=[message(raw('old-'+str(i)),str(i),t=T+timedelta(days=1,seconds=i)) for i in range(200)]
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'weekly'):_ = guard.capacity(messages,T+timedelta(days=3))
 def test_cc_sender_campaign_and_attachment_guard(self) -> None:
  mutations: tuple[Callable[[EmailMessage[str, str]], None], ...] = (add_test_cc, change_test_sender, change_test_campaign, add_test_attachment)
  for mutate in mutations:
   m=guard.parse_raw(raw());mutate(m);data=base64.urlsafe_b64encode(m.as_bytes()).decode()
   with self.assertRaises(guard.SenderGuardBlocked):_ = guard.expected(data)
 def test_exact_body_signature_subject_recipient_thread(self) -> None:
  data=raw();m=message(data);self.assertTrue(guard.verify(m,data,'thread-1')[0])
  for h,value in [('Subject','Changed'),('To','other@fixture.invalid'),('X-RBW-Campaign',engine.IDS['eti'])]:
   changed=copy.deepcopy(m);next(x for x in headers_of(changed) if x['name']==h)['value']=value
   self.assertFalse(guard.verify(changed,data,'thread-1')[0])
  changed=copy.deepcopy(m);body_of(changed)['data']=base64.urlsafe_b64encode(b'No signature\n').decode()
  self.assertFalse(guard.verify(changed,data)[0]);self.assertFalse(guard.verify(m,data,'other')[0])
@final
class EngineTests(unittest.TestCase):
 @override
 def __init__(self, methodName: str = 'runTest') -> None:
  super().__init__(methodName)
  self.tmp: tempfile.TemporaryDirectory[str] = tempfile.TemporaryDirectory()
  self.root: Path = Path(self.tmp.name)
  self.db: sqlite3.Connection = engine.db_open(self.root)
  self.c: JsonObject = engine.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
 @override
 def tearDown(self) -> None:self.db.close();self.tmp.cleanup()
 def test_contract_tamper_rejected(self) -> None:
  altered=copy.deepcopy(self.c);object_path(altered, 'lanes', 'pme')['dailyMax'] = 40;p=self.root/'contract.json';_ = p.write_text(json.dumps(altered))
  with self.assertRaises(AssertionError):_ = engine.contract(p)
 def test_business_windows_DST_and_weekend(self) -> None:
  self.assertTrue(engine.in_window(T,self.c))
  for t in [T.replace(hour=10),T.replace(hour=16),T+timedelta(days=5)]:self.assertFalse(engine.in_window(t,self.c))
  self.assertTrue(engine.in_window(datetime(2026,11,2,8,tzinfo=UTC),self.c))
 def test_exact_email_required_never_nominal_inference(self) -> None:
  c=data_coerce_json_object({'email': 'alice@fixture.invalid', 'name': 'Alice Martin', 'company': 'Fixture', 'lane': 'pme', 'siren': '111111111', 'domain': 'fixture.invalid', 'sourceUrls': ['https://fixture.invalid/']})
  sources=data_json_array(data_json_value(c.get('sourceUrls')))
  source_url=sources[0] if sources else None
  if not isinstance(source_url,str):self.fail('source URL fixture must be a string')
  page=data_coerce_json_object({'url':source_url,'text':'Fixture page confirms exact email'})
  proof=engine.refresh_proof(data_coerce_json_object(c),T,fetch_page=lambda _:page,ops=self.root)
  self.assertFalse(proof['ok']);self.assertIn('exact_email',proof['reason'])
 def test_publication_or_send_is_not_learning_reward(self) -> None:
  self.assertEqual(object_path(engine.learning(self.db,'pme',T,self.c), 'variants', 'A').get('qualified'),0)
  _ = self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('r','a@fixture.invalid','pme','interest',T.isoformat(),'{}'));self.db.commit()
  learn=engine.learning(self.db,'pme',T,self.c);self.assertIsNone(learn['winner']);self.assertEqual(object_path(learn, 'variants', 'A').get('qualified'),0)
 def test_quotes_automatic_replies_and_yes_do_not_become_need(self) -> None:
  m=message(raw());m['labelIds']=[];body_of(m)['data']=base64.urlsafe_b64encode('Oui, merci.\n\nLe 1 octobre, Thibault a écrit :\n5000 euros pour le flux'.encode()).decode()
  trimmed=engine.new_reply_text(m);self.assertEqual(engine.classify_reply(trimmed,'pme'),'interest')
  headers=headers_of(m);headers.append({'name':'Auto-Submitted','value':'auto-replied'});payload_of(m)['headers']=data_json_value(headers)
  trimmed=engine.new_reply_text(m)
  self.assertEqual(engine.classify_reply(trimmed,'pme'),'automatic_reply')
 def test_quantified_need_editorial_interest_and_opposition(self) -> None:
  m=message(raw())
  for text,lane,kind in [('Le flux de devis mobilise 30 heures par semaine.','pme','qualified_need'),('Merci, pouvez-vous envoyer une note d’angle pour notre article ?','presse','editorial_request'),('STOP, ne plus me contacter','eti','opposition'),('Je vais signaler votre message comme spam','pme','complaint')]:
   body_of(m)['data']=base64.urlsafe_b64encode(text.encode()).decode();self.assertEqual(engine.classify_reply(m,lane),kind)
 def test_new_cohort_bounce_stops_lane(self) -> None:
  _ = self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('b','a@fixture.invalid','pme','bounce',T.isoformat(),'{}'));self.db.commit()
  self.assertEqual(engine.lane_capacity(self.db,'pme',T,self.c),(False,'new_cohort_bounce_pause_awaiting_independent_smtp_proofs'))
 def test_canary_and_all_effects_share_one_daily_budget(self) -> None:
  data=raw();_ = self.db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',('op','a@fixture.invalid','pme','reply','A',self.c['copyVersion'],T.isoformat(),'verified',data,'body','s','id','thread','{}'));self.db.commit()
  ok,info=engine.lane_capacity(self.db,'pme',T,self.c);self.assertFalse(ok)
  if isinstance(info,str):self.fail('expected capacity details')
  self.assertEqual(info['dailyCap'],1)
 def test_sender_signature_and_original_thread_subject_copy(self) -> None:
  item={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture','lane':'pme','sourceUrls':['https://fixture.invalid/'],'topic':'les devis'}
  d=engine.draft(data_coerce_json_object(item),'A','followup',subject='Ancien objet réellement envoyé')
  self.assertEqual(d['subject'],'Ancien objet réellement envoyé');self.assertIn('STOP',d['body'])
  self.assertNotIn('5000 heures',engine.draft(data_coerce_json_object(item),'A')['body'])
 def test_legacy_contact_can_never_be_new_prospect(self) -> None:
  engine.put_candidate(self.db,data_coerce_json_object({'email':'a@fixture.invalid','lane':'pme','company':'Fixture','domain':'fixture.invalid','sourceUrls':['https://fixture.invalid/']}))
  _ = self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'checkedAt':T.isoformat()}),))
  engine.append_legacy(self.db,data_coerce_json_object({'recipientEmail':'a@fixture.invalid','status':'sent','campaignId':'old'}));self.db.commit()
  with patch_engine('suppressed',return_value=set[str]()):self.assertIsNone(engine.next_item(self.db,'pme',T,self.c))

 def test_recovery_requires_three_fresh_independent_smtp_proofs(self) -> None:
  _ = self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('b','old@fixture.invalid','pme','bounce',(T-timedelta(days=8)).isoformat(),'{}'))
  for i in range(3):
   engine.put_candidate(self.db,data_coerce_json_object({'email':str(i)+'@fixture.invalid','lane':'pme','name':'Fixture Person','company':'Fixture '+str(i),'domain':'fixture.invalid','sourceUrls':['https://fixture.invalid/']}))
  _ = self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'smtpVerified':False,'checkedAt':T.isoformat()}),));self.db.commit()
  with patch_engine('suppressed',return_value=set[str]()):
   self.assertFalse(engine.lane_capacity(self.db,'pme',T,self.c)[0])
   _ = self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'smtpVerified':True,'checkedAt':T.isoformat()}),));self.db.commit()
   allowed,info=engine.lane_capacity(self.db,'pme',T,self.c)
  self.assertTrue(allowed)
  if isinstance(info,str):self.fail('expected capacity details')
  self.assertEqual(info['dailyCap'],1)
  self.assertEqual(self.db.execute("SELECT count(*) FROM replies WHERE kind='bounce'").fetchone()[0],1)
 def test_complaints_are_never_auto_recovered(self) -> None:
  _ = self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('c','old@fixture.invalid','pme','complaint',(T-timedelta(days=30)).isoformat(),'{}'));self.db.commit()
  self.assertEqual(engine.lane_capacity(self.db,'pme',T,self.c),(False,'complaint_pause'))
 def test_recent_risky_provider_evidence_blocks_public_mailbox(self) -> None:
  c={'email':'a@fixture.invalid','emailVerification':{'checkedAt':T.isoformat(),'result':'risky'}}
  self.assertEqual(engine.delivery_blocker(data_coerce_json_object(c),T,self.root),'recent_adverse_delivery_evidence')

 def test_provider_proof_requires_fresh_smtp_no_catchall(self) -> None:
  c={'emailVerification':{'provider':'hunter','statusCode':200,'result':'deliverable','score':100,'checkedAt':T.isoformat(),'smtpCheck':True,'acceptAll':False,'block':False}}
  self.assertTrue(engine.provider_delivery(data_coerce_json_object(c),T))
  c['emailVerification']['acceptAll']=True;self.assertFalse(engine.provider_delivery(data_coerce_json_object(c),T))
  c['emailVerification']['acceptAll']=False;c['emailVerification']['checkedAt']=(T-timedelta(days=8)).isoformat();self.assertFalse(engine.provider_delivery(data_coerce_json_object(c),T))
 def test_media_enrichment_preserves_budget_and_holds(self) -> None:
  import robinswood_media_contact_enrichment_service as helper
  row: EnrichedCandidate={'id':'fixture','recordType':'email_contact','email':'a@fixture.invalid','contactName':'Alice Martin'}
  data={'result':'deliverable','score':100,'smtp_check':True,'accept_all':False,'block':False,'mx_records':True}
  with patch.object(helper,'verify_email',return_value={'statusCode':200,'body':{'data':data}}) as call:
   updated,left,event=helper.row_outcome(row,'fixture-key',1)
  self.assertEqual(call.call_count,1);self.assertEqual(left,0);self.assertEqual(event['hunterCalls'],1)
  self.assertTrue(object_path(data_coerce_json_object(updated), 'emailVerification').get('smtpCheck'));self.assertIs(updated.get('outreachEligible'),False)
  self.assertEqual(updated['email'],row['email'])
  updated['outreachStatus']='not_eligible_legacy_pr_hold';self.assertFalse(helper.eligible_for_processing(updated))
 def test_media_high_score_risky_is_not_verified(self) -> None:
  import robinswood_media_contact_enrichment_service as helper
  row: EnrichedCandidate={'id':'fixture','recordType':'email_contact','email':'a@fixture.invalid'}
  with patch.object(helper,'verify_email',return_value={'statusCode':200,'body':{'data':{'result':'risky','score':100,'smtp_check':True,'accept_all':True,'block':False}}}):
   updated,_left,_event=helper.row_outcome(row,'fixture-key',1)
  self.assertEqual(updated.get('enrichmentStatus'),'email_not_verified_review_or_replace');self.assertIs(updated.get('outreachEligible'),False)

@final
class EndToEndTests(unittest.TestCase):
 @override
 def __init__(self, methodName: str = 'runTest') -> None:
  super().__init__(methodName)
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=engine.db_open(self.root)
  self.c=engine.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
  self.g=EndGateway(self.root)
  self.patches=[patch_engine('OPS',self.root/'reports'),patch_engine('import_reserves',no_reserves)]
 @override
 def setUp(self) -> None:
  item={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture Services','domain':'fixture.invalid','lane':'pme','sourceUrls':['https://fixture.invalid/'],'topic':'les devis'}
  engine.put_candidate(self.db,data_coerce_json_object(item))
  _ = self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'checkedAt':T.isoformat()}),));self.db.commit()
  for p in self.patches:_ = p.__enter__()
 @override
 def tearDown(self) -> None:
  for patcher in reversed(self.patches):_ = patcher.__exit__(None,None,None)
  self.db.close();self.tmp.cleanup()
 def execute(self) -> CampaignRunResult:return engine.run('pme',apply=True,root=self.root,c=self.c,gateway=self.g,t=T,research_batch=0)
 def test_dispatch_exact_effect_then_idempotence(self) -> None:
  r=self.execute();self.assertEqual(r['status'],'sent_verified');self.assertEqual(sent_now(r),1)
  row=state_first(self.db.execute('SELECT * FROM touches'));
  if row is None:self.fail('expected a persisted touch')
  self.assertEqual(row['state'],'verified')
  self.assertIn('Robinswood',row['expected']);self.assertEqual(guard.header(self.g.get(row['gmail_id']),'X-RBW-Campaign'),engine.IDS['pme'])
  r=self.execute();self.assertEqual(sent_now(r),0);self.assertEqual(self.g.posts,1)
 def test_lost_post_response_recovered_without_resend(self) -> None:
  self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):_ = self.execute()
  self.g.fail_after_post=False;r=self.execute()
  self.assertEqual(self.g.posts,1);self.assertEqual(sent_now(r),0)
  self.assertEqual(self.db.execute('SELECT state FROM touches').fetchone()['state'],'verified')
 def test_proven_presend_refusal_is_not_an_unknown_effect(self) -> None:
  with patch.object(self.g,'send',side_effect=guard.SenderGuardBlocked('shared_sender_daily_cap')):
   r=self.execute();self.assertEqual(sent_now(r),0)
  self.assertEqual(self.db.execute('SELECT count(*) n FROM touches').fetchone()['n'],0)
  r=self.execute();self.assertEqual(sent_now(r),1)
 def test_scotland_presend_refusal_does_not_poison_reservations(self) -> None:
  import scotland_executive_conference_october_tests as prior
  from scotland_conference_test_fixtures import Fake as ConferenceFake
  case=prior.CampaignTests();case.setUp()
  try:
   g=ConferenceFake()
   with patch.object(g,'send',side_effect=guard.SenderGuardBlocked('shared_sender_daily_cap')):
    r=case.runit(g);self.assertEqual(r['externalSendsThisRun'],0)
   import scotland_executive_conference_october as scotland
   with closing(scotland.database(case.root)) as db:
    self.assertEqual(db.execute('SELECT count(*) FROM touches').fetchone()[0],0)
   self.assertNotIn('unknown_gmail_effect',r['blockingReasons'])
   self.assertEqual(case.runit(g)['externalSendsThisRun'],1)
  finally:case.tearDown()

@final
class PrimaryIdentityRegressionTests(unittest.TestCase):
 def test_siren_and_siret_spacing_and_publisher_identity(self) -> None:
  pages=[{'text':'Éditeur Fixture Services. RCS Paris 424 281 392. Hébergeur OVH SIRET 424 761 419 00045.'}]
  self.assertEqual(engine.primary_sirens([data_coerce_json_object(page) for page in pages]),['424281392','424761419'])
  self.assertEqual(engine.primary_sirens([{'text':'Téléphone 012345678. Aucun identifiant légal.'}]),[])
 def test_owned_subdomain_and_foreign_redirect(self) -> None:
  self.assertTrue(engine.owned_domain('https://fr.fixture.invalid/contact','fixture.invalid'))
  self.assertFalse(engine.owned_domain('https://fixture.invalid.attacker.invalid/','fixture.invalid'))
  self.assertFalse(engine.owned_domain('https://other.invalid/','fixture.invalid'))
 def test_contact_links_exclude_assets_and_equipment(self) -> None:
  html='<html lang="fr"><a href="/wp-content/contact-form.css">CSS</a><a href="/les-equipements">Équipement</a><a href="/mentions-legales">Mentions</a><a href="/decouvrir-les-equipes#dirigeants">Équipe</a></html>'
  with patch_engine('fetch',return_value=(html,'https://fixture.invalid/'),target_module=prospecting):
   page=engine.public_page('https://fixture.invalid/')
  self.assertEqual(page['contactLinks'],['https://fixture.invalid/mentions-legales','https://fixture.invalid/decouvrir-les-equipes'])
 def test_missing_siren_is_bound_to_official_publisher_not_host(self) -> None:
  c: JsonObject={'email':'alice.martin@fixture.invalid','name':'Alice Martin','company':'Fixture Services','domain':'fixture.invalid','lane':'pme','sourceUrls':['https://fixture.invalid/notre-equipe']}
  sources=data_json_array(data_json_value(c.get('sourceUrls')))
  source_url=sources[0] if sources else None
  if not isinstance(source_url,str):self.fail('source URL fixture must be a string')
  page={'url':source_url,'roleBlocks':['Présidente Alice Martin'],'text':'Fixture Services, présidente Alice Martin, SIREN 424281392','emails':['alice.martin@fixture.invalid']}
  row={'siren':'424281392','nom_complet':'FIXTURE SERVICES','categorie_entreprise':'PME','tranche_effectif_salarie':'21','annee_tranche_effectif_salarie':'2024','statut_diffusion':'O','etat_administratif':'A','siege':{'etat_administratif':'A'},'dirigeants':[{'nom':'MARTIN','prenoms':'ALICE','qualite':'Présidente de SAS'}]}
  def registry(url: str) -> JsonObject:
   return data_coerce_json_object({'results':[row if url.endswith('424281392') else {**row,'siren':'424761419','nom_complet':'OVH'}]})
  with tempfile.TemporaryDirectory() as tmp,patch_engine('fetch',return_value=('{"Answer":[{"type":15,"data":"10 mail.fixture.invalid."}]}','https://dns.google/'),target_module=prospecting):
   result=engine.refresh_proof(c,T,lambda _u:data_coerce_json_object(page),registry,Path(tmp))
  self.assertTrue(result['ok'],f'proof result: {result}');self.assertEqual(c['siren'],'424281392')
 def test_redirect_does_not_prove_company_identity(self) -> None:
  c: JsonObject={'email':'a@fixture.invalid','name':'Alice Martin','company':'Fixture Services','domain':'fixture.invalid','lane':'presse','sourceUrls':['https://fixture.invalid/']}
  with tempfile.TemporaryDirectory() as tmp:
   result=engine.refresh_proof(c,T,lambda u:{'url':'https://unrelated.invalid/','text':'','emails':[]},ops=Path(tmp))
  self.assertFalse(result['ok']);self.assertEqual(result['reason'],'primary_sources_unavailable')
 def test_french_copy_does_not_include_imported_english_claim(self) -> None:
  c: JsonObject={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture','lane':'pme','sourceUrls':['https://fixture.invalid/'],'topic':'Industrial maintenance group has already achieved 99% gains'}
  for v in ['A','B']:
   d=engine.draft(data_coerce_json_object(c),v);self.assertNotIn('Industrial',d['body']);self.assertNotIn('99%',d['body']);self.assertIn('les validations',d['body'])

@final
class ProfessionalMandateTests(unittest.TestCase):
 def page(self,path: str,block: str) -> JsonObject:return {'url':'https://fixture.invalid/'+path,'sha256':'fixture','roleBlocks':[block]}
 def test_current_company_professional_role_is_valid_without_legal_signatory_match(self) -> None:
  p=self.page('notre-equipe','Alice Martin, Directrice générale')
  role=engine.primary_mandate([p],'Alice Martin')
  if role is None:self.fail('expected the published professional mandate')
  self.assertEqual(role['qualite'],'directrice generale');self.assertEqual(role['basis'],'primary_company_professional_mandate')
 def test_old_articles_past_roles_and_unrelated_names_are_rejected(self) -> None:
  for p in [self.page('actualites/notre-equipe','Alice Martin, directrice générale'),self.page('notre-equipe','Ancienne directrice générale Alice Martin'),self.page('notre-equipe','Alice Martin, assistante. Bob Durand, directeur général')]:
   self.assertIsNone(engine.primary_mandate([p],'Alice Martin'))
 def test_legal_host_company_cannot_be_candidate_identity(self) -> None:
  pages=[{'text':'Fixture Services RCS Paris 424 281 392. OVH SIREN 424761419.'}]
  self.assertIn('424281392',engine.primary_sirens([data_coerce_json_object(page) for page in pages]))
  self.assertIsNone(engine.primary_mandate([self.page('mentions-legales','OVH, directeur Pierre Dupont')],'Alice Martin'))
 def test_national_reserve_query_filters_size_and_keeps_registry_separate(self) -> None:
  with (
   tempfile.TemporaryDirectory() as tmp,
   closing(engine.db_open(Path(tmp))) as db,
  ):
   recorder=FetchRecorder()
   with patch_engine('fetch',side_effect=recorder,target_module=prospecting):
    self.assertEqual(engine.reserve_national(db,T,'pme'),0)
   self.assertIn('tranche_effectif_salarie=21%2C22%2C31',recorder.url)
   self.assertEqual(data_sqlite_integer(data_sqlite_value(db,'select count(*) from candidates')),0)

@final
class AudienceReportingTests(unittest.TestCase):
 def test_qualified_historical_hold_is_not_reported_ready(self) -> None:
  with (
   tempfile.TemporaryDirectory() as tmp,
   closing(engine.db_open(Path(tmp))) as db,
  ):
   c=engine.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
   item={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture','domain':'fixture.invalid','lane':'presse','sourceUrls':['https://fixture.invalid/']}
   engine.put_candidate(db,data_coerce_json_object(item));_ = db.execute('update candidates set proof=?',(json.dumps({'ok':True,'checkedAt':T.isoformat()}),));db.commit()
   with patch_engine('suppressed',lambda:set[str]()):
    self.assertEqual(engine.audience_counts(db,'presse',T,c)['readyForInitial'],1)
    engine.append_legacy(db,data_coerce_json_object({'email':item['email'],'status':'operator_legacy_hold'}));db.commit()
    report=engine.audience_counts(db,'presse',T,c)
   self.assertEqual(report['qualified'],0);self.assertEqual(report['readyForInitial'],0);self.assertEqual(report['laneHistoricalReserveExcluded'],1);db.close()

@final
class PublishedMailboxTests(unittest.TestCase):
 def test_public_html_mailbox_encoding_is_exactly_decoded(self) -> None:
  key=0x47;email='redaction@fixture.invalid';token=bytes([key]+[x^key for x in email.encode()]).hex()
  self.assertEqual(engine.published_emails('<a data-cfemail="'+token+'">email</a>'),{email})
  self.assertEqual(engine.published_emails('alice&#64;fixture.invalid'),{'alice@fixture.invalid'})
 def test_malformed_encoding_never_constructs_an_address(self) -> None:
  self.assertEqual(engine.published_emails('<a data-cfemail="0">broken</a><a data-cfemail="00ff">broken</a>'),set())
 def test_primary_editorial_seed_keeps_legacy_hold(self) -> None:
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);cfg=root/'config';cfg.mkdir();ops=root/'campaigns/ops';ops.mkdir(parents=True)
   with closing(engine.db_open(root/'state')) as db:
    contact={'email':'redaction@fixture.invalid','name':'Rédaction','company':'Fixture','domain':'fixture.invalid','lane':'presse','sourceUrls':['https://fixture.invalid/contact'],'fitScore':90}
    _ = (cfg/'robinswood-evergreen-france-primary-seeds.json').write_text(json.dumps({'contacts':[contact]}))
    engine.append_legacy(db,data_coerce_json_object({'email':contact['email'],'status':'operator_legacy_hold'}));db.commit();engine.import_reserves(db,ops,cfg)
    self.assertEqual(db.execute('select count(*) from candidates').fetchone()[0],1)
    self.assertEqual(db.execute('select count(*) from legacy').fetchone()[0],1)

if __name__=='__main__':_ = unittest.main()

def tearDownModule() -> None:
    _offline_test_guard.assert_no_external_attempts()
