"""Offline Robb sender pilot proofs; fixture.invalid only, no Gmail network."""
import base64
import copy
import json
import sqlite3
import tempfile
import unittest
from collections.abc import Callable
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import cast, final, override
from unittest.mock import patch

import evergreen_offline_test_guard as _offline_test_guard
import evergreen_sender_pilot as pilot
import outbound_sender_guard as guard
import robinswood_evergreen_france as engine
import robinswood_evergreen_france_tests as fixture
from evergreen_campaign_data_types import (
 JsonObject,
 data_cell,
 data_coerce_json_object,
 data_integer,
 data_json_array,
 data_json_object_or_empty,
 data_json_objects,
 data_parse_json_object,
 data_sqlite_integer,
 data_sqlite_value,
 data_text,
)
from evergreen_campaign_test_fixtures import body_of, headers_of
from pydantic import JsonValue

T: datetime = fixture.T

def message_headers(message_value: JsonObject) -> list[JsonObject]:
 payload_value=data_json_object_or_empty(message_value.get('payload'))
 return data_json_objects(payload_value.get('headers'))




def object_at(value: JsonObject, key: str) -> JsonObject:
 return data_json_object_or_empty(value.get(key))

def text_at(value: JsonObject, key: str) -> str:
 return data_text(value.get(key))

def integer_at(value: JsonObject, key: str) -> int:
 return data_integer(value.get(key))

def variant_object(value: JsonObject, sender: str, variant: str) -> JsonObject:
 cohort = object_at(object_at(value, 'cohorts'), sender)
 return object_at(object_at(cohort, 'variants'), variant)

def required_row(connection: sqlite3.Connection, query: str, parameters: tuple[object, ...] = ()) -> sqlite3.Row:
 cursor = connection.execute(query, parameters)
 raw_row = cast(object, cursor.fetchone())
 if raw_row is None or not isinstance(raw_row, sqlite3.Row): raise AssertionError('expected a SQLite row')
 row = raw_row
 return row

def cell_text(row: sqlite3.Row, column: str) -> str:
 value = data_cell(row, column)
 if not isinstance(value, str): raise TypeError('expected text in fixture row')
 return value


def parse_payload(raw: str) -> EmailMessage[str, str]:
 return guard.parse_raw(raw)

def expect_rejected(raw: str) -> None:
 _message_value, operation, campaign = guard.expected(raw)
 if not operation or not campaign:
  raise TypeError('sender fixture verifier returned invalid data')

def verify_effect(message_value: JsonObject, raw: str, thread: str | None = None) -> tuple[bool, JsonObject]:
 return guard.verify(message_value, raw, thread)

def payload(op: str = 'pilot-test', lane: str = 'pme', sender: str = pilot.ROBB, email: str = 'alice@fixture.invalid', version: str | None = pilot.VERSION) -> str:
 m=parse_payload(fixture.raw(op,lane,email))
 m.replace_header('From',sender)
 m['Reply-To']=sender
 if version:m['X-RBW-Sender-Strategy']=version
 m.set_content(pilot.DISCLOSURE+'\nTexte approuvé.\nSignature réelle\n')
 return base64.urlsafe_b64encode(m.as_bytes()).decode()


def append_unapproved_sender(contract: JsonObject) -> None:
 sender_config = object_at(contract, 'senderPilot')
 senders = data_json_array(sender_config.get('prospectingSenders'))
 senders.append('bonjour@robinswood.io')
 sender_config['prospectingSenders'] = senders
 contract['senderPilot'] = sender_config

def set_contract_value(contract: JsonObject, section: str, key: str, value: JsonValue) -> None:
 section_value = object_at(contract, section)
 section_value[key] = value
 contract[section] = section_value

def no_reserves(_db: sqlite3.Connection) -> None:
 return None

