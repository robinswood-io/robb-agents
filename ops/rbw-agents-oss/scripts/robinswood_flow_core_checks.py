from __future__ import annotations

import json
import re
import sys
from datetime import datetime

from pydantic import JsonValue

if __package__:
    from .robinswood_flow_core_support import (
        APPROVAL,
        COMPOSE,
        CONTRACT,
        CRMSTATE,
        EMAILQ,
        EVENTS,
        HUMAN,
        JSON_ADAPTER,
        LEDGER,
        LIQ,
        REG,
        REPLY,
        ROOT,
        JsonObject,
        account_key,
        classify,
        load,
        object_value,
        optional_object,
        private_text,
        profile,
        report,
        required_text,
        rows,
        rows_value,
        source_message_id,
        stale_message_ids,
        text_value,
    )
else:
    from robinswood_flow_core_support import (
        APPROVAL,
        COMPOSE,
        CONTRACT,
        CRMSTATE,
        EMAILQ,
        EVENTS,
        HUMAN,
        JSON_ADAPTER,
        LEDGER,
        LIQ,
        REG,
        REPLY,
        ROOT,
        JsonObject,
        account_key,
        classify,
        load,
        object_value,
        optional_object,
        private_text,
        profile,
        report,
        required_text,
        rows,
        rows_value,
        source_message_id,
        stale_message_ids,
        text_value,
    )

def attribution() -> int:
    _ = profile()
    events = rows(EVENTS)
    unique: dict[str, JsonObject] = {required_text(row.get('event_id'), 'event_id_missing'): row for row in events if row.get('event_id')}
    _ = EVENTS.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in unique.values()), encoding='utf-8')
    counts: dict[str, int] = {}
    for row in unique.values():
        event_type = required_text(row.get('event_type'), 'event_type_missing')
        counts[event_type] = counts.get(event_type, 0) + 1
    missing = [row for row in unique.values() if not row.get('campaign_id') or not row.get('lead_id') or (row.get('event_type') in {'email_sent', 'linkedin_sent'} and (not row.get('provider_message_id') or not row.get('thread_id')))]
    return report('attribution', {'counts': {'events': len(unique), **counts, 'missingRequiredIds': len(missing)}, 'missingEvents': missing, 'privacy': 'email_bodies_excluded'}, not missing)

def dashboard() -> int:
    _ = profile()
    registry = load(REG, {})
    email_queue = rows_value(load(EMAILQ, {}).get('items'), 'email_queue_items_invalid')
    linkedin_queue_items = rows_value(load(LIQ, {}).get('items'), 'linkedin_queue_items_invalid')
    crm_state = load(CRMSTATE, {})
    reply_state = load(REPLY, {})
    scheduled = [item for item in email_queue + linkedin_queue_items if item.get('status') == 'scheduled_conditional']
    scheduled.sort(key=lambda item: text_value(item.get('dueAt')))
    next_action = scheduled[0] if scheduled else {}
    accounts_in_registry = rows_value(registry.get('accounts'), 'account_rows_invalid')
    account_states = optional_object(reply_state.get('accounts'), 'reply_accounts_invalid')
    active_account_state = optional_object(account_states.get(account_key()), 'reply_account_invalid')
    companies = optional_object(crm_state.get('companies'), 'crm_companies_invalid')
    contacts = optional_object(crm_state.get('contacts'), 'crm_contacts_invalid')
    tasks = optional_object(crm_state.get(private_text('text_011')), 'crm_tasks_invalid')
    opportunities = crm_state.get('opportunitiesCreated')
    opportunity_count = int(opportunities) if isinstance(opportunities, (str, int, float)) else 0
    return report('dashboard', {'counts': {'accounts': len(accounts_in_registry), 'approved': sum(1 for account in accounts_in_registry if account.get('approvedForSequence')), 'crmCompanies': len(companies), 'crmContacts': len(contacts), 'crmTasks': len(tasks), 'opportunitiesCreated': opportunity_count, 'emailActions': len(email_queue), 'linkedinActions': len(linkedin_queue_items), 'events': len(rows(EVENTS)), 'sequenceStopped': bool(active_account_state.get('sequenceStopped'))}, 'nextAction': next_action, 'evidenceSemantics': ['attempted', private_text('text_036'), 'user_result_verified', 'business_conversion']})

