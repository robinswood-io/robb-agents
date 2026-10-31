from __future__ import annotations

import json
import os
import time
import urllib.parse
from datetime import UTC, datetime

from pydantic import JsonValue, TypeAdapter

JsonObject = dict[str, JsonValue]
JSON_ADAPTER = TypeAdapter[JsonValue](JsonValue)
JSON_OBJECT_ADAPTER = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


from rubypayeur_recouvrement_client import http_json
from rubypayeur_recouvrement_support import (
    CANDIDATES_JSON,
    CANDIDATES_MD,
    DRAFT_QUEUE,
    LEDGER,
    SECRETS_ENV,
    SELLSY_BASE,
    SELLSY_LOGIN_URL,
    array_value,
    clean_date,
    deep_get,
    find_related_id,
    first_non_empty,
    identifier_values,
    integer_value,
    ledger_request_ids_by_status,
    load_dotenv,
    now_iso,
    object_value,
    parse_amount,
    write_json,
)

_sellsy_access_token: str | None = None
_sellsy_token_expiry: float = 0.0


def sellsy_auth() -> str:
    global _sellsy_access_token, _sellsy_token_expiry
    load_dotenv(SECRETS_ENV)
    if _sellsy_access_token and time.time() < _sellsy_token_expiry - 60:
        return _sellsy_access_token
    client_id = os.environ.get("SELLSY_CLIENT_ID", "").strip()
    client_secret = os.environ.get("SELLSY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise RuntimeError("sellsy_credentials_missing")
    body = urllib.parse.urlencode({'grant_type': 'client_credentials', 'client_id': client_id, 'client_secret': client_secret}).encode('utf-8')
    status, data = http_json('POST', SELLSY_LOGIN_URL, headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'rbw-agents-oss/1.0'}, body=body, timeout=45)
    response = object_value(data)
    access_token = response.get("access_token")
    if status >= 400 or not isinstance(access_token, str) or not access_token:
        raise RuntimeError(f"sellsy_auth_failed:{status}")
    _sellsy_access_token = access_token
    expiry = response.get("expires_in")
    _sellsy_token_expiry = time.time() + int(str(expiry or 3600))
    return _sellsy_access_token


def sellsy_request(endpoint: str, method: str='GET', body: dict[str, JsonValue] | None=None) -> dict[str, JsonValue]:
    token = sellsy_auth()
    raw_body = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None and method != 'GET' else None
    status, data = http_json(method, f'{SELLSY_BASE}{endpoint}', headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'User-Agent': 'rbw-agents-oss/1.0'}, body=raw_body, timeout=60)
    if status >= 400:
        raise RuntimeError(f'Sellsy API error: status={status} endpoint={endpoint} response={data}')
    return data if isinstance(data, dict) else {'data': data}


def try_sellsy_request(endpoint: str, warnings: list[str]) -> dict[str, JsonValue] | None:
    try:
        return sellsy_request(endpoint)
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        warnings.append(f'sellsy_fetch_failed:{endpoint}:{exc}')
        return None


def legal_id_from_company(company: dict[str, JsonValue] | None) -> str | None:
    if company is None:
        return None
    candidates = [deep_get(company, 'legal_france', 'siren'), deep_get(company, 'legal_france', 'siret'), deep_get(company, 'legal', 'siren'), deep_get(company, 'legal', 'siret'), company.get('siren'), company.get('siret'), company.get('vat_number')]
    for raw in candidates:
        if not raw:
            continue
        digits = ''.join(ch for ch in str(raw) if ch.isdigit())
        if len(digits) in (9, 14):
            return digits
    return None


def contact_from_sellsy(contact: dict[str, JsonValue] | None) -> dict[str, JsonValue]:
    if contact is None:
        return {}
    return {'first_name': first_non_empty(contact.get('first_name'), contact.get('firstname')), 'last_name': first_non_empty(contact.get('last_name'), contact.get('lastname'), contact.get('name')), 'email': first_non_empty(contact.get('email'), deep_get(contact, 'main_email', 'email')), 'phone': first_non_empty(contact.get('phone_number'), contact.get('phone'), contact.get('mobile_number'), contact.get('mobile'))}