class AliasGuardTests(unittest.TestCase):
 tmp: tempfile.TemporaryDirectory[str]
 root: Path
 g: fixture.FakeGateway

 def __init__(self, methodName: str = 'runTest') -> None:
  super().__init__(methodName)
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.g=fixture.FakeGateway()

 @override
 def tearDown(self) -> None:self.tmp.cleanup()

 def send(self,data: str | None=None,t: datetime=T) -> JsonObject:
  data=data or payload();self.g.time=t
  return guard.shared_send(self.g,data,None,lambda:self.g.post(data),ops=self.root,t=t)
 def test_robb_allowed_only_for_corporate_pilot_with_disclosure_reply_and_version(self) -> None:
  for lane in ['presse','scotland']:
   m=parse_payload(payload(lane='pme'));m.replace_header('X-RBW-Campaign',engine.IDS['presse'] if lane=='presse' else 'scotland-executive-conference-october-2026')
   with self.assertRaises(guard.SenderGuardBlocked):expect_rejected(base64.urlsafe_b64encode(m.as_bytes()).decode())
  for header,value in [('Reply-To',pilot.PRIMARY),('X-RBW-Sender-Strategy','unapproved')]:
   m=parse_payload(payload());m.replace_header(header,value)
   with self.assertRaises(guard.SenderGuardBlocked):expect_rejected(base64.urlsafe_b64encode(m.as_bytes()).decode())
  m=parse_payload(payload());m.set_content('Je suis un collègue humain.')
  with self.assertRaises(guard.SenderGuardBlocked):expect_rejected(base64.urlsafe_b64encode(m.as_bytes()).decode())
  self.assertEqual(self.send()['id'],'sent-1')
 def test_all_account_identities_and_manual_sends_consume_daily_forty(self) -> None:
  for i in range(40):
   sender=[pilot.PRIMARY,pilot.ROBB,'bonjour@robinswood.io'][i%3]
   self.g.messages[str(i)]=fixture.message(payload('old-'+str(i),sender=sender),str(i),t=T-timedelta(hours=1,seconds=i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'daily'):_ = self.send()
  self.assertEqual(self.g.posts,0)
 def test_weekly_two_hundred_is_shared(self) -> None:
  for i in range(200):self.g.messages[str(i)]=fixture.message(payload('old-'+str(i),sender=[pilot.PRIMARY,pilot.ROBB][i%2]),str(i),t=T+timedelta(seconds=i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'weekly'):_ = self.send(t=T+timedelta(days=2))
  self.assertEqual(self.g.posts,0)
 def test_alias_switch_does_not_bypass_rolling_hour_or_interval(self) -> None:
  _ = self.send(payload(sender=pilot.PRIMARY))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'interval'):_ = self.send(payload('next'),t=T+timedelta(seconds=599))
  self.assertEqual(self.g.posts,1)
  self.g.messages={}
  for i in range(6):self.g.messages[str(i)]=fixture.message(payload('old-'+str(i),sender=[pilot.PRIMARY,pilot.ROBB][i%2]),str(i),t=T-timedelta(minutes=11+8*i))
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'hourly'):_ = self.send(payload('third'))
  self.assertEqual(self.g.posts,1)
 def test_unknown_robb_effect_blocks_other_sender_without_retry(self) -> None:
  self.g.fail_before_post=True
  with self.assertRaises(TimeoutError):_ = self.send()
  self.g.fail_before_post=False
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'unresolved'):_ = self.send(payload('other',sender=pilot.PRIMARY),t=T+timedelta(minutes=10))
  self.assertEqual(self.g.posts,1)
 def test_robb_lost_response_reconciles_same_operation_exactly_once(self) -> None:
  self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):_ = self.send()
  self.g.fail_after_post=False
  self.assertTrue(self.send()['deduplicated']);self.assertEqual(self.g.posts,1)
  with self.assertRaisesRegex(guard.SenderGuardBlocked,'payload_changed'):_ = self.send(payload(sender=pilot.PRIMARY))
  self.assertEqual(self.g.posts,1)
 def test_actual_sender_reply_identity_strategy_signature_and_thread_checked(self) -> None:
  data=payload();actual=fixture.message(data)
  self.assertTrue(verify_effect(actual,data,'thread-1')[0])
  for name,value in [('From',pilot.PRIMARY),('Reply-To',pilot.PRIMARY),('X-RBW-Sender-Strategy','changed')]:
   wrong=copy.deepcopy(actual);next(h for h in message_headers(wrong) if h.get('name')==name)['value']=value
   self.assertFalse(verify_effect(wrong,data,'thread-1')[0])
  wrong=copy.deepcopy(actual);data_json_object_or_empty(data_json_object_or_empty(wrong.get('payload')).get('body'))['data']=base64.urlsafe_b64encode(b'Wrong signature').decode()
  self.assertFalse(verify_effect(wrong,data,'thread-1')[0]);self.assertFalse(verify_effect(actual,data,'wrong-thread')[0])