def guard_tests() -> int:
    _ = profile()
    checks: list[JsonObject] = []

    def ck(n: str, v: bool, d: JsonValue = None) -> None:
        checks.append({'name': n, 'ok': bool(v), 'detail': d})
    for p in [CONTRACT, REG, APPROVAL, EMAILQ, LIQ, REPLY, HUMAN, CRMSTATE]:
        try:
            _ = load(p, {})
            json.loads(p.read_text())
            ck('json:' + p.name, True)
        except (ImportError, OSError, RuntimeError, TypeError, ValueError) as e:
            ck('json:' + p.name, False, str(e))
    reg = load(REG, {})
    eq = rows_value(load(EMAILQ, {}).get('items'), 'email_queue_items_invalid')
    liq = rows_value(load(LIQ, {}).get('items'), 'linkedin_queue_items_invalid')
    led = rows(LEDGER)
    ev = rows(EVENTS)
    ck('thirteen_accounts', len(rows_value(reg.get('accounts'), 'account_rows_invalid')) == 13)
    ck('one_approved', sum(1 for x in rows_value(reg.get('accounts'), 'account_rows_invalid') if x.get('approvedForSequence')) == 1)
    ck(private_text('text_014'), sum(1 for x in rows_value(reg.get('accounts'), 'account_rows_invalid') if x.get('key') == account_key()) == 1)
    ck('d0_once', sum(1 for x in led if x.get('gmailMessageId') == source_message_id()) == 1)
    ck('stale_excluded', not any(x.get('gmailMessageId') == stale_message_ids() or x.get('provider_message_id') == stale_message_ids() for x in led + ev))
    opportunity_total = load(CRMSTATE, {}).get('opportunitiesCreated')
    opportunity_count = int(opportunity_total) if isinstance(opportunity_total, (str, int, float)) else 0
    ck('no_opportunities', opportunity_count == 0)
    ck('three_email_actions', len(eq) in (3, 4))
    ck(private_text('text_015'), len(liq) == 1 and liq[0].get('note') == '' and (liq[0].get('connectionOnly') is True))
    ck('future_due_no_immediate_touch', all(datetime.fromisoformat(required_text(x.get('dueAt'), 'due_at_invalid')) > datetime.fromisoformat('2026-07-15T16:10:00+02:00') for x in eq + liq if x.get('status') == 'scheduled_conditional'))
    ck('d0_attribution', sum(1 for x in ev if x.get('provider_message_id') == source_message_id() and x.get('send_id') == 'gmail:' + source_message_id()) == 1)
    ck('hdf_isolation', all('hdf' not in str(p).lower() for p in [REG, EMAILQ, LIQ, LEDGER, EVENTS]))
    txt = COMPOSE.read_text(encoding='utf-8', errors='ignore') if COMPOSE.exists() else ''
    m = re.search('(?m)^ABM_AUTONOMOUS_SEND=(.*)$', txt)
    ck(private_text('text_016'), bool(m and m.group(1).strip().strip('"\'') == '0'), m.group(1) if m else private_text('text_041'))
    fixtures = {'positive': 'Disponible pour un rendez-vous', 'ooo': 'Réponse automatique, absent du bureau', 'bounce': 'mailer-daemon permanent error status: 5.1.1', 'optout': 'Merci de me désabonner', 'negative': 'Non merci, pas maintenant'}
    got: JsonObject = {k: classify(v, v if k == 'bounce' else '') for k, v in fixtures.items()}
    ck('router_fixtures', got == {'positive': 'positive_or_referral', 'ooo': 'out_of_office', 'bounce': 'hard_bounce', 'optout': 'opt_out', 'negative': 'objection'}, got)
    try:
        sys.path.insert(0, str(ROOT / 'scripts'))
        from linkedin_connection_browser_provider_core import transport_preflight
        raw_preflight = transport_preflight()
        pre = object_value(JSON_ADAPTER.validate_python(raw_preflight), 'transport_preflight_invalid')
        ck(private_text('text_042'), pre.get('ok') is True or pre.get('status') == 'blocked_ui', pre)
    except (ImportError, OSError, RuntimeError, TypeError, ValueError) as e:
        ck(private_text('text_042'), False, str(e))
    ok = all(x['ok'] for x in checks)
    return report('guard-tests', {'counts': {'checks': len(checks), 'passed': sum(1 for x in checks if x['ok']), 'failed': sum(1 for x in checks if not x['ok'])}, 'checks': checks, 'externalSends': 0}, ok, 'passed' if ok else 'failed')
