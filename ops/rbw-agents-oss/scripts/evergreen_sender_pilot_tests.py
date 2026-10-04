#!/usr/bin/env python3
"""Offline Robb sender pilot proofs; fixture.invalid only, no Gmail network."""
import base64,copy,json,sqlite3,tempfile,unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
import outbound_sender_guard as guard
import evergreen_sender_pilot as pilot
import robinswood_evergreen_france as engine
import robinswood_evergreen_france_tests as fixture
T=fixture.T

def payload(op='pilot-test',lane='pme',sender=pilot.ROBB,email='alice@fixture.invalid',version=pilot.VERSION):
 m=guard.parse_raw(fixture.raw(op,lane,email))
 m.replace_header('From',sender)
 m['Reply-To']=sender
 if version:m['X-RBW-Sender-Strategy']=version
 m.set_content(pilot.DISCLOSURE+'\nTexte approuvé.\nSignature réelle\n')
 return base64.urlsafe_b64encode(m.as_bytes()).decode()

class AliasGuardTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.g=fixture.FakeGateway()
 def tearDown(self):self.tmp.cleanup()
 def send(self,data=None,t=T):
  data=data or payload();self.g.time=t
  return guard.shared_send(self.g,data,None,lambda:self.g.post(data),ops=self.root,t=t)
 def test_robb_allowed_only_for_corporate_pilot_with_disclosure_reply_and_version(self):
  for lane in ['presse','scotland']:
   m=guard.parse_raw(payload(lane='pme'));m.replace_header('X-RBW-Campaign',engine.IDS['presse'] if lane=='presse' else 'scotland-executive-conference-october-2026')
   with self.assertRaises(guard.SenderGuardBlocked):guard.expected(base64.urlsafe_b64encode(m.as_bytes()).decode())
  for header,value in [('Reply-To',pilot.PRIMARY),('X-RBW-Sender-Strategy','unapproved')]:
   m=guard.parse_raw(payload());m.replace_header(header,value)
   with self.assertRaises(guard.SenderGuardBlocked):guard.expected(base64.urlsafe_b64encode(m.as_bytes()).decode())
  m=guard.parse_raw(payload());m.set_content('Je suis un collègue humain.')
  with self.assertRaises(guard.SenderGuardBlocked):guard.expected(base64.urlsafe_b64encode(m.as_bytes()).decode())
  self.assertEqual(self.send()['id'],'sent-1')
 def test_all_account_identities_and_manual_sends_consume_daily_forty(self):
  for i in range(40):
   sender=[pilot.PRIMARY,pilot.ROBB,'bonjour@robinswood.io'][i%3]
   self.g.messages[str(i)]=fixture.message(payload('old-'+str(i),sender=sender),str(i),t=T-timedelta(hours=1,seconds=i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'daily'):self.send()
  self.assertEqual(self.g.posts,0)
 def test_weekly_two_hundred_is_shared(self):
  for i in range(200):self.g.messages[str(i)]=fixture.message(payload('old-'+str(i),sender=[pilot.PRIMARY,pilot.ROBB][i%2]),str(i),t=T+timedelta(seconds=i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'weekly'):self.send(t=T+timedelta(days=2))
  self.assertEqual(self.g.posts,0)
 def test_alias_switch_does_not_bypass_rolling_hour_or_interval(self):
  self.send(payload(sender=pilot.PRIMARY))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'interval'):self.send(payload('next'),t=T+timedelta(seconds=599))
  self.assertEqual(self.g.posts,1)
  self.g.messages={}
  for i in range(6):self.g.messages[str(i)]=fixture.message(payload('old-'+str(i),sender=[pilot.PRIMARY,pilot.ROBB][i%2]),str(i),t=T-timedelta(minutes=11+8*i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'hourly'):self.send(payload('third'))
  self.assertEqual(self.g.posts,1)
 def test_unknown_robb_effect_blocks_other_sender_without_retry(self):
  self.g.fail_before_post=True
  with self.assertRaises(TimeoutError):self.send()
  self.g.fail_before_post=False
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'unresolved'):self.send(payload('other',sender=pilot.PRIMARY),t=T+timedelta(minutes=10))
  self.assertEqual(self.g.posts,1)
 def test_robb_lost_response_reconciles_same_operation_exactly_once(self):
  self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):self.send()
  self.g.fail_after_post=False
  self.assertTrue(self.send()['deduplicated']);self.assertEqual(self.g.posts,1)
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'payload_changed'):self.send(payload(sender=pilot.PRIMARY))
  self.assertEqual(self.g.posts,1)
 def test_actual_sender_reply_identity_strategy_signature_and_thread_checked(self):
  data=payload();actual=fixture.message(data)
  self.assertTrue(guard.verify(actual,data,'thread-1')[0])
  for name,value in [('From',pilot.PRIMARY),('Reply-To',pilot.PRIMARY),('X-RBW-Sender-Strategy','changed')]:
   wrong=copy.deepcopy(actual);next(h for h in wrong['payload']['headers'] if h['name']==name)['value']=value
   self.assertFalse(guard.verify(wrong,data,'thread-1')[0])
  wrong=copy.deepcopy(actual);wrong['payload']['body']['data']=base64.urlsafe_b64encode(b'Wrong signature').decode()
  self.assertFalse(guard.verify(wrong,data,'thread-1')[0]);self.assertFalse(guard.verify(actual,data,'wrong-thread')[0])

class SenderPilotTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=engine.db_open(self.root)
  self.c=engine.contract(Path(__file__).parent.parent/'config/robinswood-evergreen-france.json')
  self.g=fixture.EndGateway(self.root)
 def tearDown(self):self.db.close();self.tmp.cleanup()
 def candidate(self,email='alice@fixture.invalid',company='Fixture Company',lane='pme'):
  engine.put_candidate(self.db,{'email':email,'name':'Alice Martin','company':company,'domain':'fixture.invalid','lane':lane,'sourceUrls':['https://fixture.invalid/']})
  self.db.execute('UPDATE candidates SET proof=? WHERE email=?',(json.dumps({'ok':True,'checkedAt':engine.stamp(T)}),email));self.db.commit()
  return self.db.execute('SELECT * FROM candidates WHERE email=?',(email,)).fetchone()
 def record(self,op,sender=pilot.ROBB,lane='pme',step='initial',created=T,variant='A',version=pilot.VERSION):
  data=payload(op,lane,sender,op+'@fixture.invalid',version)
  self.db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(op,op+'@fixture.invalid',lane,step,variant,self.c['copyVersion'],engine.stamp(created),'verified',data,'body','Fixture',op,'thread-'+op,'{}'));self.db.commit()
 def runit(self,t=T):
  self.g.time=t
  with patch.object(engine,'OPS',self.root/'reports'),patch.object(engine,'import_reserves',lambda db:None),patch.object(engine,'suppressed',return_value=set()),patch.object(engine,'now',lambda:t):
   return engine.run('pme',apply=True,root=self.root,c=self.c,gateway=self.g,t=t,research_batch=0)
 def test_contract_rejects_new_alias_caps_and_missing_approval_even_with_resigned_scope(self):
  for mutate in [lambda c:c['senderPilot']['prospectingSenders'].append('bonjour@robinswood.io'),lambda c:c['senderPilot'].__setitem__('steadyProspectingDailyMaxPerSender',20),lambda c:c['authorization'].__setitem__('latestApprovalSource','unapproved'),lambda c:c['senderPilot'].__setitem__('previousScopeSha256','changed')]:
   c=copy.deepcopy(self.c);mutate(c);c['authorization']['scopeSha256']=engine.digest({k:v for k,v in c.items() if k!='authorization'});path=self.root/'bad.json';engine.save(path,c)
   with self.assertRaises(AssertionError):engine.contract(path)
 def test_additive_schema_backup_preserves_original_data_and_old_insert_shape(self):
  backup=Path(self.db.execute("SELECT value FROM metadata WHERE key='sender_pilot_schema_backup'").fetchone()[0])
  saved=sqlite3.connect(backup)
  self.assertIsNotNone(saved.execute("SELECT name FROM sqlite_master WHERE name='touches'").fetchone())
  self.assertIsNone(saved.execute("SELECT name FROM sqlite_master WHERE name='sender_bindings'").fetchone());saved.close()
  self.record('legacy',sender=pilot.PRIMARY,version=None)
  engine.db_open(self.root).close()
  self.assertEqual(self.db.execute('SELECT count(*) FROM touches').fetchone()[0],1)
 def test_balanced_company_assignment_is_immutable_across_people_and_retries(self):
  cap={'dailyCap':12,'portfolioRamp':{'phase':'steady_30'}}
  owners=[]
  for i in range(12):
   row=self.candidate('person'+str(i)+'@fixture.invalid','company'+str(i))
   sender,version=pilot.plan(self.db,row,'initial',self.c,T,cap);pilot.bind(self.db,row,sender,version,T);owners.append(sender)
   self.assertEqual(pilot.plan(self.db,row,'initial',self.c,T,cap),(sender,version))
  self.assertEqual((owners.count(pilot.PRIMARY),owners.count(pilot.ROBB)),(6,6))
  row2=self.candidate('second@fixture.invalid','company0')
  self.assertEqual(pilot.plan(self.db,row2,'initial',self.c,T,cap)[0],owners[0])
  with self.assertRaisesRegex(RuntimeError,'immutable'):pilot.bind(self.db,row2,pilot.ROBB if owners[0]==pilot.PRIMARY else pilot.PRIMARY,pilot.VERSION,T)
 def test_legacy_conversation_uses_actual_primary_sender_and_legacy_strategy(self):
  row=self.candidate('legacy@fixture.invalid')
  self.record('legacy',sender=pilot.PRIMARY,version=None,created=T-timedelta(days=14))
  self.assertEqual(pilot.plan(self.db,row,'followup',self.c,T,{'dailyCap':1}),(pilot.PRIMARY,'legacy'))
  parent=fixture.message(payload('legacy',sender=pilot.PRIMARY,email=row['email'],version=None))
  item=json.loads(row['payload'])|{'campaignId':engine.IDS['pme'],'_sender':pilot.PRIMARY,'_sender_strategy_version':'legacy'}
  draft=engine.draft(item,'A','followup',subject=guard.header(parent,'Subject'))
  data,_,_=self.g.prepare(item,draft,'follow',parent)
  self.assertEqual(guard.values(guard.parse_raw(data),'From'),[pilot.PRIMARY])
  self.assertIsNone(guard.parse_raw(data).get('X-RBW-Sender-Strategy'))
 def test_robb_verified_signature_disclosure_and_original_subject_preserved(self):
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T)
  result=self.runit();self.assertEqual(result['status'],'sent_verified')
  original=self.db.execute("SELECT * FROM touches WHERE step='initial'").fetchone();parent=self.g.get(original['gmail_id'])
  item=json.loads(row['payload'])|{'campaignId':engine.IDS['pme'],'_sender':pilot.ROBB,'_sender_strategy_version':pilot.VERSION}
  self.assertIn(pilot.DISCLOSURE,original['expected']);self.assertIn('Robb — assistant IA',original['expected'])
  draft=engine.draft(item,'B','reply',subject=original['subject'])
  data,_,_=self.g.prepare(item,draft,'response',parent)
  parsed=guard.parse_raw(data)
  self.assertEqual(str(parsed['Subject']),original['subject']);self.assertEqual(guard.values(parsed,'From'),[pilot.ROBB])
  self.assertEqual(str(parsed['In-Reply-To']),guard.header(parent,'Message-ID'))
  item['_sender']=pilot.PRIMARY
  with self.assertRaisesRegex(RuntimeError,'original_sender'):self.g.prepare(item,draft,'switch',parent)
 def test_pending_alias_or_missing_signature_blocks_before_post(self):
  row=self.candidate();item=json.loads(row['payload'])|{'campaignId':engine.IDS['pme'],'_sender':pilot.ROBB,'_sender_strategy_version':pilot.VERSION}
  for change in [{'verificationStatus':'pending'},{'signature':''},{'replyToAddress':pilot.PRIMARY}]:
   identity={'sendAsEmail':pilot.ROBB,'verificationStatus':'accepted','replyToAddress':pilot.ROBB,'signature':'<div>Robb</div>'}|change
   with patch.object(self.g,'call',return_value={'sendAs':[identity]}):
    with self.assertRaisesRegex(RuntimeError,'not_ready'):self.g.prepare(item,engine.draft(item,'A'),'blocked')
  self.assertEqual(self.g.posts,0)
 def test_all_touch_types_consume_sender_caps_and_recovery_canary_remains_one(self):
  cap={'dailyCap':12,'portfolioRamp':{'phase':'steady_30'}}
  for i in range(6):self.record('pme'+str(i),step=['initial','reply','followup'][i%3])
  self.assertFalse(pilot.quota(self.db,'pme',pilot.ROBB,T,cap,self.c));self.assertTrue(pilot.quota(self.db,'pme',pilot.PRIMARY,T,cap,self.c))
  for i in range(4):self.record('eti'+str(i),lane='eti',step='reply')
  self.assertFalse(pilot.quota(self.db,'eti',pilot.ROBB,T,cap,self.c))
  self.assertEqual(pilot.daily_usage(self.db,T)[pilot.ROBB]['total'],10)
  self.assertFalse(pilot.quota(self.db,'pme',pilot.ROBB,T,{'dailyCap':1,'portfolioRamp':{'phase':'steady_30'}},self.c))
 def test_learning_isolated_by_actual_sender_strategy_and_copy_version(self):
  for sender in [pilot.PRIMARY,pilot.ROBB]:
   for variant in ['A','B']:
    for i in range(8):
     op=sender.split('@')[0]+variant+str(i);self.record(op,sender=sender,variant=variant,created=T-timedelta(days=14))
     if i<4 and variant==('A' if sender==pilot.ROBB else 'B'):self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',(op,op+'@fixture.invalid','pme','qualified_need',engine.stamp(T),'{}'))
  self.record('old',sender=pilot.ROBB,created=T-timedelta(days=14));self.db.execute("UPDATE touches SET copy_version='old-version' WHERE operation='old'");self.db.commit()
  aggregate=engine.learning(self.db,'pme',T,self.c)
  self.assertIsNone(aggregate['winner']);self.assertEqual(aggregate['cohorts'][pilot.ROBB]['winner'],'A');self.assertEqual(aggregate['cohorts'][pilot.PRIMARY]['winner'],'B')
  self.assertEqual(aggregate['cohorts'][pilot.ROBB]['variants']['A']['matured'],8);self.assertFalse(aggregate['bookingsInferred'])
 def test_robb_outbound_is_not_a_reply_and_inbound_is_bound_to_sender_thread(self):
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T);self.runit()
  original=self.db.execute('SELECT * FROM touches').fetchone()
  incoming=fixture.message(payload('inbound',email=pilot.ROBB),'inbound',original['thread'],T+timedelta(hours=1));incoming['labelIds']=[]
  for h in incoming['payload']['headers']:
   if h['name']=='From':h['value']=row['email']
  incoming['payload']['body']['data']=base64.urlsafe_b64encode('Notre flux de devis mobilise 30 heures par semaine.'.encode()).decode()
  self.g.messages['inbound']=incoming
  with patch.object(engine,'suppress'):
   self.assertEqual(engine.reply_scan(self.db,self.g,'pme',T+timedelta(hours=1)),1)
  replies=self.db.execute('SELECT * FROM replies').fetchall();self.assertEqual(len(replies),1);self.assertEqual(replies[0]['kind'],'qualified_need')
  wrong=copy.deepcopy(incoming);wrong['id']='wrong-identity'
  next(h for h in wrong['payload']['headers'] if h['name']=='To')['value']=pilot.PRIMARY
  self.g.messages[wrong['id']]=wrong
  self.assertEqual(engine.reply_scan(self.db,self.g,'pme',T+timedelta(hours=1)),0)
 def test_robb_ambiguous_success_reconciles_without_duplicate_or_sender_switch(self):
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T);self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):self.runit()
  self.g.fail_after_post=False;self.runit()
  self.assertEqual(self.g.posts,1);self.assertEqual(pilot.touch_identity(self.db.execute('SELECT * FROM touches').fetchone()),(pilot.ROBB,pilot.VERSION))
 def test_weekend_blocks_dispatch_for_both_identities(self):
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T)
  result=self.runit(T+timedelta(days=5))
  self.assertEqual(result['status'],'outside_business_window');self.assertEqual(self.g.posts,0)
 def test_future_thirty_simulation_has_ten_press_and_ten_prospecting_each(self):
  case=fixture.PostScotlandRampTests();case.setUp()
  try:
   case.healthy_days();base=case.t.replace(day=21)
   gateway=fixture.EndGateway(case.root/'pilot-full')
   gateway.search=lambda q:[{'id':m['id']} for m in gateway.messages.values() if guard.header(m,'To')==q.split('to:')[-1]] if q.startswith('in:sent to:') else fixture.FakeGateway.search(gateway,q)
   caps=case.c['postScotlandRamp']['steadyLaneDailyMax'];order=[lane for lane in engine.LANES for _ in range(caps[lane])]
   for lane in engine.LANES:
    for i in range(caps[lane]+1):engine.put_candidate(case.db,{'email':lane+str(i)+'@fixture.invalid','name':'Fixture Person','company':lane+str(i),'domain':lane+str(i)+'.invalid','lane':lane,'sourceUrls':['https://fixture.invalid/']})
   case.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'checkedAt':engine.stamp(base)}),));case.db.commit()
   for i,lane in enumerate(order):
    t=base+timedelta(minutes=10*i) if i<18 else base+timedelta(hours=5,minutes=10*(i-18));gateway.time=t
    with patch.object(engine,'OPS',case.root/'reports'),patch.object(engine,'now',lambda:t),patch.object(engine,'import_reserves',lambda db:None),patch.object(engine,'suppressed',return_value=set()):
     result=engine.run(lane,apply=True,root=case.root,c=case.c,gateway=gateway,t=t,research_batch=0)
    self.assertEqual(result['status'],'sent_verified')
   self.assertEqual(gateway.posts,30)
   press=[m for m in gateway.messages.values() if guard.header(m,'X-RBW-Campaign')==engine.IDS['presse']]
   prospect=[m for m in gateway.messages.values() if m not in press]
   self.assertEqual((len(press),len(prospect)),(10,20));self.assertTrue(all(guard.header(m,'From')==pilot.PRIMARY for m in press))
   self.assertEqual({s:sum(guard.header(m,'From')==s for m in prospect) for s in [pilot.PRIMARY,pilot.ROBB]},{pilot.PRIMARY:10,pilot.ROBB:10})
   for lane in engine.LANES:self.assertFalse(engine.lane_capacity(case.db,lane,t,case.c)[0])
  finally:case.tearDown()

if __name__=='__main__':unittest.main()
