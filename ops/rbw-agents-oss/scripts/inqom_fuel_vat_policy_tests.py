#!/usr/bin/env python3
from __future__ import annotations
import datetime as dt
import unittest
from unittest.mock import patch
import finance_inqom_vat_cash_basis_monthly_preparer as preparer
import inqom_operator_guidance_materializer as guidance
from inqom_vat_period_contract import fuel_vat_breakdown, fuel_adjustments_policy_good, fuel_ledger_policy_good

class FuelPolicyTests(unittest.TestCase):
    def test_default_split(self):
        self.assertEqual(fuel_vat_breakdown({'sourceVat':10}),{'sourceVat':10.0,'deductionRate':0.8,'deductibleVat':8.0,'nonDeductibleVat':2.0})
    def test_rounding_and_credit_note(self):
        self.assertEqual(fuel_vat_breakdown({'sourceVat':12.34})['deductibleVat'],9.87)
        split=fuel_vat_breakdown({'sourceVat':-12.34})
        self.assertEqual(split['deductibleVat'],-9.87)
        self.assertEqual(split['nonDeductibleVat'],-2.47)
    def test_explicit_zero_rate_is_respected(self):
        self.assertEqual(fuel_vat_breakdown({'sourceVat':10,'deductionRate':0})['deductibleVat'],0)
    def test_missing_source_and_invalid_rates_block(self):
        for row in [{},{'sourceVat':'NaN'},*({'sourceVat':10,'deductionRate':rate} for rate in ('NaN','Infinity',-0.1,1.1))]:
            with self.subTest(row=row),self.assertRaises((ValueError,ArithmeticError)):
                fuel_vat_breakdown(row)
    def test_boolean_override_is_not_evidence(self):
        self.assertFalse(fuel_adjustments_policy_good([{'label':'carburant','sourceVat':10,'vat':10,'deductionRate':1,'deductionOverride':True}]))
    def test_documented_override(self):
        evidence={'vehicleId':'UTILITY-1','documentRef':'vehicle-tax-policy.pdf','reason':'Documented vehicle regime','deductionRate':1}
        row={'label':'carburant','sourceVat':10,'vat':10,'deductionRate':1,'deductionOverrideEvidence':evidence}
        self.assertTrue(fuel_adjustments_policy_good([row]))
        row['deductionOverrideEvidence']['deductionRate']=0.8
        self.assertFalse(fuel_adjustments_policy_good([row]))
    def test_non_fuel_is_unaffected(self):
        self.assertTrue(fuel_adjustments_policy_good([{'label':'Essentielle assistance','vat':10}]))
    def test_fuel_route_and_specific_wait_precedence(self):
        base={'folderId':18627,'lineId':1,'amount':10,'account':'40111DIVERSCARBURANT','docRef':'F260001','label':'Supplier'}
        self.assertEqual(guidance.classify(base),('fuel_invoice_vat_80_default_review',True))
        self.assertEqual(guidance.classify({**base,'lineId':2593322531}),('pns_credit_note',False))
        self.assertNotEqual(guidance.classify({**base,'account':'411TEST','label':'Fuel sale'})[0],'fuel_invoice_vat_80_default_review')

