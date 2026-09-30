#!/usr/bin/env python3
"""Offline safety tests: all Gmail effects are simulated."""
import base64, copy, json, re, tempfile, unittest
from datetime import datetime, timezone, timedelta
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import patch
import scotland_executive_conference_october as m

T = datetime(2026,10,1,8,20,tzinfo=timezone.utc)

def payload(part):
    out = {'mimeType':part.get_content_type(),'headers':[{'name':k,'value':str(v)} for k,v in part.items()], 'filename':part.get_filename() or ''}
    if part.is_multipart():
        out['parts']=[payload(x) for x in part.iter_parts()]
    else:
        out['body']={'data':base64.urlsafe_b64encode(part.get_payload(decode=True)).decode()}
    return out

def inbound(text, sender='alex@example.co.uk', mid='reply1',thread='t1',auto=None):
    p={'mimeType':'text/plain','headers':[{'name':'From','value':sender}],'body':{'data':base64.urlsafe_b64encode(text.encode()).decode()}}
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
        with self.assertRaises(AssertionError):self.runit()
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

if __name__=='__main__':unittest.main(verbosity=2)
