import copy,json,unittest
from pathlib import Path
from inqom_expert_route_autonomous_resolver_tests import quarantine_decisions_consistent
F=json.loads((Path(__file__).with_name('test_fixtures')/'inqom-quarantine-contract-fixture-20261005.json').read_text())
class QuarantineContract(unittest.TestCase):
    def setUp(self):self.d=copy.deepcopy(F)
    def valid(self):return quarantine_decisions_consistent(self.d['manifest'],self.d['decisions'],self.d['records'],self.d['digest'])
    def test_real_two_lots_only(self):self.assertTrue(self.valid())
    def test_native_operation_blocks(self):
        self.d['manifest']['operations']=[{'write':True}];self.assertFalse(self.valid())
    def test_missing_decision_blocks(self):
        self.d['decisions'].pop();self.assertFalse(self.valid())
    def test_hash_drift_blocks(self):
        self.d['digest']='0'*64;self.assertFalse(self.valid())
    def test_unrelated_new_waiting_line_blocks(self):
        self.d['records'][0]['lineIds']=[3961791128];self.assertFalse(self.valid())
if __name__=='__main__':unittest.main()