def sellsy_invoice_to_item(invoice: dict[str, JsonValue], *, require_unpaid: bool=True) -> tuple[dict[str, JsonValue], list[str]]:
    warnings: list[str] = []
    status = str(invoice.get('status') or '').lower()
    if require_unpaid and status in {'paid', 'cancelled', 'canceled'}:
        raise ValueError(f'sellsy_invoice_not_collectible:{invoice.get('id')}:status={status}')
    amounts = object_value(invoice.get('amounts'))
    amount = parse_amount(first_non_empty(amounts.get('total_remaining_due_incl_tax'), amounts.get('total_incl_tax')))
    if amount <= 0:
        raise ValueError(f'sellsy_invoice_zero_remaining_due:{invoice.get('id')}')
    pdf_url = first_non_empty(invoice.get('pdf_link'), deep_get(invoice, 'public_link', 'url'))
    if not pdf_url:
        warnings.append(f'sellsy_invoice_missing_pdf_link:{invoice.get('id')}')
    item = {'amount': amount, 'invoice_number': str(first_non_empty(invoice.get('number'), invoice.get('id'))), 'invoiced_on': clean_date(first_non_empty(invoice.get('date'), invoice.get('created'))), 'due_date': clean_date(invoice.get('due_date')), 'billing_proof_remote_url': pdf_url}
    return (item, warnings)


