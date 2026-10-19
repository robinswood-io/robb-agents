#!/usr/bin/env python3
"""Apply the human-approved marketing copy without changing audience or cadence."""
import argparse, copy, fcntl, hashlib, json, shutil, sqlite3
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import urlopen
import scotland_executive_conference_october as campaign

ARCHIVE=Path('/srv/rbw-agents-oss/archive')
VERSION='2026-10-01.1'
PAGE='https://orion.rbw.ovh/campaigns/scotland-october-2026/index.html'
PROGRAMME='https://orion.rbw.ovh/campaigns/scotland-october-2026/programme-scotland-october-2026.pdf'
PRIVACY='Privacy: https://robinswood.io/en/confidentialite'
def templates():
    return {
      'A': {'version':VERSION,'subject':'{company}: a practical AI leadership session','body':"Hello {firstName},\n\nYour work on {relevance} prompted me to get in touch.\n\nI will be in Scotland from 7 to 14 October, offering a private, in-person AI session for leadership teams. In 60-90 minutes, we explore {roleFocus}, see an agent demonstration and identify one measurable next step.\n\nI have delivered AI sessions for Cerfrance leadership teams in France. This session starts with familiar business processes and leaves room for questions.\n\nWould you like the one-page programme to share with your team?\n\nIf this is not relevant, reply 'no thanks' and I will not follow up.\n\n"+PRIVACY},
      'B': {'version':VERSION,'subject':'An AI session for the leadership team at {company}?','body':"Hello {firstName},\n\nWhich workflow would be worth improving with AI at {company} - and how would you know it had worked?\n\nI will be in Scotland from 7 to 14 October. I am offering a private 60-90 minute session at your premises or an agreed venue, focused on {roleFocus}.\n\nWe use a practical demonstration, examine the evidence of correct execution and discuss a bounded next step. Previous sessions include Cerfrance leadership teams in France.\n\nWould you like the one-page programme?\n\nIf this is not relevant, reply 'no thanks' and I will not follow up.\n\n"+PRIVACY},
      'followup': {'version':VERSION,'subject':'unused','body':"Hello {firstName},\n\nA brief follow-up to my invitation for a private AI leadership session in Scotland, 7-14 October.\n\nWould the one-page programme be useful for your team at {company}? It covers the format, practical demonstration and the decision we would work towards.\n\nIf you prefer, simply tell me your city and a suitable date. The fee and arrangements are agreed before booking.\n\nIf this is not relevant, reply 'no thanks' and I will not follow up.\n\n"+PRIVACY},
      'programme': {'version':VERSION,'url':PAGE,'subject':'unused','body':"Hello {firstName},\n\nThank you - here is the one-page programme:\n"+PROGRAMME+"\n\nThe session page also includes a short evidence walkthrough and a five-question readiness check:\n"+PAGE+"\n\nYou can forward the programme to your leadership team. If you would like to explore a session, tell me your city, a preferred date between 7 and 14 October, and one workflow that matters to your business. We will agree the fee and arrangements before confirming a booking.\n\nIf you no longer want to hear from me, reply 'no thanks'.\n\n"+PRIVACY}
    }

def apply(root=campaign.ROOT, dry_run=False, gateway=None):
    with (root/'campaign.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        old=campaign.read(root/'campaign-contract.json')
        campaign.verify_contract(old)
        campaign.require(old['limits']['dailyTouches']==10 and old['limits']['weeklyTouches']==100 and old['limits']['hourlyTouches']==3 and old['limits']['minimumSendIntervalSeconds']==1200 and old['limits']['maxRunTouches']==1,'unexpected_cadence')
        updated=copy.deepcopy(old);updated['templates']=templates()
        scope=campaign.digest(campaign.signed_scope(updated))
        if scope==old['authorization']['scopeSha256']:
            return {'ok':True,'alreadyApplied':True,'copyVersion':VERSION,'authorizationScopeSha256':scope,'newGmailEffects':0}
        updated['authorization']['marketingChange']={'source':'human_campaign_improvement_cerfrance_request_2026-10-01','authorizedAt':campaign.stamp(campaign.now()),'previousScopeSha256':old['authorization']['scopeSha256'],'copyVersion':VERSION,'programmeResponse':'one requested response in the original recipient thread; existing cadence applies','audienceUnchanged':True,'limitsUnchanged':True,'bookingRequiresEvidence':True}
        updated['authorization']['scopeSha256']=scope
        campaign.verify_contract(updated)
        campaign.require(updated['items']==old['items'] and updated['limits']==old['limits'],'scope_expansion_forbidden')
        if dry_run:return {'ok':True,'simulation':True,'copyVersion':VERSION,'authorizationScopeSha256':scope,'newGmailEffects':0}
        # Fail closed until the exact public supports really exist.
        with urlopen(PAGE,timeout=25) as r:
            page=r.read(100000).decode()
            campaign.require(r.status==200 and 'Where could AI make a measurable difference?' in page and 'Olivier Taisne' in page,'public_programme_page_unavailable')
        with urlopen(PROGRAMME,timeout=25) as r:
            campaign.require(r.status==200 and r.read(5)==b'%PDF-','public_pdf_unavailable')
        db=campaign.database(root)
        campaign.require(not db.execute("SELECT 1 FROM touches WHERE state!='sent_verified'").fetchone(),'unknown_effect_prevents_copy_change')
        campaign.require(not db.execute("SELECT 1 FROM replies WHERE kind IN ('complaint','delivery_failure')").fetchone(),'negative_delivery_signal_prevents_copy_change')
        rows=db.execute("SELECT * FROM touches WHERE state='sent_verified'").fetchall()
        g=gateway or campaign.Gateway()
        for row in rows:
            item=next(x for x in old['items'] if x['id']==row['item'])
            ok,_,_=campaign.verify_effect(g,row['gmail_id'],item,json.loads(row['draft']),row['operation'],row['expected'],row['thread_id'])
            campaign.require(ok,'prior_gmail_effect_not_verified')
        archive=ARCHIVE/datetime.now(timezone.utc).strftime('%Y-%m')/('scotland-marketing-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        archive.mkdir(parents=True,mode=0o700)
        shutil.copy2(root/'campaign-contract.json',archive/'campaign-contract.json')
        backup=sqlite3.connect(archive/'campaign-state.sqlite3');db.backup(backup);backup.close();db.close()
        campaign.save(root/'campaign-contract.json',updated)
        campaign.verify_contract(campaign.read(root/'campaign-contract.json'))
        result={'ok':True,'copyVersion':VERSION,'authorizationScopeSha256':scope,'previousScopeSha256':old['authorization']['scopeSha256'],'newGmailEffects':0,'priorVerifiedEffects':len(rows),'backup':str(archive),'audienceUnchanged':True,'limitsUnchanged':True,'page':PAGE,'programme':PROGRAMME,'sourceSha256':{n:hashlib.sha256((Path(__file__).parent/n).read_bytes()).hexdigest() for n in ['scotland_executive_conference_october.py','scotland_conference_marketing.py']}}
        campaign.save(root/'marketing-activation.json',result)
        return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--dry-run',action='store_true')
    args=parser.parse_args();print(json.dumps(apply(dry_run=args.dry_run)))
