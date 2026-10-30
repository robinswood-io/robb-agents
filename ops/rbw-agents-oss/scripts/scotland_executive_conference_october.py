"""Bounded Scottish executive conference campaign. No advertising or CRM mutation."""
from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from evergreen_campaign_data_types import (
    data_json_object_or_empty,
    data_json_objects,
    data_text,
)
from pydantic import JsonValue, TypeAdapter
from scotland_conference_transport import (
    SENDER,
    Gateway,
    GatewayPort,
    addresses,
    attachments,
    classify,
    header,
    plain,
    read,
    require,
)
from scotland_executive_conference_eligibility import (
    DAILY40_PROFILE,
    GENERIC,
    dt,
    eligible,
    refresh_item_evidence,
    role_focus,
    window,
)
from scotland_executive_conference_learning import business_days
from scotland_executive_conference_learning import learn as _learn
from scotland_executive_conference_state import (
    database,
    pacing,
    read_object,
    state_count,
    state_first,
    state_rows,
    suppressed,
)
from scotland_executive_conference_types import (
    CampaignDecision,
    CampaignDraft,
    CampaignEvidence,
    CampaignEvidenceDocument,
    CampaignItem,
    CampaignLearningResult,
    CampaignProof,
    CampaignProofDocument,
    CampaignReport,
    ExecutiveCampaignContract,
    SignedCampaignScope,
)

__all__ = [
    'GENERIC',
    'SENDER',
    'Gateway',
    'addresses',
    'business_days',
    'classify',
    'database',
    'dt',
    'eligible',
    'header',
    'pacing',
    'plain',
    'read',
    'suppressed',
    'window',
]

type JsonObject = dict[str, JsonValue]

logger = logging.getLogger(__name__)

WS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2')
ROOT = WS / 'campaigns/ops/product-campaigns/scotland-executive-conference-october-2026'
GLOBAL_SUPPRESSION = WS / 'campaigns/contact-suppression.json'
OPS_REPORT = WS / 'campaigns/ops/scotland-executive-conference-october-last.json'
DAILY40_WINDOWS = [['09:00', '12:00'], ['14:00', '18:00']]
DAILY40_CRON = '*/10 9-11,14-17 * * 1-5'

CONTRACT_ADAPTER: TypeAdapter[ExecutiveCampaignContract] = TypeAdapter(ExecutiveCampaignContract)
PROOFS_ADAPTER: TypeAdapter[CampaignProofDocument] = TypeAdapter(CampaignProofDocument)
EVIDENCE_ADAPTER: TypeAdapter[CampaignEvidenceDocument] = TypeAdapter(CampaignEvidenceDocument)
JSON_OBJECT_ADAPTER: TypeAdapter[JsonObject] = TypeAdapter(dict[str, JsonValue])
LABELS_ADAPTER: TypeAdapter[list[str]] = TypeAdapter(list[str])
REPORT_ADAPTER: TypeAdapter[CampaignReport] = TypeAdapter(CampaignReport)
DRAFT_ADAPTER: TypeAdapter[CampaignDraft] = TypeAdapter(CampaignDraft)

def now() -> datetime:
    return datetime.now(UTC)

def stamp(t: datetime) -> str:
    return t.isoformat().replace('+00:00', 'Z')


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def save(path: str | Path, value: object) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name('.' + p.name + '.' + str(os.getpid()))
    with tmp.open('w') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        _written = f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)

def signed_scope(contract: ExecutiveCampaignContract) -> SignedCampaignScope:
    return {
        'campaignId': contract['campaignId'],
        'event': contract['event'],
        'limits': contract['limits'],
        'templates': contract['templates'],
        'items': contract['items'],
        'sender': contract['sender'],
        'language': contract['language'],
        'paidAdsAllowed': contract['paidAdsAllowed'],
        'crmMutationAllowed': contract['crmMutationAllowed'],
    }