def build_debt_from_sellsy(row: dict[str, JsonValue]) -> tuple[dict[str, JsonValue], dict[str, JsonValue]]:
    cfg = object_value(row.get('sellsy'))
    invoice_values = identifier_values(first_non_empty(cfg.get('invoice_ids'), row.get('sellsy_invoice_ids'), row.get('invoice_ids')))
    estimate_values = identifier_values(first_non_empty(cfg.get('estimate_ids'), row.get('sellsy_estimate_ids'), row.get('estimate_ids')))
    invoice_ids = [int(str(value)) for value in invoice_values if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip()]
    estimate_ids = [int(str(value)) for value in estimate_values if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value).strip()]
    if not invoice_ids:
        raise ValueError('sellsy_invoice_ids_required')
    warnings: list[str] = []
    invoices: list[dict[str, JsonValue]] = []
    companies: dict[int, dict[str, JsonValue] | None] = {}
    contacts: dict[int, dict[str, JsonValue] | None] = {}
    items: list[dict[str, JsonValue]] = []
    require_unpaid = cfg.get('require_unpaid', True) is not False
    for invoice_id in invoice_ids:
        invoice = sellsy_request(f'/invoices/{invoice_id}')
        invoices.append(invoice)
        item, item_warnings = sellsy_invoice_to_item(invoice, require_unpaid=require_unpaid)
        warnings.extend(item_warnings)
        items.append(item)
        company_id = find_related_id(invoice, 'company')
        contact_id = find_related_id(invoice, 'contact') or invoice.get('contact_id')
        if company_id and company_id not in companies:
            companies[company_id] = try_sellsy_request(f'/companies/{company_id}', warnings)
        if contact_id:
            try:
                contact_id_int = integer_value(contact_id)
                if contact_id_int is not None and contact_id_int not in contacts:
                    contacts[contact_id_int] = try_sellsy_request(f'/contacts/{contact_id_int}', warnings)
            except (OSError, RuntimeError, TypeError, ValueError):
                warnings.append(f'invalid_sellsy_contact_id:{contact_id}')
        parent = object_value(invoice.get('parent'))
        parent_id = integer_value(parent.get('id'))
        if parent.get('type') == 'estimate' and parent_id is not None and parent_id not in estimate_ids:
            estimate_ids.append(parent_id)
    company_ids = [cid for cid in companies if cid]
    contact_ids = [cid for cid in contacts if cid]
    if len(company_ids) > 1:
        raise ValueError(f'sellsy_invoices_multiple_companies:{company_ids}')
    company = companies.get(company_ids[0]) if company_ids else None
    contact = contacts.get(contact_ids[0]) if contact_ids else None
    contact_fields = contact_from_sellsy(contact)
    debtor_override = object_value(cfg.get('debtor'))
    first_invoice = invoices[0]
    company_name = first_non_empty(first_invoice.get('company_name'), company.get('name') if isinstance(company, dict) else None)
    legal_id = first_non_empty(debtor_override.get('siren'), debtor_override.get('siret'), legal_id_from_company(company))
    debt = {'siren': legal_id, 'gender': first_non_empty(debtor_override.get('gender'), cfg.get('gender'), 'male'), 'first_name': first_non_empty(debtor_override.get('first_name'), contact_fields.get('first_name'), cfg.get('first_name')), 'last_name': first_non_empty(debtor_override.get('last_name'), contact_fields.get('last_name'), cfg.get('last_name'), company_name), 'email': first_non_empty(debtor_override.get('email'), contact_fields.get('email'), cfg.get('email')), 'phone': first_non_empty(debtor_override.get('phone'), contact_fields.get('phone'), cfg.get('phone'), '0184807678'), 'items': items, 'late_fee': cfg.get('late_fee', True), 'terms_agree': cfg.get('terms_agree', True), 'comment': first_non_empty(cfg.get('comment'), row.get('reason'), f'Dossier généré depuis Sellsy pour factures {', '.join(str(i) for i in invoice_ids)}')}
    estimate_refs: list[dict[str, JsonValue]] = []
    for estimate_id in estimate_ids:
        estimate = try_sellsy_request(f'/estimates/{estimate_id}', warnings)
        if estimate is None:
            continue
        estimate_refs.append({'id': estimate_id, 'number': estimate.get('number'), 'status': estimate.get('status')})
        proof = first_non_empty(estimate.get('pdf_link'), deep_get(estimate, 'public_link', 'url'))
        if proof and (not debt.get('dunning_letter_proof_remote_url')):
            debt['dunning_letter_proof_remote_url'] = proof
    if cfg.get('dunning_letter_proof_remote_url'):
        debt['dunning_letter_proof_remote_url'] = cfg['dunning_letter_proof_remote_url']
    if cfg.get('dunning_letter_proof_data_uri'):
        debt['dunning_letter_proof_data_uri'] = cfg['dunning_letter_proof_data_uri']
    if cfg.get('dunning_letter_proof_file_path'):
        debt['dunning_letter_proof_file_path'] = cfg['dunning_letter_proof_file_path']
    for key in ('siren', 'gender', 'first_name', 'last_name', 'email', 'phone'):
        if debtor_override.get(key):
            debt[key] = debtor_override[key]
    sync = {'source': 'sellsy', 'invoiceIds': invoice_ids, 'estimateIds': estimate_ids, 'companyIds': company_ids, 'contactIds': contact_ids, 'companyName': company_name, 'invoiceNumbers': [i.get('number') for i in invoices], 'invoiceStatuses': [i.get('status') for i in invoices], 'estimateRefs': estimate_refs, 'warnings': warnings, 'requiresDebtorOverride': [k for k in ('siren', 'first_name', 'last_name', 'email') if not debt.get(k)]}
    return (JSON_OBJECT_ADAPTER.validate_python(debt), JSON_OBJECT_ADAPTER.validate_python(sync))


def list_sellsy_invoices(status: str, limit: int) -> list[dict[str, JsonValue]]:
    params = urllib.parse.urlencode({'status': status, 'limit': max(1, min(limit, 100))})
    data = sellsy_request(f'/invoices?{params}')
    rows = array_value(data.get('data'))
    return [object_value(row) for row in rows if isinstance(row, dict)]


def days_overdue(due_date: JsonValue) -> int | None:
    raw = clean_date(due_date)
    if not raw:
        return None
    try:
        due = datetime.fromisoformat(raw).replace(tzinfo=UTC)
        return (datetime.now(UTC).date() - due.date()).days
    except (TypeError, ValueError):
        return None


