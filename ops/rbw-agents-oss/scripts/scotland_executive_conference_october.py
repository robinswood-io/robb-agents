#!/usr/bin/env python3
"""Bounded Scottish executive conference campaign. No advertising or CRM mutation."""
from __future__ import annotations
import argparse, base64, fcntl, hashlib, html, json, os, random, re, sqlite3, sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import getaddresses
from pathlib import Path
from urllib import request, parse
from zoneinfo import ZoneInfo

WS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
ROOT = WS / 'campaigns/ops/product-campaigns/scotland-executive-conference-october-2026'
GLOBAL_SUPPRESSION = WS / 'campaigns/contact-suppression.json'
OPS_REPORT = WS / 'campaigns/ops/scotland-executive-conference-october-last.json'
SENDER = 'thibault@robinswood.io'
GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
GENERIC = re.compile(r'^(info|hello|contact|sales|support|admin|press|jobs|office|team|noreply)@', re.I)

def now():
    return datetime.now(timezone.utc)

def stamp(t):
    return t.isoformat().replace('+00:00', 'Z')

def dt(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

def read(path):
    return json.loads(Path(path).read_text())

def save(path, value):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name('.' + p.name + '.' + str(os.getpid()))
    with tmp.open('w') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)

def signed_scope(contract):
    return {k: contract[k] for k in ['campaignId', 'event', 'limits', 'templates', 'items', 'sender', 'language', 'paidAdsAllowed', 'crmMutationAllowed']}

def verify_contract(c):
    assert c['campaignId'] == 'scotland-executive-conference-october-2026'
    assert c['authorization']['scopeSha256'] == digest(signed_scope(c)), 'authorization_scope_changed'
    assert c['authorization']['source'] == 'human_campaign_launch_request_2026-09-30'
    assert c['sender'] == SENDER and c['language'] == 'en-GB'
    assert c['event']['start'] == '2026-10-07' and c['event']['end'] == '2026-10-14'
    assert c['limits']['dailyTouches'] <= 10 and c['limits']['weeklyTouches'] <= 40
    assert c['limits']['maxCompanies'] <= 40 and len(c['items']) <= c['limits']['maxCompanies']
    assert len({x['domain'] for x in c['items']}) == len(c['items']), 'multiple_contacts_same_company'
    assert c['limits']['maxFollowups'] == 1
    assert c['paidAdsAllowed'] is False and c['crmMutationAllowed'] is False
    assert c['activation'] in ['prepared', 'active', 'paused', 'complete']

def fresh(value, t, days):
    try:
        age = t - dt(value)
        return timedelta(0) <= age <= timedelta(days=days)
    except (ValueError, TypeError, AttributeError):
        return False

def eligible(item, proof, t):
    reasons = []
    if not re.fullmatch(r'CEO|Chief Executive Officer|Managing Director|Chief (?:Operating|Financial|Technology|Information) Officer', item.get('role', ''), re.I):
        reasons.append('not_verified_executive')
    if item.get('employeeMinimum', 0) <= 35 or not item.get('employeeEvidenceUrl'):
        reasons.append('strict_headcount_not_proven')
    if not item.get('scottishHeadquarters') or item.get('corporateType') != 'limited_company':
        reasons.append('scottish_corporate_scope_not_proven')
    for key in ['roleEvidenceUrl', 'legalEvidenceUrl', 'locationEvidenceUrl']:
        if not str(item.get(key, '')).startswith('https://'):
            reasons.append('missing_' + key)
    if not fresh(item.get('roleCheckedAt'), t, 14):
        reasons.append('role_evidence_stale')
    email = item.get('email', '')
    if not re.fullmatch(r'[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+', email) or GENERIC.search(email) or email.split('@')[-1] != item.get('domain'):
        reasons.append('invalid_personal_professional_address')
    if not proof or not fresh(proof.get('checkedAt'), t, 30) or proof.get('result') not in ['deliverable', 'valid'] or proof.get('acceptAll') is not False or proof.get('score', 0) < 90:
        reasons.append('deliverability_stale_or_unproven')
    return reasons

def window(t):
    local = t.astimezone(ZoneInfo('Europe/London'))
    return local.weekday() < 5 and 9 <= local.hour < 17

def body(c, item, variant, step):
    template = c['templates']['followup' if step == 'followup' else variant]
    return {
        'subject': ('Re: ' + c['templates'][variant]['subject'] if step == 'followup' else template['subject']).format(company=item['company']),
        'body': template['body'].format(firstName=item['firstName'], company=item['company'], relevance=item['relevance'])
    }

