"""Offline regression scenarios for the post-Scotland France campaign ramp."""
import copy
import json
import sqlite3
import tempfile
import unittest
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol, cast, final, override

import outbound_sender_guard as guard
import robinswood_evergreen_france as engine
from evergreen_campaign_data_types import (
 JsonObject,
 data_json_object_or_empty,
 data_text,
)
from evergreen_campaign_test_fixtures import EndGateway, EnginePatcher, patch_engine
from scotland_executive_conference_types import ExecutiveCampaignContract


class PriorCampaignTests(Protocol):
 c: ExecutiveCampaignContract
 root: Path
 def setUp(self) -> None: ...
 def write(self) -> None: ...
 def tearDown(self) -> None: ...


@final
class PostScotlandRampTests(unittest.TestCase):
  prior: PriorCampaignTests
  tmp: tempfile.TemporaryDirectory[str]
  root: Path
  db: sqlite3.Connection
  c: JsonObject
  ops_patch: EnginePatcher
  t: datetime
  old_ramp: Callable[[sqlite3.Connection, datetime, JsonObject, Path | None], JsonObject]
  ramp_patch: EnginePatcher
  def __init__(self, methodName: str = 'runTest') -> None:
   super().__init__(methodName)
   import scotland_executive_conference_october_tests as prior
   self.prior = prior.CampaignTests()
   self.tmp = tempfile.TemporaryDirectory()
   self.root = Path(self.tmp.name)
   self.db = sqlite3.connect(':memory:')
   self.c = {}
   self.ops_patch = patch_engine('OPS', self.root / 'sender')
   self.t = datetime(2026, 10, 14, 7, tzinfo=UTC)
   self.old_ramp = engine.portfolio_ramp
   self.ramp_patch = patch_engine('portfolio_ramp', self.old_ramp)
  @override
  def setUp(self) -> None:
   self.prior.setUp()
   limits = self.prior.c['limits']
   limits['timezone'] = 'Europe/London'
   self.prior.c['limits'] = limits
   self.prior.write()
   import scotland_executive_conference_october as scotland
   prior_db = scotland.database(self.prior.root)
   prior_db.close()
   self.db.close()
   self.root = Path(self.tmp.name)
   self.db = engine.db_open(self.root)
   self.c = engine.contract(Path(__file__).parent.parent / 'config/robinswood-evergreen-france.json')
   self.ops_patch = patch_engine('OPS', self.root / 'sender')
   _ = self.ops_patch.__enter__()
   self.old_ramp = engine.portfolio_ramp
   def prior_aware_ramp(db: sqlite3.Connection, t: datetime, c: JsonObject) -> JsonObject:
    return self.old_ramp(db, t, c, self.prior.root)
   self.ramp_patch = patch_engine('portfolio_ramp', prior_aware_ramp)
   _ = self.ramp_patch.__enter__()
  @override
  def tearDown(self) -> None:
   _ = self.ramp_patch.__exit__(None, None, None)
   _ = self.ops_patch.__exit__(None, None, None)
   self.db.close()
   self.tmp.cleanup()
   self.prior.tearDown()
  def effect(self, op: str, lane: str = 'pme', t: datetime | None = None, state: str = 'verified', step: str = 'initial') -> None:
   _ = self.db.execute('INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    (op, op + '@fixture.invalid', lane, step, 'A', data_text(self.c.get('copyVersion')), engine.stamp(t or self.t), state, 'raw', 'body', 'subject', op, 'thread-' + op, '{}'))
   self.db.commit()
  def healthy_days(self) -> None:
   for day in [14, 15, 16, 19, 20]:
    for i in range(10):
     self.effect(f'healthy-{day}-{i}', t=datetime(2026, 10, day, 7, tzinfo=UTC))
  def info_int(self, info: JsonObject, key: str) -> int:
   value = info.get(key)
   if not isinstance(value, int):
    self.fail(f'expected_integer_{key}')
   return value
  def section(self, info: JsonObject, key: str) -> JsonObject:
   value = info.get(key)
   if not isinstance(value, dict):
    self.fail(f'expected_object_{key}')
   return value
  def info_text(self, info: JsonObject, key: str) -> str:
   value = info.get(key)
   if not isinstance(value, str):
    self.fail(f'expected_text_{key}')
   return value
  def capacity_info(self, lane: str, t: datetime, expected_allowed: bool) -> JsonObject:
   allowed, info = engine.lane_capacity(self.db, lane, t, self.c)
   self.assertIs(allowed, expected_allowed)
   if not isinstance(info, dict):
    self.fail(f'expected_capacity_details:{lane}')
   return info
  def test_before_end_pause_and_last_authorized_date_do_not_trigger_ramp(self) -> None:
   for activation in ['active','paused','complete']:
    self.prior.c['activation']=activation;self.prior.write()
    t=datetime(2026,10,13,22,tzinfo=UTC)
    info = engine.portfolio_ramp(self.db, t, self.c)
    self.assertEqual(self.info_text(info, 'phase'), 'predecessor_active')
    self.assertEqual(self.info_int(self.capacity_info('pme', t, True), 'dailyCap'),1)
  def test_first_french_window_after_end_has_twenty_total(self) -> None:
   info=engine.portfolio_ramp(self.db,self.t,self.c)
   self.assertEqual((self.info_text(info, 'phase'), self.info_int(info, 'dailyCap'), self.info_int(info, 'weeklyCap')), ('initial_20', 20, 100))
   self.assertEqual(sum(self.info_int(self.capacity_info(lane, self.t, True), 'dailyCap') for lane in engine.LANES),20)
  def test_unknown_scotland_effect_and_adverse_signal_do_not_release_ramp(self) -> None:
   import scotland_executive_conference_october as scotland
   with closing(scotland.database(self.prior.root)) as db:
    _ = db.execute("INSERT INTO touches(item,step,created,state,operation) VALUES('fixture','initial',?,'pending','pending')", (engine.stamp(self.t),));db.commit()
    db.commit()
    self.assertEqual(self.info_text(engine.portfolio_ramp(self.db, self.t, self.c), 'reason'), 'predecessor_unknown_effect')
    _ = db.execute("UPDATE touches SET state='sent_verified'")
    db.commit()
    _ = db.execute(
     "INSERT INTO replies(gmail_id,item,kind,observed,evidence) VALUES(?,?,?,?,?)",
     ('b', 'fixture', 'complaint', engine.stamp(self.t), '{}'),
    )
    db.commit()
    self.assertEqual(self.info_text(engine.portfolio_ramp(self.db, self.t, self.c), 'reason'), 'predecessor_adverse_signal_requires_review')
  def test_missing_ledger_or_tampered_current_contract_never_uses_cached_completion(self) -> None:
   (self.prior.root/'campaign-state.sqlite3').unlink()
   self.assertTrue(self.info_text(engine.portfolio_ramp(self.db, self.t, self.c), 'reason').startswith('predecessor_completion_unproven'))
   limits = self.prior.c['limits']
   limits['lastOutboundDate'] = '2026-10-20'
   self.prior.c['limits'] = limits
   _ = engine.save(self.prior.root/'campaign-contract.json',self.prior.c)
   self.assertTrue(self.info_text(engine.portfolio_ramp(self.db, self.t, self.c), 'reason').startswith('predecessor_completion_unproven'))
  def test_current_authorized_deadline_is_read_each_time(self) -> None:
   limits = self.prior.c['limits']
   limits['lastOutboundDate'] = '2026-10-12'
   self.prior.c['limits'] = limits
   self.prior.write()
   t=datetime(2026,10,13,7,tzinfo=UTC)
   self.assertEqual(self.info_text(engine.portfolio_ramp(self.db, t, self.c), 'phase'), 'initial_20')
   limits['lastOutboundDate'] = '2026-10-13'
   self.prior.c['limits'] = limits
   self.prior.write()
   self.assertEqual(self.info_text(engine.portfolio_ramp(self.db, t, self.c), 'phase'), 'predecessor_active')
  def test_replies_followups_and_all_lanes_share_daily_twenty(self) -> None:
   lane_daily_max = data_json_object_or_empty(data_json_object_or_empty(self.c.get('postScotlandRamp')).get('laneDailyMax'))
   for lane, cap_value in lane_daily_max.items():
    if not isinstance(cap_value, int):
     self.fail(f'non_integer_lane_cap:{lane}')
    for i in range(cap_value):
     self.effect(lane + str(i), lane=lane, step=['initial', 'reply', 'followup'][i % 3])
   for lane in engine.LANES:
    info = self.capacity_info(lane, self.t, False)
    portfolio_ramp = data_json_object_or_empty(info.get('portfolioRamp'))
    self.assertEqual(self.info_int(portfolio_ramp, 'dailyUsed'), 20)
  def test_five_completed_healthy_business_days_release_thirty(self) -> None:
   self.healthy_days()
   t=datetime(2026,10,21,7,tzinfo=UTC)
   info=engine.portfolio_ramp(self.db,t,self.c)
   self.assertEqual((self.info_text(info, 'phase'), self.info_int(info, 'dailyCap'), self.info_int(info, 'weeklyCap')), ('steady_30', 30, 150))
   self.assertEqual(sum(self.info_int(self.capacity_info(lane, t, True), 'dailyCap') for lane in engine.LANES),30)
  def test_time_elapsed_or_current_incomplete_day_does_not_release_thirty(self) -> None:
   self.assertEqual(self.info_text(engine.portfolio_ramp(self.db, self.t + timedelta(days=40), self.c), 'phase'), 'initial_20')
   self.healthy_days()
   self.assertEqual(self.info_text(engine.portfolio_ramp(self.db, datetime(2026, 10, 20, 17, tzinfo=UTC), self.c), 'phase'), 'initial_20')
  def test_french_unknown_effect_blocks_portfolio_and_complaint_remains_paused(self) -> None:
   self.effect('pending',state='reserved')
   self.assertEqual(engine.lane_capacity(self.db, 'pme', self.t, self.c), (False, 'portfolio_unknown_gmail_effect'))
   _ = self.db.execute("UPDATE touches SET state='verified'")
   _ = self.db.execute("INSERT INTO replies VALUES('complaint','old@fixture.invalid','pme','complaint',?,'{}')", (engine.stamp(self.t),));self.db.commit()
   self.assertEqual(engine.lane_capacity(self.db, 'pme', self.t, self.c), (False, 'complaint_pause'))
  def test_daily_reset_uses_paris_and_weekly_history_is_not_reset(self) -> None:
   self.effect('yesterday',lane='presse',t=self.t-timedelta(days=1))
   info=engine.portfolio_ramp(self.db,self.t,self.c)
   self.assertEqual((self.info_int(info, 'dailyUsed'), self.info_int(info, 'weeklyUsed')), (0, 1))
   later=datetime(2026,10,26,8,tzinfo=UTC)
   self.assertTrue(engine.in_window(later,self.c))
   self.assertEqual(engine.portfolio_ramp(self.db,later,self.c)['weeklyUsed'],0)
  def test_ramp_cannot_increase_above_authorized_thirty_even_with_new_digest(self) -> None:
   altered = copy.deepcopy(self.c)
   self.section(altered, 'postScotlandRamp')['steadyDailyMax'] = 31
   self.section(altered, 'authorization')['scopeSha256'] = engine.digest({k: v for k, v in altered.items() if k != 'authorization'})
   p = self.root / 'altered.json'
   _ = engine.save(p, altered)
   with self.assertRaises(AssertionError): _ = engine.contract(p)
  def test_recovered_bounce_keeps_one_daily_and_historical_signal(self) -> None:
   bounce=self.t-timedelta(days=8)
   _ = self.db.execute("INSERT INTO replies VALUES('bounce','old@fixture.invalid','pme','bounce',?,'{}')", (engine.stamp(bounce),))
   _ = self.db.execute("INSERT INTO metadata VALUES('recovery_epoch_pme',?)", (json.dumps({'afterBounce': engine.stamp(bounce)}),))
   self.db.commit()
   allowed, info = engine.lane_capacity(self.db, 'pme', self.t, self.c)
   self.assertTrue(allowed)
   if not isinstance(info, dict):
    self.fail('expected_capacity_details:pme')
   self.assertEqual(self.info_int(info, 'dailyCap'), 1)
   row_value: object = cast(object, self.db.execute("SELECT count(*) FROM replies WHERE kind='bounce'").fetchone())
   if not isinstance(row_value, sqlite3.Row):
    self.fail('missing_bounce_count')
   count_value: object = cast(object, row_value[0])
   if not isinstance(count_value, int):
    self.fail('invalid_bounce_count')
   self.assertEqual(count_value, 1)
  def test_new_press_allocation_requires_exact_human_authorization(self) -> None:
   altered = copy.deepcopy(self.c)
   _ = self.section(altered, 'postScotlandRamp').pop('allocationChange')
   self.section(altered, 'authorization')['scopeSha256'] = engine.digest({k: v for k, v in altered.items() if k != 'authorization'})
   p = self.root / 'unauthorized.json'
   _ = engine.save(p, altered)
   with self.assertRaises(AssertionError): _ = engine.contract(p)
  def test_new_press_allocation_preserves_previous_authorized_scope(self) -> None:
   altered = copy.deepcopy(self.c)
   post_scotland_ramp = self.section(altered, 'postScotlandRamp')
   allocation = self.section(post_scotland_ramp, 'allocationChange')
   allocation['previousScopeSha256'] = 'not_the_previous_contract'
   authorization = self.section(altered, 'authorization')
   authorization['scopeSha256'] = engine.digest({key: value for key, value in altered.items() if key != 'authorization'})
   path = self.root / 'bad-previous.json'
   _ = engine.save(path, altered)
   with self.assertRaisesRegex(AssertionError, 'allocation_prior_scope_changed'):
    _ = engine.contract(path)
  def test_future_dispatch_simulation_stops_exactly_at_twenty_and_thirty(self) -> None:
   for steady, expected in [(False, 20), (True, 30)]:
    with self.subTest(steady=steady):
     _ = self.db.execute('DELETE FROM touches')
     _ = self.db.execute('DELETE FROM candidates')
     self.db.commit()
     if steady:
      self.healthy_days()
     base = datetime(2026, 10, 21 if steady else 14, 7, tzinfo=UTC)
     gateway = EndGateway(self.root / ('gateway-' + str(steady)))
     post_scotland_ramp = self.section(self.c, 'postScotlandRamp')
     cap_key = 'steadyLaneDailyMax' if steady else 'laneDailyMax'
     caps = self.section(post_scotland_ramp, cap_key)
     cap_values: dict[str, int] = {}
     for lane in engine.LANES:
      cap_value = caps.get(lane)
      if not isinstance(cap_value, int):
       self.fail(f'non_integer_lane_cap:{lane}')
      cap_values[lane] = cap_value
     order = [lane for lane in engine.LANES for _ in range(cap_values[lane])]
     for lane in engine.LANES:
      for i in range(cap_values[lane] + 1):
       item: JsonObject = {
        'email': f'{lane}{i}@fixture.invalid',
        'name': 'Fixture Person',
        'company': f'{lane}{i}',
        'domain': f'{lane}{i}.invalid',
        'siren': '',
        'lane': lane,
       }
       engine.put_candidate(self.db, item)
     _ = self.db.execute(
      'UPDATE candidates SET proof=?',
      (json.dumps({'ok': True, 'checkedAt': engine.stamp(base)}),),
     )
     self.db.commit()
     last_dispatch = base
     for i, lane in enumerate(order):
      # Eighteen morning slots, then afternoon; every effect is ten minutes apart.
      t = base + timedelta(minutes=10 * i) if i < 18 else base + timedelta(hours=5, minutes=10 * (i - 18))
      gateway.time = t
      last_dispatch = t
      def fixed_now(current: datetime = t) -> datetime:
       return current
      with patch_engine('OPS', self.root / ('reports-' + str(steady))), patch_engine('now', fixed_now):
       report = engine.run(lane, apply=True, root=self.root, c=self.c, gateway=gateway, t=t, research_batch=0)
      self.assertEqual(report['status'], 'sent_verified', f'lane={lane} attempt={i} report={report}')
     self.assertEqual(gateway.posts, expected)
     if steady:
      press = sum(guard.header(message_value, 'X-RBW-Campaign') == engine.IDS['presse'] for message_value in gateway.messages.values())
      prospecting = sum(guard.header(message_value, 'X-RBW-Campaign') in [engine.IDS['pme'], engine.IDS['eti']] for message_value in gateway.messages.values())
      self.assertEqual((press, prospecting), (10, 20))
     for lane in engine.LANES:
      allowed, _ = engine.lane_capacity(self.db, lane, last_dispatch, self.c)
      self.assertFalse(allowed)