def candidate_from_invoice(
    invoice: JsonObject, *, min_overdue_days: int, min_amount: float,
) -> JsonObject | None:
    status = str(invoice.get('status') or '').lower()
    if status in {'paid', 'cancelled', 'canceled', 'draft'}:
        return None
    amounts = object_value(invoice.get('amounts'))
    amount = parse_amount(first_non_empty(
        amounts.get('total_remaining_due_incl_tax'), amounts.get('total_incl_tax'),
    ))
    overdue = days_overdue(invoice.get('due_date'))
    if amount < min_amount or overdue is None or overdue < min_overdue_days:
        return None
    invoice_id = invoice.get('id')
    if not invoice_id:
        return None
    request_id = f'rubypayeur:sellsy:invoice:{invoice_id}'
    parent = object_value(invoice.get('parent'))
    sellsy = JSON_OBJECT_ADAPTER.validate_python({
        'invoice_ids': [invoice_id],
        'require_unpaid': True,
        'comment': (
            f"Candidat Rubypayeur détecté automatiquement depuis Sellsy: facture "
            f"{invoice.get('number')} en retard de {overdue} jours, reste dû {amount} EUR. "
            'À compléter/valider avant dépôt.'
        ),
    })
    parent_id = parent.get('id') if parent.get('type') == 'estimate' else None
    if parent_id:
        sellsy['estimate_ids'] = [parent_id]
    draft = {
        'requestId': request_id,
        'action': 'create_debt',
        'approvedForRubypayeur': False,
        'sellsy': sellsy,
        'candidateMeta': {
            'source': 'sellsy_late_invoice_scan',
            'detectedAt': now_iso(),
            'companyName': invoice.get('company_name'),
            'invoiceNumber': invoice.get('number'),
            'amountRemainingInclTax': amount,
            'dueDate': clean_date(invoice.get('due_date')),
            'daysOverdue': overdue,
            'status': invoice.get('status'),
            'hasPdfLink': bool(invoice.get('pdf_link') or deep_get(invoice, 'public_link', 'url')),
            'parentEstimateId': parent_id,
        },
    }
    return JSON_OBJECT_ADAPTER.validate_python(draft)

def write_candidates_markdown(payload: JsonObject) -> None:
    artifact = object_value(payload.get('artifacts'))
    lines = [
        f"# Rubypayeur Recouvrement Candidates — {payload.get('generatedAt')}",
        '',
        f"- Status: {payload.get('status')}",
        f"- Summary: {payload.get('summary')}",
        f"- Draft queue: {chr(96)}{artifact.get('draftQueue')}{chr(96)}",
        '',
        '## Guardrails',
        f'- Candidates are never approved automatically ({chr(96)}approvedForRubypayeur=false{chr(96)}).',
        '- An agent/human must enrich debtor legal/contact fields and flip approval explicitly.',
        '- Real deposit still re-reads Sellsy live and blocks paid/cancelled/zero-due invoices.',
        '',
        '## Candidates',
    ]
    for candidate_value in array_value(payload.get('candidates')):
        candidate = JSON_OBJECT_ADAPTER.validate_python(candidate_value)
        metadata = object_value(candidate.get('candidateMeta'))
        cells = (
            str(candidate.get('requestId')), str(metadata.get('companyName')),
            str(metadata.get('invoiceNumber')), f"{metadata.get('amountRemainingInclTax')} EUR",
            f"overdue={metadata.get('daysOverdue')}d", f"pdf={metadata.get('hasPdfLink')}",
        )
        lines.append('- ' + ' / '.join(cells))
    CANDIDATES_MD.parent.mkdir(parents=True, exist_ok=True)
    _ = CANDIDATES_MD.write_text('\n'.join(lines) + '\n', encoding='utf-8')