def business_days(a, b):
    day, count = a.astimezone(ZoneInfo('Europe/London')).date(), 0
    end = b.astimezone(ZoneInfo('Europe/London')).date()
    while day < end:
        day += timedelta(days=1)
        count += day.weekday() < 5
    return count

def plain(payload):
    if payload.get('mimeType') == 'text/plain':
        data = payload.get('body', {}).get('data', '')
        return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)).decode('utf-8', 'replace')
    for part in payload.get('parts', []):
        found = plain(part)
        if found:
            return found
    if payload.get('mimeType') == 'text/html':
        data = payload.get('body', {}).get('data', '')
        text = base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)).decode('utf-8', 'replace')
        return html.unescape(re.sub('<[^>]+>', ' ', text))
    return ''

def header(m, key):
    return next((h['value'] for h in m.get('payload', {}).get('headers', []) if h['name'].lower() == key.lower()), '').strip()

def addresses(value):
    return sorted(a.lower() for _, a in getaddresses([value]) if a)

def attachments(p):
    return bool(p.get('filename')) or any(attachments(x) for x in p.get('parts', []))

def classify(m):
    # Work on the new response only. Never learn from the quoted invitation.
    text = re.split(r'(?im)^On .{0,200}wrote:|^From:|^_{4,}|^-{4,}.*Original Message|^>', plain(m.get('payload', {})))[0].strip().lower()
    auto = header(m, 'Auto-Submitted').lower()
    if ('auto-replied' in auto or re.search(r'out of (?:the )?office|automatic reply|on annual leave', text)):
        return 'automatic_reply', text[:600]
    if re.search(r'spam|complaint|report(?:ed|ing) you', text):
        return 'complaint', text[:600]
    if re.search(r'unsubscribe|remove me|do not contact|stop emailing|no thanks|not interested|not relevant', text):
        return 'opt_out_or_negative', text[:600]
    if re.search(r'undeliverable|delivery.*fail|5\.1\.1|address.*not found', text):
        return 'delivery_failure', text[:600]
    if re.search(r'\bnot\b|\bno\b|\bdon.t\b|\bwon.t\b', text):
        return 'reply_received', text[:600]
    if re.search(r"\b(?:yes\b|interested|sounds (?:useful|good|interesting)|please (?:send|share)|let.s (?:talk|discuss|arrange)|happy to (?:discuss|talk))", text):
        return 'qualified_interest', text[:600]
    return 'reply_received', text[:600]

class Gateway:
    def __init__(self):
        creds = read('/home/craft/.craft-agent/xdg-config/google-mcp/credentials.json')['installed']
        tokens = read('/home/craft/.craft-agent/xdg-data/google-mcp/tokens.json')
        data = parse.urlencode(dict(client_id=creds['client_id'], client_secret=creds['client_secret'], refresh_token=tokens['refresh_token'], grant_type='refresh_token')).encode()
        with request.urlopen(request.Request(creds['token_uri'], data=data), timeout=25) as r:
            self.token = json.load(r)['access_token']
        assert self.call('/profile')['emailAddress'].lower() == SENDER, 'unexpected_gmail_account'
        self.identity = None

    def call(self, path, data=None):
        headers = {'Authorization': 'Bearer ' + self.token}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        with request.urlopen(request.Request(GMAIL + path, data=json.dumps(data).encode() if data is not None else None, headers=headers), timeout=25) as r:
            return json.load(r)

    def search(self, query):
        return self.call('/messages?' + parse.urlencode({'q': query, 'maxResults': 100})).get('messages', [])

    def get(self, message_id):
        return self.call('/messages/' + message_id + '?format=full')

    def prepare(self, item, draft, operation, parent=None):
        if self.identity is None:
            self.identity = next(x for x in self.call('/settings/sendAs')['sendAs'] if x['sendAsEmail'].lower() == SENDER)
        identity = self.identity
        signature = identity.get('signature', '').strip()
        assert signature and identity.get('verificationStatus') in [None, 'accepted'], 'sender_signature_not_ready'
        sig_text = html.unescape(re.sub('<[^>]+>', ' ', re.sub(r'<br\s*/?>', '\n', signature)))
        expected = draft['body'].strip() + '\n\n' + sig_text.strip() + '\n'
        m = EmailMessage()
        m['From'], m['To'], m['Subject'] = SENDER, item['email'], draft['subject']
        m['Message-ID'] = '<' + operation + '@robinswood.io>'
        m['X-RBW-Campaign'] = 'scotland-executive-conference-october-2026'
        m['X-RBW-Operation'] = operation
        if parent:
            m['In-Reply-To'] = header(parent, 'Message-ID')
            m['References'] = header(parent, 'Message-ID')
        m.set_content(expected)
        m.add_alternative('<div>' + html.escape(draft['body']).replace('\n', '<br>') + '</div><br>' + signature, subtype='html')
        raw = base64.urlsafe_b64encode(m.as_bytes()).decode()
        return raw, expected, hashlib.sha256(signature.encode()).hexdigest()

    def send(self, raw, thread_id=None):
        data = {'raw': raw}
        if thread_id:
            data['threadId'] = thread_id
        return self.call('/messages/send', data)

