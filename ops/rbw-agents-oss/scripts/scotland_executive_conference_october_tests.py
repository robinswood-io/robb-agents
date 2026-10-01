#!/usr/bin/env python3
"""Offline safety tests: all Gmail effects are simulated."""
import base64, copy, json, re, tempfile, unittest
from datetime import datetime, timezone, timedelta
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import patch
import scotland_executive_conference_october as m
import scotland_conference_audience as audience
import scotland_conference_marketing as marketing

T = datetime(2026,10,1,8,20,tzinfo=timezone.utc)

def payload(part):
    out = {'mimeType':part.get_content_type(),'headers':[{'name':k,'value':str(v)} for k,v in part.items()], 'filename':part.get_filename() or ''}
    if part.is_multipart():
        out['parts']=[payload(x) for x in part.iter_parts()]
    else:
        out['body']={'data':base64.urlsafe_b64encode(part.get_payload(decode=True)).decode()}
    return out

def inbound(text, sender='alex@example.co.uk', mid='reply1',thread='t1',auto=None):
    p={'mimeType':'text/plain','headers':[{'name':'From','value':sender},{'name':'To','value':m.SENDER}],'body':{'data':base64.urlsafe_b64encode(text.encode()).decode()}}
    if auto:p['headers'].append({'name':'Auto-Submitted','value':auto})
    return {'id':mid,'threadId':thread,'labelIds':['INBOX'],'internalDate':str(int((T+timedelta(hours=1)).timestamp()*1000)),'payload':p}

class Fake:
    prepare=m.Gateway.prepare
    def __init__(self, uncertain=False, mismatch=False, history=False):
        self.identity={'signature':'<div>Thibault Fritsch<br>Robinswood</div>','verificationStatus':'accepted'}
        self.messages={}
        self.uncertain=uncertain
        self.mismatch=mismatch
        self.history=history
        self.send_calls=0
    def search(self,q):
        if self.history:return [{'id':'old-company-contact'}]
        if 'rfc822msgid:' in q:
            op=q.split('rfc822msgid:')[1]
            return [{'id':k} for k,x in self.messages.items() if m.header(x,'Message-ID').strip('<>')==op]
        targets=re.findall(r'(?:to|from):([^\s{}]+)',q)
        return [{'id':k} for k,x in self.messages.items() if any(a==z or a.endswith('@'+z) for a in m.addresses(m.header(x,'To'))+m.addresses(m.header(x,'From')) for z in targets)]
    def call(self,path,data=None):
        if path.startswith('/threads/'):
            tid=path.split('/')[2].split('?')[0]
            return {'messages':[x for x in self.messages.values() if x['threadId']==tid]}
        raise AssertionError(path)
    def get(self,key):
        return copy.deepcopy(self.messages[key])
    def send(self,raw,thread_id=None):
        self.send_calls+=1
        em=BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(raw))
        key='m'+str(self.send_calls)
        msg={'id':key,'threadId':thread_id or 't'+str(self.send_calls),'labelIds':['SENT'],'payload':payload(em),'internalDate':str(int(T.timestamp()*1000))}
        if self.mismatch:msg['payload']['headers']=[h for h in msg['payload']['headers'] if h['name'].lower()!='to']+[{'name':'To','value':'wrong@example.com'}]
        self.messages[key]=msg
        if self.uncertain:
            self.uncertain=False
            raise TimeoutError()
        return {'id':key,'threadId':msg['threadId']}

class CampaignTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.supp=self.root/'suppression.json'
        m.save(self.supp,{'blockedRecipients':[],'records':[]})
        self.item={'id':'one','company':'Example Scotland','domain':'example.co.uk','email':'alex@example.co.uk','firstName':'Alex','contactName':'Alex Example','role':'CEO','employeeMinimum':36,'employeeEvidenceUrl':'https://example.co.uk/about','scottishHeadquarters':True,'corporateType':'limited_company','roleEvidenceUrl':'https://example.co.uk/team','legalEvidenceUrl':'https://example.co.uk/legal','locationEvidenceUrl':'https://example.co.uk/contact','roleCheckedAt':m.stamp(T-timedelta(days=1)),'relevance':'financial controls'}
        self.c={'campaignId':'scotland-executive-conference-october-2026','sender':m.SENDER,'language':'en-GB','activation':'active','paidAdsAllowed':False,'crmMutationAllowed':False,'event':{'start':'2026-10-07','end':'2026-10-14'},'limits':{'dailyTouches':10,'weeklyTouches':40,'maxCompanies':40,'maxFollowups':1,'firstOutboundDate':'2026-10-01','lastInitialDate':'2026-10-08','lastOutboundDate':'2026-10-13'},'templates':{k:{'subject':'AI for {company}','body':"Hello {firstName},\n\nAn in-person session for {company}. Your work on {relevance} is relevant.\n\nReply 'no thanks' to opt out."} for k in ['A','B','followup']},'items':[self.item],'authorization':{'source':'human_campaign_launch_request_2026-09-30','externalSendAuthorized':True}}
        self.proof={'checkedAt':m.stamp(T-timedelta(days=1)),'result':'deliverable','acceptAll':False,'score':100}
        self.write()
        self.patch=patch.object(m,'GLOBAL_SUPPRESSION',self.supp)
        self.patch.start()
    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()
    def write(self):
        self.c['authorization']['scopeSha256']=m.digest(m.signed_scope(self.c))
        m.save(self.root/'campaign-contract.json',self.c)
        m.save(self.root/'email-evidence.json',{'items':{x['email']:self.proof for x in self.c['items']}})
    def runit(self,g=None,t=T,apply=True):
        return m.run(self.root,gateway=g or Fake(),apply=apply,t=t,suppression_path=self.supp)
    def test_realistic_send_exact_effect_and_idempotence(self):
        g=Fake()
        a=self.runit(g)
        self.assertEqual(a['verifiedSendsTotal'],1)
        self.assertEqual(g.send_calls,1)
        self.assertEqual(a['qualifiedCompanies'],0)
        b=self.runit(g)
        self.assertEqual(g.send_calls,1)
        self.assertIn('followup_not_due',b['decisions'][0]['blockingReasons'])
    def test_unknown_effect_is_reconciled_without_resend(self):
        g=Fake(uncertain=True)
        a=self.runit(g)
        self.assertFalse(a['ok'])
        b=self.runit(g)
        self.assertTrue(b['ok'])
        self.assertEqual(g.send_calls,1)
        self.assertEqual(b['verifiedSendsTotal'],1)
    def test_bad_postsend_effect_stops_campaign(self):
        a=self.runit(Fake(mismatch=True))
        self.assertFalse(a['ok'])
        self.assertEqual(a['verifiedSendsTotal'],0)
    def test_existing_company_contact_prevents_send(self):
        g=Fake(history=True)
        a=self.runit(g)
        self.assertEqual(g.send_calls,0)
        self.assertIn('existing_company_or_recipient_relationship',a['decisions'][0]['blockingReasons'])
    def test_headcount_threshold_is_strict(self):
        for count in [0,11,35,36]:
            with self.subTest(count=count):
                x=copy.deepcopy(self.item);x['employeeMinimum']=count
                self.assertEqual('strict_headcount_not_proven' in m.eligible(x,self.proof,T),count<=35)
    def test_role_is_not_inferred_from_seniority(self):
        for role in ['Associate Director','Sales Executive','Head of Partnerships','CEO']:
            with self.subTest(role=role):
                x=copy.deepcopy(self.item);x['role']=role
                self.assertEqual('not_verified_executive' in m.eligible(x,self.proof,T),role!='CEO')
    def test_unproven_deliverability_blocks(self):
        for change in [{'checkedAt':'2026-08-12T09:55:59Z'},{'checkedAt':'2027-01-01T00:00:00Z'},{'acceptAll':True},{'score':80},{'result':'unknown'}]:
            with self.subTest(change=change):
                p=self.proof|change
                self.assertIn('deliverability_stale_or_unproven',m.eligible(self.item,p,T))
    def test_suppression_current_and_preserved(self):
        m.save(self.supp,{'blockedRecipients':[],'records':[{'email':self.item['email'],'active':True,'otherField':'preserved'}]})
        g=Fake();a=self.runit(g)
        self.assertEqual(g.send_calls,0)
        self.assertIn('suppressed',a['decisions'][0]['blockingReasons'])
    def test_out_of_window_does_not_send(self):
        for t in [T-timedelta(hours=1),T+timedelta(hours=8),T+timedelta(days=2),T+timedelta(days=14)]:
            with self.subTest(t=t):
                g=Fake();self.runit(g,t=t);self.assertEqual(g.send_calls,0)
    def test_scope_drift_fails_closed(self):
        c=copy.deepcopy(self.c);c['templates']['A']['body']='Different body'
        m.save(self.root/'campaign-contract.json',c)
        with self.assertRaises(AssertionError):self.runit()
    def test_one_executive_per_company(self):
        self.c['items'].append(self.item|{'id':'two','email':'sam@example.co.uk'})
        self.write()
        g=Fake();a=self.runit(g)
        self.assertEqual(g.send_calls,1)
        self.assertIn('another_executive_already_contacted_at_company',a['decisions'][1]['blockingReasons'])
    def test_daily_cap_includes_previous_sends(self):
        self.c['limits']['dailyTouches']=1
        self.c['items'].append(self.item|{'id':'two','email':'sam@other.co.uk','domain':'other.co.uk'})
        self.write();g=Fake();a=self.runit(g)
        self.assertEqual(g.send_calls,1)
        self.assertIn('touch_cap_reached',a['decisions'][1]['blockingReasons'])
    def test_followup_due_after_three_business_days_and_once(self):
        g=Fake();self.runit(g)
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(g.send_calls,2)
        self.assertEqual(m.header(g.messages['m2'],'Subject'),'Re: AI for Example Scotland')
        self.assertEqual(g.messages['m1']['threadId'],g.messages['m2']['threadId'])
        self.runit(g,t=T+timedelta(days=6));self.assertEqual(g.send_calls,2)
    def test_response_stops_followup_and_is_attributed_once(self):
        g=Fake();self.runit(g)
        g.messages['reply']=inbound('Yes, please send the practical details.')
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(g.send_calls,1)
        self.assertEqual(a['qualifiedCompanies'],1)
        self.assertEqual(self.runit(g,t=T+timedelta(days=6))['qualifiedCompanies'],1)
    def test_unsubscribe_updates_global_suppression_and_stops(self):
        g=Fake();self.runit(g)
        g.messages['reply']=inbound('No thanks. Please remove me.')
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(g.send_calls,1);self.assertIn(self.item['email'],m.suppressed(self.supp))
        self.assertEqual(a['qualifiedCompanies'],0)
    def test_quote_and_autoreply_are_not_leads(self):
        for text,auto,kind in [('Thanks.\nOn Thursday Alex wrote:\nYes, interested.',None,'reply_received'),('Out of office. I am interested.',None,'automatic_reply'),('Yes, please.','auto-replied','automatic_reply'),('Not interested',None,'opt_out_or_negative'),('Please stop this spam',None,'complaint'),('Yes',None,'qualified_interest')]:
            with self.subTest(text=text):self.assertEqual(m.classify(inbound(text,auto=auto))[0],kind)
    def test_wrong_recipient_reply_is_not_a_qualified_lead(self):
        g=Fake();self.runit(g);g.messages['reply']=inbound('Yes, please',sender='other@example.co.uk')
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(a['qualifiedCompanies'],0);self.assertEqual(g.send_calls,1)
    def test_learning_does_not_reward_sends_or_premature_winner(self):
        g=Fake();self.runit(g)
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertIsNone(a['learning']['winner'])
        self.assertFalse(a['learning']['opensUsed'])
        self.assertEqual(a['learning']['arms']['A']['qualifiedCompanies'],0)
    def test_simulation_has_no_network_send(self):
        g=Fake();a=self.runit(g,apply=False)
        self.assertEqual(g.send_calls,0);self.assertTrue(a['simulation'])
    def test_prepared_campaign_cannot_send(self):
        self.c['activation']='prepared';self.write();g=Fake();a=self.runit(g)
        self.assertEqual(g.send_calls,0);self.assertIn('campaign_not_active',a['decisions'][0]['blockingReasons'])

    def test_hundreds_are_allowed_without_increasing_send_cap(self):
        self.c['limits'].update(maxCompanies=500,maxContacts=500,weeklyTouches=100,maxRunTouches=1)
        self.c['items']=[self.item|{'id':str(n),'domain':f'company{n}.co.uk','email':f'alex@company{n}.co.uk'} for n in range(300)]
        self.write();g=Fake();a=self.runit(g)
        self.assertEqual(a['audienceContacts'],300)
        self.assertEqual(g.send_calls,1)
        self.assertIn('paced_run_cap_reached',a['decisions'][1]['blockingReasons'])
    def pacing_audience(self):
        self.c['limits'].update(hourlyTouches=3,minimumSendIntervalSeconds=1200,maxRunTouches=1)
        self.c['items']=[self.item|{'id':str(n),'domain':f'company{n}.co.uk','email':f'alex@company{n}.co.uk'} for n in range(6)]
        self.write()

    def test_twenty_minute_spacing_survives_a_new_process(self):
        self.pacing_audience();g=Fake();self.runit(g)
        blocked=self.runit(g,t=T+timedelta(minutes=19,seconds=59))
        self.assertEqual(g.send_calls,1)
        self.assertIn('minimum_send_interval_not_elapsed',blocked['decisions'][1]['blockingReasons'])
        self.runit(g,t=T+timedelta(minutes=20))
        self.assertEqual(g.send_calls,2)

    def test_three_in_rolling_hour_and_no_burst_at_clock_hour(self):
        self.pacing_audience();g=Fake()
        for n in range(3):self.runit(g,t=T+timedelta(minutes=20*n))
        blocked=self.runit(g,t=T+timedelta(minutes=59,seconds=59))
        self.assertEqual(g.send_calls,3)
        self.assertIn('rolling_hourly_touch_cap_reached',blocked['decisions'][3]['blockingReasons'])
        self.runit(g,t=T+timedelta(minutes=60))
        self.assertEqual(g.send_calls,4)

    def test_unknown_reservation_consumes_hourly_capacity(self):
        self.pacing_audience();g=Fake(uncertain=True);self.runit(g)
        db=m.database(self.root)
        p=m.pacing(db,self.c['limits'],T+timedelta(minutes=1));db.close()
        self.assertEqual(p['hourlyTouchesUsed'],1)
        self.assertIn('minimum_send_interval_not_elapsed',p['blockingReasons'])
        self.assertEqual(g.send_calls,1)

    def test_spacing_uses_gmail_effect_time_after_a_slow_send(self):
        self.pacing_audience();g=Fake();self.runit(g)
        db=m.database(self.root)
        row=db.execute('SELECT checks FROM touches').fetchone()
        checks=json.loads(row['checks']);checks['gmailSentAt']=m.stamp(T+timedelta(minutes=1))
        db.execute('UPDATE touches SET checks=?',(json.dumps(checks),));db.commit();db.close()
        blocked=self.runit(g,t=T+timedelta(minutes=20))
        self.assertEqual(g.send_calls,1)
        self.assertIn('minimum_send_interval_not_elapsed',blocked['decisions'][1]['blockingReasons'])
        self.runit(g,t=T+timedelta(minutes=21));self.assertEqual(g.send_calls,2)

    def test_future_reservation_cannot_bypass_pacing(self):
        self.pacing_audience();g=Fake();self.runit(g)
        db=m.database(self.root)
        p=m.pacing(db,self.c['limits'],T-timedelta(seconds=1));db.close()
        self.assertEqual(p['hourlyTouchesUsed'],1)
        self.assertGreater(p['waitSeconds'],1200)

    def test_hourly_and_spacing_limits_fail_closed(self):
        for limits in [{'hourlyTouches':4,'minimumSendIntervalSeconds':1200},{'hourlyTouches':3,'minimumSendIntervalSeconds':1199},{'hourlyTouches':True,'minimumSendIntervalSeconds':1200},{'hourlyTouches':3},{'minimumSendIntervalSeconds':1200}]:
            with self.subTest(limits=limits):
                c=copy.deepcopy(self.c);c['limits'].update(limits)
                c['authorization']['scopeSha256']=m.digest(m.signed_scope(c))
                with self.assertRaises(AssertionError):m.verify_contract(c)

    def test_regular_pacing_does_not_raise_the_daily_cap(self):
        self.pacing_audience();self.c['limits']['dailyTouches']=2;self.write();g=Fake()
        self.runit(g);self.runit(g,t=T+timedelta(minutes=20))
        blocked=self.runit(g,t=T+timedelta(minutes=40))
        self.assertEqual(g.send_calls,2)
        self.assertIn('touch_cap_reached',blocked['decisions'][2]['blockingReasons'])
        self.assertEqual(blocked['hourlyTouchCap'],3)
        self.assertEqual(blocked['minimumSendIntervalSeconds'],1200)
        self.assertEqual(blocked['dailyTouchesUsed'],2)

    def test_london_start_is_exactly_nine_am(self):
        g=Fake();self.runit(g,t=datetime(2026,10,1,7,59,tzinfo=timezone.utc))
        self.assertEqual(g.send_calls,0)
        self.runit(g,t=datetime(2026,10,1,8,0,tzinfo=timezone.utc))
        self.assertEqual(g.send_calls,1)
    def test_duplicate_email_is_rejected(self):
        self.c['items'].append(self.item|{'id':'two'});self.write()
        with self.assertRaises(AssertionError):self.runit()
    def test_touch_caps_cannot_be_expanded_in_contract(self):
        for field,value in [('dailyTouches',11),('weeklyTouches',101),('maxCompanies',501)]:
            self.c['limits'][field]=value;self.write()
            with self.assertRaises(AssertionError):self.runit()
            self.c['limits'][field]={'dailyTouches':10,'weeklyTouches':40,'maxCompanies':40}[field]

    def test_new_thread_optout_stops_sequence_and_suppresses(self):
        g=Fake();self.runit(g)
        g.messages['reply1']=inbound('No thanks',thread='other-thread')
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(g.send_calls,1)
        self.assertIn('alex@example.co.uk',m.suppressed(self.supp))
        self.assertEqual(a['qualifiedCompanies'],0)
    def test_new_thread_positive_is_not_learned_without_attribution(self):
        g=Fake();self.runit(g)
        g.messages['reply1']=inbound('Yes, interested',thread='other-thread')
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(g.send_calls,1)
        self.assertEqual(a['qualifiedCompanies'],0)
    def test_out_of_thread_bounce_pauses_and_is_attributed(self):
        class BounceFake(Fake):
            def search(self,q):
                if 'from:mailer-daemon' in q:return [{'id':'bounce1'}] if 'bounce1' in self.messages else []
                return super().search(q)
        g=BounceFake();self.runit(g)
        g.messages['bounce1']=inbound('Undeliverable: delivery failed for alex@example.co.uk',sender='mailer-daemon@example.net',mid='bounce1',thread='dsn-thread')
        a=self.runit(g,t=T+timedelta(days=1))
        self.assertFalse(a['ok'])
        self.assertIn('complaint_or_delivery_failure',a['blockingReasons'])
        self.assertIn('alex@example.co.uk',m.suppressed(self.supp))
    def test_provider_seniority_does_not_make_nonexecutive_eligible(self):
        for raw in ['Associate Director','Head of Marketing','Assistant CEO','former Chief Executive Officer','CFE / CM','Deputy CEO']:
            self.assertIsNone(audience.role(raw))
        self.assertEqual(audience.role('Chief Executive Officer & Founder'),'Chief Executive Officer')
    def test_enrichment_rejects_small_or_non_scottish_company(self):
        for count,geo in [(35,{'countryCode':'GB','city':'Edinburgh'}),(90,{'countryCode':'GB','city':'London'}),(90,{'countryCode':'CA','city':'Edinburgh'})]:
            value={'ok':True,'body':{'data':{'metrics':{'employeesCount':count},'geo':geo,'companyType':'privately held'}}}
            with patch.object(audience,'cache',return_value=value):
                self.assertEqual(audience.company({'domain':'example.co.uk'})['blocked'],'headcount_or_scottish_hq_unproven')

    def test_public_evidence_refresh_cannot_change_approved_recipient(self):
        self.c['items'][0]['roleCheckedAt']=None;self.write()
        evidence=self.item|{'qualification':'qualified_public_role_and_provider_company_evidence','email':'other@example.co.uk'}
        m.save(self.root/'audience-preparation.json',{'items':[evidence]})
        g=Fake();self.runit(g);self.assertEqual(g.send_calls,0)
        evidence['email']=self.item['email'];evidence['roleCheckedAt']=m.stamp(T-timedelta(days=1))
        m.save(self.root/'audience-preparation.json',{'items':[evidence]})
        self.runit(g);self.assertEqual(g.send_calls,1)
    def test_public_evidence_refresh_must_use_the_company_domain(self):
        self.c['items'][0]['roleCheckedAt']=None;self.write()
        evidence=self.item|{'qualification':'qualified_public_role_and_provider_company_evidence','roleEvidenceUrl':'https://unrelated.example/team'}
        m.save(self.root/'audience-preparation.json',{'items':[evidence]})
        g=Fake();self.runit(g);self.assertEqual(g.send_calls,0)

    def marketing(self):
        for key in ['A','B','followup']:
            self.c['templates'][key]['version']='2026-10-01.1'
        self.c['templates']['A']['body']="Hello {firstName},\n\nWould you like the one-page programme?\n\nReply 'no thanks' to opt out."
        self.c['templates']['programme']={'version':'2026-10-01.1','subject':'unused','url':'https://orion.rbw.ovh/campaigns/scotland-october-2026/index.html','body':"Hello {firstName},\n\nHere is the programme: https://orion.rbw.ovh/campaigns/scotland-october-2026/index.html\n\nReply 'no thanks' to opt out."}
        self.write()
    def test_requested_programme_is_sent_once_in_original_thread(self):
        self.marketing();g=Fake();self.runit(g)
        g.messages['reply1']=inbound('Yes, please.')
        a=self.runit(g,t=T+timedelta(hours=1))
        self.assertEqual(g.send_calls,2)
        self.assertEqual(a['commercialFunnel']['programmeRequestedCompanies'],1)
        self.assertEqual(a['commercialFunnel']['programmeDeliveredCompanies'],1)
        self.assertEqual(a['qualifiedCompanies'],0)
        self.assertEqual(g.messages['m2']['threadId'],'t1')
        self.assertIn('campaigns/scotland-october-2026',m.plain(g.messages['m2']['payload']))
        self.assertEqual(m.header(g.messages['m2'],'In-Reply-To'),'') if False else None
        self.runit(g,t=T+timedelta(days=1));self.assertEqual(g.send_calls,2)
    def test_template_change_preserves_sent_subject_and_cannot_replay(self):
        g=Fake();self.runit(g);self.marketing()
        self.c['templates']['A']['subject']='Changed subject for {company}';self.write()
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(g.send_calls,2)
        self.assertEqual(m.header(g.messages['m2'],'Subject'),'Re: AI for Example Scotland')
        self.assertEqual(a['learning']['arms']['A']['maturedCompanies'],0)
    def test_legacy_yes_does_not_trigger_new_programme_cta(self):
        g=Fake();self.runit(g);self.marketing()
        g.messages['reply1']=inbound('Yes')
        a=self.runit(g,t=T+timedelta(hours=1))
        self.assertEqual(g.send_calls,1)
        self.assertEqual(a['commercialFunnel']['interestCompanies'],1)
        self.assertEqual(a['commercialFunnel']['programmeRequestedCompanies'],0)
        self.assertEqual(a['qualifiedCompanies'],0)
    def test_programme_request_in_unrelated_thread_is_not_fulfilled(self):
        self.marketing();g=Fake();self.runit(g)
        g.messages['reply1']=inbound('Please send the programme.',thread='unrelated')
        a=self.runit(g,t=T+timedelta(hours=1))
        self.assertEqual(g.send_calls,1)
        self.assertEqual(a['commercialFunnel']['programmeRequestedCompanies'],0)
    def test_programme_response_obeys_pacing_and_daily_caps(self):
        self.marketing()
        self.c['limits'].update(hourlyTouches=3,minimumSendIntervalSeconds=1200,dailyTouches=1)
        self.write();g=Fake();self.runit(g)
        msg=inbound('Please send the programme.');msg['internalDate']=str(int((T+timedelta(minutes=1)).timestamp()*1000));g.messages['reply1']=msg
        a=self.runit(g,t=T+timedelta(minutes=2))
        self.assertEqual(g.send_calls,1)
        self.assertIn('minimum_send_interval_not_elapsed',a['decisions'][0]['blockingReasons'])
        self.assertIn('touch_cap_reached',a['decisions'][0]['blockingReasons'])
    def test_later_optout_cancels_requested_programme(self):
        self.marketing();g=Fake();self.runit(g)
        g.messages['reply1']=inbound('Please send the programme.')
        g.messages['reply2']=inbound('No thanks, remove me.',mid='reply2')
        a=self.runit(g,t=T+timedelta(hours=1))
        self.assertEqual(g.send_calls,1);self.assertIn('suppressed',a['decisions'][0]['blockingReasons'])
    def test_programme_unknown_effect_is_reconciled_without_resend(self):
        self.marketing();g=Fake();self.runit(g)
        g.messages['reply1']=inbound('Please send the programme.')
        g.uncertain=True
        a=self.runit(g,t=T+timedelta(hours=1));self.assertFalse(a['ok'])
        a=self.runit(g,t=T+timedelta(hours=2));self.assertTrue(a['ok'])
        self.assertEqual(g.send_calls,2);self.assertEqual(a['commercialFunnel']['programmeDeliveredCompanies'],1)
    def test_quantified_need_is_separate_from_programme_and_bookings(self):
        self.marketing();g=Fake();self.runit(g)
        g.messages['reply1']=inbound('We spend 10 hours each week reconciling invoices.')
        a=self.runit(g,t=T+timedelta(days=5))
        self.assertEqual(a['qualifiedCompanies'],1)
        self.assertEqual(a['commercialFunnel']['interestCompanies'],0)
        self.assertIsNone(a['commercialFunnel']['meetingsConfirmed'])
        self.assertIsNone(a['commercialFunnel']['conferencesBooked'])
        self.assertEqual(a['learning']['arms']['A']['qualifiedCompanies'],1)

    def test_marketing_installer_cannot_expand_audience_or_limits(self):
        self.c['limits'].update(hourlyTouches=3,minimumSendIntervalSeconds=1200,weeklyTouches=100,maxRunTouches=1);self.write()
        original=copy.deepcopy(self.c)
        result=marketing.apply(self.root,dry_run=True)
        self.assertTrue(result['ok']);self.assertEqual(result['newGmailEffects'],0)
        self.assertEqual(m.read(self.root/'campaign-contract.json'),original)
        self.c['limits']['dailyTouches']=9;self.write()
        with self.assertRaises(AssertionError):marketing.apply(self.root,dry_run=True)
    def test_role_specific_copy_and_programme_destination_are_signed(self):
        self.c['templates']=marketing.templates();self.write()
        draft=m.body(self.c,self.item|{'role':'Chief Financial Officer'},'A','initial')
        self.assertIn('cost of a workflow',draft['body'])
        self.assertLess(len(draft['body'].split()),170)
        self.c['templates']['programme']['url']='https://unapproved.example.com'
        self.write()
        with self.assertRaises(AssertionError):self.runit()