def verify_contract(value: object) -> None:
    c: ExecutiveCampaignContract = CONTRACT_ADAPTER.validate_python(value)
    require(c['campaignId'] == 'scotland-executive-conference-october-2026')
    require(c['authorization']['scopeSha256'] == digest(signed_scope(c)), 'authorization_scope_changed')
    require(c['authorization']['source'] == 'human_campaign_launch_request_2026-09-30')
    require(c['sender'] == SENDER and c['language'] == 'en-GB')
    require(c['event']['start'] == '2026-10-07' and c['event']['end'] == '2026-10-14')
    profile = c['limits'].get('cadenceProfile')
    require(profile in (None, DAILY40_PROFILE), 'unapproved_cadence_profile')
    if profile == DAILY40_PROFILE:
        limits = c['limits']
        expected = {'dailyTouches':40, 'weeklyTouches':200, 'hourlyTouches':6,
                    'minimumSendIntervalSeconds':600, 'maxRunTouches':1}
        require(type(limits.get('dailyTouches')) is int and limits.get('dailyTouches') == expected['dailyTouches'], 'unapproved_daily40_caps')
        require(type(limits.get('weeklyTouches')) is int and limits.get('weeklyTouches') == expected['weeklyTouches'], 'unapproved_daily40_caps')
        require(type(limits.get('hourlyTouches')) is int and limits.get('hourlyTouches') == expected['hourlyTouches'], 'unapproved_daily40_caps')
        require(type(limits.get('minimumSendIntervalSeconds')) is int and limits.get('minimumSendIntervalSeconds') == expected['minimumSendIntervalSeconds'], 'unapproved_daily40_caps')
        require(type(limits.get('maxRunTouches')) is int and limits.get('maxRunTouches') == expected['maxRunTouches'], 'unapproved_daily40_caps')
        require(limits.get('timezone') == 'Europe/London' and limits.get('sendingWindows') == DAILY40_WINDOWS, 'unapproved_daily40_windows')
        change = c['authorization'].get('dailyScheduleChange', {})
        require(change.get('source') == 'human_campaign_daily40_split_window_request_2026-10-02', 'daily40_authorization_missing')
        prior = change.get('previousLimits', {})
        require(all(prior.get(k) == v for k,v in {'dailyTouches':10, 'weeklyTouches':100,
                    'hourlyTouches':3, 'minimumSendIntervalSeconds':1200, 'maxRunTouches':1}.items())
                    and 'cadenceProfile' not in prior and 'sendingWindows' not in prior, 'unapproved_previous_cadence')
        previous_scope = signed_scope(c) | {'limits':prior}
        require(digest(previous_scope) == change.get('previousScopeSha256'), 'daily40_prior_scope_mismatch')
    else:
        require('sendingWindows' not in c['limits'], 'unapproved_sending_windows')
        require(0 < c['limits']['dailyTouches'] <= 10 and 0 < c['limits']['weeklyTouches'] <= 100)
    require(0 < c['limits']['maxCompanies'] <= 500 and len(c['items']) <= c['limits'].get('maxContacts', c['limits']['maxCompanies']) <= 500)
    require(len({x['email'] for x in c['items']}) == len(c['items']), 'duplicate_recipient')
    require(len({x['id'] for x in c['items']}) == len(c['items']), 'duplicate_item_id')
    require(len({x['domain'] for x in c['items']}) <= c['limits']['maxCompanies'])
    require(0 < c['limits'].get('maxRunTouches', 10) <= 10)
    pacing_keys = ['hourlyTouches', 'minimumSendIntervalSeconds']
    if profile is None and any(k in c['limits'] for k in pacing_keys):
        require(all(k in c['limits'] for k in pacing_keys), 'incomplete_pacing_limits')
        hourly = c['limits'].get('hourlyTouches')
        require(type(hourly) is int and 0 < hourly <= 3, 'unsafe_hourly_touch_limit')
        interval = c['limits'].get('minimumSendIntervalSeconds')
        require(type(interval) is int and interval >= 1200, 'unsafe_minimum_send_interval')
    require(c['limits']['firstOutboundDate'] == '2026-10-01')
    require(c['limits']['lastInitialDate'] <= '2026-10-08' and c['limits']['lastOutboundDate'] <= '2026-10-13')
    require(c['limits']['maxFollowups'] == 1)
    require(c['paidAdsAllowed'] is False and c['crmMutationAllowed'] is False)
    if 'programme' in c['templates']:
        require(c['templates']['programme'].get('url') == 'https://orion.rbw.ovh/campaigns/scotland-october-2026/index.html', 'unapproved_programme_destination')
        programme_url = c['templates']['programme'].get('url')
        require(isinstance(programme_url, str) and programme_url in c['templates']['programme']['body'], 'programme_link_missing')
    require(c['activation'] in ['prepared', 'active', 'paused', 'complete'])