def verify_effect(gateway, sent_id, item, draft, operation, expected, thread_id=None):
    m = gateway.get(sent_id)
    checks = {
        'sent': 'SENT' in m.get('labelIds', []),
        'to': addresses(header(m, 'To')) == [item['email']],
        'from': addresses(header(m, 'From')) == [SENDER],
        'noCcOrBcc': not header(m, 'Cc') and not header(m, 'Bcc'),
        'subject': header(m, 'Subject') == draft['subject'],
        'bodyAndSignature': plain(m['payload']).replace('\r\n', '\n') == expected,
        'operation': header(m, 'X-RBW-Operation') == operation,
        'noAttachment': not attachments(m['payload']),
        'thread': not thread_id or m['threadId'] == thread_id,
    }
    return all(checks.values()), m, checks

def database(root):
    db = sqlite3.connect(root / 'campaign-state.sqlite3')
    db.row_factory = sqlite3.Row
    db.executescript("""
      CREATE TABLE IF NOT EXISTS touches(item TEXT, step TEXT, variant TEXT, created TEXT,
        state TEXT, operation TEXT UNIQUE, expected TEXT, draft TEXT, signature TEXT,
        gmail_id TEXT, thread_id TEXT, checks TEXT, PRIMARY KEY(item,step));
      CREATE TABLE IF NOT EXISTS replies(gmail_id TEXT PRIMARY KEY,item TEXT,kind TEXT,observed TEXT,evidence TEXT);
    """)
    return db

def suppressed(path):
    obj = read(path)
    out = set()
    for row in obj.get('blockedRecipients', []) + obj.get('records', []):
        if row.get('active') is True or row.get('status') in ['do_not_contact','blocked','unsubscribe','opt_out']:
            out.add((row.get('email') or row.get('value') or '').lower())
    return out

