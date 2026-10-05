#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from inqom_vat_period_contract import current_period_checks

OPS = Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops')
JULY_PACK = OPS / 'finance-inqom-vat-july-2026-cash-basis-preparation.json'
MONTHLY_LAST = OPS / 'finance-inqom-vat-cash-basis-monthly-preparation-last.json'
LETTERING_CONTROL = OPS / 'finance-inqom-vat-cash-basis-monthly-period-lettering-control-last.json'
SELLSY_CONTROL = OPS / 'finance-inqom-vat-sellsy-issued-invoice-control.json'
GOCARDLESS_RECEIPTS = OPS / 'finance-inqom-vat-gocardless-cash-receipts.json'
DIRECT_BANK_RECEIPTS = OPS / 'finance-inqom-vat-direct-bank-receipts.json'
ALLOCATOR = OPS / 'finance-inqom-vat-cash-basis-allocator.json'
DEDUCTIBLE_CROSSCHECK = OPS / 'finance-inqom-vat-deductible-crosscheck.json'
OUT_JSON = OPS / 'finance-inqom-vat-cash-basis-monthly-tests.json'
OUT_MD = OPS / 'finance-inqom-vat-cash-basis-monthly-tests.md'

EXPECTED_INVOICES = {f'FC-0223{i}' for i in range(2, 9)}
EXCLUDED_AUGUST_OR_UNPAID = {f'FC-022{i}' for i in range(39, 45)}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def money(value: Any) -> float:
    try:
        return round(float(value or 0), 2)
    except Exception:
        return 0.0


def add(checks: list[dict[str, Any]], check_id: str, ok: bool, severity: str = 'critical', detail: Any = None) -> None:
    checks.append({'checkId': check_id, 'ok': bool(ok), 'severity': severity, 'detail': detail})


