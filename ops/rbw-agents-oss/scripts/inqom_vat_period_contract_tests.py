#!/usr/bin/env python3
from __future__ import annotations
import copy,json,sys,unittest
from pathlib import Path
from inqom_vat_period_contract import current_period_checks

class PeriodContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture=json.loads((Path(__file__).with_name('test_fixtures') / 'inqom-september-fixture-20261005.json').read_text())
    def check(self,edit,check_id):
        data=copy.deepcopy(self.fixture);edit(data)
        rows=current_period_checks(data)
        self.assertFalse(next(r['ok'] for r in rows if r['checkId']==check_id),rows)
    def test_real_september_passes_own_evidence(self):
        rows=current_period_checks(self.fixture)
        self.assertTrue(all(r['ok'] for r in rows),rows)
        self.assertEqual(self.fixture['period']['startDate'],'2026-09-01')
        self.assertEqual(self.fixture['declarationDraft']['exact']['netVatDue'],2593.79)
    def add_fuel_adjustment(self,data,vat=8.0,source_vat=10.0,rate=None):
        row={'vat':vat,'sourceVat':source_vat,'taxCategory':'carburant','label':'Facture carburant gazole','evidenceStatus':'live_readback_verified','invoiceEntryId':101,'bankEntryId':202,'bankDocRef':'BQ-FUEL','sourceLineDigestSha256':'a'*64,'checks':{'invoiceRead':True,'bankRead':True}}
        if rate is not None:
            row['deductionRate']=rate
        deductible=data['cashCollections']['deductibleVat']
        deductible['verifiedCashBasisAdjustments']=[row]
        deductible['configuredAdjustmentCount']=1
        deductible['verifiedAdjustmentCount']=1
        deductible['adjustmentTotal']=vat
        deductible['deductibleVat']=round(deductible['independentSigned4456NetMovement']+vat,2)
        data['declarationDraft']['exact']['deductibleVatOtherGoodsServices']=deductible['deductibleVat']
        data['declarationDraft']['exact']['netVatDue']=round(data['declarationDraft']['exact']['grossVatDue20Percent']-deductible['deductibleVat'],2)
    def test_fuel_vat_defaults_to_80_percent(self):
        data=copy.deepcopy(self.fixture)
        self.add_fuel_adjustment(data)
        rows=current_period_checks(data)
        self.assertTrue(all(r['ok'] for r in rows),rows)
    def test_full_fuel_vat_without_override_blocks(self):
        self.check(lambda d:self.add_fuel_adjustment(d,vat=10.0,source_vat=10.0),'current_period_fuel_vat_default_80_percent')
    def test_collection_drift_blocks(self):
        self.check(lambda d:d['cashCollections']['totalsExact'].update(grossCollectedTtc=26496),'current_period_collections_exact')
    def test_invoice_unreconciled_blocks(self):
        self.check(lambda d:d['cashCollections']['payments'][0]['taxAllocationEvidence']['invoice'].update(reconciled=False),'current_period_invoice_tax_evidence')
    def test_wrong_period_blocks(self):
        self.check(lambda d:d['period'].update(startDate='2026-08-01',endDate='2026-08-31'),'current_period_collections_exact')
    def test_duplicate_payment_blocks(self):
        self.check(lambda d:d['cashCollections']['payments'].append(copy.deepcopy(d['cashCollections']['payments'][0])),'current_period_collections_exact')
    def test_independent_ledger_drift_blocks(self):
        self.check(lambda d:d['cashCollections']['deductibleVat'].update(independentSigned4456NetMovement=177.8),'current_period_deductible_reconciliation')
    def test_missing_live_evidence_blocks(self):
        self.check(lambda d:d['cashCollections']['deductibleVat'].update(sourceLineDigestSha256=''),'current_period_deductible_live_evidence')
    def test_unverified_adjustment_blocks(self):
        self.check(lambda d:d['cashCollections']['deductibleVat'].update(configuredAdjustmentCount=1),'current_period_deductible_live_evidence')
    def test_wrong_declared_total_blocks(self):
        self.check(lambda d:d['declarationDraft']['exact'].update(netVatDue=4211.94),'current_period_declaration_arithmetic')

if __name__=='__main__':
    unittest.main(argv=[sys.argv[0]],verbosity=1)