@final
class SenderPilotTests(unittest.TestCase):
 @override
 def __init__(self, methodName: str = 'runTest') -> None:
  super().__init__(methodName)
  self.tmp: tempfile.TemporaryDirectory[str] = tempfile.TemporaryDirectory()
  self.root: Path = Path(self.tmp.name)
  self.db: sqlite3.Connection = engine.db_open(self.root)
  self.c: JsonObject = engine.contract(Path(__file__).parent.parent / 'config/robinswood-evergreen-france.json')
  self.g: fixture.EndGateway = fixture.EndGateway(self.root)
 @override
 def tearDown(self) -> None:
  self.db.close()
  self.tmp.cleanup()
 def candidate(self, email: str='alice@fixture.invalid', company: str='Fixture Company', lane: str='pme') -> sqlite3.Row:
  _candidate = engine.put_candidate(self.db, {'email':email,'name':'Alice Martin','company':company,'domain':'fixture.invalid','lane':lane})
  _cursor = self.db.execute('UPDATE candidates SET proof=? WHERE email=?',(json.dumps({'ok':True,'checkedAt':engine.stamp(T)}),email))
  row = required_row(self.db, 'SELECT * FROM candidates WHERE email=?', (email,))
  return row
 def record(self, op: str, sender: str = pilot.ROBB, lane: str = 'pme', step: str = 'initial', created: datetime = T, variant: str = 'A', version: str | None = pilot.VERSION) -> None:
  data=payload(op,lane,sender,op+'@fixture.invalid',version)
  _cursor = self.db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(op,op+'@fixture.invalid',lane,step,variant,self.c['copyVersion'],engine.stamp(created),'verified',data,'body','Fixture',op,'thread-'+op,'{}'));self.db.commit()
 def runit(self, t: datetime = T) -> JsonObject:
  self.g.time=t
  def fixed_now() -> datetime:
   return t
  with patch.object(engine,'OPS',self.root/'reports'),patch.object(engine,'import_reserves',no_reserves),patch.object(engine,'suppressed',return_value=set[str]()),patch.object(engine,'now',fixed_now):
   return data_coerce_json_object(engine.run('pme',apply=True,root=self.root,c=self.c,gateway=self.g,t=t,research_batch=0))
 def test_contract_rejects_new_alias_caps_and_missing_approval_even_with_resigned_scope(self) -> None:
  mutations: tuple[Callable[[JsonObject], None], ...] = (append_unapproved_sender, lambda contract: set_contract_value(contract, 'senderPilot', 'steadyProspectingDailyMaxPerSender', 20), lambda contract: set_contract_value(contract, 'authorization', 'latestApprovalSource', 'unapproved'), lambda contract: set_contract_value(contract, 'senderPilot', 'previousScopeSha256', 'changed'))
  for mutate in mutations:
   contract = copy.deepcopy(self.c)
   mutate(contract)
   authorization = object_at(contract, 'authorization')
   authorization['scopeSha256'] = engine.digest({key: value for key, value in contract.items() if key != 'authorization'})
   contract['authorization'] = authorization
   path = self.root / 'bad.json'
   engine.save(path, contract)
   with self.assertRaises(AssertionError): _ = engine.contract(path)
 def test_additive_schema_backup_preserves_original_data_and_old_insert_shape(self) -> None:
  backup_value = data_sqlite_value(self.db, "SELECT value FROM metadata WHERE key='sender_pilot_schema_backup'")
  if not isinstance(backup_value, str): raise TypeError('schema backup path was not recorded')
  backup = Path(backup_value)
  saved=sqlite3.connect(backup)
  self.assertIsNotNone(data_sqlite_value(saved, "SELECT name FROM sqlite_master WHERE name='touches'"))
  self.assertIsNone(data_sqlite_value(saved, "SELECT name FROM sqlite_master WHERE name='sender_bindings'"))
  saved.close()
  self.record('legacy',sender=pilot.PRIMARY,version=None)
  engine.db_open(self.root).close()
  self.assertEqual(data_sqlite_integer(data_sqlite_value(self.db, 'SELECT count(*) FROM touches')), 1)
 def test_balanced_company_assignment_is_immutable_across_people_and_retries(self) -> None:
  cap: JsonObject={'dailyCap':12,'portfolioRamp':{'phase':'steady_30'}}
  owners: list[str]=[]
  for i in range(12):
   row=self.candidate('person'+str(i)+'@fixture.invalid','company'+str(i))
   sender,version=pilot.plan(self.db,row,'initial',self.c,T,cap)
   if sender is None or version is None:self.fail('eligible initial contact must have a sender strategy')
   pilot.bind(self.db,row,sender,version,T);owners.append(sender)
   self.assertEqual(pilot.plan(self.db,row,'initial',self.c,T,cap),(sender,version))
  self.assertEqual((owners.count(pilot.PRIMARY),owners.count(pilot.ROBB)),(6,6))
  row2=self.candidate('second@fixture.invalid','company0')
  self.assertEqual(pilot.plan(self.db,row2,'initial',self.c,T,cap)[0],owners[0])
  with self.assertRaisesRegex(RuntimeError,'immutable'):pilot.bind(self.db,row2,pilot.ROBB if owners[0]==pilot.PRIMARY else pilot.PRIMARY,pilot.VERSION,T)
 def test_legacy_conversation_uses_actual_primary_sender_and_legacy_strategy(self) -> None:
  row=self.candidate('legacy@fixture.invalid')
  self.record('legacy',sender=pilot.PRIMARY,version=None,created=T-timedelta(days=14))
  self.assertEqual(pilot.plan(self.db,row,'followup',self.c,T,{'dailyCap':1}),(pilot.PRIMARY,'legacy'))
  parent=fixture.message(payload('legacy',sender=pilot.PRIMARY,email=cell_text(row, 'email'),version=None))
  item=data_parse_json_object(cell_text(row, 'payload'))|{'campaignId':engine.IDS['pme'],'_sender':pilot.PRIMARY,'_sender_strategy_version':'legacy'}
  draft=engine.draft(item,'A','followup',subject=guard.header(parent,'Subject'))
  data,_,_=self.g.prepare(item,data_coerce_json_object(draft),'follow',parent)
  self.assertEqual(guard.values(parse_payload(data),'From'),[pilot.PRIMARY])
  self.assertIsNone(parse_payload(data).get('X-RBW-Sender-Strategy'))
 def test_robb_verified_signature_disclosure_and_original_subject_preserved(self) -> None:
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T)
  result=self.runit();self.assertEqual(result['status'],'sent_verified')
  original = required_row(self.db, "SELECT * FROM touches WHERE step='initial'")
  parent = self.g.get(cell_text(original, 'gmail_id'))
  item=data_parse_json_object(cell_text(row, 'payload'))|{'campaignId':engine.IDS['pme'],'_sender':pilot.ROBB,'_sender_strategy_version':pilot.VERSION}
  self.assertIn(pilot.DISCLOSURE,cell_text(original, 'expected'));self.assertIn('Je suis Robb, l’assistant IA de Robinswood.',cell_text(original, 'expected'))
  draft=engine.draft(item,'B','reply',subject=cell_text(original, 'subject'))
  data,_,_=self.g.prepare(item,data_coerce_json_object(draft),'response',parent)
  parsed=parse_payload(data)
  self.assertEqual(str(parsed['Subject']),cell_text(original, 'subject'));self.assertEqual(guard.values(parsed,'From'),[pilot.ROBB])
  self.assertEqual(str(parsed['In-Reply-To']),guard.header(parent,'Message-ID'))
  item['_sender']=pilot.PRIMARY
  with self.assertRaisesRegex(RuntimeError,'original_sender'):_ = self.g.prepare(item,data_coerce_json_object(draft),'switch',parent)
 def test_pending_alias_or_missing_signature_blocks_before_post(self) -> None:
  row=self.candidate();item=data_parse_json_object(cell_text(row, 'payload'))|{'campaignId':engine.IDS['pme'],'_sender':pilot.ROBB,'_sender_strategy_version':pilot.VERSION}
  for change in [{'verificationStatus':'pending'},{'signature':''},{'replyToAddress':pilot.PRIMARY}]:
   identity={'sendAsEmail':pilot.ROBB,'verificationStatus':'accepted','replyToAddress':pilot.ROBB,'signature':'<div>Robb</div>'}|change
   with patch.object(self.g,'call',return_value={'sendAs':[identity]}), self.assertRaisesRegex(RuntimeError,'not_ready'):
    _ = self.g.prepare(item,data_coerce_json_object(engine.draft(item,'A')),'blocked')
  self.assertEqual(self.g.posts,0)
 def test_all_touch_types_consume_sender_caps_and_recovery_canary_remains_one(self) -> None:
  cap: JsonObject={'dailyCap':12,'portfolioRamp':{'phase':'steady_30'}}
  for i in range(6):self.record('pme'+str(i),step=['initial','reply','followup'][i%3])
  self.assertFalse(pilot.quota(self.db,'pme',pilot.ROBB,T,cap,self.c));self.assertTrue(pilot.quota(self.db,'pme',pilot.PRIMARY,T,cap,self.c))
  for i in range(4):self.record('eti'+str(i),lane='eti',step='reply')
  self.assertFalse(pilot.quota(self.db,'eti',pilot.ROBB,T,cap,self.c))
  self.assertEqual(pilot.daily_usage(self.db,T)[pilot.ROBB]['total'],10)
  self.assertFalse(pilot.quota(self.db,'pme',pilot.ROBB,T,{'dailyCap':1,'portfolioRamp':{'phase':'steady_30'}},self.c))
 def test_learning_isolated_by_actual_sender_strategy_and_copy_version(self) -> None:
  for sender in [pilot.PRIMARY,pilot.ROBB]:
   for variant in ['A','B']:
    for i in range(8):
     op=sender.split('@')[0]+variant+str(i);self.record(op,sender=sender,variant=variant,created=T-timedelta(days=14))
     if i<4 and variant==('A' if sender==pilot.ROBB else 'B'):_ = self.db.execute('INSERT INTO replies VALUES(?,?,?,?,?,?)',(op,op+'@fixture.invalid','pme','qualified_need',engine.stamp(T),'{}'))
  self.record('old',sender=pilot.ROBB,created=T-timedelta(days=14));_ = self.db.execute("UPDATE touches SET copy_version='old-version' WHERE operation='old'");self.db.commit()
  aggregate=engine.learning(self.db,'pme',T,self.c)
  self.assertIsNone(aggregate['winner']);self.assertEqual(text_at(object_at(object_at(aggregate, 'cohorts'), pilot.ROBB), 'winner'),'A');self.assertEqual(text_at(object_at(object_at(aggregate, 'cohorts'), pilot.PRIMARY), 'winner'),'B')
  self.assertEqual(integer_at(variant_object(aggregate, pilot.ROBB, 'A'), 'matured'),8);self.assertFalse(aggregate['bookingsInferred'])
 def test_robb_outbound_is_not_a_reply_and_inbound_is_bound_to_sender_thread(self) -> None:
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T);_ = self.runit()
  original=required_row(self.db, 'SELECT * FROM touches')
  incoming=fixture.message(payload('inbound',email=pilot.ROBB),'inbound',cell_text(original, 'thread'),T+timedelta(hours=1));incoming['labelIds']=[]
  for h in headers_of(incoming):
   if h['name']=='From':h['value']=cell_text(row, 'email')
  body_of(incoming)['data']=base64.urlsafe_b64encode(b'Notre flux de devis mobilise 30 heures par semaine.').decode()
  self.g.messages['inbound']=incoming
  with patch.object(engine,'suppress'):
   self.assertEqual(engine.reply_scan(self.db,self.g,'pme',T+timedelta(hours=1)),1)
  replies=self.db.execute('SELECT * FROM replies').fetchall();self.assertEqual(len(replies),1);self.assertEqual(replies[0]['kind'],'qualified_need')
  wrong=copy.deepcopy(incoming);wrong['id']='wrong-identity'
  next(h for h in headers_of(wrong) if h['name']=='To')['value']=pilot.PRIMARY
  self.g.messages[wrong['id']]=wrong
  self.assertEqual(engine.reply_scan(self.db,self.g,'pme',T+timedelta(hours=1)),0)
 def test_robb_ambiguous_success_reconciles_without_duplicate_or_sender_switch(self) -> None:
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T);self.g.fail_after_post=True
  with self.assertRaises(TimeoutError):_ = self.runit()
  self.g.fail_after_post=False;_ = self.runit()
  self.assertEqual(self.g.posts,1);self.assertEqual(pilot.touch_identity(required_row(self.db, 'SELECT * FROM touches')),(pilot.ROBB,pilot.VERSION))
 def test_weekend_blocks_dispatch_for_both_identities(self) -> None:
  row=self.candidate();pilot.bind(self.db,row,pilot.ROBB,pilot.VERSION,T)
  result=self.runit(T+timedelta(days=5))
  self.assertEqual(result['status'],'outside_business_window');self.assertEqual(self.g.posts,0)
 def test_future_thirty_simulation_has_ten_press_and_ten_prospecting_each(self) -> None:
  case=fixture.PostScotlandRampTests();case.setUp()
  try:
   case.healthy_days();base=case.t.replace(day=21)
   gateway=RampGateway(case.root/'pilot-full')
   caps=object_at(object_at(case.c,'postScotlandRamp'),'steadyLaneDailyMax');order=[lane for lane in engine.LANES for _ in range(integer_at(caps,lane))]
   for lane in engine.LANES:
    for i in range(integer_at(caps,lane)+1):engine.put_candidate(case.db,{'email':lane+str(i)+'@fixture.invalid','name':'Fixture Person','company':lane+str(i),'domain':lane+str(i)+'.invalid','lane':lane,'sourceUrls':['https://fixture.invalid/']})
   _ = case.db.execute('UPDATE candidates SET proof=?',(json.dumps({'ok':True,'checkedAt':engine.stamp(base)}),));case.db.commit()
   t=base
   for i,lane in enumerate(order):
    t=base+timedelta(minutes=10*i) if i<18 else base+timedelta(hours=5,minutes=10*(i-18));gateway.time=t
    with patch.object(engine,'OPS',case.root/'reports'),patch.object(engine,'now',return_value=t),patch.object(engine,'import_reserves',no_reserves),patch.object(engine,'suppressed',return_value=set[str]()):
     result=engine.run(lane,apply=True,root=case.root,c=case.c,gateway=gateway,t=t,research_batch=0)
    self.assertEqual(result['status'],'sent_verified')
   self.assertEqual(gateway.posts,30)
   press=[m for m in gateway.messages.values() if guard.header(m,'X-RBW-Campaign')==engine.IDS['presse']]
   prospect=[m for m in gateway.messages.values() if m not in press]
   self.assertEqual((len(press),len(prospect)),(10,20));self.assertTrue(all(guard.header(m,'From')==pilot.PRIMARY for m in press))
   self.assertEqual({s:sum(guard.header(m,'From')==s for m in prospect) for s in [pilot.PRIMARY,pilot.ROBB]},{pilot.PRIMARY:10,pilot.ROBB:10})
   for lane in engine.LANES:self.assertFalse(engine.lane_capacity(case.db,lane,t,case.c)[0])
  finally:case.tearDown()

class RampGateway(fixture.EndGateway):
 @override
 def search(self, query: str) -> list[JsonObject]:
  if query.startswith('in:sent to:'):
   return [{'id': mid} for mid, message in self.messages.items() if guard.header(message,'To')==query.split('to:')[-1]]
  return super().search(query)

if __name__=='__main__':_ = unittest.main()

def tearDownModule() -> None:
    _offline_test_guard.assert_no_external_attempts()
