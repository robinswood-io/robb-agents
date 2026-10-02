#!/usr/bin/env python3
"""Offline safety/integration tests. No live credentials, networks, or contacts."""
import base64, copy, json, sqlite3, tempfile, unittest
from datetime import datetime,timedelta,timezone
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch
import outbound_sender_guard as guard
import robinswood_evergreen_france as engine
T=datetime(2026,10,5,8,0,tzinfo=timezone.utc)
def raw(op='test-op',lane='pme',email='alice@fixture.invalid',subject='Fixture'):
 m=EmailMessage();m['From']=guard.SENDER;m['To']=email;m['Subject']=subject
 m['Message-ID']='<'+op+'@robinswood.io>';m['X-RBW-Operation']=op;m['X-RBW-Campaign']=engine.IDS[lane]
 m.set_content('Bonjour Alice,\n\nTexte approuvé.\n\nSignature réelle\n')
 return base64.urlsafe_b64encode(m.as_bytes()).decode()
def message(data,mid='sent-1',thread='thread-1',t=T):
 m=guard.parse_raw(data);body=m.get_body(preferencelist=('plain',)).get_content()
 return {'id':mid,'threadId':thread,'labelIds':['SENT'],'internalDate':str(int(t.timestamp()*1000)),
 'payload':{'mimeType':'text/plain','headers':[{'name':k,'value':str(v)} for k,v in m.items()],
 'body':{'data':base64.urlsafe_b64encode(body.encode()).decode()}}}
class FakeGateway:
 def __init__(self):self.messages={};self.posts=0;self.fail_after_post=False;self.fail_before_post=False
 def get(self,mid):return self.messages[mid]
 def search(self,query):
  return [{'id':m['id']} for m in self.messages.values() if guard.header(m,'Message-ID').strip('<>')==query.split('rfc822msgid:')[-1]]
 def call(self,path):
  if path.startswith('/messages/'):return self.messages[path.split('/')[2].split('?')[0]]
  return {'messages':[{'id':k} for k in self.messages]}
 def post(self,data,thread=None):
  self.posts+=1
  if self.fail_before_post:raise TimeoutError('network ambiguity')
  m=message(data,'sent-'+str(self.posts),thread or 'thread-'+str(self.posts),t=getattr(self,'time',T));self.messages[m['id']]=m
  if self.fail_after_post:raise TimeoutError('response lost')
  return {'id':m['id'],'threadId':m['threadId']}
class GuardTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.g=FakeGateway()
 def tearDown(self):self.tmp.cleanup()
 def send(self,data=None,thread=None,t=T):
  data=data or raw();self.g.time=t;return guard.shared_send(self.g,data,thread,lambda:self.g.post(data,thread),ops=self.root,t=t)
 def test_exact_effect_and_idempotence(self):
  a=self.send();b=self.send();self.assertEqual(a['id'],b['id']);self.assertEqual(self.g.posts,1)
  db=guard.database(self.root/'outbound-sender-guard.sqlite3');self.assertEqual(db.execute("SELECT state FROM effects").fetchone()['state'],'verified');db.close()
 def test_payload_change_is_rejected(self):
  self.send()
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'payload_changed'):self.send(raw(subject='Mutated'))
  self.assertEqual(self.g.posts,1)
 def test_ambiguous_success_reconciles_without_second_post(self):
  self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):self.send()
  self.g.fail_after_post=False
  result=self.send();self.assertTrue(result['deduplicated']);self.assertEqual(self.g.posts,1)
 def test_unknown_never_blindly_retries(self):
  self.g.fail_before_post=True
  with self.assertRaises(TimeoutError):self.send()
  self.g.fail_before_post=False
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'unresolved'):self.send()
  self.assertEqual(self.g.posts,1)
 def test_lunch_weekend_and_end_exclusive(self):
  for t in [T.replace(hour=10),T.replace(hour=16),T+timedelta(days=5)]:
   with self.subTest(t=t):
    with self.assertRaisesRegex(guard.SenderGuardBlocked,'window'):self.send(t=t)
  self.assertEqual(self.g.posts,0)
 def test_scotland_timezone_is_preserved(self):
  data=raw();m=guard.parse_raw(data);m.replace_header('X-RBW-Campaign','scotland-executive-conference-october-2026');data=base64.urlsafe_b64encode(m.as_bytes()).decode()
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'window'):guard.shared_send(self.g,data,None,lambda:self.g.post(data),ops=self.root,t=T.replace(hour=7))
  guard.shared_send(self.g,data,None,lambda:self.g.post(data),ops=self.root,t=T)
 def test_global_daily_cap_counts_all_sent_campaigns(self):
  for i in range(40):self.g.messages[str(i)]=message(raw('old-'+str(i)),str(i),t=T-timedelta(hours=1,seconds=i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'daily'):self.send()
  self.assertEqual(self.g.posts,0)
 def test_interval_and_rolling_hour(self):
  self.send()
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'interval'):self.send(raw('second'),t=T+timedelta(seconds=599))
  self.send(raw('second'),t=T+timedelta(seconds=600));self.assertEqual(self.g.posts,2)
  self.assertEqual(guard.counts(list(self.g.messages.values()),T+timedelta(seconds=3600))['hourly'],1)
 def test_weekly_and_hourly_caps(self):
  messages=[message(raw('old-'+str(i)),str(i),t=T+timedelta(seconds=601+i)) for i in range(6)]
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'hourly'):guard.capacity(messages,T+timedelta(seconds=2000))
  messages=[message(raw('old-'+str(i)),str(i),t=T+timedelta(days=1,seconds=i)) for i in range(200)]
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'weekly'):guard.capacity(messages,T+timedelta(days=3))
 def test_cc_sender_campaign_and_attachment_guard(self):
  for mutate in [lambda m:m.__setitem__('Cc','other@fixture.invalid'),lambda m:m.replace_header('From','other@fixture.invalid'),lambda m:m.replace_header('X-RBW-Campaign','unapproved'),lambda m:m.add_attachment(b'x',maintype='application',subtype='octet-stream',filename='x.bin')]:
   m=guard.parse_raw(raw());mutate(m);data=base64.urlsafe_b64encode(m.as_bytes()).decode()
   with self.assertRaises(guard.SenderGuardBlocked):guard.expected(data)
 def test_exact_body_signature_subject_recipient_thread(self):
  data=raw();m=message(data);self.assertTrue(guard.verify(m,data,'thread-1')[0])
  for h,value in [('Subject','Changed'),('To','other@fixture.invalid'),('X-RBW-Campaign',engine.IDS['eti'])]:
   changed=copy.deepcopy(m);next(x for x in changed['payload']['headers'] if x['name']==h)['value']=value
   self.assertFalse(guard.verify(changed,data,'thread-1')[0])
  changed=copy.deepcopy(m);changed['payload']['body']['data']=base64.urlsafe_b64encode(b'No signature\n').decode()
  self.assertFalse(guard.verify(changed,data)[0]);self.assertFalse(guard.verify(m,data,'other')[0])
class EngineTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=engine.db_open(self.root)
  self.c=engine.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
 def tearDown(self):self.db.close();self.tmp.cleanup()
 def test_contract_tamper_rejected(self):
  altered=copy.deepcopy(self.c);altered['lanes']['pme']['dailyMax']=40;p=self.root/'contract.json';p.write_text(json.dumps(altered))
  with self.assertRaises(AssertionError):engine.contract(p)
 def test_business_windows_DST_and_weekend(self):
  self.assertTrue(engine.in_window(T,self.c))
  for t in [T.replace(hour=10),T.replace(hour=16),T+timedelta(days=5)]:self.assertFalse(engine.in_window(t,self.c))
  self.assertTrue(engine.in_window(datetime(2026,11,2,8,tzinfo=timezone.utc),self.c))
 def test_exact_email_required_never_nominal_inference(self):
  c={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture','lane':'pme','siren':'111111111','domain':'fixture.invalid','sourceUrls':['https://fixture.invalid/']}
  page={'url':c['sourceUrls'][0],'text':'Fixture 111111111 Alice Martin Directrice','sha256':'x','emails':set()}
  proof=engine.refresh_proof(c,T,fetch_page=lambda _:page,ops=self.root)
  self.assertFalse(proof['ok']);self.assertIn('exact_email',proof['reason'])
 def test_publication_or_send_is_not_learning_reward(self):
  self.assertEqual(engine.learning(self.db,'pme',T,self.c)['variants']['A']['qualified'],0)
  self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('r','a@fixture.invalid','pme','interest',T.isoformat(),'{}'));self.db.commit()
  learn=engine.learning(self.db,'pme',T,self.c);self.assertIsNone(learn['winner']);self.assertEqual(learn['variants']['A']['qualified'],0)
 def test_quotes_automatic_replies_and_yes_do_not_become_need(self):
  m=message(raw());m['labelIds']=[];m['payload']['body']['data']=base64.urlsafe_b64encode('Oui, merci.\n\nLe 1 octobre, Thibault a écrit :\n5000 euros pour le flux'.encode()).decode()
  trimmed=engine.new_reply_text(m);self.assertEqual(engine.classify_reply(trimmed,'pme'),'interest')
  m['payload']['headers'].append({'name':'Auto-Submitted','value':'auto-replied'})
  self.assertEqual(engine.classify_reply(trimmed,'pme'),'automatic_reply')
 def test_quantified_need_editorial_interest_and_opposition(self):
  m=message(raw())
  for text,lane,kind in [('Le flux de devis mobilise 30 heures par semaine.','pme','qualified_need'),('Merci, pouvez-vous envoyer une note d’angle pour notre article ?','presse','editorial_request'),('STOP, ne plus me contacter','eti','opposition'),('Je vais signaler votre message comme spam','pme','complaint')]:
   m['payload']['body']['data']=base64.urlsafe_b64encode(text.encode()).decode();self.assertEqual(engine.classify_reply(m,lane),kind)
 def test_new_cohort_bounce_stops_lane(self):
  self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('b','a@fixture.invalid','pme','bounce',T.isoformat(),'{}'));self.db.commit()
  self.assertEqual(engine.lane_capacity(self.db,'pme',T,self.c),(False,'new_cohort_bounce_pause_awaiting_independent_smtp_proofs'))
 def test_canary_and_all_effects_share_one_daily_budget(self):
  data=raw();self.db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',('op','a@fixture.invalid','pme','reply','A',self.c['copyVersion'],T.isoformat(),'verified',data,'body','s','id','thread','{}'));self.db.commit()
  ok,info=engine.lane_capacity(self.db,'pme',T,self.c);self.assertFalse(ok);self.assertEqual(info['dailyCap'],1)
 def test_sender_signature_and_original_thread_subject_copy(self):
  item={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture','lane':'pme','sourceUrls':['https://fixture.invalid/'],'topic':'les devis'}
  d=engine.draft(item,'A','followup',subject='Ancien objet réellement envoyé')
  self.assertEqual(d['subject'],'Ancien objet réellement envoyé');self.assertIn('STOP',d['body'])
  self.assertNotIn('5000 heures',engine.draft(item,'A')['body'])
 def test_legacy_contact_can_never_be_new_prospect(self):
  engine.put_candidate(self.db,{'email':'a@fixture.invalid','lane':'pme','company':'Fixture','domain':'fixture.invalid','sourceUrls':['https://fixture.invalid/']})
  self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'checkedAt':T.isoformat()}),))
  engine.append_legacy(self.db,{'recipientEmail':'a@fixture.invalid','status':'sent','campaignId':'old'});self.db.commit()
  with patch.object(engine,'suppressed',return_value=set()):row,step,_=engine.next_item(self.db,'pme',T,self.c)
  self.assertIsNone(row)

 def test_recovery_requires_three_fresh_independent_smtp_proofs(self):
  self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('b','old@fixture.invalid','pme','bounce',(T-timedelta(days=8)).isoformat(),'{}'))
  for i in range(3):
   engine.put_candidate(self.db,{'email':str(i)+'@fixture.invalid','lane':'pme','name':'Fixture Person','company':'Fixture '+str(i),'domain':'fixture.invalid','sourceUrls':['https://fixture.invalid/']})
  self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'smtpVerified':False,'checkedAt':T.isoformat()}),));self.db.commit()
  with patch.object(engine,'suppressed',return_value=set()):
   self.assertFalse(engine.lane_capacity(self.db,'pme',T,self.c)[0])
   self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'smtpVerified':True,'checkedAt':T.isoformat()}),));self.db.commit()
   allowed,info=engine.lane_capacity(self.db,'pme',T,self.c)
  self.assertTrue(allowed);self.assertEqual(info['dailyCap'],1)
  self.assertEqual(self.db.execute("SELECT count(*) FROM replies WHERE kind='bounce'").fetchone()[0],1)
 def test_complaints_are_never_auto_recovered(self):
  self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',('c','old@fixture.invalid','pme','complaint',(T-timedelta(days=30)).isoformat(),'{}'));self.db.commit()
  self.assertEqual(engine.lane_capacity(self.db,'pme',T,self.c),(False,'complaint_pause'))
 def test_recent_risky_provider_evidence_blocks_public_mailbox(self):
  c={'email':'a@fixture.invalid','emailVerification':{'checkedAt':T.isoformat(),'result':'risky'}}
  self.assertEqual(engine.delivery_blocker(c,T,self.root),'recent_adverse_delivery_evidence')

 def test_provider_proof_requires_fresh_smtp_no_catchall(self):
  c={'emailVerification':{'provider':'hunter','statusCode':200,'result':'deliverable','score':100,'checkedAt':T.isoformat(),'smtpCheck':True,'acceptAll':False,'block':False}}
  self.assertTrue(engine.provider_delivery(c,T))
  c['emailVerification']['acceptAll']=True;self.assertFalse(engine.provider_delivery(c,T))
  c['emailVerification']['acceptAll']=False;c['emailVerification']['checkedAt']=(T-timedelta(days=8)).isoformat();self.assertFalse(engine.provider_delivery(c,T))
 def test_media_enrichment_preserves_budget_and_holds(self):
  import robinswood_media_contact_enrichment_2026 as helper
  row={'id':'fixture','recordType':'email_contact','email':'a@fixture.invalid','contactName':'Alice Martin'}
  data={'result':'deliverable','score':100,'smtp_check':True,'accept_all':False,'block':False,'mx_records':True}
  with patch.object(helper,'verify_email',return_value={'statusCode':200,'body':{'data':data}}) as call:
   updated,left,event=helper.row_outcome(row,'fixture-key',1)
  self.assertEqual(call.call_count,1);self.assertEqual(left,0);self.assertEqual(event['hunterCalls'],1)
  self.assertTrue(updated['emailVerification']['smtpCheck']);self.assertFalse(updated['outreachEligible'])
  self.assertEqual(updated['email'],row['email'])
  updated['outreachStatus']='not_eligible_legacy_pr_hold';self.assertFalse(helper.eligible_for_processing(updated))
 def test_media_high_score_risky_is_not_verified(self):
  import robinswood_media_contact_enrichment_2026 as helper
  row={'id':'fixture','recordType':'email_contact','email':'a@fixture.invalid'}
  with patch.object(helper,'verify_email',return_value={'statusCode':200,'body':{'data':{'result':'risky','score':100,'smtp_check':True,'accept_all':True,'block':False}}}):
   updated,left,event=helper.row_outcome(row,'fixture-key',1)
  self.assertEqual(updated['enrichmentStatus'],'email_not_verified_review_or_replace');self.assertFalse(updated['outreachEligible'])