def daily40_contract(value: object) -> ExecutiveCampaignContract:
    """Change pacing only; bind unchanged recipients/copy to the previous scope."""
    original: ExecutiveCampaignContract = CONTRACT_ADAPTER.validate_python(value)
    verify_contract(original)
    if original['limits'].get('cadenceProfile') == DAILY40_PROFILE:
        return copy.deepcopy(original)
    require(all(original['limits'].get(k) == v for k,v in {
        'dailyTouches':10, 'weeklyTouches':100, 'hourlyTouches':3,
        'minimumSendIntervalSeconds':1200, 'maxRunTouches':1}.items()), 'unexpected_existing_campaign_caps')
    updated = copy.deepcopy(original)
    updated['limits']['dailyTouches'] = 40
    updated['limits']['weeklyTouches'] = 200
    updated['limits']['hourlyTouches'] = 6
    updated['limits']['minimumSendIntervalSeconds'] = 600
    updated['limits']['maxRunTouches'] = 1
    updated['limits']['cadenceProfile'] = DAILY40_PROFILE
    updated['limits']['timezone'] = 'Europe/London'
    updated['limits']['sendingWindows'] = copy.deepcopy(DAILY40_WINDOWS)
    updated['limits']['hours'] = '09:00-12:00 and 14:00-18:00 Monday-Friday'
    updated['authorization']['dailyScheduleChange'] = {
        'source':'human_campaign_daily40_split_window_request_2026-10-02',
        'authorizedAt':stamp(now()), 'previousScopeSha256':original['authorization']['scopeSha256'],
        'previousLimits':copy.deepcopy(original['limits']),
        'humanInstruction':"il faut augmenter à 40 l'envoi journalier de 9h à 12h et de 14h à 18h",
        'audienceAndCopyUnchanged':True, 'weeklyTouches':200}
    updated['authorization']['scopeSha256'] = digest(signed_scope(updated))
    verify_contract(updated)
    return updated


def body(c: ExecutiveCampaignContract, item: CampaignItem, variant: str, step: str, original: CampaignDraft | None = None) -> CampaignDraft:
    template = c['templates'][step if step in ['followup','programme'] else variant]
    return {
        'subject': ('Re: ' + (original['subject'] if original else c['templates'][variant]['subject']) if step in ['followup','programme'] else template['subject']).format(company=item['company']),
        'body': template['body'].format(firstName=item['firstName'], company=item['company'], relevance=item['relevance'], roleFocus=role_focus(item)),
        'copyVersion': template.get('version','legacy')
    }

def learn(db: sqlite3.Connection, t: datetime, copy_version: str | None = None) -> CampaignLearningResult:
    return _learn(db, t, copy_version)