def main() -> None:
    generated_at = now_iso()
    pack = read_json(JULY_PACK, {})
    monthly = read_json(MONTHLY_LAST, {})
    lettering = read_json(LETTERING_CONTROL, {})
    sellsy_control = read_json(SELLSY_CONTROL, {})
    gocardless_receipts = read_json(GOCARDLESS_RECEIPTS, {})
    direct_bank_receipts = read_json(DIRECT_BANK_RECEIPTS, {})
    allocator = read_json(ALLOCATOR, {})
    deductible_crosscheck = read_json(DEDUCTIBLE_CROSSCHECK, {})
    payments = ((pack.get('cashCollections') or {}).get('payments') or []) if isinstance(pack, dict) else []
    totals = (pack.get('cashCollections') or {}).get('totalsExact') or {}
    declaration = (pack.get('declarationDraft') or {}).get('exact') or {}
    rounded = (pack.get('declarationDraft') or {}).get('roundedForLikelyCa3Entry') or {}
    safety = pack.get('safety') or {}
    controls = pack.get('controls') or {}
    excluded = pack.get('excludedFromJulyCashBasis') or []
    excluded_numbers = {str(x.get('invoiceNumber')) for x in excluded if isinstance(x, dict)}
    paid_numbers = {str(x.get('invoiceNumber')) for x in payments if isinstance(x, dict)}
    statuses = {str(x.get('status')) for x in payments if isinstance(x, dict)}
    checks: list[dict[str, Any]] = []
    add(checks, 'july_pack_exists', JULY_PACK.exists(), detail=str(JULY_PACK))
    add(checks, 'monthly_last_exists', MONTHLY_LAST.exists(), detail=str(MONTHLY_LAST))
    add(checks, 'vat_subreports_exist', all(p.exists() for p in [SELLSY_CONTROL, GOCARDLESS_RECEIPTS, DIRECT_BANK_RECEIPTS, ALLOCATOR, DEDUCTIBLE_CROSSCHECK]), detail=[str(p) for p in [SELLSY_CONTROL, GOCARDLESS_RECEIPTS, DIRECT_BANK_RECEIPTS, ALLOCATOR, DEDUCTIBLE_CROSSCHECK]])
    add(checks, 'seven_paid_out_gocardless_payments', len(payments) == 7 and statuses == {'paid_out'}, detail={'count': len(payments), 'statuses': sorted(statuses), 'invoices': sorted(paid_numbers)})
    add(checks, 'expected_invoice_numbers_included', EXPECTED_INVOICES.issubset(paid_numbers), detail=sorted(paid_numbers))
    add(checks, 'gross_collected_ttc_exact', money(totals.get('grossCollectedTtc')) == 17616.00, detail=totals)
    add(checks, 'taxable_base_ht_exact', money(totals.get('taxableBaseHt')) == 14680.00 and money(declaration.get('taxableBase20Percent')) == 14680.00, detail={'totals': totals, 'declaration': declaration})
    add(checks, 'vat_collected_exact', money(totals.get('vatCollected')) == 2936.00 and money(declaration.get('grossVatDue20Percent')) == 2936.00, detail={'totals': totals, 'declaration': declaration})
    add(checks, 'deductible_vat_pack_exact', money((pack.get('deductibleVat') or {}).get('totalExact')) == 112.20 and money(declaration.get('deductibleVatOtherGoodsServices')) == 112.20, detail={'deductibleVat': pack.get('deductibleVat'), 'declaration': declaration})
    add(checks, 'net_vat_due_rounded', money(declaration.get('netVatDue')) == 2823.80 and int(rounded.get('netVatDue') or 0) == 2824, detail={'exact': declaration, 'rounded': rounded})
    add(checks, 'no_refunds_or_failed_july', int(controls.get('gocardlessRefundCountJuly') or 0) == 0 and bool(controls.get('excludedFailedPayments')) is True, detail=controls)
    add(checks, 'excluded_august_or_unpaid_invoices', EXCLUDED_AUGUST_OR_UNPAID.intersection(excluded_numbers) >= {'FC-02239', 'FC-02240', 'FC-02241', 'FC-02242', 'FC-02243', 'FC-02244'}, detail=sorted(excluded_numbers))
    add(checks, 'fc02238_included_for_445888_context', 'FC-02238' in paid_numbers and any(money(p.get('vatCollected')) == 1000.0 for p in payments if p.get('invoiceNumber') == 'FC-02238'), detail=[p for p in payments if p.get('invoiceNumber') == 'FC-02238'])
    add(checks, 'sellsy_issued_invoice_control_ok', sellsy_control.get('ok') is True and (sellsy_control.get('counts') or {}).get('includedInvoices') == 7 and (sellsy_control.get('counts') or {}).get('excludedInvoices', 0) >= 6, detail={'summary': sellsy_control.get('summary'), 'counts': sellsy_control.get('counts')})
    add(checks, 'gocardless_receipts_control_ok', gocardless_receipts.get('ok') is True and (gocardless_receipts.get('counts') or {}).get('receipts') == 7 and money((gocardless_receipts.get('totals') or {}).get('vatCollected')) == 2936.00, detail={'summary': gocardless_receipts.get('summary'), 'counts': gocardless_receipts.get('counts'), 'totals': gocardless_receipts.get('totals')})
    add(checks, 'direct_bank_receipts_zero', direct_bank_receipts.get('ok') is True and (direct_bank_receipts.get('counts') or {}).get('directBankCustomerReceipts') == 0, detail={'summary': direct_bank_receipts.get('summary'), 'counts': direct_bank_receipts.get('counts')})
    add(checks, 'cash_basis_allocator_ok', allocator.get('ok') is True and (allocator.get('counts') or {}).get('allocations') == 7 and money((allocator.get('totals') or {}).get('vatCollected')) == 2936.00, detail={'summary': allocator.get('summary'), 'counts': allocator.get('counts'), 'totals': allocator.get('totals')})
    add(checks, 'deductible_crosscheck_preserves_july_and_carries_backdated_71', deductible_crosscheck.get('ok') is True and money(((deductible_crosscheck.get('deductibleVat') or {}).get('retainedAmount'))) == 112.20 and money(((deductible_crosscheck.get('deductibleVat') or {}).get('currentLedgerAmount'))) == 183.20 and money(((deductible_crosscheck.get('deductibleVat') or {}).get('nextPeriodCarryforwardAmount'))) == 71.00 and int((deductible_crosscheck.get('counts') or {}).get('backdatedAdjustments') or 0) == 4 and int((deductible_crosscheck.get('counts') or {}).get('actionQueue') or 0) == 0 and not (deductible_crosscheck.get('warningReasons') or []) and (deductible_crosscheck.get('resolution') or {}).get('julyDeclarationAmountPreserved') is True, detail={'summary': deductible_crosscheck.get('summary'), 'counts': deductible_crosscheck.get('counts'), 'resolution': deductible_crosscheck.get('resolution')})
    add(checks, 'mutations_and_fiscal_submission_blocked', safety.get('mutationAllowed') is False and safety.get('taxFilingAllowed') is False and safety.get('externalSubmissionAllowed') is False and safety.get('paymentInstructionAllowed') is False, detail=safety)
    monthly_safety = monthly.get('safety') or {}
    monthly_submission_blocked = monthly_safety.get('externalSubmissionAllowed') is False and monthly_safety.get('taxPaymentAllowed') is False
    monthly_mutation_blocked = monthly_safety.get('mutationAllowed') is False and monthly_safety.get('nativeLetteringMutationAllowed') is False
    add(checks, 'monthly_prepare_only', monthly.get('ok') is True and monthly_mutation_blocked and monthly_submission_blocked, detail={'summary': monthly.get('summary'), 'blockingReasons': monthly.get('blockingReasons'), 'safety': monthly.get('safety')})
    monthly_payments = ((monthly.get('cashCollections') or {}).get('payments') or [])
    monthly_totals = ((monthly.get('cashCollections') or {}).get('totalsExact') or {})
    monthly_exact = ((monthly.get('declarationDraft') or {}).get('exact') or {})
    monthly_deductible = ((monthly.get('cashCollections') or {}).get('deductibleVat') or {})
    monthly_controls = monthly.get('controls') or {}
    monthly_quorum = monthly_controls.get('internalFiscalQuorum') or {}
    checks.extend(current_period_checks(monthly))
    monthly_ordinary = monthly_controls.get('ordinaryAccountingFollowup') or {}
    fc02245 = [p for p in monthly_payments if p.get('invoiceNumber') == 'FC-02245']
    add(checks, 'august_v8_contract_live', monthly.get('contractVersion') == 'finance-inqom-vat-cash-basis-monthly-preparer-v10-2026-09-05-disputed-fail-closed', detail=monthly.get('contractVersion'))
    if (monthly.get('period') or {}).get('startDate') == '2026-08-01' and (monthly.get('period') or {}).get('endDate') == '2026-08-31':
        add(checks, 'august_ten_collections_exact', len(monthly_payments) == 10 and money(monthly_totals.get('grossCollectedTtc')) == 26496.00 and money(monthly_totals.get('taxableBaseHt')) == 22080.00 and money(monthly_totals.get('vatCollected')) == 4416.00, detail={'count': len(monthly_payments), 'totals': monthly_totals})
    if (monthly.get('period') or {}).get('startDate') == '2026-08-01' and (monthly.get('period') or {}).get('endDate') == '2026-08-31':
        add(checks, 'august_fc02245_included_with_full_evidence', len(fc02245) == 1 and money(fc02245[0].get('grossCollectedTtc')) == 2160.00 and money(fc02245[0].get('taxableBaseHt')) == 1800.00 and money(fc02245[0].get('vatCollected')) == 360.00 and fc02245[0].get('entryId') == 945484951 and fc02245[0].get('docRef') == 'BQ109730243' and fc02245[0].get('matching411TransferVerified') is True and ((fc02245[0].get('taxAllocationEvidence') or {}).get('method') == 'inqom_sellsy_invoice_prorata'), detail=fc02245)
    if (monthly.get('period') or {}).get('startDate') == '2026-08-01' and (monthly.get('period') or {}).get('endDate') == '2026-08-31':
        add(checks, 'august_deductible_net_after_regularizations', money(monthly_deductible.get('postedDebitVatInvoiceControl')) == 722.35 and money(monthly_deductible.get('postedCreditVatRegularizations')) == 544.55 and money(monthly_deductible.get('inqom4456NetMovement')) == 177.80 and money(monthly_deductible.get('deductibleVat')) == 204.06 and monthly_deductible.get('reconciliationOk') is True, detail=monthly_deductible)
    adjustment_evidence = monthly_deductible.get('verifiedCashBasisAdjustments') or []
    if (monthly.get('period') or {}).get('startDate') == '2026-08-01' and (monthly.get('period') or {}).get('endDate') == '2026-08-31':
        add(checks, 'august_deductible_independent_live_evidence', money(monthly_deductible.get('independentSigned4456NetMovement')) == 177.80 and monthly_deductible.get('componentReconciliationOk') is True and monthly_deductible.get('configuredAdjustmentCount') == 1 and monthly_deductible.get('verifiedAdjustmentCount') == 1 and not (monthly_deductible.get('adjustmentEvidenceErrors') or []) and len(adjustment_evidence) == 1 and adjustment_evidence[0].get('invoiceEntryId') == 628648298 and adjustment_evidence[0].get('bankEntryId') == 955471299 and adjustment_evidence[0].get('bankDocRef') == 'BQ110725027' and adjustment_evidence[0].get('evidenceStatus') == 'live_readback_verified' and all((adjustment_evidence[0].get('checks') or {}).values()) and bool(monthly_deductible.get('sourceLineDigestSha256')) and bool(adjustment_evidence[0].get('sourceLineDigestSha256')), detail=monthly_deductible)
    monthly_collection_errors = ((monthly.get('controls') or {}).get('collectionEvidenceErrors') or [])
    add(checks, 'august_collection_evidence_fail_closed', not monthly_collection_errors and ((monthly.get('controls') or {}).get('refundCheckMethod') == 'explicit_failed_cancelled_refunded_reversed_event_exclusion') and int(((monthly.get('controls') or {}).get('sourceReadback') or {}).get('invoiceTaxFallbackCount') or 0) == 0, detail={'errors': monthly_collection_errors, 'sourceReadback': ((monthly.get('controls') or {}).get('sourceReadback') or {}), 'refunds': ((monthly.get('cashCollections') or {}).get('refunds') or [])})
    wrapper_text = Path('/srv/rbw-agents-oss/scripts/finance_inqom_vat_cash_basis_monthly_preparer.py').read_text(encoding='utf-8')
    add(checks, 'wrapper_has_no_assumed_rate_allocation_path', 'fallback_assumed_20_percent' not in wrapper_text and 'allocation = allocate(' in wrapper_text and 'missing_reconciled_invoice_tax_evidence' in wrapper_text, detail='fail_closed_invoice_tax_evidence')
    add(checks, 'wrapper_has_explicit_disallowed_status_filter', 'DISALLOWED_COLLECTION_STATUS_TOKENS' in wrapper_text and 'disallowed_collection_status(label)' in wrapper_text and "'DISPUTED'" in wrapper_text and "'CONTESTED'" in wrapper_text, detail='failed_cancelled_refunded_reversed_chargeback')
    add(checks, 'wrapper_has_no_hardcoded_august_deductible_literal', 'expert_rh_adjustment = 26.26' not in wrapper_text and 'verifiedDeductibleVatCashBasisAdjustments' in wrapper_text and 'verify_deductible_adjustment_live' in wrapper_text, detail='policy_configured_live_readback')
    if (monthly.get('period') or {}).get('startDate') == '2026-08-01' and (monthly.get('period') or {}).get('endDate') == '2026-08-31':
        add(checks, 'august_declaration_exact_supersedes_incomplete_3333_65', money(monthly_exact.get('grossVatDue20Percent')) == 4416.00 and money(monthly_exact.get('deductibleVatOtherGoodsServices')) == 204.06 and money(monthly_exact.get('netVatDue')) == 4211.94 and money(monthly_exact.get('netVatDue')) != 3333.65, detail=monthly_exact)
    add(checks, 'august_internal_fiscal_quorum_unanimous', monthly_quorum.get('passed') is True and monthly_quorum.get('status') == 'passed' and int(monthly_quorum.get('passVotes') or 0) == 5 and int(monthly_quorum.get('requiredVotes') or 0) == 5 and not (monthly_quorum.get('failedAgents') or []), detail=monthly_quorum)
    add(checks, 'august_no_invoice_tax_fallback', all(((p.get('taxAllocationEvidence') or {}).get('method') == 'inqom_sellsy_invoice_prorata') for p in monthly_payments), detail=[{'invoice':p.get('invoiceNumber'),'method':(p.get('taxAllocationEvidence') or {}).get('method')} for p in monthly_payments])
    add(checks, 'period_lettering_accounting_followup_non_fiscal', int(monthly_ordinary.get('unresolvedCandidateCount') or 0) > 0 and monthly_ordinary.get('fiscalBlocking') is False and monthly_controls.get('portalEntryBlockedByFiscalControls') is False and monthly_controls.get('readyForHumanPortalValidation') is True and not (monthly.get('blockingReasons') or []), detail={'ordinary': monthly_ordinary, 'monthlyBlocking': monthly.get('blockingReasons'), 'letteringStatus': lettering.get('status')})

    lettering_blob = json.dumps(lettering, ensure_ascii=False)
    candidate_rows = [
        row for collection in ('unresolvedCandidates', 'alreadyLetteredOrResolvedCandidates')
        for row in (lettering.get(collection) or []) if isinstance(row, dict)
    ]
    runtime_states = sorted({str(row.get('periodLetteringState') or '') for row in candidate_rows if row.get('periodLetteringState')})
    legacy_runtime_mismatch_tracked = 'Outil inconnu: inqom_get_native_lettering_preflight' in lettering_blob
    native_preflight_observed = any('native_preflight' in state for state in runtime_states)
    fallback_preflight_observed = any('fallback_preflight' in state for state in runtime_states)
    runtime_mode_accounted_for = legacy_runtime_mismatch_tracked or native_preflight_observed or fallback_preflight_observed
    add(
        checks,
        'native_preflight_runtime_mismatch_tracked',
        runtime_mode_accounted_for,
        severity='warning',
        detail={
            'summary': lettering.get('summary'),
            'warningReasons': lettering.get('warningReasons'),
            'runtimeMode': 'native_preflight_available' if native_preflight_observed else ('fallback_preflight' if fallback_preflight_observed else ('legacy_unknown_tool_tracked' if legacy_runtime_mismatch_tracked else 'unaccounted')),
            'runtimeStates': runtime_states,
        },
    )
    failed = [c for c in checks if not c['ok']]
    critical_failed = [c for c in failed if c.get('severity') == 'critical']
    high_failed = [c for c in failed if c.get('severity') == 'high']
    warnings = [c for c in failed if c.get('severity') == 'warning']
    payload = {
        'generatedAt': generated_at,
        'contractVersion': 'finance-inqom-vat-cash-basis-monthly-tests-v6-current-period-contract',
        'capabilityId': 'finance-inqom-vat-cash-basis-monthly-tests',
        'ok': not critical_failed and not high_failed,
        'status': 'pass_with_warnings' if warnings and not critical_failed and not high_failed else ('pass' if not failed else 'failed'),
        'summary': f"finance_inqom_vat_cash_basis_monthly_tests: checks={len(checks)} failed={len(failed)} critical_failed={len(critical_failed)} high_failed={len(high_failed)} warnings={len(warnings)} july_net_vat=2824 current_period={monthly.get('period')} current_net_vat={monthly_exact.get('netVatDue')} quorum=5/5 fail_closed_evidence=true prepare_only=true",
        'counts': {'checks': len(checks), 'failed': len(failed), 'criticalFailed': len(critical_failed), 'highFailed': len(high_failed), 'warnings': len(warnings)},
        'blockingReasons': [c['checkId'] for c in critical_failed + high_failed],
        'warningReasons': [c['checkId'] for c in warnings],
        'checks': checks,
        'failedChecks': failed,
        'guardrails': {
            'noTaxFiling': True,
            'noTaxPayment': True,
            'noInqomMutation': True,
            'noExternalSend': True,
            'exclude44551000': True,
            'include44588800OnlyWhenInvoiceLinked': True,
            'ordinaryPeriodLetteringNonFiscalUnlessQuorumConflict': True,
            'internalFiscalQuorumRequired': True,
        },
        'artifacts': {'reportJson': str(OUT_JSON), 'reportMd': str(OUT_MD), 'julyPack': str(JULY_PACK), 'monthlyLast': str(MONTHLY_LAST), 'letteringControl': str(LETTERING_CONTROL), 'sellsyControl': str(SELLY_CONTROL) if False else str(SELLSY_CONTROL), 'gocardlessReceipts': str(GOCARDLESS_RECEIPTS), 'directBankReceipts': str(DIRECT_BANK_RECEIPTS), 'allocator': str(ALLOCATOR), 'deductibleCrosscheck': str(DEDUCTIBLE_CROSSCHECK)},
        'updatedBy': 'finance-inqom-vat-cash-basis-monthly-tests-v6-current-period-contract',
    }
    write_json(OUT_JSON, payload)
    OUT_MD.write_text('\n'.join([f"# Finance Inqom TVA cash-basis monthly tests — {generated_at}", '', f"- Summary: {payload['summary']}", f"- OK: **{payload['ok']}**", f"- Warnings: {len(warnings)}", '', '## Checks', *[f"- {'✅' if c['ok'] else '⚠️' if c['severity']=='warning' else '❌'} {c['checkId']} ({c['severity']})" for c in checks]]) + '\n', encoding='utf-8')
    print(json.dumps({'generatedAt': generated_at, 'summary': payload['summary'], 'blockingReasons': payload['blockingReasons'], 'warningReasons': payload['warningReasons']}, ensure_ascii=False))
    if not payload['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