class EndGateway(engine.Gateway,FakeGateway):
 def __init__(self,root,t=T):
  FakeGateway.__init__(self);self.root=root;self.time=t;self.identity={'signature':'<div>Thibault Fritsch<br>Robinswood</div>','verificationStatus':'accepted'}
 def call(self,path,data=None):
  if path.startswith('/threads/'):
   tid=path.split('/')[2].split('?')[0];return {'messages':[m for m in self.messages.values() if m['threadId']==tid]}
  return FakeGateway.call(self,path)
 def send(self,data,thread_id=None):
  return guard.shared_send(self,data,thread_id,lambda:self.post(data,thread_id),ops=self.root/'sender',t=self.time)
class EndToEndTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=engine.db_open(self.root)
  self.c=engine.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
  item={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture Services','domain':'fixture.invalid','lane':'pme','sourceUrls':['https://fixture.invalid/'],'topic':'les devis'}
  engine.put_candidate(self.db,item)
  self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'checkedAt':T.isoformat()}),));self.db.commit()
  self.g=EndGateway(self.root)
  self.patches=[patch.object(engine,'OPS',self.root/'reports'),patch.object(engine,'import_reserves',lambda db:None),patch.object(engine,'suppressed',lambda:set()),patch.object(engine,'now',lambda:T)]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.db.close();self.tmp.cleanup()
 def execute(self):return engine.run('pme',apply=True,root=self.root,c=self.c,gateway=self.g,t=T,research_batch=0)
 def test_dispatch_exact_effect_then_idempotence(self):
  r=self.execute();self.assertEqual(r['status'],'sent_verified');self.assertEqual(r['counts']['sentNow'],1)
  row=self.db.execute('SELECT * FROM touches').fetchone();self.assertEqual(row['state'],'verified')
  self.assertIn('Robinswood',row['expected']);self.assertEqual(guard.header(self.g.get(row['gmail_id']),'X-RBW-Campaign'),engine.IDS['pme'])
  r=self.execute();self.assertEqual(r['counts']['sentNow'],0);self.assertEqual(self.g.posts,1)
 def test_lost_post_response_recovered_without_resend(self):
  self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):self.execute()
  self.g.fail_after_post=False;r=self.execute()
  self.assertEqual(self.g.posts,1);self.assertEqual(r['counts']['sentNow'],0)
  self.assertEqual(self.db.execute('SELECT state FROM touches').fetchone()['state'],'verified')
 def test_proven_presend_refusal_is_not_an_unknown_effect(self):
  with patch.object(self.g,'send',side_effect=guard.SenderGuardBlocked('shared_sender_daily_cap')):
   r=self.execute();self.assertEqual(r['counts']['sentNow'],0)
  self.assertEqual(self.db.execute('SELECT count(*) n FROM touches').fetchone()['n'],0)
  r=self.execute();self.assertEqual(r['counts']['sentNow'],1)
 def test_scotland_presend_refusal_does_not_poison_reservations(self):
  import scotland_executive_conference_october_tests as prior
  case=prior.CampaignTests();case.setUp()
  try:
   g=prior.Fake()
   with patch.object(g,'send',side_effect=guard.SenderGuardBlocked('shared_sender_daily_cap')):
    r=case.runit(g);self.assertEqual(r['externalSendsThisRun'],0)
   db=engine.transport.database(case.root)
   self.assertEqual(db.execute('SELECT count(*) FROM touches').fetchone()[0],0);db.close()
   self.assertNotIn('unknown_gmail_effect',r['blockingReasons'])
   self.assertEqual(case.runit(g)['externalSendsThisRun'],1)
  finally:case.tearDown()