def verify_effect(gateway: GatewayPort, sent_id: str, item: CampaignItem, draft: CampaignDraft, operation: str, expected: str, thread_id: str | None) -> tuple[bool, JsonObject, dict[str, bool | str]]:
    message = gateway.get(sent_id)
    labels = message.get('labelIds')
    payload_value = message.get('payload')
    payload: JsonObject = payload_value if isinstance(payload_value, dict) else {}
    stored_thread = message.get('threadId')
    checks: dict[str, bool | str] = {
        'sent': isinstance(labels, list) and 'SENT' in labels,
        'to': addresses(header(message, 'To')) == [item['email']],
        'from': addresses(header(message, 'From')) == [SENDER],
        'noCcOrBcc': not header(message, 'Cc') and not header(message, 'Bcc'),
        'subject': header(message, 'Subject') == draft['subject'],
        'bodyAndSignature': plain(payload).replace('\r\n', '\n') == expected,
        'operation': header(message, 'X-RBW-Operation') == operation,
        'noAttachment': not attachments(payload),
        'thread': not thread_id or stored_thread == thread_id,
    }
    return all(checks.values()), message, checks



def add_suppression(email: str, reason: str, message_id: str) -> None:
    with GLOBAL_SUPPRESSION.with_suffix('.lock').open('a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        obj = read_object(GLOBAL_SUPPRESSION)
        if email not in suppressed(GLOBAL_SUPPRESSION):
            records = obj.setdefault('records', [])
            if not isinstance(records, list):
                raise TypeError('invalid_suppression_records')
            records.append({'email':email,'active':True,'status':'do_not_contact','reason':reason,'sourceGmailMessageId':message_id,'campaignId':'scotland-executive-conference-october-2026','createdAt':stamp(now())})
            obj['updatedAt'] = stamp(now())
            save(GLOBAL_SUPPRESSION, obj)


def run(root: Path = ROOT, gateway: GatewayPort | None = None, apply: bool = False, t: datetime | None = None, suppression_path: Path = GLOBAL_SUPPRESSION) -> CampaignReport:
    realtime = t is None
    t = t or now()
    c: ExecutiveCampaignContract = CONTRACT_ADAPTER.validate_python(read(root / 'campaign-contract.json'))
    verify_contract(c)
    proof_document: CampaignProofDocument = PROOFS_ADAPTER.validate_python(read(root / 'email-evidence.json'))
    proofs: dict[str, CampaignProof] = proof_document['items']
    # Public evidence may be refreshed without changing the authorized recipients or copy.
    evidence_path=root/'audience-preparation.json'
    evidence_document: CampaignEvidenceDocument
    if evidence_path.exists():
        evidence_document = EVIDENCE_ADAPTER.validate_python(read(evidence_path))
    else:
        evidence_document = {'items': []}
    current_evidence: dict[str, CampaignEvidence] = {item['id']: item for item in evidence_document['items']}
    refresh_item_evidence(c['items'], current_evidence)
    db = database(root)
    decision: list[CampaignDecision] = []
    # Pending sends are reconciled, never automatically repeated after an unknown outcome.
    g = gateway
    if apply:
        g = g or Gateway()
        for row in state_rows(db.execute("SELECT * FROM touches WHERE state!='sent_verified'")):
            operation = row['operation']
            matches = g.search('in:sent rfc822msgid:' + operation + '@robinswood.io')
            if len(matches) == 1:
                item = next(x for x in c['items'] if x['id'] == row['item'])
                ok,m,checks = verify_effect(g,data_text(matches[0].get('id')),item,DRAFT_ADAPTER.validate_json(row['draft']),row['operation'],row['expected'],row.optional_text('thread_id'))
                if ok:
                    checks['gmailSentAt'] = stamp(datetime.fromtimestamp(int(data_text(m.get('internalDate')))/1000,UTC))
                    _ = db.execute("UPDATE touches SET state='sent_verified',gmail_id=?,thread_id=?,checks=? WHERE item=? AND step=?", (m['id'],m['threadId'],json.dumps(checks),row['item'],row['step']))
                    db.commit()
        verified_initials=state_rows(db.execute("SELECT * FROM touches WHERE step='initial' AND state='sent_verified'"))
        for row in verified_initials:
            messages = data_json_objects(g.call('/threads/' + row['thread_id'] + '?format=full').get('messages',[]))
            item = next(x for x in c['items'] if x['id']==row['item'])
            # A fresh reply may arrive in a new thread. It stops the sequence,
            # but qualifies as a lead only when bound to the invitation thread.
            for match in g.search('after:'+dt(row['created']).date().isoformat()+' from:'+item['email']+' -in:sent'):
                if match['id'] not in {data_text(m.get('id')) for m in messages}:
                    m=g.get(data_text(match.get('id')))
                    if addresses(header(m,'From'))==[item['email']] and SENDER in addresses(header(m,'To')):
                        messages.append(m)
            for m in messages:
                if 'SENT' in LABELS_ADAPTER.validate_python(m.get('labelIds', [])) or int(data_text(m.get('internalDate')) or '0') <= dt(row['created']).timestamp()*1000:
                    continue
                kind,evidence = classify(m)
                # Bare acceptance asks for the programme only when that was the
                # actual stored invitation, never from a newly changed template.
                invitation=DRAFT_ADAPTER.validate_json(row['draft'])
                if kind=='qualified_interest' and 'one-page programme' in invitation['body'].lower() and re.fullmatch(r"yes[,.! ]*(?:please[.! ]*)?|please[.! ]*|sure[.! ]*", evidence):
                    kind='programme_requested'
                if (addresses(header(m,'From')) != [item['email']] or m.get('threadId') != row.optional_text('thread_id')) and kind in ['qualified_interest','qualified_need','programme_requested']:
                    kind='reply_received'
                _ = db.execute("INSERT OR IGNORE INTO replies VALUES(?,?,?,?,?)", (m['id'],item['id'],kind,stamp(t),evidence))
                if kind in ['opt_out_or_negative','complaint','delivery_failure']:
                    add_suppression(item['email'],kind,data_text(m.get('id')))
            db.commit()
        if verified_initials:
            since=min(dt(r['created']).date().isoformat() for r in verified_initials)
            for found in g.search('after:'+since+' -in:sent {from:mailer-daemon from:postmaster subject:undeliverable subject:"delivery status"}'):
                m=g.get(data_text(found.get('id')))
                if 'SENT' in LABELS_ADAPTER.validate_python(m.get('labelIds', [])):continue
                text=plain(data_json_object_or_empty(m.get('payload')))
                for row in verified_initials:
                    item=next(x for x in c['items'] if x['id']==row['item'])
                    if (row['operation'] in text or item['email'].lower() in text.lower()) and classify(m)[0]=='delivery_failure':
                        _ = db.execute("INSERT OR IGNORE INTO replies VALUES(?,?,?,?,?)",(m['id'],item['id'],'delivery_failure',stamp(t),text[:600]))
                        add_suppression(item['email'],'delivery_failure',data_text(m.get('id')))
            db.commit()
    if realtime:
        t = now()
        # Absorb small scheduler/network jitter without turning a tick into a burst.
        wait = pacing(db, c['limits'], t)['waitSeconds']
        if 0 < wait <= 30:
            time.sleep(wait)
            t = now()
    copy_version=c['templates']['A'].get('version')
    learning = learn(db,t,copy_version)
    danger = state_count(db.execute("SELECT count(*) FROM replies WHERE kind IN ('complaint','delivery_failure')"))
    unknown = state_count(db.execute("SELECT count(*) FROM touches WHERE state!='sent_verified'"))
    local = t.astimezone(ZoneInfo('Europe/London'))
    daily = sum(dt(x['created']).astimezone(ZoneInfo('Europe/London')).date()==local.date() for x in state_rows(db.execute("SELECT created FROM touches")))
    weekly = sum(dt(x['created']).astimezone(ZoneInfo('Europe/London')).isocalendar()[:2]==local.isocalendar()[:2] for x in state_rows(db.execute("SELECT created FROM touches")))
    arm_counts = {v:state_count(db.execute("SELECT count(*) FROM touches WHERE step='initial' AND variant=?",(v,))) for v in ['A','B']}
    sent_this_run = 0
    company_by_item = {x['id']:x['domain'] for x in c['items']}
    requested={r['item'] for r in state_rows(db.execute("SELECT item FROM replies WHERE kind='programme_requested'"))}
    delivered={r['item'] for r in state_rows(db.execute("SELECT item FROM touches WHERE step='programme'"))}
    ordered_items=sorted(c['items'],key=lambda item:0 if item['id'] in requested-delivered else 1)
    for item in ordered_items:
        reasons = eligible(item,proofs.get(item['email']),t)
        if item['email'] in suppressed(suppression_path):
            reasons.append('suppressed')
        existing = state_first(db.execute("SELECT * FROM touches WHERE item=? AND step='initial'",(item['id'],)))
        owned_company = [x for x in state_rows(db.execute("SELECT item FROM touches WHERE step='initial'")) if company_by_item.get(x['item']) == item['domain'] and x['item'] != item['id']]
        if owned_company:
            reasons.append('another_executive_already_contacted_at_company')
        programme_reply=None
        step,variant,parent,thread = 'initial',('A' if arm_counts['A']<=arm_counts['B'] else 'B'),None,None
        if existing:
            step,variant,thread = 'followup',existing['variant'],existing.optional_text('thread_id')
            response_rows=state_rows(db.execute("SELECT * FROM replies WHERE item=? ORDER BY observed,gmail_id",(item['id'],)))
            requests=[r for r in response_rows if r['kind']=='programme_requested']
            negative=any(r['kind'] in ['opt_out_or_negative','complaint','delivery_failure'] for r in response_rows)
            already_programme=state_first(db.execute("SELECT 1 FROM touches WHERE item=? AND step='programme'",(item['id'],)))
            if requests and not negative and 'programme' in c['templates'] and not already_programme:
                step='programme'
                programme_reply=requests[-1]['gmail_id']
            else:
                if state_first(db.execute("SELECT 1 FROM touches WHERE item=? AND step='followup'",(item['id'],))):
                    reasons.append('sequence_complete')
                if response_rows:
                    reasons.append('reply_received_stop_sequence')
                if business_days(dt(existing['created']),t)<3:
                    reasons.append('followup_not_due')
            if existing['state'] != 'sent_verified':
                reasons.append('initial_effect_not_verified')
        if step=='initial' and local.date().isoformat()>c['limits']['lastInitialDate']:
            reasons.append('initial_window_expired')
        if local.date().isoformat()>c['limits']['lastOutboundDate']:
            reasons.append('campaign_outbound_expired')
        if not window(t, c['limits']):
            reasons.append('outside_london_business_window')
        if local.date().isoformat()<c['limits']['firstOutboundDate']:
            reasons.append('campaign_not_started')
        if c['activation']!='active':
            reasons.append('campaign_not_active')
        if not c['authorization'].get('externalSendAuthorized'):
            reasons.append('external_send_not_authorized')
        if danger or unknown:
            reasons.append('campaign_paused_negative_or_unknown_effect')
        if sent_this_run >= c['limits'].get('maxRunTouches',10):
            reasons.append('paced_run_cap_reached')
        reasons.extend(pacing(db,c['limits'],t)['blockingReasons'])
        if daily>=c['limits']['dailyTouches'] or weekly>=c['limits']['weeklyTouches']:
            reasons.append('touch_cap_reached')
        if learning['winner'] and sum(arm_counts.values())%4!=3 and step=='initial':
            variant=learning['winner']
        draft=body(c,item,variant,step,DRAFT_ADAPTER.validate_json(existing['draft']) if existing else None)
        decision_row: CampaignDecision = {'id':item['id'],'company':item['company'],'step':step,'variant':variant,'blockingReasons':sorted(set(reasons)),'status':'blocked' if reasons else 'ready'}
        if not reasons and apply:
            if g is None:
                raise AssertionError('missing_apply_gateway')
            # Search current relationship at company and recipient level immediately before send.
            matches=g.search('in:anywhere {to:'+item['email']+' from:'+item['email']+' to:'+item['domain']+' from:'+item['domain']+'}')
            permitted={x['gmail_id'] for x in state_rows(db.execute("SELECT gmail_id FROM touches WHERE item=? AND state='sent_verified'",(item['id'],)))}
            if step=='programme':
                if programme_reply is None:
                    raise AssertionError('missing_programme_reply')
                request_message=g.get(programme_reply)
                require(addresses(header(request_message,'From')) == [item['email']] and request_message.get('threadId') == thread and 'SENT' not in LABELS_ADAPTER.validate_python(request_message.get('labelIds', [])), 'programme_request_not_bound_to_recipient_thread')
                permitted.update(r['gmail_id'] for r in state_rows(db.execute("SELECT gmail_id FROM replies WHERE item=?",(item['id'],))))
            if any(m['id'] not in permitted for m in matches):
                decision_row.update(status='blocked',blockingReasons=['existing_company_or_recipient_relationship'])
            else:
                if existing:
                    parent=g.get(programme_reply or existing['gmail_id'])
                operation='rbw-scotland-'+digest({'id':item['id'],'step':step,'draft':draft})[:40]
                raw,expected,signature=g.prepare(JSON_OBJECT_ADAPTER.validate_python(item),JSON_OBJECT_ADAPTER.validate_python(draft),operation,parent)
                require(draft['body'].startswith('Hello '+item['firstName']+',') and 'no thanks' in draft['body'].lower())
                # Reserve and fsync via SQLite before contacting Gmail. Any uncertain effect stops the campaign.
                _ = db.execute("INSERT INTO touches VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(item['id'],step,variant,stamp(t),'pending',operation,expected,json.dumps(draft),signature,None,thread,None))
                db.commit()
                if step=='initial':arm_counts[variant]+=1
                try:
                    sent=g.send(raw,thread)
                    _ = db.execute("UPDATE touches SET gmail_id=?,thread_id=? WHERE item=? AND step=?",(sent['id'],sent['threadId'],item['id'],step))
                    db.commit()
                    ok,m,checks=verify_effect(g,data_text(sent.get('id')),item,draft,operation,expected,thread)
                    if ok:
                        checks['gmailSentAt'] = stamp(datetime.fromtimestamp(int(data_text(m.get('internalDate')))/1000,UTC))
                    _ = db.execute("UPDATE touches SET state=?,checks=? WHERE item=? AND step=?",('sent_verified' if ok else 'sent_unverified',json.dumps(checks),item['id'],step))
                    db.commit()
                    decision_row.update(status='sent_verified' if ok else 'sent_unverified',gmailMessageId=data_text(sent.get('id')),gmailThreadId=data_text(sent.get('threadId')))
                    daily+=1;weekly+=1;sent_this_run+=1
                    if not ok:
                        unknown+=1
                except Exception as e:
                    logger.exception('campaign_send_effect_requires_reconciliation')
                    from outbound_sender_guard import SenderGuardBlocked
                    if isinstance(e,SenderGuardBlocked) and not e.write_attempted:
                        # A proven pre-send refusal is not an ambiguous Gmail effect.
                        _ = db.execute("DELETE FROM touches WHERE item=? AND step=? AND state='pending' AND gmail_id IS NULL",(item['id'],step))
                        db.commit()
                        if step=='initial':arm_counts[variant]-=1
                        decision_row.update(status='sender_preflight_blocked',blockingReasons=[str(e)])
                    else:
                        decision_row.update(status='send_effect_unknown',errorType=type(e).__name__)
                        unknown+=1
        decision.append(decision_row)
    counts={s:sum(x['status']==s for x in decision) for s in sorted({x['status'] for x in decision})}
    funnel: dict[str, int | None] = {k:state_count(db.execute("SELECT count(DISTINCT item) FROM replies WHERE kind=?",(kind,))) for k,kind in [('programmeRequestedCompanies','programme_requested'),('interestCompanies','qualified_interest'),('qualifiedNeedCompanies','qualified_need')]}
    funnel['programmeDeliveredCompanies']=state_count(db.execute("SELECT count(DISTINCT item) FROM touches WHERE step='programme' AND state='sent_verified'"))
    # Scheduling and paid engagement require separate concrete evidence. A
    # positive email or request for information never counts as a booking.
    funnel.update(meetingsConfirmed=None,conferencesBooked=None,bookingEvidenceAvailable=False)
    report: dict[str, object] = {'generatedAt':stamp(t),'ok':not danger and not unknown,'capabilityId':c['campaignId'],'campaignId':c['campaignId'],'status':'active' if c['activation']=='active' and not danger and not unknown else 'prepared_or_paused','externalSendsThisRun':counts.get('sent_verified',0),'verifiedSendsTotal':state_count(db.execute("SELECT count(*) FROM touches WHERE state='sent_verified'")),'qualifiedCompanies':funnel['qualifiedNeedCompanies'] if copy_version else funnel['interestCompanies'],'counts':counts,'decisions':decision,'learning':learning,'summary':f'Scottish conference: {len(c["items"])} audience contacts, {counts.get("sent_verified",0)} verified sends this run; qualified responses drive learning','blockingReasons':(['unknown_gmail_effect'] if unknown else [])+(['complaint_or_delivery_failure'] if danger else []),'authorizationScopeSha256':c['authorization']['scopeSha256'],'simulation':not apply,'sender':SENDER,'audienceContacts':len(c['items']),'audienceCompanies':len({x['domain'] for x in c['items']}),'qualifiedAudienceContacts':sum(not eligible(x,proofs.get(x['email']),t) for x in c['items']),'qualifiedAudienceCompanies':len({x['domain'] for x in c['items'] if not eligible(x,proofs.get(x['email']),t)}),'dailyTouchCap':c['limits']['dailyTouches'],'weeklyTouchCap':c['limits']['weeklyTouches'],'nextBusinessWindow':'2026-10-01T09:00:00+01:00' if local.date().isoformat()<'2026-10-01' else None}
    report.update(commercialFunnel=funnel, copyVersion=copy_version or 'legacy')
    report.update(hourlyTouchCap=c['limits'].get('hourlyTouches'), minimumSendIntervalSeconds=c['limits'].get('minimumSendIntervalSeconds'), hourlyTouchesUsed=pacing(db,c['limits'],t)['hourlyTouchesUsed'], dailyTouchesUsed=daily, weeklyTouchesUsed=weekly)
    save(root/'campaign-last.json',report)
    save(root/'qualified-leads.json',{'generatedAt':stamp(t),'items':[dict(x, contact=next(i for i in c['items'] if i['id']==x['item'])) for x in state_rows(db.execute("SELECT * FROM replies WHERE kind=?", ('qualified_need' if copy_version else 'qualified_interest',)))]})
    db.close()
    return REPORT_ADAPTER.validate_python(report)

class Arguments(argparse.Namespace):
    apply: bool = False


def main() -> int:
    ap=argparse.ArgumentParser()
    _ = ap.add_argument('--apply',action='store_true')
    args=ap.parse_args(namespace=Arguments())
    ROOT.mkdir(parents=True,exist_ok=True)
    with (ROOT/'campaign.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        result=run(apply=args.apply)
        save(OPS_REPORT,result)
        print(json.dumps(result))
    return 0 if result['ok'] else 1

if __name__=='__main__':
    raise SystemExit(main())
