#!/usr/bin/env python3
"""Month-bound verification of cash-basis preparation, using reconciled invoice evidence."""
from __future__ import annotations
import calendar
from datetime import date
from decimal import Decimal
import re

FUEL_TOKENS = ('carburant', 'fuel', 'essence', 'gazole', 'diesel')

def amount(value):
    value=Decimal(str(value))
    if not value.is_finite():raise ValueError('non_finite_amount')
    return value.quantize(Decimal('0.01'))

def adjustment_text(row):
    keys=('taxCategory','category','account','accountName','label','entryLabel','description','supplier','vendor','docRef')
    nested=row.get('evidence') if isinstance(row.get('evidence'),dict) else {}
    return ' '.join(str(row.get(k) or nested.get(k) or '').lower() for k in keys)

def is_fuel_adjustment(row):
    text=adjustment_text(row)
    account=str(row.get('account') or row.get('accountName') or '').lower()
    return ('carburant' in account or bool(re.search(r'\b(?:carburants?|fuels?|essence|gazole|gasoil|diesel)\b',text)))

def adjustment_source_vat(row):
    for key in ('sourceVat','invoiceVat','originalVat','vatBeforeDeduction','grossVat'):
        if row.get(key) is not None:
            return amount(row[key])
    return None

def fuel_vat_breakdown(row):
    source=adjustment_source_vat(row)
    if source is None:
        raise ValueError('fuel_invoice_source_vat_required')
    rate=Decimal('0.80')
    for key in ('deductionRate','deductibleRate','vatDeductionRate'):
        if row.get(key) is not None:
            rate=Decimal(str(row[key]));break
    if not rate.is_finite() or not Decimal('0') <= rate <= Decimal('1'):
        raise ValueError('fuel_deduction_rate_invalid')
    override=row.get('deductionOverrideEvidence')
    if rate > Decimal('0.80'):
        if (not isinstance(override,dict) or
            not all(isinstance(override.get(key),str) and override[key].strip() for key in ('vehicleId','documentRef','reason')) or
            Decimal(str(override.get('deductionRate'))) != rate):
            raise ValueError('fuel_deduction_override_evidence_required')
    deductible=amount(source*rate)
    result={'sourceVat':float(source),'deductionRate':float(rate),
            'deductibleVat':float(deductible),'nonDeductibleVat':float(source-deductible)}
    if rate > Decimal('0.80'):
        result['deductionOverrideEvidence']=dict(override)
    return result

def fuel_adjustments_policy_good(adjustments):
    for row in adjustments:
        if not isinstance(row,dict):
            return False
        if not is_fuel_adjustment(row):
            continue
        try:
            declared=amount(row['vat'])
            expected=fuel_vat_breakdown(row)
        except (ValueError,TypeError,ArithmeticError,KeyError):
            return False
        if declared != amount(expected['deductibleVat']):
            return False
    return True

def fuel_ledger_policy_good(deductible):
    rows=deductible.get('fuelVatTreatments') or []
    if deductible.get('fuelVatEvidenceErrors') or deductible.get('fuelVatInvoiceCount',0) != len(rows):
        return False
    try:
        corrections=Decimal('0')
        identities=[]
        for row in rows:
            expected=fuel_vat_breakdown(row)
            if (not row.get('invoiceEntryId') or not row.get('invoiceDocRef') or not row.get('sourceDocumentRef') or
                amount(row['deductibleVat']) != amount(expected['deductibleVat']) or
                amount(row['nonDeductibleVat']) != amount(expected['nonDeductibleVat'])):
                return False
            corrections+=amount(expected['deductibleVat'])-amount(row['postedVat'])
            identities.append(row['invoiceEntryId'])
        return len(identities)==len(set(identities)) and corrections==amount(deductible.get('fuelVatAdjustmentTotal',0))
    except (ValueError,TypeError,ArithmeticError,KeyError):
        return False

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
    add('current_period_deductible_reconciliation',movement is not None and movement==signed and signed==amount(deductible.get('inqom4456NetMovement',0)) and adjustments_total is not None and amount(deductible.get('adjustmentTotal',0))==adjustments_total and amount(deductible.get('deductibleVat',0))==signed+adjustments_total+amount(deductible.get('fuelVatAdjustmentTotal',0)) and deductible.get('reconciliationOk') is True and deductible.get('componentReconciliationOk') is True,{'period':period,'netMovement':str(movement),'independentMovement':str(signed)})
    evidence_good=(deductible.get('configuredAdjustmentCount')==deductible.get('verifiedAdjustmentCount')==len(adjustments) and
                   not deductible.get('adjustmentEvidenceErrors') and len(str(deductible.get('sourceLineDigestSha256') or ''))==64 and
                   bool(deductible.get('referenceChecks')) and all(deductible['referenceChecks'].values()) and
                   all(a.get('evidenceStatus')=='live_readback_verified' and bool(a.get('invoiceEntryId')) and bool(a.get('bankEntryId')) and bool(a.get('bankDocRef')) and len(str(a.get('sourceLineDigestSha256') or ''))==64 and bool(a.get('checks')) and all(a['checks'].values()) for a in adjustments))
    add('current_period_deductible_live_evidence',evidence_good,{'period':period,'configured':deductible.get('configuredAdjustmentCount'),'verified':deductible.get('verifiedAdjustmentCount')})
    add('current_period_fuel_vat_default_80_percent',fuel_adjustments_policy_good(adjustments),{'period':period,'fuelAdjustments':[a for a in adjustments if is_fuel_adjustment(a)]})
    add('current_period_fuel_vat_ledger_evidence',fuel_ledger_policy_good(deductible),{'period':period,'fuelInvoiceCount':deductible.get('fuelVatInvoiceCount',0),'errors':deductible.get('fuelVatEvidenceErrors') or []})
    exact=(monthly.get('declarationDraft') or {}).get('exact') or {}
    try:
        declared=(amount(exact['taxableBase20Percent'])==sums['taxableBaseHt'] and
                  amount(exact['grossVatDue20Percent'])==sums['vatCollected'] and
                  amount(exact['deductibleVatOtherGoodsServices'])==amount(deductible['deductibleVat']) and
                  amount(exact['netVatDue'])==sums['vatCollected']-amount(deductible['deductibleVat']))
    except (ValueError,ArithmeticError,KeyError):declared=False
    add('current_period_declaration_arithmetic',declared,{'period':period,'declaration':exact})
    return checks