def add_suppression(email, reason, message_id):
    with GLOBAL_SUPPRESSION.with_suffix('.lock').open('a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        obj = read(GLOBAL_SUPPRESSION)
        if email not in suppressed(GLOBAL_SUPPRESSION):
            obj.setdefault('records', []).append({'email':email,'active':True,'status':'do_not_contact','reason':reason,'sourceGmailMessageId':message_id,'campaignId':'scotland-executive-conference-october-2026','createdAt':stamp(now())})
            obj['updatedAt'] = stamp(now())
            save(GLOBAL_SUPPRESSION, obj)

def learn(db, t):
    result = {}
    for v in ['A','B']:
        matured = [x['item'] for x in db.execute("SELECT * FROM touches WHERE step='initial' AND state='sent_verified' AND variant=?", (v,)) if business_days(dt(x['created']),t) >= 3]
        success = len({x['item'] for x in db.execute("SELECT * FROM replies WHERE kind='qualified_interest'")} & set(matured))
        result[v] = {'maturedCompanies':len(matured),'qualifiedCompanies':success,'posteriorMean':(1+success)/(2+len(matured))}
    # Balanced exploration until evidence is adequate; technical success is not a reward.
    ready = all(x['maturedCompanies'] >= 8 for x in result.values()) and sum(x['qualifiedCompanies'] for x in result.values()) >= 3
    rng = random.Random(20261007)
    probability_a = sum(rng.betavariate(1+result['A']['qualifiedCompanies'],1+result['A']['maturedCompanies']-result['A']['qualifiedCompanies']) > rng.betavariate(1+result['B']['qualifiedCompanies'],1+result['B']['maturedCompanies']-result['B']['qualifiedCompanies']) for _ in range(5000))/5000 if ready else .5
    winner = ('A' if probability_a >= .95 else 'B' if probability_a <= .05 else None) if ready else None
    return {'arms':result,'winner':winner,'allocation':'balanced' if not winner else '75_percent_winner_25_percent_exploration','reward':'one_qualified_interest_per_company','probabilityABeatsB':probability_a,'minMaturedCompaniesPerArm':8,'opensUsed':False,'automaticBudgetOrAudienceChanges':False}

def run(root=ROOT, gateway=None, apply=False, t=None, suppression_path=GLOBAL_SUPPRESSION):
    t = t or now()
    c = read(root / 'campaign-contract.json')
    verify_contract(c)
    proofs = read(root / 'email-evidence.json').get('items', {})
    db = database(root)
    decision = []
    # Pending sends are reconciled, never automatically repeated after an unknown outcome.
    g = gateway
    if apply:
        g = g or Gateway()
        for row in db.execute("SELECT * FROM touches WHERE state!='sent_verified'").fetchall():
            matches = g.search('in:sent rfc822msgid:' + row['operation'] + '@robinswood.io')
            if len(matches) == 1:
                item = next(x for x in c['items'] if x['id'] == row['item'])
                ok,m,checks = verify_effect(g,matches[0]['id'],item,json.loads(row['draft']),row['operation'],row['expected'],row['thread_id'])
                if ok:
                    db.execute("UPDATE touches SET state='sent_verified',gmail_id=?,thread_id=?,checks=? WHERE item=? AND step=?", (m['id'],m['threadId'],json.dumps(checks),row['item'],row['step']))
                    db.commit()
        for row in db.execute("SELECT * FROM touches WHERE step='initial' AND state='sent_verified'").fetchall():
            messages = g.call('/threads/' + row['thread_id'] + '?format=full').get('messages',[])
            item = next(x for x in c['items'] if x['id']==row['item'])
            for m in messages:
                if 'SENT' in m.get('labelIds', []) or int(m.get('internalDate',0)) <= dt(row['created']).timestamp()*1000:
                    continue
                kind,evidence = classify(m)
                if addresses(header(m,'From')) != [item['email']] and kind=='qualified_interest':
                    kind='reply_received'
                db.execute("INSERT OR IGNORE INTO replies VALUES(?,?,?,?,?)", (m['id'],item['id'],kind,stamp(t),evidence))
                if kind in ['opt_out_or_negative','complaint','delivery_failure']:
                    add_suppression(item['email'],kind,m['id'])
            db.commit()
    learning = learn(db,t)
    danger = db.execute("SELECT count(*) FROM replies WHERE kind IN ('complaint','delivery_failure')").fetchone()[0]
    unknown = db.execute("SELECT count(*) FROM touches WHERE state!='sent_verified'").fetchone()[0]
    local = t.astimezone(ZoneInfo('Europe/London'))
    daily = sum(dt(x['created']).astimezone(ZoneInfo('Europe/London')).date()==local.date() for x in db.execute("SELECT created FROM touches"))
    weekly = sum(dt(x['created']).astimezone(ZoneInfo('Europe/London')).isocalendar()[:2]==local.isocalendar()[:2] for x in db.execute("SELECT created FROM touches"))
    for n,item in enumerate(c['items']):
        reasons = eligible(item,proofs.get(item['email']),t)
        if item['email'] in suppressed(suppression_path):
            reasons.append('suppressed')
        existing = db.execute("SELECT * FROM touches WHERE item=? AND step='initial'",(item['id'],)).fetchone()
        step,variant,parent,thread = 'initial',('A' if n%2==0 else 'B'),None,None
        if existing:
            step,variant,thread = 'followup',existing['variant'],existing['thread_id']
            if db.execute("SELECT 1 FROM touches WHERE item=? AND step='followup'",(item['id'],)).fetchone():
                reasons.append('sequence_complete')
            if db.execute("SELECT 1 FROM replies WHERE item=?",(item['id'],)).fetchone():
                reasons.append('reply_received_stop_sequence')
            if existing['state'] != 'sent_verified' or business_days(dt(existing['created']),t)<3:
                reasons.append('followup_not_due')
        if step=='initial' and local.date().isoformat()>c['limits']['lastInitialDate']:
            reasons.append('initial_window_expired')
        if local.date().isoformat()>c['limits']['lastOutboundDate']:
            reasons.append('campaign_outbound_expired')
        if not window(t):
            reasons.append('outside_london_business_window')
        if local.date().isoformat()<c['limits']['firstOutboundDate']:
            reasons.append('campaign_not_started')
        if c['activation']!='active':
            reasons.append('campaign_not_active')
        if not c['authorization'].get('externalSendAuthorized'):
            reasons.append('external_send_not_authorized')
        if danger or unknown:
            reasons.append('campaign_paused_negative_or_unknown_effect')
        if daily>=c['limits']['dailyTouches'] or weekly>=c['limits']['weeklyTouches']:
            reasons.append('touch_cap_reached')
        if learning['winner'] and n%4!=3 and step=='initial':
            variant=learning['winner']
        draft=body(c,item,variant,step)
        row={'id':item['id'],'company':item['company'],'step':step,'variant':variant,'blockingReasons':sorted(set(reasons)),'status':'blocked' if reasons else 'ready'}
        if not reasons and apply:
            # Search current relationship at company and recipient level immediately before send.
            matches=g.search('in:anywhere {to:'+item['email']+' from:'+item['email']+' to:'+item['domain']+' from:'+item['domain']+'}')
            permitted={x['gmail_id'] for x in db.execute("SELECT gmail_id FROM touches WHERE item=? AND state='sent_verified'",(item['id'],))}
            if any(m['id'] not in permitted for m in matches):
                row.update(status='blocked',blockingReasons=['existing_company_or_recipient_relationship'])
            else:
                if existing:
                    parent=g.get(existing['gmail_id'])
                operation='rbw-scotland-'+digest({'id':item['id'],'step':step,'draft':draft})[:40]
                raw,expected,signature=g.prepare(item,draft,operation,parent)
                assert draft['body'].startswith('Hello '+item['firstName']+',') and 'no thanks' in draft['body'].lower()
                # Reserve and fsync via SQLite before contacting Gmail. Any uncertain effect stops the campaign.
                db.execute("INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(item['id'],step,variant,stamp(t),'pending',operation,expected,json.dumps(draft),signature,None,thread,None))
                db.commit()
                try:
                    sent=g.send(raw,thread)
                    db.execute("UPDATE touches SET gmail_id=?,thread_id=? WHERE item=? AND step=?",(sent['id'],sent['threadId'],item['id'],step))
                    db.commit()
                    ok,m,checks=verify_effect(g,sent['id'],item,draft,operation,expected,thread)
                    db.execute("UPDATE touches SET state=?,checks=? WHERE item=? AND step=?",('sent_verified' if ok else 'sent_unverified',json.dumps(checks),item['id'],step))
                    db.commit()
                    row.update(status='sent_verified' if ok else 'sent_unverified',gmailMessageId=sent['id'],gmailThreadId=sent['threadId'])
                    daily+=1;weekly+=1
                    if not ok:
                        unknown+=1
                except Exception as e:
                    row.update(status='send_effect_unknown',errorType=type(e).__name__)
                    unknown+=1
        decision.append(row)
    counts={s:sum(x['status']==s for x in decision) for s in sorted({x['status'] for x in decision})}
    report={'generatedAt':stamp(t),'ok':not danger and not unknown,'campaignId':c['campaignId'],'status':'active' if c['activation']=='active' and not danger and not unknown else 'prepared_or_paused','externalSendsThisRun':counts.get('sent_verified',0),'verifiedSendsTotal':db.execute("SELECT count(*) FROM touches WHERE state='sent_verified'").fetchone()[0],'qualifiedCompanies':db.execute("SELECT count(DISTINCT item) FROM replies WHERE kind='qualified_interest'").fetchone()[0],'counts':counts,'decisions':decision,'learning':learning,'authorizationScopeSha256':c['authorization']['scopeSha256'],'simulation':not apply,'sender':SENDER,'nextBusinessWindow':'2026-10-01T09:20:00+01:00' if local.date().isoformat()<'2026-10-01' else None}
    save(root/'campaign-last.json',report)
    save(root/'qualified-leads.json',{'generatedAt':stamp(t),'items':[dict(x) for x in db.execute("SELECT * FROM replies WHERE kind='qualified_interest'")]})
    db.close()
    return report

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--apply',action='store_true')
    args=ap.parse_args()
    ROOT.mkdir(parents=True,exist_ok=True)
    with (ROOT/'campaign.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        result=run(apply=args.apply)
        save(OPS_REPORT,result)
        print(json.dumps(result))
    return 0 if result['ok'] else 1

if __name__=='__main__':
    raise SystemExit(main())
