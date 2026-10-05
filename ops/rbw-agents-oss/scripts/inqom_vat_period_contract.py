#!/usr/bin/env python3
"""Month-bound verification of cash-basis preparation, using reconciled invoice evidence."""
from __future__ import annotations
import calendar
from datetime import date
from decimal import Decimal

def amount(value):
    value=Decimal(str(value))
    if not value.is_finite():raise ValueError('non_finite_amount')
    return value.quantize(Decimal('0.01'))

def current_period_checks(monthly):
    checks=[]
    def add(name,ok,detail):
        checks.append({'checkId':name,'ok':bool(ok),'severity':'critical','detail':detail})
    period=monthly.get('period') or {}
    try:
        start=date.fromisoformat(period['startDate']);end=date.fromisoformat(period['endDate'])
        valid_period=start.day==1 and start.year==end.year and start.month==end.month and end.day==calendar.monthrange(start.year,start.month)[1]
    except (ValueError,KeyError):
        valid_period=False
    cash=monthly.get('cashCollections') or {}
    payments=cash.get('payments') or []
    totals=cash.get('totalsExact') or {}
    ids=[p.get('paymentId') for p in payments]
    try:
        sums={key:sum((amount(p[key]) for p in payments),Decimal('0')) for key in ('grossCollectedTtc','taxableBaseHt','vatCollected')}
        dates_ok=valid_period and all(start.isoformat() <= str(p.get('chargeDate') or '')[:10] <= end.isoformat() for p in payments)
        totals_ok=all(amount(totals[key])==sums[key] for key in sums)
    except (ValueError,ArithmeticError,KeyError):
        sums={};dates_ok=False;totals_ok=False
    add('current_period_collections_exact',dates_ok and totals_ok and None not in ids and len(ids)==len(set(ids)),{'period':period,'count':len(payments),'totals':totals})
    evidence_ok=True
    for p in payments:
        evidence=p.get('taxAllocationEvidence') or {};invoice=evidence.get('invoice') or {}
        try:
            gross=amount(p['grossCollectedTtc']);ttc=amount(invoice['ttc']);ht=amount(invoice['ht']);vat=amount(invoice['vat'])
            reconciled=(ttc>0 and 0<gross<=ttc and ht+vat==ttc and
                        amount(gross*ht/ttc)==amount(p['taxableBaseHt']) and
                        amount(gross*vat/ttc)==amount(p['vatCollected']) and
                        amount(p['taxableBaseHt'])+amount(p['vatCollected'])==gross)
        except (ValueError,ArithmeticError,KeyError):reconciled=False
        evidence_ok=evidence_ok and reconciled and evidence.get('method')=='inqom_sellsy_invoice_prorata' and invoice.get('reconciled') is True and bool(invoice.get('entryIds')) and bool(invoice.get('docRefs')) and invoice.get('invoiceNumber')==p.get('invoiceNumber') and bool(p.get('entryId')) and bool(p.get('docRef')) and p.get('disallowedStatusEvidenceChecked') is True
    add('current_period_invoice_tax_evidence',evidence_ok,{'period':period,'invoiceNumbers':[p.get('invoiceNumber') for p in payments]})
    deductible=cash.get('deductibleVat') or {};adjustments=deductible.get('verifiedCashBasisAdjustments') or []
    try:
        movement=amount(deductible['postedDebitVatInvoiceControl'])-amount(deductible['postedCreditVatRegularizations'])
        signed=amount(deductible['independentSigned4456NetMovement'])
        adjustments_total=sum((amount(a['vat']) for a in adjustments),Decimal('0'))
    except (ValueError,ArithmeticError,KeyError):
        movement=None;signed=None;adjustments_total=None
    add('current_period_deductible_reconciliation',movement is not None and movement==signed and signed==amount(deductible.get('inqom4456NetMovement',0)) and adjustments_total is not None and amount(deductible.get('adjustmentTotal',0))==adjustments_total and amount(deductible.get('deductibleVat',0))==signed+adjustments_total and deductible.get('reconciliationOk') is True and deductible.get('componentReconciliationOk') is True,{'period':period,'netMovement':str(movement),'independentMovement':str(signed)})
    evidence_good=(deductible.get('configuredAdjustmentCount')==deductible.get('verifiedAdjustmentCount')==len(adjustments) and
                   not deductible.get('adjustmentEvidenceErrors') and len(str(deductible.get('sourceLineDigestSha256') or ''))==64 and
                   bool(deductible.get('referenceChecks')) and all(deductible['referenceChecks'].values()) and
                   all(a.get('evidenceStatus')=='live_readback_verified' and bool(a.get('invoiceEntryId')) and bool(a.get('bankEntryId')) and bool(a.get('bankDocRef')) and len(str(a.get('sourceLineDigestSha256') or ''))==64 and bool(a.get('checks')) and all(a['checks'].values()) for a in adjustments))
    add('current_period_deductible_live_evidence',evidence_good,{'period':period,'configured':deductible.get('configuredAdjustmentCount'),'verified':deductible.get('verifiedAdjustmentCount')})
    exact=(monthly.get('declarationDraft') or {}).get('exact') or {}
    try:
        declared=(amount(exact['taxableBase20Percent'])==sums['taxableBaseHt'] and
                  amount(exact['grossVatDue20Percent'])==sums['vatCollected'] and
                  amount(exact['deductibleVatOtherGoodsServices'])==amount(deductible['deductibleVat']) and
                  amount(exact['netVatDue'])==sums['vatCollected']-amount(deductible['deductibleVat']))
    except (ValueError,ArithmeticError,KeyError):declared=False
    add('current_period_declaration_arithmetic',declared,{'period':period,'declaration':exact})
    return checks