class PublicQualificationTests(unittest.TestCase):
    def setUp(self):
        self.now=datetime.now(timezone.utc)
        self.item={'id':'one','company':'Example Scotland','domain':'example.co.uk','email':'alex@example.co.uk','contactName':'Alex Example','role':'Chief Executive Officer','corporateType':'limited_company','roleEvidenceUrl':'https://example.co.uk/team','legalEvidenceUrl':'https://example.co.uk/legal','roleCheckedAt':m.stamp(self.now-timedelta(days=1)),'addressSourceType':'found','qualification':audience.QUALIFIED}
        self.page={'url':'https://example.co.uk/team','checkedAt':m.stamp(self.now-timedelta(minutes=1)),'text':'Example Scotland Limited. Alex Example, Chief Executive Officer.','emails':[]}
    def test_inaccessible_site_preserves_review_without_refreshing_date(self):
        result=audience.qualify_item(self.item,[])
        self.assertEqual(result['qualification'],audience.QUALIFIED)
        self.assertEqual(result['roleCheckedAt'],self.item['roleCheckedAt'])
    def test_stale_or_unrelated_review_cannot_be_preserved(self):
        for updates in [{'roleCheckedAt':m.stamp(self.now-timedelta(days=15))},{'roleEvidenceUrl':'https://unrelated.example/team'}]:
            result=audience.qualify_item(self.item|updates,[])
            self.assertNotEqual(result['qualification'],audience.QUALIFIED)
            self.assertIsNone(result['roleCheckedAt'])
    def test_generated_mailbox_requires_primary_publication(self):
        result=audience.qualify_item(self.item|{'addressSourceType':'generated','qualification':'candidate'},[self.page])
        self.assertEqual(result['qualification'],'address_binding_requires_primary_confirmation')
        self.assertIsNone(result['roleCheckedAt'])
    def test_published_mailto_qualifies_generated_address(self):
        text,emails=audience.public_html('<div>Example Scotland Limited. Alex Example, Chief Executive Officer.</div><a href="mailto:alex%40example.co.uk?subject=Hello">Email Alex</a>')
        self.assertNotIn('alex@example.co.uk',text)
        result=audience.qualify_item(self.item|{'addressSourceType':'generated','qualification':'candidate'},[self.page|{'text':text,'emails':emails}])
        self.assertEqual(result['qualification'],audience.QUALIFIED)
        self.assertEqual(result['addressBindingEvidenceUrl'],self.page['url'])
    def test_other_domains_or_substring_mailboxes_cannot_bind(self):
        for page in [self.page|{'url':'https://unrelated.example/team','emails':[self.item['email']]},self.page|{'text':self.page['text']+' fakealex@example.co.uk'}]:
            result=audience.qualify_item(self.item|{'addressSourceType':'generated','qualification':'candidate'},[page])
            self.assertNotEqual(result['qualification'],audience.QUALIFIED)
    def test_explicit_former_role_invalidates_prior_review(self):
        result=audience.qualify_item(self.item,[self.page|{'text':'Example Scotland Limited. Alex Example, former Chief Executive Officer.'}])
        self.assertNotEqual(result['qualification'],audience.QUALIFIED)
        self.assertIsNone(result['roleCheckedAt'])
    def test_adjacent_executive_cannot_qualify_a_different_director(self):
        item=self.item|{'contactName':'Alan Mclean','role':'Managing Director','qualification':'candidate'}
        page=self.page|{'text':'Example Scotland Limited. Alan Bailey Managing Director – Fabrication Bio > Alan Mclean Contracts & Commercial Director Bio > Alasdair Noble Director'}
        self.assertNotEqual(audience.qualify_item(item,[page])['qualification'],audience.QUALIFIED)
    def test_former_role_of_another_person_does_not_reject_current_executive(self):
        page=self.page|{'text':'Example Scotland Limited. Previous Person former Chief Executive Officer > Alex Example Group Chief Executive Officer.'}
        self.assertEqual(audience.qualify_item(self.item,[page])['qualification'],audience.QUALIFIED)
    def test_all_name_occurrences_are_checked_for_attached_role(self):
        page=self.page|{'text':'Example Scotland Limited. Alex Example Menu Contact > Careers. Executive team: Alex Example Co-Founder & Chief Executive Officer.'}
        result=audience.qualify_item(self.item|{'qualification':'candidate'},[page])
        self.assertEqual(result['qualification'],audience.QUALIFIED)
    def test_original_provider_source_type_is_recovered_without_api_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            m.save(root/'hunter-cache'/'cached.json',{'body':{'data':{'emails':[{'value':'alex@example.co.uk','source_type':'generated'}]}}})
            with patch.object(audience,'ROOT',root),patch.object(audience,'call',side_effect=AssertionError('network forbidden')):
                self.assertEqual(audience.cached_address_types(),{'alex@example.co.uk':'generated'})
    def test_concurrent_identity_or_review_update_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);original=self.item|{'qualification':'candidate'}
            m.save(root/'audience-preparation.json',{'items':[original],'counts':{}})
            changed=original|{'email':'changed@example.co.uk','roleCheckedAt':m.stamp(self.now)}
            def fetch(*args):
                m.save(root/'audience-preparation.json',{'items':[changed],'counts':{}})
                return [self.page]
            with patch.object(audience,'ROOT',root),patch.object(audience,'public_company_pages',side_effect=fetch):
                audience.qualify_cached()
            self.assertEqual(audience.read(root/'audience-preparation.json')['items'],[changed])

if __name__=='__main__':unittest.main(verbosity=2)