class PrimaryIdentityRegressionTests(unittest.TestCase):
 def test_siren_and_siret_spacing_and_publisher_identity(self):
  pages=[{'text':'Éditeur Fixture Services. RCS Paris 424 281 392. Hébergeur OVH SIRET 424 761 419 00045.'}]
  self.assertEqual(engine.primary_sirens(pages),['424281392','424761419'])
  self.assertEqual(engine.primary_sirens([{'text':'Téléphone 012345678. Aucun identifiant légal.'}]),[])
 def test_owned_subdomain_and_foreign_redirect(self):
  self.assertTrue(engine.owned_domain('https://fr.fixture.invalid/contact','fixture.invalid'))
  self.assertFalse(engine.owned_domain('https://fixture.invalid.attacker.invalid/','fixture.invalid'))
  self.assertFalse(engine.owned_domain('https://other.invalid/','fixture.invalid'))
 def test_contact_links_exclude_assets_and_equipment(self):
  html='<html lang="fr"><a href="/wp-content/contact-form.css">CSS</a><a href="/les-equipements">Équipement</a><a href="/mentions-legales">Mentions</a><a href="/decouvrir-les-equipes#dirigeants">Équipe</a></html>'
  with patch.object(engine,'fetch',return_value=(html,'https://fixture.invalid/')):
   page=engine.public_page('https://fixture.invalid/')
  self.assertEqual(page['contactLinks'],['https://fixture.invalid/mentions-legales','https://fixture.invalid/decouvrir-les-equipes'])
 def test_missing_siren_is_bound_to_official_publisher_not_host(self):
  c={'email':'alice.martin@fixture.invalid','name':'Alice Martin','company':'Fixture Services','domain':'fixture.invalid','lane':'pme','sourceUrls':['https://fixture.invalid/']}
  page={'url':c['sourceUrls'][0],'text':'Fixture Services, présidente Alice Martin. RCS Paris 424 281 392. Hébergeur OVH SIREN 424761419.','emails':{c['email']},'sha256':'fixture','contactLinks':[]}
  row={'siren':'424281392','nom_complet':'FIXTURE SERVICES','categorie_entreprise':'PME','tranche_effectif_salarie':'21','annee_tranche_effectif_salarie':'2024','statut_diffusion':'O','etat_administratif':'A','siege':{},'dirigeants':[{'nom':'MARTIN','prenoms':'ALICE','qualite':'Présidente de SAS'}]}
  def registry(url):
   return {'results':[row if url.endswith('424281392') else {**row,'siren':'424761419','nom_complet':'OVH'}]}
  with tempfile.TemporaryDirectory() as tmp,patch.object(engine,'fetch',return_value=('{"Answer":[{"type":15,"data":"10 mail.fixture.invalid."}]}','https://dns.google/')):
   result=engine.refresh_proof(c,T,lambda u:page,registry,Path(tmp))
  self.assertTrue(result['ok']);self.assertEqual(c['siren'],'424281392')
 def test_redirect_does_not_prove_company_identity(self):
  c={'email':'a@fixture.invalid','name':'Alice Martin','company':'Fixture Services','domain':'fixture.invalid','lane':'presse','sourceUrls':['https://fixture.invalid/']}
  with tempfile.TemporaryDirectory() as tmp:
   result=engine.refresh_proof(c,T,lambda u:{'url':'https://unrelated.invalid/','text':'','emails':set()},ops=Path(tmp))
  self.assertFalse(result['ok']);self.assertEqual(result['reason'],'primary_sources_unavailable')
 def test_french_copy_does_not_include_imported_english_claim(self):
  c={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture','lane':'pme','sourceUrls':['https://fixture.invalid/'],'topic':'Industrial maintenance group has already achieved 99% gains'}
  for v in ['A','B']:
   d=engine.draft(c,v);self.assertNotIn('Industrial',d['body']);self.assertNotIn('99%',d['body']);self.assertIn('les validations',d['body'])


class ProfessionalMandateTests(unittest.TestCase):
 def page(self,path,block):return {'url':'https://fixture.invalid/'+path,'sha256':'fixture','roleBlocks':[block]}
 def test_current_company_professional_role_is_valid_without_legal_signatory_match(self):
  p=self.page('notre-equipe','Alice Martin, Directrice générale')
  role=engine.primary_mandate([p],'Alice Martin')
  self.assertEqual(role['qualite'],'directrice generale');self.assertEqual(role['basis'],'primary_company_professional_mandate')
 def test_old_articles_past_roles_and_unrelated_names_are_rejected(self):
  for p in [self.page('actualites/notre-equipe','Alice Martin, directrice générale'),self.page('notre-equipe','Ancienne directrice générale Alice Martin'),self.page('notre-equipe','Alice Martin, assistante. Bob Durand, directeur général')]:
   self.assertIsNone(engine.primary_mandate([p],'Alice Martin'))
 def test_legal_host_company_cannot_be_candidate_identity(self):
  pages=[{'text':'Fixture Services RCS Paris 424 281 392. OVH SIREN 424761419.'}]
  self.assertIn('424281392',engine.primary_sirens(pages))
  self.assertIsNone(engine.primary_mandate([self.page('mentions-legales','OVH, directeur Pierre Dupont')],'Alice Martin'))
 def test_national_reserve_query_filters_size_and_keeps_registry_separate(self):
  with tempfile.TemporaryDirectory() as tmp:
   db=engine.db_open(Path(tmp))
   with patch.object(engine,'fetch',return_value=('{"results":[],"total_pages":1}','https://registry.invalid')) as request:
    self.assertEqual(engine.reserve_national(db,T,'pme'),0)
   self.assertIn('tranche_effectif_salarie=21%2C22%2C31',request.call_args[0][0]);self.assertEqual(db.execute('select count(*) from candidates').fetchone()[0],0);db.close()


class AudienceReportingTests(unittest.TestCase):
 def test_qualified_historical_hold_is_not_reported_ready(self):
  with tempfile.TemporaryDirectory() as tmp:
   db=engine.db_open(Path(tmp));c=engine.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
   item={'email':'alice@fixture.invalid','name':'Alice Martin','company':'Fixture','domain':'fixture.invalid','lane':'presse','sourceUrls':['https://fixture.invalid/']}
   engine.put_candidate(db,item);db.execute('update candidates set proof=?',(json.dumps({'ok':True,'checkedAt':T.isoformat()}),));db.commit()
   with patch.object(engine,'suppressed',lambda:set()):
    self.assertEqual(engine.audience_counts(db,'presse',T,c)['readyForInitial'],1)
    engine.append_legacy(db,{'email':item['email'],'status':'operator_legacy_hold'});db.commit()
    report=engine.audience_counts(db,'presse',T,c)
   self.assertEqual(report['qualified'],0);self.assertEqual(report['readyForInitial'],0);self.assertEqual(report['laneHistoricalReserveExcluded'],1);db.close()


class PublishedMailboxTests(unittest.TestCase):
 def test_public_html_mailbox_encoding_is_exactly_decoded(self):
  key=0x47;email='redaction@fixture.invalid';token=bytes([key]+[x^key for x in email.encode()]).hex()
  self.assertEqual(engine.published_emails('<a data-cfemail="'+token+'">email</a>'),{email})
  self.assertEqual(engine.published_emails('alice&#64;fixture.invalid'),{'alice@fixture.invalid'})
 def test_malformed_encoding_never_constructs_an_address(self):
  self.assertEqual(engine.published_emails('<a data-cfemail="0">broken</a><a data-cfemail="00ff">broken</a>'),set())
 def test_primary_editorial_seed_keeps_legacy_hold(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);cfg=root/'config';cfg.mkdir();ops=root/'campaigns/ops';ops.mkdir(parents=True);db=engine.db_open(root/'state')
   contact={'email':'redaction@fixture.invalid','name':'Rédaction','company':'Fixture','domain':'fixture.invalid','lane':'presse','sourceUrls':['https://fixture.invalid/contact'],'fitScore':90}
   (cfg/'robinswood-evergreen-france-primary-seeds.json').write_text(json.dumps({'contacts':[contact]}))
   engine.append_legacy(db,{'email':contact['email'],'status':'operator_legacy_hold'});db.commit();engine.import_reserves(db,ops,cfg)
   self.assertEqual(db.execute('select count(*) from candidates').fetchone()[0],1)
   self.assertEqual(db.execute('select count(*) from legacy').fetchone()[0],1);db.close()

if __name__=='__main__':unittest.main()
