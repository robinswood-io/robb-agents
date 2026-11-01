"""Offline effects only: approved 40/day profile, London split window, real guards."""
import copy
import json
import unittest
from datetime import UTC, datetime, timedelta
from typing import override
from unittest.mock import patch

import scotland_conference_test_fixtures as fixtures
import scotland_executive_conference_october as m
from scotland_conference_test_fixtures import ITEM_ADAPTER, Fake
from scotland_executive_conference_types import ExecutiveCampaignContract


class Daily40Tests(unittest.TestCase):
    def __init__(self, methodName: str = 'runTest') -> None:
        super().__init__(methodName)
        self.fx: fixtures.CampaignFixture = fixtures.CampaignFixture()
        self.old: ExecutiveCampaignContract = copy.deepcopy(self.fx.c)
        self.c: ExecutiveCampaignContract = copy.deepcopy(self.old)

    @override
    def setUp(self) -> None:
        self.fx.setUp()
        self.fx.c['limits'].update(weeklyTouches=100,hourlyTouches=3,minimumSendIntervalSeconds=1200,maxRunTouches=1,maxCompanies=500,maxContacts=500)
        self.fx.write()
        self.old=copy.deepcopy(self.fx.c)
        self.c=m.daily40_contract(self.old)
        self.fx.c=self.c
        self.fx.write()
    @override
    def tearDown(self) -> None:
        self.fx.tearDown()
    def resign(self) -> None:
        self.c['authorization']['scopeSha256']=m.digest(m.signed_scope(self.c))
    def test_change_preserves_approved_scope_and_is_idempotent(self) -> None:
        self.assertEqual(self.c['items'],self.old['items'])
        self.assertEqual(self.c['templates'],self.old['templates'])
        self.assertEqual(self.c['event'],self.old['event'])
        self.assertEqual(m.daily40_contract(self.c),self.c)
        change = self.c['authorization'].get('dailyScheduleChange')
        if change is None: raise AssertionError('schedule provenance missing')
        self.assertEqual(m.digest(m.signed_scope(self.old)),change.get('previousScopeSha256'))
    def test_no_unauthorized_raise_or_profile(self) -> None:
        for field,value in [('dailyTouches',41),('weeklyTouches',201),('hourlyTouches',7),('minimumSendIntervalSeconds',599),('maxRunTouches',2),('cadenceProfile','other')]:
            c=copy.deepcopy(self.c);c['limits'][field]=value;c['authorization']['scopeSha256']=m.digest(m.signed_scope(c))
            with self.subTest(field=field),self.assertRaises(AssertionError):m.verify_contract(c)
    def test_cadence_requires_authorization(self) -> None:
        del self.c['authorization']['dailyScheduleChange']
        with self.assertRaisesRegex(AssertionError,'daily40_authorization_missing'):m.verify_contract(self.c)
    def test_resigned_recipient_cannot_change_previous_approval(self) -> None:
        self.c['items'][0]['email']='other@example.co.uk';self.resign()
        with self.assertRaisesRegex(AssertionError,'daily40_prior_scope_mismatch'):m.verify_contract(self.c)
    def test_resigned_copy_cannot_change_previous_approval(self) -> None:
        self.c['templates']['A']['body']+='changed';self.resign()
        with self.assertRaisesRegex(AssertionError,'daily40_prior_scope_mismatch'):m.verify_contract(self.c)
    def test_window_cannot_expand(self) -> None:
        self.c['limits']['sendingWindows']=[['09:00','18:00']];self.resign()
        with self.assertRaisesRegex(AssertionError,'unapproved_daily40_windows'):m.verify_contract(self.c)
    def test_london_exact_boundaries_and_lunch(self) -> None:
        # October BST: these are UTC instants corresponding to the requested local hours.
        for hour,minute,second,wanted in [(7,59,59,False),(8,0,0,True),(10,59,59,True),(11,0,0,False),(12,59,59,False),(13,0,0,True),(16,59,59,True),(17,0,0,False)]:
            with self.subTest(hour=hour,minute=minute):
                self.assertEqual(m.window(datetime(2026,10,5,hour,minute,second,tzinfo=UTC),self.c['limits']),wanted)
    def test_weekend_and_winter_london(self) -> None:
        self.assertFalse(m.window(datetime(2026,10,3,9,tzinfo=UTC),self.c['limits']))
        self.assertFalse(m.window(datetime(2026,11,2,8,59,tzinfo=UTC),self.c['limits']))
        self.assertTrue(m.window(datetime(2026,11,2,9,tzinfo=UTC),self.c['limits']))
        self.assertFalse(m.window(datetime(2026,11,2,12,tzinfo=UTC),self.c['limits']))
    def test_lunch_and_after_close_cannot_send(self) -> None:
        for t in [datetime(2026,10,5,11,tzinfo=UTC),datetime(2026,10,5,12,tzinfo=UTC),datetime(2026,10,5,17,tzinfo=UTC)]:
            g=Fake();r=m.run(root=self.fx.root,gateway=g,apply=True,t=t,suppression_path=self.fx.supp)
            self.assertEqual(g.send_calls,0);self.assertIn('outside_london_business_window',r['decisions'][0]['blockingReasons'])
    def test_six_in_rolling_hour_unknown_reservations_count(self) -> None:
        db=m.database(self.fx.root)
        t=datetime(2026,10,5,9,tzinfo=UTC)
        for i in range(6):
            _ = db.execute("INSERT INTO touches(item,step,state,created,variant,operation,draft,checks) VALUES(?,?,?,?,?,?,?,?)",(str(i),'initial','unknown',m.stamp(t-timedelta(minutes=59-10*i)),'A',str(i),'{}','{}'))
        db.commit()
        p=m.pacing(db,self.c['limits'],t)
        self.assertEqual(p['hourlyTouchesUsed'],6)
        self.assertIn('rolling_hourly_touch_cap_reached',p['blockingReasons'])
        db.close()
    def test_600_seconds_uses_actual_gmail_time(self) -> None:
        db=m.database(self.fx.root);t=datetime(2026,10,5,8,tzinfo=UTC)
        _ = db.execute("INSERT INTO touches(item,step,state,created,variant,operation,draft,checks) VALUES(?,?,?,?,?,?,?,?)",('old','initial','sent_verified',m.stamp(t),'A','old','{}',json.dumps({'gmailSentAt':m.stamp(t+timedelta(seconds=25))})))
        db.commit()
        self.assertGreater(m.pacing(db,self.c['limits'],t+timedelta(seconds=600))['waitSeconds'],0)
        self.assertEqual(m.pacing(db,self.c['limits'],t+timedelta(seconds=625))['waitSeconds'],0)
        db.close()
    def test_full_split_day_stops_at_40_without_replay(self) -> None:
        # Forty-two scheduled opportunities, all fictitious companies and mailboxes.
        old=copy.deepcopy(self.old);old['items']=[]
        for i in range(42):
            domain='example'+str(i)+'.co.uk'
            item=ITEM_ADAPTER.validate_python(self.fx.item|{'id':'item'+str(i),'company':'Company '+str(i),'domain':domain,'email':'alex@'+domain})
            for key in ('employeeEvidenceUrl','roleEvidenceUrl','legalEvidenceUrl','locationEvidenceUrl'):
                item[key]='https://'+domain+'/about'
            old['items'].append(item)
        old['authorization']['scopeSha256']=m.digest(m.signed_scope(old))
        self.fx.c=m.daily40_contract(old);self.fx.write();g=Fake()
        last_report = None
        for hour in (9,10,11,14,15,16,17):
            for minute in range(0,60,10):
                t=datetime(2026,10,5,hour-1,minute,tzinfo=UTC)
                with patch.object(fixtures,'T',t):
                    last_report=m.run(root=self.fx.root,gateway=g,apply=True,t=t,suppression_path=self.fx.supp)
        self.assertEqual(g.send_calls,40)
        if last_report is None: raise AssertionError('daily simulation did not run')
        self.assertEqual(last_report['dailyTouchesUsed'],40)
        self.assertTrue(any('touch_cap_reached' in x['blockingReasons'] for x in last_report['decisions']))
        db=m.database(self.fx.root)
        self.assertEqual(db.execute("SELECT count(*) FROM touches WHERE state='sent_verified'").fetchone()[0],40)
        self.assertEqual(db.execute("SELECT count(DISTINCT item) FROM touches").fetchone()[0],40)
        db.close()
if __name__=='__main__':_ = unittest.main()