def scan_sellsy_candidates(*, max_items: int, min_overdue_days: int, min_amount: float, write_draft_queue: bool=True) -> dict[str, JsonValue]:
    generated_at = now_iso()
    seen: set[str] = set()
    candidates: list[dict[str, JsonValue]] = []
    processed = ledger_request_ids_by_status()
    blocked_ids = set(processed.get('created', set()))
    errors: list[str] = []
    for status in ('late', 'unpaid'):
        try:
            invoices = list_sellsy_invoices(status, max_items)
        except (OSError, RuntimeError, TypeError, ValueError) as exc:
            errors.append(f'sellsy_list_failed:{status}:{exc}')
            continue
        for invoice in invoices:
            if len(candidates) >= max_items:
                break
            candidate = candidate_from_invoice(invoice, min_overdue_days=min_overdue_days, min_amount=min_amount)
            if not candidate:
                continue
            rid = str(candidate['requestId'])
            if rid in seen or rid in blocked_ids:
                continue
            seen.add(rid)
            candidates.append(candidate)
    if write_draft_queue:
        DRAFT_QUEUE.parent.mkdir(parents=True, exist_ok=True)
        _ = DRAFT_QUEUE.write_text(''.join(json.dumps(c, ensure_ascii=False) + '\n' for c in candidates), encoding='utf-8')
    payload = JSON_OBJECT_ADAPTER.validate_python({'generatedAt': generated_at, 'contractVersion': 'rubypayeur-recouvrement-oss-v3-sellsy-autonomy', 'capabilityId': 'rubypayeur-recouvrement-candidate-scan', 'ok': not errors, 'status': 'processed' if candidates else 'blocked' if errors else 'no_candidates', 'summary': f'rubypayeur candidates: candidates={len(candidates)} errors={len(errors)} min_overdue_days={min_overdue_days} min_amount={min_amount}', 'counts': {'candidates': len(candidates), 'errors': len(errors), 'alreadyProcessedIds': len(blocked_ids)}, 'blockingReasons': ['sellsy_candidate_scan_errors'] if errors else [], 'errors': errors, 'artifacts': {'candidatesJson': str(CANDIDATES_JSON), 'candidatesMd': str(CANDIDATES_MD), 'draftQueue': str(DRAFT_QUEUE), 'ledger': str(LEDGER)}, 'checks': {'sellsySyncEnabled': True, 'approvalRequiredForDeposit': True, 'writeDraftQueue': write_draft_queue, 'minOverdueDays': min_overdue_days, 'minAmount': min_amount}, 'candidates': candidates, 'updatedBy': 'rubypayeur-recouvrement-candidate-scan'})
    write_json(CANDIDATES_JSON, payload)
    write_candidates_markdown(payload)
    return payload


def create_sellsy_followup_task(sellsy_sync: dict[str, JsonValue] | None, rubypayeur: dict[str, JsonValue], request_id: str) -> dict[str, JsonValue] | None:
    if sellsy_sync is None:
        return None
    related: list[JsonObject] = []
    for cid in array_value(sellsy_sync.get('companyIds')):
        related.append({'type': 'company', 'id': int(str(cid))})
    for cid in array_value(sellsy_sync.get('contactIds')):
        related.append({'type': 'contact', 'id': int(str(cid))})
    if not related:
        return {'ok': False, 'reason': 'no_sellsy_related_entities'}
    ref = rubypayeur.get('ref') or rubypayeur.get('id') or 'sans-ref'
    invoice_values = array_value(sellsy_sync.get('invoiceNumbers')) or array_value(sellsy_sync.get('invoiceIds'))
    invoices = ', '.join(str(value) for value in invoice_values)
    body = JSON_OBJECT_ADAPTER.validate_python({'title': f'Rubypayeur recouvrement déposé — {ref}', 'status': 'todo', 'is_private': False, 'label_id': int(os.environ.get('SELLSY_TASK_DEFAULT_LABEL_ID', '3107783')), 'description': f'Dossier Rubypayeur créé depuis OSS. Référence: {ref}. RequestId: {request_id}. Factures Sellsy: {invoices}.', 'related': related})
    try:
        task = sellsy_request('/tasks', method='POST', body=body)
        return JSON_OBJECT_ADAPTER.validate_python({'ok': True, 'taskId': task.get('id'), 'ref': ref})
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        return JSON_OBJECT_ADAPTER.validate_python({'ok': False, 'error': str(exc), 'ref': ref})
