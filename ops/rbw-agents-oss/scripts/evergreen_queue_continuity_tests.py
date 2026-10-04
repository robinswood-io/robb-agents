#!/usr/bin/env python3
"""Offline continuity/legacy safety proofs; no external recipients or requests."""
import base64,copy,json,sqlite3,tempfile,unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
import robinswood_evergreen_france as e
import evergreen_queue_continuity as q
import evergreen_sender_pilot as pilot
import outbound_sender_guard as guard
import robinswood_evergreen_france_tests as fixture
T=fixture.T
class QueueTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=e.db_open(self.root)
  self.c=e.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
  self.cfg=q.policy(Path(__file__).parent.parent/'config/robinswood-evergreen-queue.json')
  self.real_policy=q.policy;self.patch=patch.object(q,'policy',return_value=self.cfg);self.patch.start()
  self.g=fixture.EndGateway(self.root)
  def search(query):
   if query.startswith('in:sent to:'):
    email=query.split('to:')[-1]
    return [{'id':m['id']} for m in self.g.messages.values() if 'SENT' in m.get('labelIds',[]) and e.transport.addresses(guard.header(m,'To'))==[email]]
   if query.startswith('from:'):
    email=query.split('from:')[1].split(' ')[0]
    return [{'id':m['id']} for m in self.g.messages.values() if 'SENT' not in m.get('labelIds',[]) and e.transport.addresses(guard.header(m,'From'))==[email]]
   return fixture.FakeGateway.search(self.g,query)
  self.g.search=search
 def tearDown(self):self.patch.stop();self.db.close();self.tmp.cleanup()
 def candidate(self,email='editor@fixture.invalid',lane='presse',company='Fixture'):
  item={'email':email,'name':'Fixture Person','company':company,'domain':'fixture.invalid','lane':lane,'sourceUrls':['https://fixture.invalid/']}
  e.put_candidate(self.db,item);self.db.execute('UPDATE candidates SET proof=?,checked=? WHERE email=?',(json.dumps({'ok':True,'checkedAt':e.stamp(T)}),e.stamp(T),email));self.db.commit()
  return self.db.execute('SELECT * FROM candidates WHERE email=?',(email,)).fetchone()
 def legacy(self,email='editor@fixture.invalid',campaign='robinswood-media-authority-2026',state='sent',age=14):
  row=self.candidate(email);data=fixture.raw('legacy-op',lane='presse',email=email,subject='Objet réellement envoyé en juillet')
  m=guard.parse_raw(data);del m['X-RBW-Campaign'];del m['X-RBW-Operation'];data=base64.urlsafe_b64encode(m.as_bytes()).decode()
  message=fixture.message(data,'original','original-thread',T-timedelta(days=age));self.g.messages['original']=message
  self.db.execute('INSERT INTO legacy VALUES(?,?,?,?,?)',(email,campaign,'original',guard.header(message,'Subject'),state));self.db.commit();return row,message
 def audit(self):return q.audit_historical(self.db,self.g,'presse',T,set(),e.business_days,self.cfg)
 def runit(self):
  self.g.time=T
  with patch.object(e,'OPS',self.root/'reports'),patch.object(e,'import_reserves',lambda db:None),patch.object(e,'suppressed',return_value=set()),patch.object(e,'now',return_value=T):
   return e.run('presse',apply=True,root=self.root,c=self.c,gateway=self.g,t=T,research_batch=0)
 def test_policy_rejects_arbitrary_replay_caps_or_new_legacy_cohort(self):
  for key,value in [('historicalFollowupMaximum',2),('historicalFollowupCampaigns',['robinswood-pme-hdf-dirigeants-2026-06']),('paidAllowed',True)]:
   c=copy.deepcopy(self.cfg);c[key]=value;p=self.root/'bad.json';p.write_text(json.dumps(c))
   with self.assertRaises(AssertionError):self.real_policy(p)
 def test_empty_qualified_supply_is_reported_honestly_and_refill_required(self):
  state=q.coverage(self.db,'pme',T,self.c,e.audience_counts(self.db,'pme',T,self.c),self.cfg)
  self.assertEqual(state['readyPotentialBeforeGmailAndQuotaChecks'],0);self.assertTrue(state['refillRequired']);self.assertTrue(state['qualifiedSupplyCanBeZero'])
  self.assertFalse(state['contactsOrRepliesRepeatedToFillQueue']);self.assertEqual(state['targetQualifiedReserve'],36)
 def test_refill_uses_low_water_and_bounded_hourly_daily_backoff(self):
  self.assertFalse(q.refill_allowed(self.db,'pme',T,False,self.cfg))
  self.assertTrue(q.refill_allowed(self.db,'pme',T,True,self.cfg))
  self.assertFalse(q.refill_allowed(self.db,'pme',T+timedelta(seconds=3599),True,self.cfg))
  for i in range(1,8):self.assertTrue(q.refill_allowed(self.db,'pme',T+timedelta(hours=i),True,self.cfg))
  self.assertFalse(q.refill_allowed(self.db,'pme',T+timedelta(hours=8),True,self.cfg))
  self.assertTrue(q.refill_allowed(self.db,'pme',T+timedelta(days=1),True,self.cfg))
 def test_failed_proofs_retry_before_seven_days_valid_proofs_do_not(self):
  self.candidate('failed@fixture.invalid','pme','Failed');self.candidate('valid@fixture.invalid','pme','Valid')
  self.db.execute("UPDATE candidates SET checked=?",(e.stamp(T-timedelta(days=2)),))
  self.db.execute("UPDATE candidates SET proof=? WHERE email='failed@fixture.invalid'",(json.dumps({'ok':False,'checkedAt':e.stamp(T-timedelta(days=2))}),));self.db.commit()
  seen=[]
  def refresh(item,t):seen.append(item['email']);return {'ok':False,'checkedAt':e.stamp(t),'reason':'still_unproven'}
  with patch.object(e,'refresh_proof',side_effect=refresh):e.research(self.db,T,batch=10,lane='pme')
  self.assertEqual(seen,['failed@fixture.invalid'])
 def test_operator_holds_and_hdf_pause_are_not_lifted_for_queue_volume(self):
  self.legacy(state='operator_legacy_hold');self.assertEqual(self.audit()['checked'],0)
  self.db.execute("UPDATE legacy SET state='sent',campaign='robinswood-pme-hdf-dirigeants-2026-06'");self.db.commit()
  self.assertEqual(self.audit()['checked'],0);self.assertIsNone(q.historical_parent(self.db,'editor@fixture.invalid'))
 def test_legacy_original_without_custom_headers_is_verified_by_canonical_effect(self):
  row,message=self.legacy();result=self.audit()
  self.assertEqual(result['eligible'],1);parent=q.historical_parent(self.db,row['email']);self.assertTrue(q.validate_parent(message,parent))
  self.assertEqual(self.db.execute('SELECT count(*) FROM touches').fetchone()[0],0)
  self.assertEqual(self.db.execute('SELECT state FROM legacy').fetchone()[0],'sent')
 def test_wrong_original_sender_recipient_missing_body_and_suppression_hold(self):
  for change in ['sender','recipient','body','suppression']:
   with self.subTest(change=change):
    self.db.execute('DELETE FROM legacy');self.db.execute('DELETE FROM historical_threads');self.db.commit()
    row,message=self.legacy();blocked=set()
    if change=='suppression':blocked={row['email']}
    elif change=='body':message['payload']['body']['data']=''
    else:next(h for h in message['payload']['headers'] if h['name']==('From' if change=='sender' else 'To'))['value']='other@fixture.invalid'
    self.assertEqual(q.audit_historical(self.db,self.g,'presse',T,blocked,e.business_days,self.cfg)['eligible'],0)
 def test_existing_thread_reply_or_later_touch_stops_legacy_followup(self):
  row,message=self.legacy();other=copy.deepcopy(message);other['id']='later';self.g.messages['later']=other
  self.assertEqual(self.audit()['eligible'],0)
 def test_legacy_followup_due_before_new_cold_contact_and_sent_once_in_original_thread(self):
  row,parent=self.legacy();self.audit();self.candidate('aaa-new@fixture.invalid',company='Other')
  result=self.runit();self.assertEqual(result['status'],'sent_verified')
  effect=self.db.execute('SELECT * FROM touches').fetchone()
  self.assertEqual(effect['email'],row['email']);self.assertEqual(effect['step'],'followup')
  self.assertEqual(effect['subject'],guard.header(parent,'Subject'));self.assertEqual(effect['thread'],'original-thread')
  self.assertEqual(pilot.touch_identity(effect),(pilot.PRIMARY,'legacy'));self.assertEqual(self.g.posts,1)
  self.runit();self.assertEqual(self.g.posts,1)
  self.assertEqual(e.learning(self.db,'presse',T+timedelta(days=14),self.c)['variants']['A']['matured'],0)
 def test_new_reply_between_audit_and_send_blocks_before_post(self):
  row,parent=self.legacy();self.audit();other=copy.deepcopy(parent);other['id']='reply';self.g.messages['reply']=other
  self.assertEqual(self.runit()['status'],'historical_followup_held')
  self.assertEqual(self.g.posts,0);self.assertEqual(self.db.execute('select count(*) from touches').fetchone()[0],0)
 def test_original_effect_mutation_after_audit_is_rejected_before_post(self):
  row,parent=self.legacy();self.audit();parent['payload']['body']['data']=base64.urlsafe_b64encode(b'Mutated original').decode()
  self.assertEqual(self.runit()['status'],'historical_followup_held')
  self.assertEqual(self.g.posts,0)
 def test_legacy_lost_response_reconciles_without_repeating_or_resetting_history(self):
  self.legacy();self.audit();self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):self.runit()
  self.g.fail_after_post=False;self.runit();self.assertEqual(self.g.posts,1)
  self.assertEqual(self.db.execute('select count(*) from legacy').fetchone()[0],1)
  self.assertEqual(self.db.execute('select state from touches').fetchone()[0],'verified')
 def test_expired_proof_does_not_make_old_contact_ready(self):
  row,_=self.legacy();self.audit();self.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'checkedAt':e.stamp(T-timedelta(days=8))}),));self.db.commit()
  with patch.object(e,'suppressed',return_value=set()):
   self.assertIsNone(e.next_item(self.db,'presse',T,self.c)[0])
  coverage=q.coverage(self.db,'presse',T,self.c,e.audience_counts(self.db,'presse',T,self.c),self.cfg)
  self.assertEqual(coverage['followupsDueBeforeFreshChecks'],0)
 def test_additive_snapshot_keeps_history_and_original_touch_schema(self):
  backup=Path(self.db.execute("SELECT value FROM metadata WHERE key='historical_queue_schema_backup'").fetchone()[0]);original=sqlite3.connect(backup)
  self.assertIsNotNone(original.execute("SELECT name FROM sqlite_master WHERE name='sender_bindings'").fetchone());self.assertIsNone(original.execute("SELECT name FROM sqlite_master WHERE name='historical_threads'").fetchone());original.close()
  self.assertEqual(len(self.db.execute('pragma table_info(touches)').fetchall()),14)
 def test_replies_to_legacy_followup_are_scanned_and_do_not_become_fake_bookings(self):
  row,parent=self.legacy();self.audit();self.runit()
  incoming=fixture.message(fixture.raw('incoming',lane='presse',email=pilot.PRIMARY),'incoming','original-thread',T+timedelta(hours=1));incoming['labelIds']=[]
  next(h for h in incoming['payload']['headers'] if h['name']=='From')['value']=row['email']
  incoming['payload']['body']['data']=base64.urlsafe_b64encode('Merci, pouvez-vous envoyer une note d’angle pour notre article ?'.encode()).decode();self.g.messages['incoming']=incoming
  with patch.object(e,'suppress'):self.assertEqual(e.reply_scan(self.db,self.g,'presse',T+timedelta(hours=1)),1)
  self.assertEqual(self.db.execute('select kind from replies').fetchone()[0],'editorial_request')
  self.assertFalse(e.learning(self.db,'presse',T+timedelta(days=14),self.c)['bookingsInferred'])
 def test_immutable_other_sender_assignment_holds_historical_company(self):
  row,_=self.legacy();self.audit();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T)
  self.assertEqual(pilot.plan(self.db,row,'followup',self.c,T,{'dailyCap':10}),(None,None))
 def test_transient_history_read_retries_after_bounded_backoff(self):
  row,_=self.legacy()
  with patch.object(self.g,'get',side_effect=TimeoutError):self.assertEqual(self.audit()['held'],1)
  self.assertEqual(self.audit()['checked'],0)
  retry=q.audit_historical(self.db,self.g,'presse',T+timedelta(hours=25),set(),e.business_days,self.cfg)
  self.assertEqual(retry['eligible'],1)
 def test_changed_old_thread_does_not_starve_next_eligible_new_contact(self):
  row,parent=self.legacy();self.audit();self.candidate('aaa-new@fixture.invalid',company='Other')
  other=copy.deepcopy(parent);other['id']='later';self.g.messages['later']=other
  self.assertEqual(self.runit()['status'],'historical_followup_held')
  self.assertEqual(self.runit()['status'],'sent_verified');self.assertEqual(self.g.posts,1)
  self.assertEqual(self.db.execute('SELECT email FROM touches').fetchone()[0],'aaa-new@fixture.invalid')
 def test_old_optout_suppresses_globally_without_resetting_or_contaminating_new_metrics(self):
  row,parent=self.legacy();incoming=copy.deepcopy(parent);incoming['id']='old-optout';incoming['labelIds']=[]
  next(h for h in incoming['payload']['headers'] if h['name']=='From')['value']=row['email']
  incoming['payload']['body']['data']=base64.urlsafe_b64encode(b'STOP, ne plus me contacter').decode();self.g.messages['old-optout']=incoming
  with patch.object(e,'suppress') as suppress:
   q.audit_historical(self.db,self.g,'presse',T,set(),e.business_days,self.cfg,e.observe_historical_negative)
   suppress.assert_called_once_with(row['email'],'opposition','old-optout')
  self.assertEqual(self.db.execute('SELECT count(*) FROM replies').fetchone()[0],0)
  self.assertEqual(self.db.execute('SELECT state FROM legacy').fetchone()[0],'sent')
 def test_discovery_is_lane_specific_and_search_terms_come_from_public_registry(self):
  for siren,category in [('111111111','PME'),('222222222','ETI')]:
   payload={'nom_complet':'Private renamed label','sourceUrl':'https://recherche-entreprises.api.gouv.fr/search?categorie_entreprise='+category+'&page=1','categorie_entreprise':category,'leaders':[{'nom':'Martin','prenoms':'Alice'}]}
   self.db.execute('INSERT INTO research VALUES(?,?,?,?)',(siren,json.dumps(payload),e.stamp(T-timedelta(days=2)),'needs_official_domain_and_exact_contact'))
  self.db.commit();urls=[]
  def fetch(url):
   urls.append(url)
   if 'api.gouv.fr' in url:return json.dumps({'results':[{'siren':'111111111','nom_complet':'Public Registry Company','statut_diffusion':'O'}]}),url
   return '<a href="https://fixture.invalid/">Official</a>',url
  def page(url):return {'url':url,'text':'SIREN 111111111 Public Registry Company Alice Martin','sha256':'x','emails':{'alice.martin@fixture.invalid'},'contactLinks':[]}
  with patch.object(e,'fetch',side_effect=fetch):result=e.discover_company(self.db,T,fetch_page=page,lane='pme',retry_hours=24)
  self.assertEqual(result['addedContacts'],1)
  self.assertTrue(any('Public+Registry+Company' in url for url in urls));self.assertFalse(any('Private' in url for url in urls))
  self.assertEqual(self.db.execute("SELECT reason FROM research WHERE siren='222222222'").fetchone()[0],'needs_official_domain_and_exact_contact')

if __name__=='__main__':unittest.main()