class FuelPreparationTests(unittest.TestCase):
    def lines(self,posted=10):
        return [{'entryId':101,'account':'44566000','amount':-posted,'docRef':'FUEL-101','label':'Facture gazole'}]
    def policy(self,source=10):
        return {'fuelVatInvoiceEvidence':[{'folderId':18627,'invoiceEntryId':101,'invoiceDocRef':'FUEL-101','sourceDocumentRef':'FUEL-101.pdf','sourceVat':source}]}
    def test_ledger_default_corrects_full_vat(self):
        fuel=preparer.prepare_fuel_ledger_vat(self.lines(),self.policy(),18627)
        self.assertEqual(fuel['fuelVatAdjustmentTotal'],-2)
        self.assertEqual(fuel['fuelVatTreatments'][0]['nonDeductibleVat'],2)
        self.assertTrue(fuel_ledger_policy_good(fuel))
    def test_already_reduced_vat_is_not_reduced_again(self):
        fuel=preparer.prepare_fuel_ledger_vat(self.lines(8),self.policy(),18627)
        self.assertEqual(fuel['fuelVatAdjustmentTotal'],0)
        self.assertTrue(fuel_ledger_policy_good(fuel))
    def test_missing_source_document_blocks(self):
        fuel=preparer.prepare_fuel_ledger_vat(self.lines(),{},18627)
        self.assertTrue(fuel['fuelVatEvidenceErrors'])
        self.assertFalse(fuel_ledger_policy_good(fuel))
    def test_wrong_invoice_and_duplicate_evidence_block(self):
        for change in ('docref','duplicate','folder'):
            policy=self.policy()
            if change=='docref':policy['fuelVatInvoiceEvidence'][0]['invoiceDocRef']='OTHER'
            elif change=='folder':policy['fuelVatInvoiceEvidence'][0]['folderId']=124920
            else:policy['fuelVatInvoiceEvidence']*=2
            self.assertFalse(fuel_ledger_policy_good(preparer.prepare_fuel_ledger_vat(self.lines(),policy,18627)),change)
    def test_credit_note_reverses_both_parts(self):
        fuel=preparer.prepare_fuel_ledger_vat(self.lines(-10),self.policy(-10),18627)
        self.assertEqual(fuel['fuelVatAdjustmentTotal'],2)
        self.assertEqual(fuel['fuelVatTreatments'][0]['deductibleVat'],-8)
        self.assertTrue(fuel_ledger_policy_good(fuel))
    def test_controller_detects_tampered_split(self):
        fuel=preparer.prepare_fuel_ledger_vat(self.lines(),self.policy(),18627)
        fuel['fuelVatTreatments'][0]['deductibleVat']=10
        self.assertFalse(fuel_ledger_policy_good(fuel))
    def test_monthly_preparer_uses_fuel_split_without_mutation(self):
        calls=[]
        def native(tool,args,**kwargs):
            calls.append((tool,args))
            return {'lines':self.lines()}
        with patch.object(preparer,'inqom_call_tool',side_effect=native),patch.object(preparer,'read_json',return_value=self.policy()):
            result=preparer.prepare_deductible_vat_from_inqom(dt.date(2026,10,1),dt.date(2026,10,31),18627)
        self.assertEqual(result['deductibleVat'],8)
        self.assertEqual(result['independentSigned4456NetMovement'],10)
        self.assertTrue(result['reconciliationOk'])
        self.assertEqual([call[0] for call in calls],['inqom_search_lines_advanced'])
    def test_monthly_preparer_blocks_missing_fuel_source(self):
        with patch.object(preparer,'inqom_call_tool',return_value={'lines':self.lines()}),patch.object(preparer,'read_json',return_value={}):
            result=preparer.prepare_deductible_vat_from_inqom(dt.date(2026,10,1),dt.date(2026,10,31),18627)
        self.assertFalse(result['reconciliationOk'])
    def test_non_fuel_ledger_is_unchanged(self):
        lines=self.lines();lines[0].update(label='Software subscription',docRef='SW-101')
        self.assertEqual(preparer.prepare_fuel_ledger_vat(lines,{},18627)['fuelVatInvoiceCount'],0)
    def test_live_cash_adjustment_applies_80_percent(self):
        spec={'adjustmentId':'FUEL-PAID','folderId':18627,'periodStart':'2026-10-01','periodEnd':'2026-10-31',
              'supplier':'Gazole fournisseur','deductibleVat':8,'sourceVat':10,
              'invoiceEvidence':{'date':'2026-09-20','entryId':101,'labelContains':'FUEL-101','vatAccount':'44566000',
                                 'vatAmount':-10,'docRef':'FUEL-101','sourceType':'Chaintrust','grossAccountPrefix':'401','grossAmount':60},
              'bankEvidence':{'date':'2026-10-03','entryId':202,'labelContains':'Gazole','accountPrefix':'512',
                              'amount':60,'docRef':'BQ-202','sourceType':'Banking'}}
        invoice=[{'entryId':101,'account':'44566000','amount':-10,'docRef':'FUEL-101','sourceType':'Chaintrust'},
                 {'entryId':101,'account':'60610000','amount':-50},
                 {'entryId':101,'account':'401FUEL','amount':60}]
        bank=[{'entryId':202,'account':'51200000','amount':60,'docRef':'BQ-202','sourceType':'Banking'}]
        def native(tool,args,**kwargs):
            self.assertEqual(tool,'inqom_search_lines_advanced')
            return {'lines':invoice if args['startDate']=='2026-09-20' else bank}
        with patch.object(preparer,'inqom_call_tool',side_effect=native):
            result=preparer.verify_deductible_adjustment_live(spec)
            self.assertTrue(result['verified'],result)
            self.assertEqual(result['vat'],8)
            self.assertEqual(result['nonDeductibleVat'],2)
            self.assertTrue(fuel_adjustments_policy_good([result]))
            spec['deductibleVat']=10
            self.assertFalse(preparer.verify_deductible_adjustment_live(spec)['verified'])
    def test_controller_requires_source_document(self):
        fuel=preparer.prepare_fuel_ledger_vat(self.lines(),self.policy(),18627)
        del fuel['fuelVatTreatments'][0]['sourceDocumentRef']
        self.assertFalse(fuel_ledger_policy_good(fuel))
    def test_multiple_vat_lines_are_adjusted_once_per_invoice(self):
        lines=self.lines(6)+self.lines(4)
        fuel=preparer.prepare_fuel_ledger_vat(lines,self.policy(),18627)
        self.assertEqual(fuel['fuelVatInvoiceCount'],1)
        self.assertEqual(fuel['fuelVatAdjustmentTotal'],-2)
        self.assertTrue(fuel_ledger_policy_good(fuel))
    def test_monthly_controller_reconciles_fuel_correction(self):
        from inqom_vat_period_contract import current_period_checks
        import json
        from pathlib import Path
        monthly=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-september-fixture-20261005.json').read_text())
        fuel=preparer.prepare_fuel_ledger_vat(self.lines(),self.policy(),18627)
        deductible=monthly['cashCollections']['deductibleVat'];deductible.update(fuel)
        deductible['deductibleVat']-=2
        monthly['declarationDraft']['exact']['deductibleVatOtherGoodsServices']-=2
        monthly['declarationDraft']['exact']['netVatDue']+=2
        checks=current_period_checks(monthly)
        self.assertTrue(all(check['ok'] for check in checks),checks)

if __name__=='__main__':
    unittest.main()
